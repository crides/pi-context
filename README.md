# Pi Context: Agentic Context Management for Pi

An Agentic Context Management tool that helps AI agents keep long conversations focused by maintaining a clean working set: checkpoint useful anchors, inspect the active history structure, and compact noisy completed paths into state summaries.

Inspired by kimi-cli d-mail, it brings lossless time travel to Pi's session tree.

For more on the design philosophy, see the [blog post](https://blog.xlab.app/p/51d26495/) ([中文版本](https://blog.xlab.app/p/6a966aeb/)).

## Naming migration note

Earlier versions used more Git-like names such as `context_tag`, `context_log`, and `context_checkout`.

Current versions intentionally use conversation-native names instead:
- `context_checkpoint`
- `context_timeline`
- `context_compact`
- `context_remove`
- `context_read`

These tools manage **conversation history**, not repository state. They should not be treated as Git commands or as replacements for real `git tag`, `git log`, or `git checkout`. Context navigation does not modify or roll back files, running processes, browser state, tickets, databases, or remote services.

## Installation

```bash
pi install npm:pi-context
```

## Usage

### For Humans

Requires Pi >= 0.87.0 (native `context_edit` entries). ACM (**A**gentic **C**ontext **M**anagement) works automatically. Before compacting, the extension acquires command context if needed; no manual `/acm` is required.

`/acm` and `/acm <task>` remain available for compatibility.

### Checkpoint naming and timeline estimates

Use checkpoint names ending in `-start`, `-done`, `-pivot`, `-pause`, or `-resume` to declare a task or phase change, keeping the scope prefix consistent within a phase's lifecycle (for example `parser-investigation-start` → `parser-investigation-done`). Other names remain valid ordinary anchors. Timeline displays the parsed phase next to each label, folds hidden intervals with message counts and approximate tokens using Pi's heuristic, and marks off-path summaries. Interval estimates describe historical content, exclude internal context-management traffic, and are not exact current-model occupancy or reclaimable space.

Show the same structural timeline the agent sees, without adding it to model context:

```bash
/timeline [limit] [--verbose]
```

### Context usage notes

When context usage first crosses 25%, 50%, or 75%, the extension adds a hidden note to model context, prefixed `[pi-context extension, automatic; not from the user]` so the model does not mistake it for user input (about 50 tokens, appended at the end so the prompt cache is unaffected). It states the usage and points to the compact gate; it does not tell the model to compact. Warnings re-arm when usage falls below a threshold (after a remove or compact). Configure thresholds with a JSON file or an environment variable (highest precedence first):

1. `PI_CONTEXT_USAGE_WARNINGS`, e.g. `60,90`, or `off`
2. Project file `<project>/.pi/pi-context.json`
3. User file `~/.pi/agent/pi-context.json`
4. Defaults: 25, 50, 75

```json
{ "usageWarnings": [60, 90] }
```

Use `"usageWarnings": "off"` (or `[]`) to disable. Invalid values are ignored with a warning at session start and the next source is used. Files are read at session start, so `/reload` applies edits. `/context-warnings` shows the active thresholds, their source, and both file paths. Note: unlike Pi's own project settings, the project file is read without a project-trust check; it can only change warning thresholds.

In the TUI, `/timeline` and `/context` open an overlay that scrolls when taller than the terminal (↑/↓, PgUp/PgDn, Home/End; q/Esc close). In RPC, JSON, and print modes they send the same content as plain text.

Removed spans appear as `[REMOVED]` gap notes. Pi's `/tree` ignores context edits, so it still shows removed entries; the gap note's host entry carries a `removed:<first>..<last>` label there instead.

Open a visual dashboard to inspect context-window usage and token distribution (similar to `claude code /context`). It counts the edited context, so removed content is excluded.

```bash
/context
```

![](img/context.png)

### Session analysis (repository checkout)

Generate an offline token timeline from a saved Pi session, with checkpoint markers, compaction events, cumulative usage, and an explicitly simulated threshold-only comparison:

```bash
npm run analyze:session -- /path/to/session.jsonl --out /path/to/report
```

Open `report/session-token-chart.html` in a browser. See [session analysis documentation](tools/session-analysis/README.md) for snapshot cutoffs, simulation parameters, measurement limits, and privacy notes. This developer tool is not included in the npm extension package.

### For Agents

This extension adds the `context-management` skill, which guides agents to keep the active conversation as the smallest sufficient working set for the next step. It includes five tools:

1. **🔖 Anchor (`context_checkpoint`)**
   Label a meaningful conversation node with a unique semantic checkpoint name, such as `parser-investigation-start` and `parser-investigation-done`.

2. **📊 Inspect (`context_timeline`)**
   View the active path as a structural map of checkpoints, summaries/compactions, branch points, user turns, and current position. Use it when orientation or compact target selection depends on history shape.

3. **⏪ Compact (`context_compact`)**
   Create a summarized continuation branch from an earlier checkpoint, history node, or `root`. The summary should restore the useful state after the target: current task, decisions, external side effects such as changed files or remote updates, validation state, source anchors, and the explicit next step.

4. **✂️ Remove (`context_remove`)**
   Remove a middle span (strictly after `after`, through `until`) from model context while keeping later work raw. Uses Pi's append-only `context_edit` entries: nothing is copied or deleted, entry IDs and labels stay put, and usage is not duplicated. A gap note (the agent's summary, or an automatic one) marks where the span was. Spans snap so tool calls stay paired with results, and overlapping earlier removals are folded in. The provider prefix cache is re-read from the span onward.

5. **📖 Read (`context_read`)**
   Read the original content of any entry or path (`id` through `until`), ignoring context edits. Used to recover details from removed spans; the result is appended at the end of context, nothing is restored in place.
