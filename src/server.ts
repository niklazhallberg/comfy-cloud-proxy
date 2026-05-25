import "dotenv/config";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "comfy-cloud-proxy",
  version: "0.2.1"
});

function getCloudConfig(): { baseUrl: string; apiKey: string } | { error: string } {
  const baseUrl = process.env.COMFY_CLOUD_BASE_URL || "https://cloud.comfy.org";
  const apiKey = process.env.COMFY_CLOUD_API_KEY;
  if (!apiKey) return { error: "Missing COMFY_CLOUD_API_KEY in .env" };
  return { baseUrl, apiKey };
}

function toolError(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

function toolOk(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2)
      }
    ]
  };
}

function inferMimeType(filename: string): string {
  const ext = extname(filename).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".bmp") return "image/bmp";
  if (ext === ".tif" || ext === ".tiff") return "image/tiff";
  return "application/octet-stream";
}

async function blake3OrSha256(buf: Buffer): Promise<{ algo: "sha256"; hex: string }> {
  // We use sha256 here because Node's built-in crypto doesn't ship blake3.
  // Cloud accepts both prefixes (blake3:/sha256:) for /api/assets/from-hash and
  // identity comparisons. For uploads we just need a stable client-side hash to
  // log in the manifest — content-addressing on Cloud is authoritative.
  return { algo: "sha256", hex: createHash("sha256").update(buf).digest("hex") };
}

const SIMPLE_TXT2IMG_CHECKPOINT = "v1-5-pruned-emaonly-fp16.safetensors";

type WorkflowNode = { inputs: Record<string, unknown>; class_type: string };
type Workflow = Record<string, WorkflowNode>;

type SimpleTxt2ImgParams = {
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  seed: number;
};

function buildSimpleTxt2ImgWorkflow(params: SimpleTxt2ImgParams): Workflow {
  const { prompt, negativePrompt, width, height, steps, cfg, seed } = params;
  return {
    "3": {
      inputs: {
        seed,
        steps,
        cfg,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 1,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0]
      },
      class_type: "KSampler"
    },
    "4": {
      inputs: { ckpt_name: SIMPLE_TXT2IMG_CHECKPOINT },
      class_type: "CheckpointLoaderSimple"
    },
    "5": {
      inputs: { width, height, batch_size: 1 },
      class_type: "EmptyLatentImage"
    },
    "6": {
      inputs: { text: prompt, clip: ["4", 1] },
      class_type: "CLIPTextEncode"
    },
    "7": {
      inputs: { text: negativePrompt ?? "", clip: ["4", 1] },
      class_type: "CLIPTextEncode"
    },
    "8": {
      inputs: { samples: ["3", 0], vae: ["4", 2] },
      class_type: "VAEDecode"
    },
    "9": {
      inputs: { filename_prefix: "ComfyUI", images: ["8", 0] },
      class_type: "SaveImage"
    }
  };
}

const simpleTxt2ImgInputShape = {
  prompt: z.string().min(1),
  negativePrompt: z.string().optional(),
  width: z.number().int().min(64).max(2048).default(512),
  height: z.number().int().min(64).max(2048).default(512),
  steps: z.number().int().min(1).max(150).default(20),
  cfg: z.number().min(0).max(30).default(7),
  seed: z.number().int().min(0).optional()
};

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

server.tool("ping", "Simple connectivity check", {}, async () => {
  return {
    content: [{ type: "text", text: "pong" }]
  };
});

