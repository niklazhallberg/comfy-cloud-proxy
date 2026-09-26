import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateWorkflowCost, substitutePlaceholders } from "../src/workflow.js";

test("substitutes {{NAME}} tokens anywhere in the graph", () => {
  const missing = new Set<string>();
  const out = substitutePlaceholders(
    { "1": { class_type: "KSampler", inputs: { seed: "{{SEED}}", list: ["{{PROMPT}}"] } } },
    { SEED: 42, PROMPT: "a red chair" },
    missing
  );
  assert.deepEqual(out, { "1": { class_type: "KSampler", inputs: { seed: 42, list: ["a red chair"] } } });
  assert.equal(missing.size, 0);
});

test("reports unresolved placeholders instead of submitting them", () => {
  const missing = new Set<string>();
  substitutePlaceholders({ "1": { inputs: { image: "{{PRODUCT_MASTER}}" } } }, {}, missing);
  assert.deepEqual([...missing], ["PRODUCT_MASTER"]);
});

test("leaves strings that merely contain braces untouched", () => {
  const missing = new Set<string>();
  const out = substitutePlaceholders({ text: "use {{SEED}} here" }, {}, missing);
  assert.deepEqual(out, { text: "use {{SEED}} here" });
  assert.equal(missing.size, 0);
});

test("a local-only graph costs only the light GPU baseline", () => {
  const cost = estimateWorkflowCost({ "3": { class_type: "KSampler", inputs: {} } });
  assert.equal(cost.partner.length, 0);
  assert.equal(cost.total, cost.gpuBaseline);
  assert.equal(cost.hasSUPIR, false);
});

test("Partner Nodes and SUPIR raise the estimate", () => {
  const cost = estimateWorkflowCost({
    "1": { class_type: "Flux2MaxImageNode", inputs: {} },
    "2": { class_type: "OpenAIGPTImage1", inputs: { model: "gpt-image-1", quality: "high", n: 2 } },
    "3": { class_type: "SUPIR_sample", inputs: {} }
  });
  assert.equal(cost.partner.length, 2);
  assert.ok(Math.abs(cost.partnerSum - (0.13 + 0.25 * 2)) < 1e-9);
  assert.equal(cost.hasSUPIR, true);
  assert.ok(cost.total > cost.partnerSum);
});

test("unknown OpenAI model/quality falls back to the worst-case price", () => {
  const cost = estimateWorkflowCost({
    "1": { class_type: "OpenAIGPTImage1", inputs: { model: "future-model", quality: "ultra" } }
  });
  assert.equal(cost.partnerSum, 0.67);
});
