import {
    convertToLlm,
    estimateTokens,
    SessionManager,
    type ContextEditEntryDraft,
    type SessionBoundaryDraft,
    type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ImageContent, TextContent, ToolCall } from "@earendil-works/pi-ai";
import { formatTokens } from "./utils.js";

/** Passive record describing one context_remove; it never enters model context. */
export const RemovalRecordType = "pi-context-removal";
/** Gap notes start with this prefix; it identifies the entry hosting the note. */
export const RemovalMarkerPrefix = "[context_remove]";
/** Prefix of the /tree label placed on a gap note's host entry. */
export const RemovalLabelPrefix = "removed:";
/** Content of structural stubs kept only so message roles stay valid. */
export const RemovedStubText = "[removed by context_remove; see the removal note above]";

export interface RemovalRecord {
    markerId: string;
    stubIds: string[];
    omittedIds: string[];
    keptIds: string[];
    afterId: string;
    untilId: string;
    firstId: string;
    lastId: string;
    count: number;
    tokens: number;
}

type Replacement = ContextEditEntryDraft["replacement"];
type AgentMsg = ReturnType<SessionManager["buildSessionProjection"]>["messages"][number];
type TargetKind = "user" | "assistant" | "toolResult" | "custom";

interface Target {
    id: string;
    index: number;
    kind: TargetKind;
    entry: SessionEntry;
    messages: AgentMsg[];
}

export function replacementText(replacement: Replacement | undefined): string | undefined {
    if (!replacement) return undefined;
    const content = replacement.content;
    if (typeof content === "string") return content;
    const text = (content as { type: string; text?: string }[]).find((block) => block.type === "text");
    return text?.text;
}

const isMarkerText = (text: string | undefined) => !!text && text.startsWith(RemovalMarkerPrefix);

/** Latest context edit per target on the given path (branch-relative, latest wins). */
export function collectEdits(branch: readonly SessionEntry[]): Map<string, Replacement> {
    const edits = new Map<string, Replacement>();
    for (const entry of branch) {
        if (entry.type === "context_edit") edits.set(entry.targetId, entry.replacement);
    }
    return edits;
}

/** Removal records whose gap note is still the latest edit of its host entry. */
export function activeRemovals(branch: readonly SessionEntry[], edits: Map<string, Replacement>): Map<string, RemovalRecord> {
    const removals = new Map<string, RemovalRecord>();
    for (const entry of branch) {
        if (entry.type !== "custom" || entry.customType !== RemovalRecordType) continue;
        const record = entry.data as RemovalRecord | undefined;
        if (!record || typeof record.markerId !== "string") continue;
        removals.set(record.markerId, record);
    }
    for (const id of [...removals.keys()]) {
        if (!isMarkerText(replacementText(edits.get(id)))) removals.delete(id);
    }
    return removals;
}

/** Entries that no longer contribute their content: omitted or reduced to a stub. */
export function removedIds(edits: Map<string, Replacement>): Set<string> {
    const removed = new Set<string>();
    for (const [id, replacement] of edits) {
        if (replacement === null || replacementText(replacement) === RemovedStubText) removed.add(id);
    }
    return removed;
}

const toolCallIdOf = (entry: SessionEntry): string | undefined =>
    entry.type === "message" && entry.message.role === "toolResult" ? entry.message.toolCallId : undefined;

const toolCallsOf = (entry: SessionEntry): ToolCall[] =>
    entry.type === "message" && entry.message.role === "assistant"
        ? entry.message.content.filter((block): block is ToolCall => block.type === "toolCall")
        : [];

function targetKind(entry: SessionEntry): TargetKind | undefined {
    if (entry.type === "custom_message") return "custom";
    if (entry.type !== "message") return undefined;
    const role = entry.message.role;
    return role === "user" || role === "assistant" || role === "toolResult" ? role : undefined;
}

const sideOf = (kind: TargetKind) => kind === "assistant" ? "assistant" : "user";

export interface PlanOptions {
    afterId: string;
    untilId: string;
    requestLeaf: string;
    afterName: string;
    untilName: string;
    summary?: string;
}

export interface RemovalPlan {
    drafts: SessionBoundaryDraft[];
    record: RemovalRecord;
    markerText: string;
    checkpoints: string[];
    notes: string[];
    /** Gap-note hosts of earlier removals absorbed by this one; their labels become stale. */
    foldedMarkerIds: string[];
}

/**
 * Plan context edits that remove (after, until] from model context.
 *
 * The span is snapped so tool calls and results stay paired, widened to absorb
 * earlier removals it overlaps, and replaced by a gap note hosted on the first
 * visible entry. Structural stubs keep the role sequence at both span edges
 * identical to the original, so neighbouring messages stay valid.
 */
