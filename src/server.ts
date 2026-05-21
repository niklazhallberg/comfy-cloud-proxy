import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "comfy-cloud-proxy",
  version: "0.0.3"
});

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

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("comfy-cloud-proxy MCP server started");
