import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { describeUsageConfig, resolveUsageConfig, validateThresholds } from "../dist/config.js";

function dirs({ project, user } = {}) {
    const root = mkdtempSync(join(tmpdir(), "pi-context-config-"));
    const cwd = join(root, "proj");
    const agentDir = join(root, "agent");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    if (project !== undefined) writeFileSync(join(cwd, ".pi", "pi-context.json"), project);
    if (user !== undefined) writeFileSync(join(agentDir, "pi-context.json"), user);
    return { cwd, agentDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const resolve = (d, env) => resolveUsageConfig({ env, cwd: d.cwd, agentDir: d.agentDir });

test("defaults when nothing is configured", () => {
    const d = dirs();
    try {
        const c = resolve(d);
        assert.deepEqual([c.thresholds, c.source, c.warnings], [[25, 50, 75], "default", []]);
        assert.match(describeUsageConfig(c), /25%, 50%, 75% \(from defaults\)/);
        assert.match(describeUsageConfig(c), /not found/);
    } finally { d.cleanup(); }
});

test("precedence: env > project > user > defaults", () => {
    const d = dirs({ project: '{"usageWarnings":[40]}', user: '{"usageWarnings":[60,90]}' });
    try {
        assert.deepEqual([resolve(d, "10,20").thresholds, resolve(d, "10,20").source], [[10, 20], "env"]);
        assert.deepEqual([resolve(d).thresholds, resolve(d).source], [[40], "project"]);
        rmSync(join(d.cwd, ".pi", "pi-context.json"));
        assert.deepEqual([resolve(d).thresholds, resolve(d).source], [[60, 90], "user"]);
        assert.equal(resolve(d, "").source, "user", "empty env counts as unset");
    } finally { d.cleanup(); }
});

test("off in a file disables warnings", () => {
    for (const value of ['"off"', "[]", "false"]) {
        const d = dirs({ user: `{"usageWarnings":${value}}` });
        try {
            const c = resolve(d);
            assert.deepEqual([c.thresholds, c.source], [[], "user"]);
            assert.match(describeUsageConfig(c), /warnings: off/);
        } finally { d.cleanup(); }
    }
});

test("invalid sources warn and fall through", () => {
    const d = dirs({ project: "{not json", user: '{"usageWarnings":[50,150]}' });
    try {
        const c = resolve(d, "abc");
        assert.equal(c.source, "default");
        assert.equal(c.warnings.length, 3);
        assert.match(c.warnings[0], /PI_CONTEXT_USAGE_WARNINGS="abc" is invalid/);
        assert.match(c.warnings[1], /invalid JSON/);
        assert.match(c.warnings[2], /"usageWarnings" must be/);
        assert.match(describeUsageConfig(c), /Warning: .*invalid JSON/);
    } finally { d.cleanup(); }
});

test("files without usageWarnings or non-object JSON are skipped", () => {
    const d = dirs({ project: '{"other":1}', user: "[1,2]" });
    try {
        const c = resolve(d);
        assert.equal(c.source, "default");
        assert.deepEqual(c.warnings.length, 1);
        assert.match(c.warnings[0], /expected a JSON object/);
    } finally { d.cleanup(); }
});

test("validateThresholds", () => {
    assert.deepEqual(validateThresholds([75, "25", 25]), [25, 75]);
    assert.deepEqual(validateThresholds("off"), []);
    assert.equal(validateThresholds([0]), undefined);
    assert.equal(validateThresholds("50,,75"), undefined);
    assert.equal(validateThresholds(50), undefined);
});
