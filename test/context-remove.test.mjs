import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager, convertToLlm } from "@earendil-works/pi-coding-agent";

import registerContext from "../dist/index.js";
import registerDashboard from "../dist/context.js";

function usage() {
    return {
        input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120,
        cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 },
    };
}
const assistant = (content, stopReason = "toolUse") => ({
    role: "assistant", content, api: "anthropic-messages", provider: "fixture",
    model: "offline", usage: usage(), stopReason, timestamp: 1,
});
const call = (id, name, args = {}) => ({ type: "toolCall", id, name, arguments: args });
const user = (text) => ({ role: "user", content: text, timestamp: 1 });
const result = (toolCallId, toolName, text) => ({
    role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false, timestamp: 1,
});

/**
 * u0 a0(c0) r0[start] a1(c1) r1 a2(c2) r2 a3[done] u1 a4(c4) r4 a5(request)
 * The span a1..a3 is the noisy investigation; u1..r4 is recent raw work.
 */
function createHarness({ requestCalls = [call("rm1", "context_remove")] } = {}) {
    const sm = SessionManager.inMemory(process.cwd());
    const ids = {};
    ids.u0 = sm.appendMessage(user("fix parser timeout"));
    ids.a0 = sm.appendMessage(assistant([call("c0", "read", { path: "src/parser.ts" })]));
    ids.r0 = sm.appendMessage(result("c0", "read", "parser.ts contents"));
    sm.appendLabelChange(ids.r0, "parser-investigation-start");
    ids.a1 = sm.appendMessage(assistant([{ type: "text", text: "Searching." }, call("c1", "grep", { pattern: "timeout" })]));
    ids.r1 = sm.appendMessage(result("c1", "grep", "NOISY grep output"));
    ids.a2 = sm.appendMessage(assistant([call("c2", "read", { path: "src/regex.ts" })]));
    ids.r2 = sm.appendMessage(result("c2", "read", "NOISY read output"));
    ids.a3 = sm.appendMessage(assistant([{ type: "text", text: "Root cause: unbounded regex." }], "stop"));
    sm.appendLabelChange(ids.a3, "parser-investigation-done");
    ids.u1 = sm.appendMessage(user("now add a test"));
    ids.a4 = sm.appendMessage(assistant([call("c4", "read", { path: "test/parser.test.ts" })]));
    ids.r4 = sm.appendMessage(result("c4", "read", "test file contents"));
    ids.a5 = sm.appendMessage(assistant(requestCalls));

    const tools = new Map();
    const events = new Map();
    const commands = new Map();
    const sent = [];
    const ctx = {
        sessionManager: sm,
        getContextUsage: () => undefined,
        hasPendingMessages: () => false,
        abort: () => {},
        ui: { notify: () => {} },
    };
    registerContext({
        registerCommand: (name, definition) => commands.set(name, definition),
        registerTool: (definition) => tools.set(definition.name, definition),
        on: (name, handler) => events.set(name, handler),
        setLabel: (id, label) => sm.appendLabelChange(id, label),
        sendUserMessage: () => {},
        sendMessage: (message, options) => sent.push({ message, options }),
    });
    const run = (name, id, params) => tools.get(name).execute(id, params, undefined, undefined, ctx);
    return {
        sm, ids, sent, events, ctx, commands,
        remove: (params, id = "rm1") => run("context_remove", id, params),
        read: (params) => run("context_read", "read1", params),
        timeline: (params = {}) => run("context_timeline", "tl1", params),
        compact: (params, id) => run("context_compact", id, params),
        /** Simulate Pi: tool result, then turn_end drafts committed via SessionManager. */
        commitTurn: async (requestId = ids.a5) => {
            for (const block of sm.getEntry(requestId).message.content) {
                if (block.type === "toolCall") sm.appendMessage(result(block.id, block.name, "ok"));
            }
            const boundary = await events.get("turn_end")({ messageEntryId: requestId, entries: [] }, ctx);
            for (const draft of boundary?.entries ?? []) {
                if (draft.type === "context_edit") sm.appendContextEdit(draft.targetId, draft.replacement);
                else if (draft.type === "custom") sm.appendCustomEntry(draft.customType, draft.data);
            }
            return boundary;
        },
    };
}

const projectedText = (sm) => JSON.stringify(sm.buildSessionProjection().messages);

function assertValidShape(sm) {
    let previous;
    let open = new Set();
    for (const message of convertToLlm(sm.buildSessionProjection().messages)) {
        if (message.role === "assistant") {
            assert.notEqual(previous, "assistant", "no adjacent assistant messages");
            open = new Set(message.content.filter((b) => b.type === "toolCall").map((b) => b.id));
        } else if (message.role === "toolResult") {
            assert.ok(open.delete(message.toolCallId), `tool result ${message.toolCallId} follows its call`);
        } else {
            open = new Set();
        }
        previous = message.role;
    }
}