export function planRemoval(sm: SessionManager, options: PlanOptions): RemovalPlan {
    const branch = sm.getBranch();
    const indexOf = (id: string) => branch.findIndex((entry) => entry.id === id);
    const after = indexOf(options.afterId);
    const until = indexOf(options.untilId);
    const request = indexOf(options.requestLeaf);
    if (request < 0) throw new Error("context_remove: cannot locate the requesting tool call on the active path.");
    if (after < 0) throw new Error(`context_remove: 'after' (${options.afterName}) is not on the active path.`);
    if (until < 0) throw new Error(`context_remove: 'until' (${options.untilName}) is not on the active path.`);
    if (until <= after) throw new Error("context_remove: 'until' must come after 'after' on the active path.");
    if (until >= request) {
        throw new Error("context_remove: 'until' must precede the current turn. To drop everything after a point, use context_compact.");
    }

    // Tool-call ownership: result index -> assistant index, assistant index -> result indices.
    const callOwner = new Map<string, number>();
    const owner = new Map<number, number>();
    const results = new Map<number, number[]>();
    branch.forEach((entry, index) => {
        for (const call of toolCallsOf(entry)) callOwner.set(call.id, index);
        const callId = toolCallIdOf(entry);
        const assistantIndex = callId === undefined ? undefined : callOwner.get(callId);
        if (assistantIndex === undefined) return;
        owner.set(index, assistantIndex);
        results.set(assistantIndex, [...(results.get(assistantIndex) ?? []), index]);
    });

    const edits = collectEdits(branch);
    const earlier = [...activeRemovals(branch, edits).values()]
        .map((record) => ({ record, first: indexOf(record.firstId), last: indexOf(record.lastId) }))
        .filter((removal) => removal.first >= 0 && removal.last >= 0);

    let start = after + 1;
    let end = until;
    for (let changed = true; changed;) {
        changed = false;
        for (let index = start; index <= end; index++) {
            const assistantIndex = owner.get(index);
            if (assistantIndex !== undefined && assistantIndex < start) {
                start = index + 1;
                changed = true;
                continue;
            }
            const resultIndices = results.get(index);
            const lastResult = resultIndices ? Math.max(...resultIndices) : -1;
            if (lastResult > end) {
                end = lastResult;
                changed = true;
            }
        }
        for (const removal of earlier) {
            if (removal.last < start || removal.first > end) continue;
            if (removal.first < start) { start = removal.first; changed = true; }
            if (removal.last > end) { end = removal.last; changed = true; }
        }
    }

    const notes: string[] = [];
    if (start > after + 1) notes.push("start moved forward past tool results whose call precedes the span");
    if (start < after + 1) notes.push("start moved back to absorb an earlier removal");
    if (end > until) notes.push("end extended to keep tool calls paired with their results or to absorb an earlier removal");
    if (end >= request) throw new Error("context_remove: the span would reach the current turn after snapping tool results; choose an earlier 'until'.");
    if (start > end) throw new Error("context_remove: nothing to remove between 'after' and 'until'.");

    for (let index = start; index <= end; index++) {
        if (branch[index].type === "compaction") {
            throw new Error("context_remove: the span contains a compaction entry; choose boundaries after it.");
        }
    }

    const visible = new Map<string, AgentMsg[]>();
    for (const projected of sm.buildSessionProjection().entries) {
        if (projected.messages.length) visible.set(projected.sourceEntry.id, projected.messages);
    }

    const targets: Target[] = [];
    const keptIds: string[] = [];
    const checkpoints: string[] = [];
    for (let index = start; index <= end; index++) {
        const entry = branch[index];
        const label = sm.getLabel(entry.id);
        if (label && !label.startsWith(RemovalLabelPrefix)) checkpoints.push(label);
        const messages = visible.get(entry.id);
        if (!messages) continue;
        const kind = targetKind(entry);
        if (!kind) { keptIds.push(entry.id); continue; }
        targets.push({ id: entry.id, index, kind, entry, messages });
    }
    if (!targets.length) throw new Error("context_remove: the span has no model-visible content left to remove.");
    if (keptIds.length) notes.push(`${keptIds.length} entries cannot be edited and stay in context: ${keptIds.join(", ")}`);

    const tokens = targets.reduce((sum, target) =>
        sum + target.messages.reduce((total, message) => total + estimateTokens(message), 0), 0);
    // Labels, records and edits carry no content; keep them out of the IDs we report.
    const hasContent = (entry: SessionEntry) =>
        entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary";
    let firstIndex = start;
    let lastIndex = end;
    while (firstIndex < lastIndex && !hasContent(branch[firstIndex])) firstIndex++;
    while (lastIndex > firstIndex && !hasContent(branch[lastIndex])) lastIndex--;
    const firstId = branch[firstIndex].id;
    const lastId = branch[lastIndex].id;
    const contained = earlier.filter((removal) => removal.first >= start && removal.last <= end);
    const folded = contained
        .map((removal) => replacementText(edits.get(removal.record.markerId)))
        .filter((text): text is string => !!text)
        .map((text) => text.slice(RemovalMarkerPrefix.length).trim());

    const lines = [
        `${RemovalMarkerPrefix} Removed ${targets.length} context entries (~${formatTokens(tokens)} tokens) after ${options.afterName} through ${options.untilName} (entries ${firstId}..${lastId}).`,
    ];
    if (checkpoints.length) lines.push(`Checkpoints inside: ${checkpoints.join(", ")}.`);
    if (options.summary?.trim()) lines.push(`Summary: ${options.summary.trim()}`);
    for (const text of folded) lines.push(`Earlier removal folded in: ${text}`);
    lines.push(`Originals remain in session history: context_read({ id: "${firstId}", until: "${lastId}" }).`);
    const markerText = lines.join("\n");

    const replacements = new Map<string, Replacement>(targets.map((target) => [target.id, null]));
    const consumed = new Set<string>();
    const head = targets[0];
    consumed.add(head.id);
    let endSide: "user" | "assistant";
    if (head.kind === "assistant") {
        const headResults = targets.filter((target) => target.kind === "toolResult" && owner.get(target.index) === head.index);
        const answered = new Set(headResults.map((target) => toolCallIdOf(target.entry)));
        const calls = toolCallsOf(head.entry).filter((call) => answered.has(call.id));
        const content: AssistantMessage["content"] = [
            { type: "text", text: markerText },
            ...calls.map((call) => ({ ...call, arguments: {} })),
        ];
        replacements.set(head.id, { content });
        for (const result of headResults) {
            replacements.set(result.id, { content: [{ type: "text", text: RemovedStubText }] });
            consumed.add(result.id);
        }
        endSide = calls.length ? "user" : "assistant";
    } else {
        replacements.set(head.id, { content: head.kind === "toolResult" ? [{ type: "text", text: markerText }] : markerText });
        endSide = "user";
    }

    const last = targets[targets.length - 1];
    if (sideOf(last.kind) !== endSide && !consumed.has(last.id)) {
        if (last.kind === "assistant") {
            // Snapping guarantees a trailing assistant has no paired results left in the span.
            replacements.set(last.id, { content: [{ type: "text", text: RemovedStubText }] });
        } else {
            const closer = targets.find((target) => !consumed.has(target.id) && (target.kind === "user" || target.kind === "custom"));
            if (!closer) {
                throw new Error("context_remove: cannot close this span without breaking message order; start or end it at a user turn or a tool call.");
            }
            replacements.set(closer.id, { content: RemovedStubText });
        }
    }

    const record: RemovalRecord = {
        markerId: head.id,
        stubIds: targets.filter((target) => target.id !== head.id && replacements.get(target.id) !== null).map((target) => target.id),
        omittedIds: targets.filter((target) => replacements.get(target.id) === null).map((target) => target.id),
        keptIds,
        afterId: branch[start - 1].id,
        untilId: lastId,
        firstId,
        lastId,
        count: targets.length,
        tokens,
    };
    const drafts: SessionBoundaryDraft[] = targets.map((target) => ({
        type: "context_edit",
        targetId: target.id,
        replacement: replacements.get(target.id) ?? null,
    }));
    drafts.push({ type: "custom", customType: RemovalRecordType, data: record });
    return { drafts, record, markerText, checkpoints, notes, foldedMarkerIds: contained.map((removal) => removal.record.markerId) };
}