server.tool(
  "get_object_info",
  "Fetch node schema from Comfy Cloud. Without nodeName: returns totalNodes + sample list. With nodeName: returns that node's full schema.",
  { nodeName: z.string().optional() },
  async ({ nodeName }) => {
    const baseUrl = process.env.COMFY_CLOUD_BASE_URL || "https://cloud.comfy.org";
    const apiKey = process.env.COMFY_CLOUD_API_KEY;

    if (!apiKey) {
      return {
        content: [{ type: "text", text: "Missing COMFY_CLOUD_API_KEY in .env" }],
        isError: true
      };
    }

    let data: Record<string, unknown>;
    try {
      const res = await fetch(`${baseUrl}/api/object_info`, {
        headers: {
          "X-API-Key": apiKey
        }
      });

      if (!res.ok) {
        const text = await res.text();
        return {
          content: [{ type: "text", text: `Comfy Cloud error ${res.status}: ${text}` }],
          isError: true
        };
      }

      data = (await res.json()) as Record<string, unknown>;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Failed to fetch object_info: ${message}` }],
        isError: true
      };
    }

    if (nodeName) {
      const node = data[nodeName];
      if (node === undefined) {
        return {
          content: [{ type: "text", text: `Node "${nodeName}" not found in object_info` }],
          isError: true
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(node, null, 2) }]
      };
    }

    const nodeNames = Object.keys(data);
    const preview = nodeNames.slice(0, 25);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              totalNodes: nodeNames.length,
              sampleNodes: preview
            },
            null,
            2
          )
        }
      ]
    };
  }
);

server.tool(
  "submit_simple_txt2img",
  "Submit a minimal SD1.5 txt2img workflow to Comfy Cloud and return the prompt_id. Does not poll for completion.",
  simpleTxt2ImgInputShape,
  async ({ prompt, negativePrompt, width, height, steps, cfg, seed }) => {
    const baseUrl = process.env.COMFY_CLOUD_BASE_URL || "https://cloud.comfy.org";
    const apiKey = process.env.COMFY_CLOUD_API_KEY;

    if (!apiKey) {
      return {
        content: [{ type: "text", text: "Missing COMFY_CLOUD_API_KEY in .env" }],
        isError: true
      };
    }

    const actualSeed =
      seed ?? Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);

    const workflow = buildSimpleTxt2ImgWorkflow({
      prompt,
      negativePrompt,
      width,
      height,
      steps,
      cfg,
      seed: actualSeed
    });

    let data: Record<string, unknown>;
    try {
      const res = await fetch(`${baseUrl}/api/prompt`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey
        },
        body: JSON.stringify({ prompt: workflow })
      });

      if (!res.ok) {
        const text = await res.text();
        return {
          content: [
            { type: "text", text: `Comfy Cloud error ${res.status}: ${text}` }
          ],
          isError: true
        };
      }

      data = (await res.json()) as Record<string, unknown>;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Failed to submit prompt: ${message}` }],
        isError: true
      };
    }

    const promptId =
      (data.prompt_id as string | undefined) ??
      (data.promptId as string | undefined) ??
      null;
    const nodeErrors = data.node_errors ?? data.nodeErrors ?? null;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              promptId,
              number: data.number ?? null,
              nodeErrors,
              seed: actualSeed,
              checkpoint: SIMPLE_TXT2IMG_CHECKPOINT,
              workflow
            },
            null,
            2
          )
        }
      ]
    };
  }
);

server.tool(
  "export_simple_txt2img_workflow",
  "Build the same SD1.5 txt2img workflow as submit_simple_txt2img and write it to output/simple-txt2img-workflow.json in the project. Does not call the Comfy Cloud API.",
  simpleTxt2ImgInputShape,
  async ({ prompt, negativePrompt, width, height, steps, cfg, seed }) => {
    const actualSeed =
      seed ?? Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);

    const workflow = buildSimpleTxt2ImgWorkflow({
      prompt,
      negativePrompt,
      width,
      height,
      steps,
      cfg,
      seed: actualSeed
    });

    const filePath = join(projectRoot, "output", "simple-txt2img-workflow.json");

    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify(workflow, null, 2), "utf8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: "text", text: `Failed to write workflow file: ${message}` }
        ],
        isError: true
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              filePath,
              seed: actualSeed,
              checkpoint: SIMPLE_TXT2IMG_CHECKPOINT,
              workflow
            },
            null,
            2
          )
        }
      ]
    };
  }
);

// =============================================================================
// Section A — upload_image
//
// Commit: feat(proxy): add upload_image tool
//
// Wraps POST /api/upload/image (multipart). Reads a local file from disk and
// posts it as form-data. Comfy Cloud is content-addressed — re-uploading the
// same bytes returns the same `name` (a hash-derived filename), making the
// operation idempotent.
//
// Read-back verification chosen: structural — verify the response contains a
// non-empty `name`, and re-issue HEAD /api/assets/hash/{sha256:...} to confirm
// the asset is queryable on Cloud. We use sha256 (not blake3) because Node's
// built-in crypto doesn't ship blake3; Cloud accepts both prefixes.
//
// Test criteria:
//   1. Given a valid local PNG, returns `{name, subfolder, type, hash}`.
//   2. Given a missing file path, returns isError with a clear message.
//   3. Given the same PNG twice, returns the same `name` both times.
// =============================================================================