test("removes a middle span, keeps the tail raw, IDs and usage unchanged", async () => {
    const h = createHarness();
    const entriesBefore = h.sm.getEntries().filter((e) => e.type === "message").length;
    const res = await h.remove({
        after: "parser-investigation-start", until: "parser-investigation-done",
        summary: "unbounded regex in src/regex.ts:120",
    });
    assert.match(res.content[0].text, /context_remove scheduled/);
    // Nothing changes until the turn boundary commits the drafts.
    assert.match(projectedText(h.sm), /NOISY grep output/);

    await h.commitTurn();
    const text = projectedText(h.sm);
    assert.doesNotMatch(text, /NOISY/);
    assert.doesNotMatch(text, /Root cause: unbounded regex/);
    assert.match(text, /\[context_remove\] Removed/);
    assert.match(text, /unbounded regex in src\/regex.ts:120/);
    assert.match(text, /Checkpoints inside: parser-investigation-done/);
    assert.match(text, /parser.ts contents/, "prefix kept");
    assert.match(text, /test file contents/, "tail kept raw");
    assertValidShape(h.sm);

    // Append-only: originals keep their IDs and no billable message is copied.
    for (const id of Object.values(h.ids)) assert.ok(h.sm.getBranch().some((e) => e.id === id));
    const messagesAfter = h.sm.getEntries().filter((e) => e.type === "message").length;
    assert.equal(messagesAfter, entriesBefore + 1, "only the context_remove tool result is new");
    assert.equal(h.sm.getLabel(h.ids.a3), "parser-investigation-done", "labels stay in place");
});

test("context_read returns original content of removed entries", async () => {
    const h = createHarness();
    await h.remove({ after: "parser-investigation-start", until: "parser-investigation-done" });
    await h.commitTurn();
    const res = await h.read({ id: h.ids.a1, until: "parser-investigation-done" });
    const text = res.content[0].text;
    assert.match(text, /NOISY grep output/);
    assert.match(text, /NOISY read output/);
    assert.match(text, /Root cause: unbounded regex/);
    assert.match(text, /removed from context/);
    assert.match(text, /hosts a removal note/);
    assert.match(text, /checkpoint: parser-investigation-done/);

    const truncated = await h.read({ id: h.ids.a1, until: h.ids.a3, maxChars: 60 });
    assert.match(truncated.content[0].text, /truncated at maxChars=60/);
    assert.match(truncated.content[0].text, /^context_read: original content of 1 entry \(last truncated\)/);
    await assert.rejects(h.read({ id: h.ids.a3, until: h.ids.a1 }), /ancestor/);
});

test("timeline marks the gap and removed checkpoints without leaking content", async () => {
    const h = createHarness();
    await h.remove({ after: "parser-investigation-start", until: "parser-investigation-done", summary: "regex" });
    await h.commitTurn();
    const text = (await h.timeline()).content[0].text;
    assert.match(text, /\[REMOVED\] Removed 5 context entries/);
    assert.match(text, /removed from context, checkpoint: parser-investigation-done, phase: done/);
    assert.doesNotMatch(text, /NOISY/);
});

test("pure removal still leaves an automatic gap note", async () => {
    const h = createHarness();
    await h.remove({ after: "parser-investigation-start", until: "parser-investigation-done" });
    await h.commitTurn();
    assert.match(projectedText(h.sm), /\[context_remove\] Removed .*Originals remain in session history/s);
    assert.doesNotMatch(projectedText(h.sm), /Summary:/);
});

test("until on a tool call extends to its result", async () => {
    const h = createHarness();
    const res = await h.remove({ after: "parser-investigation-start", until: h.ids.a1 });
    assert.equal(res.details.record.lastId, h.ids.r1);
    assert.match(res.content[0].text, /end extended/);
    await h.commitTurn();
    assert.doesNotMatch(projectedText(h.sm), /NOISY grep output/);
    assert.match(projectedText(h.sm), /NOISY read output/);
    assertValidShape(h.sm);
});

test("rejects invalid boundaries", async () => {
    const h = createHarness();
    await assert.rejects(h.remove({ after: "parser-investigation-start", until: h.ids.a5 }), /must precede the current turn/);
    await assert.rejects(h.remove({ after: "parser-investigation-done", until: "parser-investigation-start" }), /must come after/);
    await assert.rejects(h.remove({ after: "nope", until: "parser-investigation-done" }), /not on the active path/);
    h.sm.branch(h.ids.r0);
    const sibling = h.sm.appendMessage(user("sibling"));
    h.sm.branch(h.ids.a5);
    await assert.rejects(h.remove({ after: "parser-investigation-start", until: sibling }), /not on the active path/);
});

