# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).

## [0.3.0] — 2026-09-26

### Added
- `dry_run` option on `submit_workflow` (or `COMFY_DRY_RUN=true`): resolves placeholders and runs the cost gate, returns the final workflow and cost estimate, and submits nothing. Works without an API key.
- Unit tests for placeholder substitution and cost estimation (`npm test`).
- GitHub Actions CI: typecheck, test, build.
- `.env.example`, `LICENSE` (MIT), this changelog.

### Changed
- Placeholder and cost logic moved from `src/server.ts` to `src/workflow.ts` (pure, I/O-free).
- `.mcp.json` uses a project-relative Playwright profile path instead of an absolute one.

## [0.2.1] — 2026-05-25

### Added
- `upload_workflow_to_userdata` / `delete_workflow_from_userdata`: push a workflow JSON to the user's Comfy Cloud editor.

## [0.2.0] — 2026-05-22

### Added
- `submit_workflow` for any API-format graph, with `{{PLACEHOLDER}}` substitution and a mandatory `max_cost_usd` gate.
- `upload_image`, `upload_mask`, `get_job_status`, `view_output`, `write_manifest`.

## [0.1.0] — 2026-05-21

### Added
- First working MCP server: `ping`, `get_object_info`, `submit_simple_txt2img`, `export_simple_txt2img_workflow`.