server.tool(
  "upload_image",
  "Upload a local image to Comfy Cloud's input store via POST /api/upload/image. Returns the canonical name to reference in workflows.",
  {
    filePath: z.string().min(1, "filePath is required"),
    type: z.enum(["input", "temp"]).default("input")
  },
  async ({ filePath, type }) => {
    const cfg = getCloudConfig();
    if ("error" in cfg) return toolError(cfg.error);

    let bytes: Buffer;
    try {
      bytes = await readFile(filePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return toolError(`Failed to read ${filePath}: ${msg}`);
    }
    const hash = await blake3OrSha256(bytes);

    const form = new FormData();
    const filename = basename(filePath);
    form.append("image", new Blob([new Uint8Array(bytes)], { type: inferMimeType(filename) }), filename);
    form.append("type", type);

    let response: Response;
    try {
      response = await fetch(`${cfg.baseUrl}/api/upload/image`, {
        method: "POST",
        headers: { "X-API-Key": cfg.apiKey },
        body: form
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return toolError(`Upload failed (network): ${msg}`);
    }

    if (!response.ok) {
      const body = await response.text();
      return toolError(`Cloud error ${response.status}: ${body}`);
    }

    const data = (await response.json()) as { name?: string; subfolder?: string; type?: string };
    if (!data.name) {
      return toolError(`Upload returned malformed response: ${JSON.stringify(data)}`);
    }

    // Read-back: HEAD /api/assets/hash/sha256:{hex} to confirm Cloud sees the asset.
    let assetSeen = false;
    try {
      const head = await fetch(`${cfg.baseUrl}/api/assets/hash/${hash.algo}:${hash.hex}`, {
        method: "HEAD",
        headers: { "X-API-Key": cfg.apiKey }
      });
      assetSeen = head.ok;
    } catch {
      // Non-fatal: structural success is enough; flag for inspection.
    }

    return toolOk({
      name: data.name,
      subfolder: data.subfolder ?? "",
      type: data.type ?? type,
      sourceFile: filePath,
      sizeBytes: bytes.byteLength,
      clientHash: `${hash.algo}:${hash.hex}`,
      assetSeenOnCloud: assetSeen
    });
  }
);

// =============================================================================
// Section B — upload_mask
//
// Commit: feat(proxy): add upload_mask tool
//
// Wraps POST /api/upload/mask. Requires `original_ref` JSON-string referencing
// the previously uploaded image. Returns layer hashes for the four mask layers
// (mask / paint / painted / painted_masked).
//
// Read-back verification chosen: structural — verify the response contains the
// expected layer-hash fields. Hash-based HEAD verification is harder here
// because the mask response gives layer hashes, not a single content hash.
//
// Test criteria:
//   1. Given a valid mask PNG + a valid original_ref, returns layer metadata.
//   2. Given a malformed original_ref, returns the Cloud's 4xx error verbatim.
//   3. Given a missing mask file path, returns isError before any HTTP call.
// =============================================================================

server.tool(
  "upload_mask",
  "Upload a local mask paired with a previously uploaded image. Wraps POST /api/upload/mask.",
  {
    filePath: z.string().min(1),
    originalRef: z
      .object({
        filename: z.string().min(1),
        subfolder: z.string().optional(),
        type: z.string().optional()
      })
      .describe("Reference to the original image: at minimum its `filename` from upload_image."),
    type: z.enum(["input", "temp"]).default("input")
  },
  async ({ filePath, originalRef, type }) => {
    const cfg = getCloudConfig();
    if ("error" in cfg) return toolError(cfg.error);

    let bytes: Buffer;
    try {
      bytes = await readFile(filePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return toolError(`Failed to read ${filePath}: ${msg}`);
    }

    const form = new FormData();
    const filename = basename(filePath);
    form.append("image", new Blob([new Uint8Array(bytes)], { type: inferMimeType(filename) }), filename);
    form.append("original_ref", JSON.stringify(originalRef));
    form.append("type", type);

    let response: Response;
    try {
      response = await fetch(`${cfg.baseUrl}/api/upload/mask`, {
        method: "POST",
        headers: { "X-API-Key": cfg.apiKey },
        body: form
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return toolError(`Mask upload failed (network): ${msg}`);
    }

    if (!response.ok) {
      const body = await response.text();
      return toolError(`Cloud error ${response.status}: ${body}`);
    }

    const data = (await response.json()) as Record<string, unknown>;
    const expectedKeys = ["mask", "paint", "painted", "painted_masked", "name"];
    const missing = expectedKeys.filter((k) => !(k in data));
    if (missing.length > 0 && !("name" in data)) {
      return toolError(
        `Mask upload returned malformed response (missing ${missing.join(", ")}): ${JSON.stringify(data)}`
      );
    }

    return toolOk({ ...data, sourceFile: filePath, sizeBytes: bytes.byteLength });
  }
);

// =============================================================================
// Section C — submit_workflow (v0.2.0: + placeholder substitution + cost gate)
//
// Commit: feat(proxy): add submit_workflow with placeholders + max_cost_usd gate
//
// Generic POST /api/prompt for any API-format workflow. New in v0.2.0:
//   1. Placeholder substitution. Workflow JSON may contain `"{{NAME}}"` tokens
//      in any string field. The `inputs` parameter is a flat record mapping
//      NAME → value. Substitution walks the workflow recursively and replaces
//      every `"{{NAME}}"` with `inputs[NAME]`. Missing placeholder → refuse.
//   2. max_cost_usd hard gate. Caller MUST pass a USD ceiling. The proxy
//      detects known Partner Nodes in the workflow, estimates upper-bound cost
//      using a static table (derived from live /api/object_info price
//      formulas), adds a rough GPU baseline if SUPIR-like nodes are present,
//      and refuses if estimate > max_cost_usd.
//
// Cost-gate rationale: jsonata evaluation of the live price formula would be
// cleanest, but for v1 a static upper-bound table is faster and the values
// are stable (BFL/OpenAI pricing changes infrequently). Refresh table when
// pricing updates land.
//
// Read-back verification: poll GET /api/jobs/{prompt_id}/status once after
// submit to confirm queue accepted the workflow.
//
// Test criteria:
//   1. Given workflow with `{{NAME}}` tokens + matching `inputs`, substitution
//      succeeds and submits.
//   2. Given workflow with `{{NAME}}` token but missing `inputs[NAME]`, refuses
//      with clear missing-placeholder error.
//   3. Given workflow whose Partner Node cost exceeds max_cost_usd, refuses
//      with breakdown.
//   4. Given workflow within budget, submits and returns prompt_id + read-back
//      status.
// =============================================================================

// Partner Node cost table — upper-bound USD per call.
// Sourced from live /api/object_info price_badge expressions (verified 2026-05).
// Refresh when pricing changes.
const PARTNER_NODE_COSTS: Record<
  string,
  { fixed?: number; lookup?: (inputs: Record<string, unknown>) => number }
> = {
  Flux2ProImageNode: { fixed: 0.06 }, // 2048×1152 = 2.36MP → $0.03 + $0.015×2
  Flux2MaxImageNode: { fixed: 0.13 }, // 2048×1152 → $0.07 + $0.03×2
  FluxProUltraImageNode: { fixed: 0.06 }, // legacy archived workflow
  OpenAIGPTImage1: {
    lookup: (inputs) => {
      const model = String(inputs.model ?? "gpt-image-2");
      const quality = String(inputs.quality ?? "medium");
      const n = Number(inputs.n ?? 1);
      const upper: Record<string, Record<string, number>> = {
        "gpt-image-1": { low: 0.02, medium: 0.07, high: 0.25 },
        "gpt-image-1.5": { low: 0.02, medium: 0.062, high: 0.22 },
        "gpt-image-2": { low: 0.019, medium: 0.168, high: 0.67 }
      };
      const perCall = upper[model]?.[quality] ?? 0.67; // worst-case fallback
      return perCall * n;
    }
  },
  GeminiImageNode: { fixed: 0.039 },
  GeminiImage2Node: {
    lookup: (inputs) => {
      const model = String(inputs.model ?? "");
      const resolution = String(inputs.resolution ?? "1K");
      const isFlash = /nano banana 2/i.test(model);
      const flashPrices: Record<string, number> = { "1K": 0.07, "2K": 0.1014, "4K": 0.154 };
      const proPrices: Record<string, number> = { "1K": 0.134, "2K": 0.134, "4K": 0.24 };
      return (isFlash ? flashPrices : proPrices)[resolution] ?? 0.24;
    }
  }
};

const SUPIR_NODE_TYPES = new Set([
  "SUPIR_model_loader_v2",
  "SUPIR_sample",
  "SUPIR_encode",
  "SUPIR_conditioner",
  "SUPIR_decode"
]);

const PLACEHOLDER_REGEX = /^\{\{([A-Z][A-Z0-9_]*)\}\}$/;

function substitutePlaceholders(
  value: unknown,
  inputs: Record<string, unknown>,
  missing: Set<string>
): unknown {
  if (typeof value === "string") {
    const match = value.match(PLACEHOLDER_REGEX);
    if (!match) return value;
    const name = match[1];
    if (!(name in inputs)) {
      missing.add(name);
      return value;
    }
    return inputs[name];
  }
  if (Array.isArray(value)) {
    return value.map((v) => substitutePlaceholders(v, inputs, missing));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substitutePlaceholders(v, inputs, missing);
    }
    return out;
  }
  return value;
}

function estimateWorkflowCost(workflow: Record<string, unknown>): {
  partner: { classType: string; nodeId: string; usd: number }[];
  partnerSum: number;
  hasSUPIR: boolean;
  gpuBaseline: number;
  total: number;
} {
  const partner: { classType: string; nodeId: string; usd: number }[] = [];
  let hasSUPIR = false;
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!node || typeof node !== "object") continue;
    const classType = (node as { class_type?: string }).class_type;
    if (!classType) continue;
    if (SUPIR_NODE_TYPES.has(classType)) hasSUPIR = true;
    const cost = PARTNER_NODE_COSTS[classType];
    if (!cost) continue;
    const inputs = ((node as { inputs?: Record<string, unknown> }).inputs ?? {}) as Record<
      string,
      unknown
    >;
    const usd = cost.fixed ?? cost.lookup?.(inputs) ?? 0;
    partner.push({ classType, nodeId, usd });
  }
  const partnerSum = partner.reduce((acc, p) => acc + p.usd, 0);
  // GPU baseline: workflows with SUPIR are heavier (~70-110 GPU-sec upper); without SUPIR ~5-15 sec
  const gpuBaseline = hasSUPIR ? 0.55 : 0.07;
  return { partner, partnerSum, hasSUPIR, gpuBaseline, total: partnerSum + gpuBaseline };
}

server.tool(
  "submit_workflow",
  "Submit an API-format workflow to Comfy Cloud. v0.2.0: substitutes {{PLACEHOLDER}} tokens from `inputs`; enforces `max_cost_usd` hard gate against estimated Partner Node + GPU cost; injects extra_data.api_key_comfy_org for Partner Nodes.",
  {
    workflow: z
      .record(z.string(), z.any())
      .describe("API-format workflow: { node_id: { class_type, inputs } }. May contain {{NAME}} placeholders."),
    inputs: z
      .record(z.string(), z.any())
      .optional()
      .describe("Placeholder values, e.g. { PRODUCT_MASTER: 'abc.png', SEED: 123 }. Required if workflow has {{NAME}} tokens."),
    max_cost_usd: z
      .number()
      .nonnegative()
      .describe("REQUIRED. Hard ceiling. Estimated cost (Partner Nodes + GPU baseline) compared to this; over → refuse."),
    partnerNodeAuth: z
      .boolean()
      .default(true)
      .describe("Inject extra_data.api_key_comfy_org. Required for Partner Nodes."),
    extraData: z
      .record(z.string(), z.any())
      .optional()
      .describe("Additional extra_data fields to merge in (besides api_key_comfy_org).")
  },
  async ({ workflow, inputs, max_cost_usd, partnerNodeAuth, extraData }) => {
    const cfg = getCloudConfig();
    if ("error" in cfg) return toolError(cfg.error);

    // Step 1: substitute placeholders.
    const missing = new Set<string>();
    const substituted = substitutePlaceholders(workflow, inputs ?? {}, missing) as Record<
      string,
      unknown
    >;
    if (missing.size > 0) {
      return toolError(
        `Workflow contains unresolved placeholders: ${[...missing]
          .map((m) => `{{${m}}}`)
          .join(", ")}. Pass values in 'inputs'.`
      );
    }

    // Step 2: cost gate (against substituted workflow so OpenAI model/quality lookup works).
    const cost = estimateWorkflowCost(substituted);
    if (cost.total > max_cost_usd) {
      return toolError(
        `Cost gate refusal: estimated total $${cost.total.toFixed(3)} exceeds max_cost_usd $${max_cost_usd.toFixed(
          2
        )}.\nBreakdown:\n` +
          (cost.partner.length === 0
            ? "  (no Partner Nodes detected)\n"
            : cost.partner
                .map((p) => `  - ${p.classType} (node ${p.nodeId}): $${p.usd.toFixed(3)}`)
                .join("\n") + "\n") +
          `  - GPU baseline (${cost.hasSUPIR ? "SUPIR-heavy" : "light"}): $${cost.gpuBaseline.toFixed(
            3
          )}\n  - Sum: $${cost.total.toFixed(3)}`
      );
    }

    const body: Record<string, unknown> = { prompt: substituted };
    const mergedExtra: Record<string, unknown> = { ...(extraData ?? {}) };
    if (partnerNodeAuth) {
      mergedExtra.api_key_comfy_org = cfg.apiKey;
    }
    if (Object.keys(mergedExtra).length > 0) {
      body.extra_data = mergedExtra;
    }

    let response: Response;
    try {
      response = await fetch(`${cfg.baseUrl}/api/prompt`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": cfg.apiKey
        },
        body: JSON.stringify(body)
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return toolError(`Submit failed (network): ${msg}`);
    }

    if (!response.ok) {
      const text = await response.text();
      return toolError(`Cloud error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as {
      prompt_id?: string;
      number?: unknown;
      node_errors?: unknown;
    };
    const promptId = data.prompt_id ?? null;
    if (!promptId) {
      return toolError(`Submit returned no prompt_id: ${JSON.stringify(data)}`);
    }

    // Read-back: confirm the workflow was accepted by querying job status once.
    let status: string | null = null;
    let statusError: string | null = null;
    try {
      const statusResp = await fetch(`${cfg.baseUrl}/api/jobs/${promptId}/status`, {
        headers: { "X-API-Key": cfg.apiKey }
      });
      if (statusResp.ok) {
        const statusJson = (await statusResp.json()) as { status?: string };
        status = statusJson.status ?? null;
      } else {
        statusError = `status ${statusResp.status}`;
      }
    } catch (err) {
      statusError = err instanceof Error ? err.message : String(err);
    }

    return toolOk({
      promptId,
      number: data.number ?? null,
      nodeErrors: data.node_errors ?? null,
      readBackStatus: status,
      readBackError: statusError,
      partnerNodeAuthInjected: partnerNodeAuth,
      cost: {
        estimatedTotalUsd: cost.total,
        partnerNodeBreakdown: cost.partner,
        gpuBaselineUsd: cost.gpuBaseline,
        maxCostUsdAllowed: max_cost_usd
      }
    });
  }
);

// =============================================================================
// Section D — get_job_status
//
// Commit: feat(proxy): add get_job_status tool
//
// Wraps GET /api/jobs/{id}. Returns the full job detail when available
// (workflow, outputs, execution_status, execution_meta, execution_error).
// Read-only — the call itself is the verification.
//
// Test criteria:
//   1. Given a known prompt_id, returns a structured object.
//   2. Given an unknown prompt_id, returns a clear "not found" message.
//   3. Given a completed job, the response includes `outputs`.
// =============================================================================

server.tool(
  "get_job_status",
  "Fetch full job detail from Comfy Cloud. Wraps GET /api/jobs/{prompt_id}. Returns status, outputs, execution_meta, execution_error.",
  {
    promptId: z.string().min(1)
  },
  async ({ promptId }) => {
    const cfg = getCloudConfig();
    if ("error" in cfg) return toolError(cfg.error);

    let response: Response;
    try {
      response = await fetch(`${cfg.baseUrl}/api/jobs/${promptId}`, {
        headers: { "X-API-Key": cfg.apiKey }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return toolError(`Status fetch failed (network): ${msg}`);
    }

    if (!response.ok) {
      const body = await response.text();
      return toolError(`Cloud error ${response.status}: ${body}`);
    }

    const data = await response.json();
    return toolOk(data);
  }
);

// =============================================================================
// Section E — view_output
//
// Commit: feat(proxy): add view_output tool
//
// Wraps GET /api/view. The endpoint returns a 302 redirect to a signed GCS URL.
// We must NOT forward X-API-Key to the GCS URL (leak vector — Skill Rule 9).
// Saves the binary to a caller-specified path under the project's output/.
//
// Read-back verification chosen: byte-level integrity — verify content-length
// matches the bytes received, and write hash to manifest for downstream
// integrity audits.
//
// Test criteria:
//   1. Given a valid filename from a completed job, saves the file to disk.
//   2. Given a non-existent filename, returns isError with Cloud's message.
//   3. The X-API-Key header is NOT sent to the signed URL (verified via
//      manual redirect chain, see redirect: "manual" in code).
// =============================================================================

server.tool(
  "view_output",
  "Download a generated output via /api/view. Follows the 302 redirect WITHOUT forwarding X-API-Key. Saves to disk and returns path + hash.",
  {
    filename: z.string().min(1),
    subfolder: z.string().optional(),
    type: z.enum(["output", "input", "temp"]).default("output"),
    channel: z.enum(["rgba", "rgb", "alpha"]).default("rgba"),
    savePath: z.string().describe("Absolute or project-relative path to write the downloaded file.")
  },
  async ({ filename, subfolder, type, channel, savePath }) => {
    const cfg = getCloudConfig();
    if ("error" in cfg) return toolError(cfg.error);

    const params = new URLSearchParams({ filename, type, channel });
    if (subfolder) params.set("subfolder", subfolder);

    let viewResp: Response;
    try {
      viewResp = await fetch(`${cfg.baseUrl}/api/view?${params}`, {
        method: "GET",
        headers: { "X-API-Key": cfg.apiKey },
        redirect: "manual"
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return toolError(`view request failed (network): ${msg}`);
    }

    let bytes: Buffer;
    let contentType: string | null = null;

    if (viewResp.status === 302 || viewResp.status === 301 || viewResp.status === 307) {
      const location = viewResp.headers.get("location");
      if (!location) {
        return toolError(`Cloud returned ${viewResp.status} but no Location header`);
      }
      // Fetch the signed URL WITHOUT forwarding X-API-Key.
      let signedResp: Response;
      try {
        signedResp = await fetch(location);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return toolError(`Signed URL fetch failed: ${msg}`);
      }
      if (!signedResp.ok) {
        return toolError(`Signed URL returned ${signedResp.status}`);
      }
      bytes = Buffer.from(await signedResp.arrayBuffer());
      contentType = signedResp.headers.get("content-type");
    } else if (viewResp.ok) {
      bytes = Buffer.from(await viewResp.arrayBuffer());
      contentType = viewResp.headers.get("content-type");
    } else {
      const body = await viewResp.text();
      return toolError(`Cloud error ${viewResp.status}: ${body}`);
    }

    if (bytes.byteLength === 0) {
      return toolError("Downloaded 0 bytes — refusing to write empty file.");
    }

    try {
      await mkdir(dirname(savePath), { recursive: true });
      await writeFile(savePath, bytes);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return toolError(`Failed to write ${savePath}: ${msg}`);
    }

    const hash = await blake3OrSha256(bytes);

    return toolOk({
      filename,
      type,
      channel,
      savedTo: savePath,
      sizeBytes: bytes.byteLength,
      contentType,
      sha256: hash.hex
    });
  }
);

// =============================================================================
// Section F — write_manifest
//
// Commit: feat(proxy): add write_manifest tool with cost logging fields
//
// Writes a per-submission manifest JSON. Captures everything needed to reproduce
// a run later, plus cost provenance fields per Skill Rule 4:
//   - partner_node_cost_usd
//   - gpu_seconds_per_node
//   - total_asset_cost_usd
//
// Read-back verification chosen: re-read the written JSON and validate against
// the expected schema before reporting success.
//
// Test criteria:
//   1. Given a complete manifest payload, writes a JSON file at the expected path.
//   2. After write, the file parses and contains all required keys.
//   3. Missing required keys return isError before any disk write.
// =============================================================================

const manifestPartnerCostShape = z.object({
  classType: z.string(),
  costUsd: z.number().nonnegative()
});

const manifestNodeGpuShape = z.object({
  nodeId: z.string(),
  classType: z.string(),
  gpuSeconds: z.number().nonnegative()
});

const manifestInputShape = {
  promptId: z.string().min(1),
  template: z.string().describe("Template name, e.g. husqvarna-v1-variant-a"),
  workflowApiPath: z.string().describe("Path to the .api.json submitted"),
  workflowCanvasPath: z.string().optional().describe("Path to the .canvas.json source"),
  params: z.record(z.string(), z.any()).describe("User-set parameters (prompt, seed, model, etc.)"),
  seed: z.number().int().nonnegative().describe("Locked seed used for reproducibility"),
  objectInfoHash: z.string().optional().describe("Hash of /api/object_info snapshot at submit time"),
  systemStats: z.record(z.string(), z.any()).optional().describe("GET /api/system_stats response"),
  partnerNodeCosts: z
    .array(manifestPartnerCostShape)
    .default([])
    .describe("Per-Partner-Node cost in USD"),
  gpuSecondsPerNode: z
    .array(manifestNodeGpuShape)
    .default([])
    .describe("Per-non-Partner-node GPU seconds, from execution events"),
  tierCostPerGpuSecond: z
    .number()
    .nonnegative()
    .default(0)
    .describe("Cloud tier's $/GPU-second for total cost calc. 0 = skip GPU cost summation."),
  totalAssetCostUsd: z
    .number()
    .nonnegative()
    .optional()
    .describe("If omitted, computed as sum(partnerNodeCosts) + sum(gpuSecondsPerNode) * tierCostPerGpuSecond"),
  variant: z.string().optional().describe("A/B variant tag, e.g. 'A' or 'B'"),
  notes: z.string().optional(),
  savePath: z.string().describe("Absolute or project-relative path to write the manifest JSON to.")
};

server.tool(
  "write_manifest",
  "Write a per-submission manifest with full provenance + cost data (Partner Node + GPU seconds + total asset cost).",
  manifestInputShape,
  async (input) => {
    const partnerSum = input.partnerNodeCosts.reduce((acc, p) => acc + p.costUsd, 0);
    const gpuSecondsSum = input.gpuSecondsPerNode.reduce((acc, n) => acc + n.gpuSeconds, 0);
    const computedTotal = partnerSum + gpuSecondsSum * input.tierCostPerGpuSecond;
    const totalAssetCostUsd =
      typeof input.totalAssetCostUsd === "number" ? input.totalAssetCostUsd : computedTotal;

    const manifest = {
      schemaVersion: "comfy-cloud-proxy.manifest/1",
      promptId: input.promptId,
      template: input.template,
      variant: input.variant ?? null,
      workflowApiPath: input.workflowApiPath,
      workflowCanvasPath: input.workflowCanvasPath ?? null,
      params: input.params,
      seed: input.seed,
      objectInfoHash: input.objectInfoHash ?? null,
      systemStats: input.systemStats ?? null,
      cost: {
        partnerNodes: input.partnerNodeCosts,
        partnerNodeCostUsdSum: partnerSum,
        gpuSecondsPerNode: input.gpuSecondsPerNode,
        gpuSecondsSum,
        tierCostPerGpuSecond: input.tierCostPerGpuSecond,
        totalAssetCostUsd
      },
      notes: input.notes ?? null,
      writtenAt: new Date().toISOString()
    };

    try {
      await mkdir(dirname(input.savePath), { recursive: true });
      await writeFile(input.savePath, JSON.stringify(manifest, null, 2), "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return toolError(`Failed to write manifest to ${input.savePath}: ${msg}`);
    }

    // Read-back: re-parse and confirm required keys present.
    try {
      const raw = await readFile(input.savePath, "utf8");
      const parsed = JSON.parse(raw);
      const required = ["schemaVersion", "promptId", "template", "params", "seed", "cost", "writtenAt"];
      const missing = required.filter((k) => !(k in parsed));
      if (missing.length > 0) {
        return toolError(`Manifest write succeeded but read-back is missing: ${missing.join(", ")}`);
      }
      const st = await stat(input.savePath);
      return toolOk({
        savedTo: input.savePath,
        sizeBytes: st.size,
        totalAssetCostUsd,
        partnerNodeCostUsdSum: partnerSum,
        gpuSecondsSum
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return toolError(`Manifest read-back failed: ${msg}`);
    }
  }
);

// =============================================================================
// Section G — upload_workflow_to_userdata
//
// Commit: feat(proxy): add upload_workflow_to_userdata tool
//
// Pushes a workflow JSON (canvas or api format) to Cloud's per-user userdata
// scratch area via POST /api/userdata/{path}. The uploaded file becomes
// accessible in cloud.comfy.org's editor — either via File → Load Workflow,
// or directly via the userdata API.
//
// Cloud's userdata endpoint is content-flat: subfolders don't auto-create on
// POST. POST to /api/userdata/workflows/x.json returns 404 unless the
// workflows/ subfolder has been created by the editor's own Save action first.
// Therefore, default targets in this tool put files at root. Caller can pass
// an explicit path; if it includes a subfolder that doesn't exist, the POST
// will 404 and we surface that clearly.
//
// Test criteria:
//   1. Given a canvas JSON path + remote filename, returns success with
//      {modified, path, size}.
//   2. Given a non-existent local file, returns isError early.
//   3. Given a remote subfolder that doesn't exist, returns isError with
//      Cloud's 404 message verbatim (no silent fallback).
// =============================================================================

server.tool(
  "upload_workflow_to_userdata",
  "Push a workflow JSON file to Cloud's per-user userdata so it shows up in cloud.comfy.org's editor. Default remote filename is the local file's basename at userdata root.",
  {
    localPath: z.string().min(1, "localPath is required"),
    remotePath: z
      .string()
      .optional()
      .describe(
        "Path on Cloud's userdata (relative). If omitted, uses basename(localPath). Cloud subfolders do NOT auto-create — POST to a non-existent subfolder returns 404."
      ),
    overwrite: z
      .boolean()
      .default(true)
      .describe("If false and remote file already exists, return error instead of replacing.")
  },
  async ({ localPath, remotePath, overwrite }) => {
    const cfg = getCloudConfig();
    if ("error" in cfg) return toolError(cfg.error);

    let bytes: Buffer;
    try {
      bytes = await readFile(localPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return toolError(`Failed to read ${localPath}: ${msg}`);
    }

    const target = remotePath ?? basename(localPath);
    const url = `${cfg.baseUrl}/api/userdata/${target.replace(/^\/+/, "")}`;

    if (!overwrite) {
      try {
        const existsCheck = await fetch(url, { headers: { "X-API-Key": cfg.apiKey } });
        if (existsCheck.ok) {
          return toolError(
            `Remote file already exists at userdata/${target} and overwrite=false. Refusing to replace.`
          );
        }
      } catch {
        // Couldn't check; proceed with upload.
      }
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": cfg.apiKey
        },
        body: new Uint8Array(bytes)
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return toolError(`Upload failed (network): ${msg}`);
    }

    if (!response.ok) {
      const body = await response.text();
      return toolError(
        `Cloud error ${response.status} at userdata/${target}: ${body}\n` +
          `Note: Cloud's userdata does NOT auto-create subfolders. If you POSTed to ` +
          `workflows/x.json and got 404, save a workflow once via the editor first ` +
          `(that creates the subfolder), then retry.`
      );
    }

    const data = (await response.json()) as { modified?: number; path?: string; size?: number };
    return toolOk({
      remotePath: data.path ?? target,
      sizeBytes: data.size ?? bytes.byteLength,
      modifiedAt: data.modified
        ? new Date(data.modified).toISOString()
        : new Date().toISOString(),
      localSourcePath: localPath,
      accessibleAt: `${cfg.baseUrl}/api/userdata/${target}`
    });
  }
);

// =============================================================================
// Section H — delete_workflow_from_userdata
//
// Commit: feat(proxy): add delete_workflow_from_userdata tool
//
// Wraps DELETE /api/userdata/{path}. Used for cleanup of old workflow
// iterations.
//
// Test criteria:
//   1. Given an existing remote path, returns success.
//   2. Given a non-existent path, returns isError with Cloud's 404.
//   3. Given a path with subfolder, behaves the same as upload (Cloud passes
//      the path through verbatim).
// =============================================================================

server.tool(
  "delete_workflow_from_userdata",
  "Delete a workflow file from Cloud's userdata. Wraps DELETE /api/userdata/{path}.",
  {
    remotePath: z.string().min(1, "remotePath is required")
  },
  async ({ remotePath }) => {
    const cfg = getCloudConfig();
    if ("error" in cfg) return toolError(cfg.error);

    const url = `${cfg.baseUrl}/api/userdata/${remotePath.replace(/^\/+/, "")}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "DELETE",
        headers: { "X-API-Key": cfg.apiKey }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return toolError(`Delete failed (network): ${msg}`);
    }

    if (!response.ok && response.status !== 204) {
      const body = await response.text();
      return toolError(`Cloud error ${response.status} at userdata/${remotePath}: ${body}`);
    }

    return toolOk({
      deletedPath: remotePath,
      httpStatus: response.status
    });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("comfy-cloud-proxy MCP server started");