interface Shape { adjacentAssistant: number; orphanResults: number; unansweredCalls: number }

function shapeOf(messages: AgentMsg[]): Shape {
    const shape: Shape = { adjacentAssistant: 0, orphanResults: 0, unansweredCalls: 0 };
    let previous: string | undefined;
    let open = new Set<string>();
    for (const message of convertToLlm(messages) as unknown as { role: string; content?: unknown; toolCallId?: string }[]) {
        if (message.role === "system") continue;
        if (message.role === "assistant") {
            if (previous === "assistant") shape.adjacentAssistant++;
            shape.unansweredCalls += open.size;
            const blocks = Array.isArray(message.content) ? message.content as { type?: string; id?: string }[] : [];
            open = new Set(blocks.filter((block) => block.type === "toolCall" && block.id).map((block) => block.id!));
        } else if (message.role === "toolResult") {
            if (!message.toolCallId || !open.delete(message.toolCallId)) shape.orphanResults++;
        } else {
            shape.unansweredCalls += open.size;
            open = new Set();
        }
        previous = message.role;
    }
    shape.unansweredCalls += open.size;
    return shape;
}

/** Apply drafts to a throwaway copy and refuse plans that worsen provider message structure. */
export function validateRemoval(sm: SessionManager, drafts: SessionBoundaryDraft[]): void {
    const header = sm.getHeader();
    if (!header) return;
    const preview = SessionManager.inMemory(sm.getCwd(), undefined, [header, ...sm.getBranch()]);
    for (const draft of drafts) {
        if (draft.type === "context_edit") preview.appendContextEdit(draft.targetId, draft.replacement);
    }
    const before = shapeOf(sm.buildSessionProjection().messages);
    const after = shapeOf(preview.buildSessionProjection().messages);
    const worse = (["adjacentAssistant", "orphanResults", "unansweredCalls"] as const).filter((key) => after[key] > before[key]);
    if (worse.length) {
        throw new Error(`context_remove: removing this span would break message structure (${worse.join(", ")}); choose other boundaries, e.g. at user turns or checkpoints.`);
    }
}

