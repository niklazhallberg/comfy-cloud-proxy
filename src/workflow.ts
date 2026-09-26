// Pure workflow logic used by submit_workflow: placeholder substitution and
// the max_cost_usd cost estimate. Kept free of I/O so it can be unit-tested.

// Partner Node cost table — upper-bound USD per call.
// Sourced from live /api/object_info price_badge expressions (verified 2026-05).
// Refresh when pricing changes.
export const PARTNER_NODE_COSTS: Record<
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

export const SUPIR_NODE_TYPES = new Set([
  "SUPIR_model_loader_v2",
  "SUPIR_sample",
  "SUPIR_encode",
  "SUPIR_conditioner",
  "SUPIR_decode"
]);

export const PLACEHOLDER_REGEX = /^\{\{([A-Z][A-Z0-9_]*)\}\}$/;

export function substitutePlaceholders(
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

export function estimateWorkflowCost(workflow: Record<string, unknown>): {
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
