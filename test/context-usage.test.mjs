import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import registerContext from "../dist/index.js";
import { validateThresholds } from "../dist/config.js";

// Explicit env by default so a real ~/.pi/agent/pi-context.json cannot affect these tests.
function createHarness(env = "25,50,75") {
    const previous = process.env.PI_CONTEXT_USAGE_WARNINGS;
    if (env === undefined) delete process.env.PI_CONTEXT_USAGE_WARNINGS;
    else process.env.PI_CONTEXT_USAGE_WARNINGS = env;
    const events = new Map();
    try {
        registerContext({
            registerCommand: () => {}, registerTool: () => {},
            on: (name, handler) => events.set(name, handler),
            setLabel: () => {}, sendUserMessage: () => {}, sendMessage: () => {},
        });
    } finally {
        if (previous === undefined) delete process.env.PI_CONTEXT_USAGE_WARNINGS;
        else process.env.PI_CONTEXT_USAGE_WARNINGS = previous;
    }
    const sm = SessionManager.inMemory(process.cwd());
    sm.appendMessage({ role: "user", content: "hi", timestamp: 1 });
    /** Run one turn_end at `percent` usage and commit drafts like Pi does. */
    const turn = async (percent) => {
        const ctx = {
            sessionManager: sm, abort: () => {},
            getContextUsage: () => percent === undefined ? undefined
                : { percent, tokens: percent * 10_000, contextWindow: 1_000_000 },
        };
        const boundary = await events.get("turn_end")({ messageEntryId: sm.getLeafId(), entries: [] }, ctx);
        for (const draft of boundary?.entries ?? []) {
            if (draft.type === "custom") sm.appendCustomEntry(draft.customType, draft.data);
            else if (draft.type === "custom_message") {
                sm.appendCustomMessageEntry(draft.customType, draft.content, draft.display, draft.details);
            }
        }
        return boundary?.entries ?? [];
    };
    return { sm, turn };
}

const warned = (entries) => entries.filter((e) => e.type === "custom_message").map((e) => e.details.level);

test("warns once per threshold crossed, skips passed levels, re-arms after a drop", async () => {
    const h = createHarness();
    assert.deepEqual(await h.turn(10), []);
    assert.deepEqual(warned(await h.turn(30)), [25]);
    assert.deepEqual(await h.turn(40), [], "no repeat while above 25%");
    assert.deepEqual(warned(await h.turn(80)), [75], "jumps straight to the highest level passed");
    assert.deepEqual(await h.turn(80), []);
    const drop = await h.turn(20);
    assert.deepEqual(drop.map((e) => [e.type, e.data?.level]), [["custom", 0]], "passive re-arm record");
    assert.deepEqual(warned(await h.turn(30)), [25], "warns again after usage fell");
});

test("warning is hidden, model-visible, and informational", async () => {
    const h = createHarness();
    const [draft] = await h.turn(52);
    assert.equal(draft.display, false);
    assert.match(draft.content, /^\[pi-context extension, automatic; not from the user\] Context usage passed 50%: 52\.0% \(520k\/1\.0M\)/);
    assert.match(draft.content, /not an instruction/);
    const projected = JSON.stringify(h.sm.buildSessionProjection().messages);
    assert.match(projected, /Context usage passed 50%/);
});

test("unknown usage and disabled thresholds emit nothing", async () => {
    assert.deepEqual(await createHarness().turn(undefined), []);
    assert.deepEqual(await createHarness("off").turn(90), []);
});

test("custom thresholds", async () => {
    const h = createHarness("60, 90");
    assert.deepEqual(await h.turn(55), []);
    assert.deepEqual(warned(await h.turn(61)), [60]);
    assert.equal(validateThresholds("abc"), undefined);
    assert.equal(validateThresholds("75,25,150"), undefined, "one bad value rejects the whole list");
    assert.deepEqual(validateThresholds("75,25,25"), [25, 75]);
});
