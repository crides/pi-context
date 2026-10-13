# PROJECT KNOWLEDGE BASE

**Generated:** 2026-09-20

## OVERVIEW
Project: **pi-context** (v2.3.0)
Stack: TypeScript (ES2022 / Node16, strict, ESM), `@earendil-works/pi-coding-agent` >= 0.87.0 (native `context_edit`), `@earendil-works/pi-ai` Type schemas, `@earendil-works/pi-tui` for the dashboard. Plain Node 20+ `.mjs` for dev tooling and tests (no extra deps).

An Agentic Context Management extension for the `pi` coding agent. It lets agents structure, inspect, and clean up conversation history via named checkpoints, a structural timeline view, and checkpoint-based compaction — lossless time travel over Pi's session tree.

## STRUCTURE
*   `src/index.ts`: Extension entry. Registers the `/acm` command and the agent tools (`context_checkpoint`, `context_timeline`, `context_compact`, `context_remove`, `context_read`), plus the deferred compaction flow and removal commit on `turn_end`/`agent_end` events. The timeline renders parsed checkpoint phases and folded intervals. Exports `didConversationAdvance` for tests.
*   `src/context.ts`: `/context` command — TUI overlay dashboard showing token usage per category (rough estimates over `buildSessionProjection()` messages, so context edits apply, scaled to actual usage).
*   `src/usage.ts`: context usage notes. At `turn_end`, when usage first passes a threshold (default 25/50/75, `PI_CONTEXT_USAGE_WARNINGS` overrides or `off`), returns a hidden `pi-context-usage` custom_message draft; when usage drops below the last warned level, a passive `pi-context-usage-level` custom record re-arms. Last level is read from the active branch (survives reload, follows /tree and compaction). Skipped while a compact is pending (the entry would cancel it) and while or when a removal commits (usage is about to change).
*   `src/overlay.ts`: `showTextOverlay` shared by `/timeline` and `/context`. Guards on `ctx.mode === "tui"` (not `hasUI`: RPC reports `hasUI` but `custom()` returns undefined); otherwise sends plain text via `notify`. Manual scrolling sized from `tui.terminal.rows`.
*   `/timeline` (in `src/index.ts`): runs the `context_timeline` tool's `execute` (shared via `defineTool`) and shows it in a TUI overlay, or `notify` without UI. Never enters model context.
*   `src/remove.ts`: `context_remove` planning (span snapping, earlier-removal folding, gap note, structural stubs), preview validation of provider message shape, and `context_read` rendering.
*   `src/utils.ts`: Shared helpers — `formatTokens`, `isContextTool`, `formatContextUsage`, `parseCheckpointPhase`, `estimateHistoryTokens`, `describeHistoryInterval`.
*   `skills/context-management/`: The agent-facing skill. `SKILL.md` teaches the checkpoint → timeline → compact rhythm, the `<scope>-<phase>` naming convention, and the compact gate; `references/` holds per-scenario guidance.
*   `tools/session-analysis/`: Repo-local offline analyzer for saved session JSONL snapshots (library `analyze-session.mjs`, CLI `session-analysis-cli.mjs`, report template `session-chart.html`). Emits interactive HTML + JSON/CSV. Not published.
*   `test/`: `node --test` unit tests (`*.test.mjs`), live-model test (`live-command-context.mjs`), test fixtures (`*.ts` extensions), and manual scenarios (`test.md`).
*   `evals/`: Python skill-behavior eval harness (`run_context_eval.py`, `run_context_multi_turn_eval.py`), eval set definitions + notes, and historical `run-*` outputs (gitignored).

## COMMANDS
| Action | Command |
|--------|---------|
| Install | `npm install` |
| Typecheck | `npm run typecheck` |
| Test | `npm test` = typecheck + `tsc` emit to `dist/` + `node --test test/*.test.mjs` |
| Live test | `npm run test:live` (opt-in: real model, uses Pi auth, costs tokens) |
| Analyze session | `npm run analyze:session -- <session.jsonl> [--out dir]` (repo checkout only; default output `.pi/session-analysis/` is gitignored) |
| Run locally | `pi --no-skills --no-extensions -e ./src/index.ts -e ./src/context.ts --skill ./skills` |
| Skill evals | `python evals/run_context_eval.py <set\|all>`; `python evals/run_context_multi_turn_eval.py <with-skill\|both>` |

## CODING STANDARDS
*   **Language**: TypeScript ESM (`"type": "module"`); Node16 resolution means local imports carry `.js` extensions (`./utils.js`).
*   **Style**: Extension modules are `export default function (pi: ExtensionAPI)`. Tool schemas use `Type.Object` from `pi-ai`. Iterative DFS (not recursion) for session-tree walks.
*   **Rules**: `strict: true`. SDK types not exported from the main entry (e.g. `SessionTreeNode`) are defined locally near usage. No linter/formatter config — match existing style.
*   **Tests**: `.mjs` files using `node:test` + `node:assert`; they import the **compiled** `dist/` output, so run `npm test` (which recompiles) rather than `node --test` on a stale `dist`.

