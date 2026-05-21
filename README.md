# comfy-cloud-proxy

A bridge that lets an AI assistant — Claude, Cursor, your in-house agent — actually *make* images on [Comfy Cloud](https://cloud.comfy.org), instead of just talking about them.

Ask in plain language, get a generated image (and the workflow that made it) back. No tab-switching, no copying parameters between tools, no "can you also generate the negative-space variation."

## What it changes for you

The default loop today is: brief the model → copy the prompt into Comfy → click around → paste the result back. Each handoff is a place where ideas die.

With this proxy in the loop, the assistant becomes the operator. You stay in the conversation; it submits the workflow, hands you the output, and is ready for the next iteration before you've finished describing it.

A few examples of what that looks like:

- *"Give me ten variations of this hero shot with different lighting moods."* → ten prompts get queued, you get back a sheet.
- *"Same composition, but warmer, and bump steps to 30."* → parameter tweak without leaving the chat.
- *"Generate the storyboard frames for scene 4, beat by beat, same seed for continuity."* → frames land in your output folder.

The workflows are also exported as portable JSON, so anything the assistant produces can be opened, fine-tuned, or version-controlled like any other asset.

## Why this matters

### For Valtech Radon

Radon already operates in "AI as a creative collaborator" territory. This makes the collaboration concrete:

- **Prompt-to-pixel without context-switching.** A copywriter or art director iterating with an assistant can ask for variations directly and keep working — the model produces the artefact instead of producing instructions for a human to produce the artefact.
- **A house workflow becomes a capability.** Every saved Comfy workflow — LoRA stacks, ControlNet rigs, brand-trained models — can be exposed as something the assistant *can do*, not something it can describe. Once a workflow is a capability, every team and every assistant inherits it.
- **Provenance you can show a client.** Every generation is a structured request with a recoverable parameter set. When a client asks "how was this made," there is an answer.

### For video editors

Editors lose hours to "I need 60 background plates, slightly different" or "make me 12 title-card alternatives." Those errands stop being errands:

- **Batched variations on demand.** Ask for N variants across seeds, prompts, or styles, and walk away. Review the contact sheet when it's ready.
- **Storyboard and previs before the shoot.** Frame-per-beat generation from a script, with consistent seeds for shot continuity.
- **Look-dev iteration at conversation speed.** Diff cfg / steps / sampler combinations without re-clicking the canvas.

When the assistant gets 90% of the way there, the exported workflow JSON drops straight into the Comfy Cloud UI for the last 10% of manual polish.

### For large asset productions

This is where the value compounds. Generation becomes one step in a longer chain — and now the chain is something an agent can run end-to-end:

- **Pipeline orchestration.** Briefing → prompt expansion → generation → QA pass → DAM upload, each step a capability the agent calls in order. No fragile glue scripts; no humans babysitting the queue.
- **Workflow as a versioned artefact.** Each campaign's workflows live alongside the rest of the project, reviewable in a PR, reproducible six months later. "Which version of the canvas did we ship that campaign with" becomes a `git log`.
- **A registry of capabilities.** Add a new workflow — product shot, logo animation, 4K upscale — and the assistant picks the right one for the brief without anyone teaching it node graphs.
- **One place to control cost and capacity.** Rate-limit, cache, route to different Comfy endpoints, or swap cloud for self-hosted — without touching the clients that depend on it.

## Status

Early stage. One canonical workflow shipped, more on the way. Reach out if there is a workflow you'd want exposed as a capability for your team.
