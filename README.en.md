# Godot MCP Enhanced

> Free · Open Source · Secure — a rare open-source MCP server for Godot offering **systematic security protections + a three-tier architecture + runtime control**.

An MCP server that gives AI (Claude Code, Cursor, and other MCP clients) a tool layer to truly **read, write, run, and verify** Godot projects: 46 MCP tools (merged, with 240+ actions; full list in [capability-matrix](docs/capability-matrix.md)) covering scenes / scripts / UI / animation / physics / particles / navigation / audio / testing / export, a three-tier architecture (headless + editor + game bridge) + path allowlist / injection defense / sandbox security.
While competitors bet on **authoring** (generation), this project bets on **verification** — QA orchestration, regression diffs, an operation audit log, and deterministic playtesting together form a **continuous verification pipeline for AI-assisted game development** (CI for AI game dev).

> **Tool descriptions are in Chinese** (serving the Chinese Godot developer community; i18n PRs welcome). This English README covers positioning, comparison, security, and setup; for the full per-action tool list see the [Chinese README](README.md) and [capability-matrix](docs/capability-matrix.md).

**[中文文档](README.md)**

## Beginner Path: Make a Game Without Opening the Godot Editor

New to game engines? After installing [Godot](https://godotengine.org/download), describe your idea to the AI in one sentence ("make a 2048 clone", "add a double jump to my character") — reading, writing, running, and verification are all done by the AI through this tool, **without ever opening the Godot editor**:

1. **Say what you want** — the AI scaffolds the project (`create_project`) and writes scenes & scripts (`quick_scene` / `write_script`);
2. **See it run** — `run_and_verify` actually runs the game with structured error analysis; `screenshot` (action `capture`) shows you what it looks like;
3. **Iterate** — every `edit_script` change goes through `validate_scripts` full compilation; you just give feedback;
4. **Accept** — `qa` runs a structured suite against the *real running game* (`playtest.seed` locks RNG: same input → reproducible); `verify_delivery` gates delivery (scene-tree integrity + script health + performance);
5. **Mistakes are cheap** — editor-tier writes all register into Godot's native undo stack: one **Ctrl+Z** reverts any AI mistake.

**No Godot installed yet?** One command auto-installs it (official GitHub releases, same-source SHA512 verification, zero prerequisites):

```bash
npx godot-mcp-enhanced install        # latest stable by default; or pin a tag like 4.7.2-stable
```

It installs into `~/.godot-mcp/godot/<version>/` and registers the binary into the search chain and the path allowlist; `setup` also offers interactive installation when no Godot is detected.

**Generate a playable game directly?** Built-in templates (four-piece set: playable demo + GDD + deterministic qa suite + CSV tuning table):

```bash
npx godot-mcp-enhanced init my-game --template=2048    # or snake / breakout
cd my-game
npx godot-mcp-enhanced qa run qa/2048.qa.md --project .   # real-run deterministic assertions
```

Zero external assets (procedural placeholder art), runs without ever opening the editor; retune by editing `tuning/*.csv` → re-export via `csv_to_resources` → restart; `design/gdd/` ships an 8-section game design document (passes `validate_gdd`) for the AI to iterate on.

**Record gameplay into a demo GIF with one command** (share it anywhere):

```bash
npx godot-mcp-enhanced gif . --seconds 8 --fps 4              # arrow keys by default; breakout: --keys left,right
```

Bridge-driven fixed-rate screenshots + key timeline injection, with a zero-dependency hand-written GIF89a encoder (exact palette ≤256 colors / median-cut quantization); output defaults to `dist/demo.gif` inside the project; paths outside the project require y/N confirmation.

**Export to the web and play in the browser**:

```bash
npx godot-mcp-enhanced web .            # auto-installs export templates (~1GB first time) → exports → serves locally
```

Headless `--export-release` (official path) + a `127.0.0.1` path-traversal-proof static server; prints `http://127.0.0.1:<port>/` to play; `web --serve-only <dir>` replays an existing export.

Using the [Claude Code Game Studios](https://github.com/Donchitos/Claude-Code-Game-Studios) template? See the **[CCGS integration guide](docs/guides/ccgs-integration.md)** (Chinese) — CCGS owns the design workflow, this project owns real runtime verification.

**Not sure where to start?** The `game-wizard` skill: four-track triage (no idea / vague / clear / existing project) → stage machine (env → create → tweak → **hard qa gate** → export → share), every gate decided by the qa exit code — "don't ask if the doc is written, ask if the game runs":

```bash
npx godot-mcp-enhanced skills install    # installs game-wizard (plus 6 more skills); then tell the AI "make me a playable game"
```

> **Roadmap**: the six-batch one-stop journey (distribution / install / templates / GIF / Web / wizard) has fully landed; future directions in [ROADMAP](ROADMAP.md).

## Comparison

> **This project does not chase "the most tools".** In the ecosystem, godot-mcp-pro has 175 tools but is closed-source at $15; the free Coding-Solo has only 13. What's genuinely scarce is not tool count, but the combination of **free + open source + systematic security** — the security dimension is almost unaddressed across the field.
> Data as of 2026-06-27 (stars / tool counts / pricing may change; see each project's repo).

| Dimension | **This project** | godot-mcp-pro | GDAI MCP | Coding-Solo/godot-mcp | yanhuifair/Godot-MCP [^p4] |
|---|:---:|:---:|:---:|:---:|:---:|
| Price | **Free** | $15 one-time [^p1] | $19 one-time [^p2] | Free [^p3] | Free [^p4] |
| Open Source | **✅ MIT** | ❌ server precompiled/closed [^p1] | ❌ [^p2] | ✅ [^p3] | ✅ [^p4] |
| Tools | **46** ([matrix](docs/capability-matrix.md)) | 175 [^p1] | ~30 [^p1] | 13 [^p1] | 386 [^p4] |
| Security features | **✅ path allowlist / injection defense / sandbox / confirm tokens / output anti-forgery** | — | — | — | Partial (TCP token) [^p4] |
| Architecture | **three-tier: headless + editor + bridge** | single editor WS [^p1] | stdio [^p1] | headless CLI [^p1] | TS server + editor plugin over TCP [^p4] |
| **Runtime control (engine-level)** | **✅ game bridge: live state / input simulation / record-replay / frame-verify** | ❌ file & editor only | ❌ | ❌ | ✅ 11 runtime tools [^p4] |
| **Deterministic playtest (freeze / frame-stepping / RNG lock)** | **✅ freeze / step_until with structured conditions / `playtest.seed` RNG lock + fixed_delta / snapshot-restore** | — | — | — | ✅ freeze→step→screenshot (no RNG lock / conditional stepping) [^p4][^p5] |
| Godot 4.5–4.7 compat matrix | **✅** | — | — | — | — (4.x only) [^p4] |
| Chinese tool descriptions | **✅** | — | — | ❌ | ❌ |

[^p1]: https://github.com/youichi-uda/godot-mcp-pro README (includes its own comparison table), fetched 2026-06-27
[^p2]: GDAI MCP, quoted from godot-mcp-pro's comparison table, 2026-06-27
[^p3]: https://github.com/Coding-Solo/godot-mcp, fetched 2026-06-27
[^p4]: https://github.com/yanhuifair/Godot-MCP, fetched 2026-08-19 (tool count 386 verified via `grep -c "registry.register(" src/tools/register.ts`)
[^p5]: That README claims "freeze/step/screenshot — **No other public Godot MCP does this**", which is inaccurate: this project's `playtest.freeze` / `step_until` (structured conditional stepping) and [satelliteoflove/godot-mcp](https://github.com/satelliteoflove/godot-mcp)'s deterministic playtesting (since 2025-12) both predate the claim — readers are invited to verify.

_"—" means the project's public README does not disclose the capability; not necessarily absent. PRs welcome._

> **Not just a file-level bridge — engine-level runtime control.**
> Most solutions in the field (including closed-source commercial SaaS) only let AI read/write project files — they **can't see or control a running game**.
> This project's Game Bridge connects to a live game over TCP: read live node trees & properties, GPU viewport screenshots, property sampling, signal watching, input simulation, record-replay, plus `frame-verify` anti-cheat — closing the loop **change → run → verify**, not just editing files.

> **"Determinism" levels: frame stepping ≠ true determinism.** The word "deterministic" is being stretched in this field (one project labels freeze / fixed-frame stepping as "Deterministic" — with no RNG seeding, the same input on different random states is still not reproducible). Deterministic testing actually has three levels:
>
> | Level | Capability | Meaning |
> |---|---|---|
> | **L1 frame stepping** | freeze / fixed-frame step / screenshot | "pause and inspect frame by frame" |
> | **L2 input timeline** | frame-timed input timeline (`send_input_sequence`) | locks "what the player did on frame N" |
> | **L3 true determinism** | `playtest.seed` RNG lock + `fixed_delta` physics step lock + `step_until` conditional stepping + `snapshot/restore` | same input + same seed ⇒ **reproducible across runs** |
>
> This project implements all three. As of 2026-08-20, known competitors reach at most L1 (freeze/fixed-frame step, no RNG lock) or L2 (frame-timed input, no pause, no seed). Reproducible "AI testing AI-written games" requires at least L3.

> **Upgrading from [Coding-Solo/godot-mcp](https://github.com/Coding-Solo/godot-mcp)?** See the **[migration guide](docs/migration-from-coding-solo.md)** — zero capability loss; gain three-tier architecture / security / verification gates / cross-version matrix.

## Security

As of 2026-06-28, systematic security features are rare among Godot MCP solutions. This project ships multiple defense layers, suitable for scenarios that require a trusted boundary:

- **Path access control** — `ALLOWED_PROJECT_PATHS` allowlist (deny-by-default), with junction / symlink bypass defense
- **GDScript injection defense** — dangerous-API pattern scanning + string-concatenation bypass detection
- **Confirm tokens for dangerous ops** — node deletion etc. require explicit confirmation
- **Output anti-forgery** — random per-execution marker prevents GDScript from forging MCP output
- **Local-only** — no remote exposure, no third-party data upload (note: update-checker queries npm registry on startup, see "Anonymous Telemetry" below)

<details>
<summary><b>⚠️ Honest boundaries (read before relying on this)</b></summary>

The above is a **mistake-prevention layer**, not an unbreakable security boundary. GDScript has full system access; the sandbox can be bypassed indirectly (`call()` dynamic dispatch, multi-step variable construction of API names, etc.).

- For real isolation: container / VM + `GODOT_MCP_ALLOW_UNSAFE=false`
- Disable scanning: `GODOT_MCP_SANDBOX=disabled` (development only)
- This tool is **for local trusted environments only**; no remote attestation or encryption.

</details>

## Anonymous Telemetry (off by default)

**Opt-in, zero egress by default.** Only enabled when `GODOT_MCP_TELEMETRY=true` is set explicitly; Stage 0 endpoint defaults to empty = **no data leaves the process**.

- **What we collect**: tool name + success bool + duration_ms + error category (whitelist-sanitized, not raw text) + salted sha256 project hash (irreversible)
- **Never collected**: source code / scene content / file paths / project names / editor logs / email, IP, account
- **Install UUID lives at**: `~/.godot-mcp/telemetry-uuid.txt` (POSIX 0o600)
- **CI forced off**: `CI=true` ignores the opt-in even if set

> **⚠️ Honest disclosure — update-checker egress**: every MCP server startup passively fetches `https://registry.npmjs.org/godot-mcp-enhanced/latest` via `fetch(REGISTRY_URL)` in `src/core/update-checker.ts` (24h cache). This is unrelated to telemetry but does send data off-host. **As of v0.25.7, set `GODOT_MCP_UPDATE_CHECK=false` (or `0`/`no`/`off`, case-insensitive) to disable this startup egress**; the `self_update` check action bypasses this gate via `force:true`, and since its risk='read' requires no confirmation token, **AI can autonomously trigger egress** (IP/UA leak to npmjs.org). For strict zero egress, use firewall or readOnly mode rejecting the entire tool. The CLI download chain (`install`/`web` fetching GitHub releases, user-triggered) is a separate egress point — see [`docs/telemetry.md`](docs/telemetry.md).
>
> **Proxy environment variables (verified)**: Node's native fetch (undici) **does NOT read** `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` by default (Node ≥24 can set `NODE_USE_ENV_PROXY=1` to enable). Verified: with a dead proxy port set, fetching registry.npmjs.org still returns 200 via direct connection. In enterprise proxy environments the update check **connects directly** (possibly silently blocked by the firewall); `NO_PROXY` is **not** an effective zero-egress measure. See the proxy section in [`docs/telemetry.md`](docs/telemetry.md).
>
> **⚠️ Honest disclosure — vision-router egress**: when `screenshot` analyze action sets `vision_route=true` + `GODOT_MCP_VISION_KEY`, the screenshot base64 + prompt is sent to `https://api.groq.com` (groq vision model). **Dual opt-in, zero egress by default** (no `vision_route` or no key → fallback to local detail tier). Set `GODOT_MCP_VISION_BASE_URL` to point to self-hosted/ollama/regional proxy to avoid egress to groq. See [`docs/telemetry.md`](docs/telemetry.md).

## Core Capabilities

### Three-tier architecture — static editing / live debugging / runtime verification

Not a single connection, but three tiers split by scenario (auto-detected, non-conflicting):

| Tier | Connection | Use case |
|---|---|---|
| **Headless CLI** | standalone Godot process | file R/W, batch creation, one-shot verification (default) |
| **Editor WebSocket** | connects running editor | live scene ops, undo, scene-tree sync |
| **Game Bridge** | TCP to running game | E2E testing, runtime debugging, input simulation, state verification |

Every editor-tier write registers into Godot's native undo stack (10 production command files, 53 `create_action` call sites, recursive incl. the `commands/asset/` subdirectory — verify with `grep -rc "create_action" addons/godot_mcp_server/commands/ | grep -v ":0"`): if the AI makes a mistake, one **Ctrl+Z** in the editor reverts it. The widest undo coverage in this field.

### Closed-loop AI development

```
read_scene / read_script → understand structure → write_script / edit_script
→ run_and_verify (error analysis) → validate_scripts → verify_delivery (delivery gate)
```

- **`verify_delivery`** — end-to-end delivery gate: scene-tree integrity + script health + performance + custom assertions
- **`validate_scripts`** — triggers full Godot compile (incl. cross-file deps), catches Parse Errors headless misses
- **`dev_loop`** — execute → verify → screenshot, with acceptance criteria

### Batch ops & resource management

- **`batch_add_nodes`** — add multiple nodes in one call, single pack+save at the end (avoids per-node headless restart)
- **`validate_project`** — static scan for missing resources, broken `preload()`/`load()` paths, orphaned `.import` files
- **`import_resources`** — bulk-register resources (images/audio/fonts/3D), auto-generate `.import`

### Structured workflows (with checklists)

Following agentic-skills methodology (e.g. obra/superpowers), this project ships AI-followable structured development workflows (`setup_project_rules` generates them to `.claude/rules/godot-mcp-workflow-*.md`):

- **Bridge E2E flow** — install → run(wait_for_bridge) → ping → input+wait → screenshot/frame-verify
- **Edit→Run→Verify loop** — read → edit → run_and_verify → validate_scripts → verify_delivery
- **Safe-edit flow** — search_and_replace first / validate after edit / override-guard / confirm token

Each workflow ships with a checklist + common-deviation tips, keeping AI on-rails and reducing footguns.

## Tools (46)

> **46 MCP tools** (merged tool definitions, 272 actions). **Tool descriptions are in Chinese** — see the [Chinese README](README.md) for the full per-action list. For English-speaking technical users, the value of [capability-matrix](docs/capability-matrix.md) is its **security classification** (`danger-api` / `guarded` / `safe`) and coverage structure — evidence of the systematic security approach, not a tool catalog.

## MCP Resources

AI clients can discover and read project context via the `godot://` URI scheme without explicit tool calls.

| URI | Description |
|-----|------|
| `godot://project/info` | project metadata + file stats (JSON) |
| `godot://project/config` | raw `project.godot` file |
| `godot://scene/{path}` | read a `.tscn` scene as a node-tree summary |
| `godot://script/{path}` | read a `.gd` script file |
| `godot://file/{path}` | read any text file from the project |

Security: paths must be under project root (no `../` traversal); `.godot/`, `.import/`, `node_modules/` blocked; `.import`/`.uid`/`.godot` extensions blocked.

## Quick Start

### Claude Code — User Scope (available in all Godot projects)

```bash
claude mcp add -s user godot -- npx -y godot-mcp-enhanced
```

> **Why `-s user`?** Godot MCP is a personal dev tool used across many Godot projects. `-s user` writes to `~/.claude.json` top-level, available in every project automatically. See [Claude Code MCP docs](https://code.claude.com/docs/en/mcp#mcp-installation-scopes).

### Cursor / Cline / Windsurf / others

Add to your project's `.cursor/mcp.json` or MCP configuration:

```json
{
  "mcpServers": {
    "godot": { "command": "npx", "args": ["-y", "godot-mcp-enhanced"] }
  }
}
```

### Tencent CodeBuddy (CN users)

CodeBuddy (2026-06-27 verified) supports external stdio MCP servers: **Settings → MCP tab → Add MCP**, paste the same json. Or one-click install from its MCP Market (once listed).
> ⚠️ End-to-end onboarding verification pending.

### Warp

[Warp](https://www.warp.dev/) supports MCP natively: **Settings → Agents → MCP servers → + Add → CLI Server**, paste the same json (`command: npx`, `args: ["-y", "godot-mcp-enhanced"]`).

### ZCode (Zhipu GLM-5.2 ADE)

[ZCode](https://zcode.z.ai/) supports MCP. **Settings → MCP servers → New** (stdio, `command: npx`, `args: ["-y", "godot-mcp-enhanced"]`), or write to `<project>/.zcode/config.json` / `.agents/mcp.json`. **Key**: ZCode reads `AGENTS.md` (not `CLAUDE.md`) — run `setup_project_rules` (dual-write by default) to generate `AGENTS.md`.
> Full steps, three config methods, env / permission matrix in [ZCode guide](docs/使用指南-ZCode.md).

### One-click setup

```bash
npx godot-mcp-enhanced setup
# Auto-detects: Godot path + AI client + writes config
```

### First-time use

After connecting to a Godot project, run the project-rules setup tool:

```
setup_project_rules(project_path="your/project/path")
```

This auto-generates:
- **`.claude/settings.json`**: PostToolUse hook reminding the AI to run `validate_scripts` after editing `.gd` files
- **`CLAUDE.md`**: project-level rules with GDScript validation and release gate (`verify_delivery`)

## Acknowledgements

- [godot-mcp](https://github.com/Coding-Solo/godot-mcp) — original project; this is a fork (Copyright (c) 2025 Solomon Elias, MIT; see [LICENSE](LICENSE))
- [Hastur Operation Plugin](https://github.com/rayxuln/hastur-operation-plugin) — inspiration for dynamic GDScript execution & structured output
- [Claude Code Game Studios](https://github.com/Donchitos/Claude-Code-Game-Studios) — borrowed concepts: hooks + rules, verify / gate-check, workflow pipeline, GDScript lint, GDD standard, chain-of-verification, code templates (using CCGS? see the [integration guide](docs/guides/ccgs-integration.md))

## Requirements

- Godot Engine 4.x (tested 4.6+)
- Node.js >= 18
- GUT addon (for `run_tests`)

## License

[MIT](LICENSE) — includes upstream [Coding-Solo/godot-mcp](https://github.com/Coding-Solo/godot-mcp) copyright (Copyright (c) 2025 Solomon Elias).

## Roadmap

Project direction & milestones (M1 positioning & reach / M2 robustness P0 / M3 security P1 / M4 feature parity P2): see [ROADMAP.md](ROADMAP.md).

## Changelog

Full change log: see [CHANGELOG.md](CHANGELOG.md).
