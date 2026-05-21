# comfy-cloud-proxy

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that exposes [Comfy Cloud](https://cloud.comfy.org) as a set of tools an AI assistant (Claude, ChatGPT desktop, Cursor, etc.) can call directly.

It turns "generate an image with these parameters" into a tool call instead of a manual UI session — which means an LLM, an agent, or a CI job can drive image generation the same way it drives the rest of your stack.

## What it does

The server speaks MCP over stdio and exposes four tools:

| Tool | Purpose |
| --- | --- |
| `ping` | Connectivity check. Returns `pong`. |
| `get_object_info` | Fetches the node schema from Comfy Cloud. With `nodeName` it returns the full schema for one node; without it returns a summary of all available nodes. Useful for discovering what samplers, loaders, and upscalers are installed. |
| `submit_simple_txt2img` | Submits a minimal SD1.5 text-to-image workflow (`CheckpointLoaderSimple` → `CLIPTextEncode` × 2 → `KSampler` → `VAEDecode` → `SaveImage`) and returns the `prompt_id`. Non-blocking — does not poll. |
| `export_simple_txt2img_workflow` | Builds the same workflow as `submit_simple_txt2img` and writes it to `output/simple-txt2img-workflow.json` without calling the API. Handy for inspecting or hand-editing the graph. |

All workflows are plain ComfyUI **API-format JSON** — the same shape Comfy Cloud accepts at `/api/prompt`. That makes the tool output a portable artifact: you can paste the JSON into the Comfy Cloud canvas, version it in git, or feed it into another pipeline.

## How it works

```
┌──────────────┐  stdio   ┌─────────────────────┐  HTTPS   ┌──────────────┐
│  AI client   │ ───────▶ │  comfy-cloud-proxy  │ ───────▶ │  Comfy Cloud │
│ (Claude etc.)│ ◀─────── │     (this repo)     │ ◀─────── │   /api/...   │
└──────────────┘          └─────────────────────┘          └──────────────┘
```

- Built on `@modelcontextprotocol/sdk` with Zod-validated inputs.
- One file (`src/server.ts`), zero state, started with `npm run dev` (tsx) or `npm run build && npm start`.
- Authenticates to Comfy Cloud with an `X-API-Key` header from `COMFY_CLOUD_API_KEY`.

## Setup

1. `npm install`
2. Create `.env`:
   ```
   COMFY_CLOUD_API_KEY=your-key-here
   COMFY_CLOUD_BASE_URL=https://cloud.comfy.org   # optional override
   ```
3. Register the server with your MCP-capable client. For Claude Code, drop a `.mcp.json` like:
   ```json
   {
     "mcpServers": {
       "comfy-cloud-proxy": {
         "command": "npm",
         "args": ["run", "dev"],
         "cwd": "/absolute/path/to/comfy-cloud-proxy"
       }
     }
   }
   ```

## Why this matters

### For Valtech Radon

Radon already lives in the territory of "AI in production creative work." The proxy gives the team a thin, auditable layer between an LLM assistant and Comfy Cloud, which unlocks three things:

- **Prompt-to-pixel without context-switching.** A copywriter or art director iterating with Claude can ask for variations directly, get the `prompt_id`, and keep working — the model invokes the tool instead of the human switching tabs.
- **A house workflow becomes a tool.** `submit_simple_txt2img` is the example, but the same pattern wraps any saved workflow (LoRA stacks, ControlNet rigs, brand-trained models). Once a workflow is "a tool," it can be reused by every assistant, agent, or script across the agency.
- **Auditable generation.** Every call goes through the proxy, so it is a natural place to add logging, cost capture, content policy, or watermarking — useful for client-facing AI work where provenance matters.

### For video editors

Editors lose hours to "I need 60 background plates, slightly different" or "make me 12 alternative title cards." The proxy turns those errands into a single instruction:

- **Batched variations on demand.** An agent can call `submit_simple_txt2img` N times with seed/prompt sweeps and hand back the file list — no human in the loop until review.
- **Storyboard / previs scaffolding.** Generate a frame-per-beat from a script before anything is shot, with consistent seeds for shot continuity.
- **Look-dev iteration.** Same workflow, parameterised — quickly diff cfg/steps/sampler choices without re-clicking the canvas.

The `export_simple_txt2img_workflow` tool also gives editors a portable JSON they can drop into the Comfy Cloud UI for manual fine-tuning when the agent gets 90% of the way there.

### For large asset production pipelines

This is where MCP starts to earn its keep. The proxy is one node in a graph; once Comfy Cloud is a tool, you can compose it:

- **Pipeline orchestration.** Slot generation between briefing (LLM expands brief → prompt list), generation (`submit_simple_txt2img`), QA (vision model rates outputs), and delivery (DAM upload). Each step is a tool call; an agent chains them.
- **Workflow as code.** API-format JSON committed alongside the proxy means workflows are versioned, reviewable, and reproducible. No more "which version of the canvas did we ship that campaign with?"
- **Multi-workflow registry.** Add new tools (`submit_product_shot`, `submit_logo_animation`, `submit_upscale_4k`) and an agent picks the right one based on the brief — without anyone teaching it Comfy's node graph.
- **Cost and capacity control.** Because every prompt funnels through one process, you can rate-limit, cache, or route to different Comfy endpoints (cloud vs. self-hosted) without touching the clients that depend on it.

## Status

This is an early proxy: one canonical workflow (SD1.5 txt2img), no polling, no asset retrieval. Expanding it means adding more `server.tool(...)` blocks — typically a `buildXxxWorkflow()` helper plus an input schema. PRs and forks welcome.

## License

Not yet specified — internal/private use.