## WHERE TO LOOK
*   **Source**: `src/`
*   **Tests**: `test/` (unit: `*.test.mjs`; manual/live scenarios: `test.md`)
*   **Skill**: `skills/context-management/SKILL.md` — the contract for when agents checkpoint, inspect, and compact. `references/` for scenario-specific guidance.
*   **Session analysis**: `tools/session-analysis/README.md` — report views, CLI options, measurement/simulation limits, privacy rules. Read it before changing analyzer behavior or interpreting output.
*   **Evals**: `evals/README.md` — eval set purposes, run matrix, scoring dimensions.

## NOTES
*   **Architecture**: The extension operates on `SessionManager`'s entry tree: `pi.setLabel` for checkpoints, `branchWithSummary` + `navigateTree` for compaction. Nothing is deleted from disk; all history stays recoverable.
*   **Checkpoint Naming**: The skill documents `<scope>-<phase>` suffixes (`start/done/pivot/pause/resume`) as an agent-facing convention; the extension only parses the suffix for timeline display and does not track phase state. Timeline interval estimates use Pi's token heuristic over historical content (excluding internal context-management traffic), describe what was folded, and are not reclaimable tokens; never recommend the nearest checkpoint as a compact target.
*   **Native Compaction**: Leave Pi's manual, threshold, and overflow compaction untouched — no `session_before_compact` interception or replacement prompts.
*   **Compact flow**: `context_compact` returns `"compact start"` immediately → `turn_end` aborts the agent loop → `agent_end` defers (via `setTimeout` + `waitForIdle`, because `agent_end` fires before the agent is truly idle) → `didConversationAdvance` cancels for unaccounted context or queued input → build a summary branch → restore the original leaf so `navigateTree(summaryId)` rebuilds state with the correct origin → fire-and-forget continuation. In codemode, branch from the target, retain the whole parent output as `pi-context-codemode-output`, merge folded `codemode-store` state into one net delta (including only deletions of prefix keys), then attach the summary. The model sees prefix → output → summary; nothing is rerun. Do not navigate to the custom output itself: Pi moves selected user/custom messages into the editor. Never duplicate billable assistant/tool-result messages or their usage.
*   **Remove flow**: `context_remove` plans and validates at execute time (on a throwaway `SessionManager.inMemory` copy), stores `PendingRemove`, and returns its `context_edit` drafts plus a passive `pi-context-removal` custom record from `turn_end` when `messageEntryId` matches the requesting assistant entry; Pi commits them and rebuilds model state from the projection. Never copy entries or branch for removal. The gap note is hosted on the first visible entry in the span; stubs keep the role sequence at both edges unchanged (assistant tool calls keep IDs with empty arguments, their results become stub text). If the turn ends without a matching `turn_end`, `agent_end` reports it via a hidden `nextTurn` message. Remove and compact are mutually exclusive within a turn. On commit, the gap-note host gets a `removed:<first>..<last>` label (only if unlabeled) so `/tree` shows it; labels of folded earlier gap notes are cleared. The timeline hides `removed:` labels from meta, and they are never listed as checkpoints inside a span. Reported span IDs skip leading/trailing entries without content (labels, records, edits). `context_read` is not an internal context tool: its result is task content.
*   **ACM enablement**: `context_compact` auto-acquires `ExtensionCommandContext` by dispatching `/acm` with `expandPromptTemplates: true` (Pi >= 0.84.2); the command handler resolves the pending promise. State (`CommandCtx`, `CompactParams`) is per-extension-instance and cleared on `session_shutdown`.
*   **Advancement gate**: After a direct compact request, only passive entries (`label`, `custom`, `session_info`, `model_change`, `thinking_level_change`), its successful result, and empty abort-boundary assistant messages are safe. For built-in codemode (Pi >= 0.99.0), anchor at the actual sole outer codemode call using `<parent id>/<n>` (parent IDs are opaque). Require one successful parent result and one matching successful nested compact; additional nested tools/models are allowed because the full output is retained. Omitted arguments or truncated unrelated calls are safe, but a missing compact record cancels. Repeated compact requests invalidate the pending request even if the script catches the error. The target must strictly precede the script on the active path. Other contextual entries or queued input cancel before navigation. Pi awaits `session_before_tree` hooks after this check; context appended inside those hooks is an existing non-atomic-navigation limitation, not covered by the pre-navigation gate. Do not add recovery-navigation loops that replay hook side effects. Never fall back to the current leaf. Retained output counts as task context, unlike internal management messages.
*   **Publishing**: `files` = `src`, `skills`, `README.md`. Source-first: Pi loads the `.ts` extensions directly; `dist/` is only for unit tests. `tools/`, `test/`, `evals/` are development-only.
*   **Skill authoring**: Keep `skills/**` examples generic — no task-specific data, private session details, or one-off IDs. The skill's prompting principle is proportionality: checkpoint before noisy work, timeline when orientation matters, compact only when a known continuation benefits after recovery cost. Never encourage compact after final answers.
*   **Evals side effect**: The Python eval runners temporarily remove installed `pi-context` from `~/.pi/agent/settings.json` while running — don't run them concurrently with real Pi sessions you care about.
*   **Privacy**: The session analyzer exports no message/command/result bodies, but filenames, checkpoint names, and timestamps may still be sensitive; default output goes to gitignored `.pi/`.