interface EntryBody { role: string; text: string; images: ImageContent[] }

function entryBody(entry: SessionEntry): EntryBody | undefined {
    const images: ImageContent[] = [];
    const blocks = (content: unknown): string => {
        if (typeof content === "string") return content;
        if (!Array.isArray(content)) return "";
        return content.map((block: any) => {
            if (block?.type === "text") return block.text as string;
            if (block?.type === "image") { images.push(block as ImageContent); return "[image]"; }
            if (block?.type === "toolCall") return `call: ${block.name}(${JSON.stringify(block.arguments)})`;
            return "";
        }).filter(Boolean).join("\n");
    };
    if (entry.type === "custom_message") return { role: "CUSTOM", text: blocks(entry.content), images };
    if (entry.type === "branch_summary" || entry.type === "compaction") return { role: "SUMMARY", text: entry.summary, images };
    if (entry.type !== "message") return undefined;
    const message = entry.message as any;
    switch (message.role) {
        case "user": return { role: "USER", text: blocks(message.content), images };
        case "assistant": return { role: "AI", text: blocks(message.content), images };
        case "toolResult":
            return { role: "TOOL", text: `(${message.toolName}${message.isError ? ", error" : ""}) ${blocks(message.content)}`, images };
        case "bashExecution":
            return {
                role: "BASH",
                text: `$ ${message.command}\n${message.output}${message.exitCode !== undefined ? `\n[exit ${message.exitCode}]` : ""}`,
                images,
            };
        default: {
            const text = blocks(message.content) || (typeof message.summary === "string" ? message.summary : "");
            return text ? { role: String(message.role).toUpperCase(), text, images } : undefined;
        }
    }
}

/** Render original entry content, ignoring context edits, for context_read. */
export function readEntries(sm: SessionManager, entries: readonly SessionEntry[],
    options: { maxChars: number; untilId?: string }): (TextContent | ImageContent)[] {
    const branch = sm.getBranch();
    const onPath = new Set(branch.map((entry) => entry.id));
    const edits = collectEdits(branch);
    const removals = activeRemovals(branch, edits);
    const removed = removedIds(edits);
    const single = entries.length === 1;
    const parts: string[] = [];
    const images: ImageContent[] = [];
    let used = 0;
    let shown = 0;
    let truncatedAt: string | undefined;
    let partial = false;
    for (const entry of entries) {
        const body = entryBody(entry);
        if (!body) {
            if (single) parts.push(`--- ${entry.id} [${entry.type}] (no model content)`);
            continue;
        }
        const status = !onPath.has(entry.id) ? "off the active path"
            : removals.has(entry.id) ? "hosts a removal note in context"
                : removed.has(entry.id) ? "removed from context"
                    : edits.has(entry.id) ? "edited in context" : undefined;
        const label = sm.getLabel(entry.id);
        const meta = [label && `checkpoint: ${label}`, status].filter(Boolean).join(", ");
        const chunk = `--- ${entry.id} [${body.role}]${meta ? ` (${meta})` : ""}\n${body.text}`;
        if (used + chunk.length > options.maxChars) {
            parts.push(chunk.slice(0, Math.max(0, options.maxChars - used)));
            truncatedAt = entry.id;
            partial = true;
            break;
        }
        used += chunk.length;
        shown++;
        parts.push(chunk);
        images.push(...body.images);
    }
    const count = shown + (partial ? 1 : 0);
    const header = `context_read: original content of ${count} entr${count === 1 ? "y" : "ies"}${partial ? " (last truncated)" : ""} (context edits not applied).`;
    if (truncatedAt) {
        parts.push(`[truncated at maxChars=${options.maxChars}; continue with context_read({ id: "${truncatedAt}"${options.untilId ? `, until: "${options.untilId}"` : ""} }) or raise maxChars]`);
    }
    return [{ type: "text", text: [header, ...parts].join("\n") }, ...images];
}