test("a later removal absorbs an overlapping earlier one and folds its note", async () => {
    const h = createHarness();
    await h.remove({ after: "parser-investigation-start", until: "parser-investigation-done", summary: "first finding" });
    await h.commitTurn();
    const a6 = h.sm.appendMessage(assistant([call("rm2", "context_remove")]));
    const res = await h.remove({ after: "root", until: h.ids.a2 }, "rm2");
    assert.equal(res.details.record.lastId, h.ids.a3, "extended to cover the earlier removal");
    await h.commitTurn(a6);
    const text = projectedText(h.sm);
    assert.match(text, /Earlier removal folded in: .*first finding/);
    assert.doesNotMatch(text, /parser.ts contents/);
    assert.match(text, /fix parser timeout/);
    assertValidShape(h.sm);
    const timeline = (await h.timeline()).content[0].text;
    assert.equal(timeline.match(/\[REMOVED\]/g)?.length, 1, "only the new gap note is active");
    assert.equal(h.sm.getLabel(h.ids.a1), undefined, "folded gap-note label cleared");
    assert.equal(h.sm.getLabel(h.ids.a0), `removed:${h.ids.a0}..${h.ids.a3}`);
    assert.doesNotMatch(text, /Checkpoints inside: [^\n]*removed:/);
});

test("gap note host gets a /tree label, hidden from timeline meta", async () => {
    const h = createHarness();
    await h.remove({ after: "parser-investigation-start", until: "parser-investigation-done" });
    await h.commitTurn();
    assert.equal(h.sm.getLabel(h.ids.a1), `removed:${h.ids.a1}..${h.ids.a3}`);
    assert.doesNotMatch((await h.timeline()).content[0].text, /checkpoint: removed:/);
});

test("/timeline command renders the tool output without touching the session", async () => {
    const h = createHarness();
    await h.remove({ after: "parser-investigation-start", until: "parser-investigation-done" });
    await h.commitTurn();
    const before = h.sm.getEntries().length;
    let rendered;
    await h.commands.get("timeline").handler("--verbose 100", {
        ...h.ctx, hasUI: true,
        ui: {
            notify: () => assert.fail("UI is available"),
            custom: async (factory) => {
                const theme = { fg: (_c, v) => v, bold: (v) => v };
                rendered = factory({}, theme, {}, () => {}).render(250).join("\n");
            },
        },
    });
    assert.match(rendered, /Context Timeline/);
    assert.match(rendered, /\[REMOVED\] Removed 5 context entries/);
    assert.equal(h.sm.getEntries().length, before, "nothing appended");

    const notes = [];
    await h.commands.get("timeline").handler("", { ...h.ctx, hasUI: false, ui: { notify: (t) => notes.push(t) } });
    assert.match(notes[0], /\[REMOVED\]/);
});

test("/context dashboard does not count removed content", async () => {
    const sm = SessionManager.inMemory(process.cwd());
    sm.appendMessage(user("u".repeat(40000)));
    sm.appendMessage(assistant([call("c1", "read")]));
    const big = sm.appendMessage(result("c1", "read", "r".repeat(40000)));
    sm.appendContextEdit(big, { content: "stub" });
    const commands = new Map();
    registerDashboard({ registerCommand: (n, d) => commands.set(n, d), getActiveTools: () => [], getAllTools: () => [] });
    let rendered;
    await commands.get("context").handler("", {
        sessionManager: sm, getSystemPrompt: () => "",
        getContextUsage: () => ({ tokens: 10000, contextWindow: 20000, percent: 50 }),
        ui: {
            notify: () => assert.fail("usage is available"),
            custom: async (factory) => {
                const theme = { fg: (_c, v) => v, bold: (v) => v };
                rendered = factory({}, theme, {}, () => {}).render(120).join("\n");
            },
        },
    });
    assert.match(rendered, /Messages\s+10k/);
    assert.doesNotMatch(rendered, /Tool Call\s+5k/);
});

test("one remove per turn; compact refused while a remove is pending", async () => {
    const h = createHarness({ requestCalls: [call("rm1", "context_remove"), call("rm1b", "context_remove"), call("cp1", "context_compact")] });
    await h.remove({ after: "parser-investigation-start", until: "parser-investigation-done" });
    await assert.rejects(h.remove({ after: "root", until: h.ids.r0 }, "rm1b"), /only one context_remove/);
    await assert.rejects(h.compact({ target: "root", summary: "x" }, "cp1"), /context_remove is pending/);
});

test("unapplied removal is reported at agent_end, not applied to a different turn", async () => {
    const h = createHarness();
    await h.remove({ after: "parser-investigation-start", until: "parser-investigation-done" });
    const boundary = await h.events.get("turn_end")({ messageEntryId: h.ids.a4, entries: [] }, h.ctx);
    assert.equal(boundary, undefined);
    await h.events.get("agent_end")({}, h.ctx);
    assert.match(h.sent.at(-1).message.content, /context_remove was not applied/);
    assert.equal(h.sent.at(-1).options.deliverAs, "nextTurn");
    assert.match(projectedText(h.sm), /NOISY grep output/);
});
