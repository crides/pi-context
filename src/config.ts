import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DefaultUsageThresholds } from "./usage.js";

/** Extension config file name, under the Pi agent dir (user) or `<cwd>/.pi/` (project). */
export const ConfigFileName = "pi-context.json";
export const UsageEnvVar = "PI_CONTEXT_USAGE_WARNINGS";

export type UsageSource = "env" | "project" | "user" | "default";

export interface UsageConfig {
    thresholds: number[];
    source: UsageSource;
    /** Ignored invalid inputs, in the order they were checked. */
    warnings: string[];
    files: { project: string; user: string };
}

/**
 * Validate a threshold setting: "off"/"none"/"false"/"0", false or [] disable;
 * otherwise a list (array or comma-separated string) of percentages in (0, 100).
 * Any invalid element rejects the whole value (undefined), so typos are reported, not half-applied.
 */
export function validateThresholds(value: unknown): number[] | undefined {
    if (value === false) return [];
    if (typeof value === "string") {
        const text = value.trim();
        if (/^(off|none|false|0)$/i.test(text)) return [];
        if (!text) return undefined;
        value = text.split(",").map((part) => part.trim());
    }
    if (!Array.isArray(value)) return undefined;
    const numbers = value.map((item) => typeof item === "string" && !item.trim() ? NaN : Number(item));
    if (numbers.some((n) => !Number.isFinite(n) || n <= 0 || n >= 100)) return undefined;
    return [...new Set(numbers)].sort((a, b) => a - b);
}

/** Resolve thresholds: env var > project file > user file > defaults. Invalid sources are skipped with a warning. */
export function resolveUsageConfig(options: { env: string | undefined; cwd: string; agentDir: string }): UsageConfig {
    const files = {
        project: join(options.cwd, ".pi", ConfigFileName),
        user: join(options.agentDir, ConfigFileName),
    };
    const warnings: string[] = [];
    const result = (thresholds: number[], source: UsageSource): UsageConfig => ({ thresholds, source, warnings, files });

    if (options.env !== undefined && options.env.trim() !== "") {
        const thresholds = validateThresholds(options.env);
        if (thresholds) return result(thresholds, "env");
        warnings.push(`${UsageEnvVar}="${options.env}" is invalid; ignored.`);
    }
    for (const source of ["project", "user"] as const) {
        const path = files[source];
        if (!existsSync(path)) continue;
        let data: unknown;
        try {
            data = JSON.parse(readFileSync(path, "utf8"));
        } catch (err) {
            warnings.push(`${path}: invalid JSON (${err instanceof Error ? err.message : String(err)}); ignored.`);
            continue;
        }
        if (typeof data !== "object" || data === null || Array.isArray(data)) {
            warnings.push(`${path}: expected a JSON object; ignored.`);
            continue;
        }
        if (!("usageWarnings" in data)) continue;
        const thresholds = validateThresholds((data as { usageWarnings: unknown }).usageWarnings);
        if (thresholds) return result(thresholds, source);
        warnings.push(`${path}: "usageWarnings" must be "off" or a list of percentages between 0 and 100; ignored.`);
    }
    return result([...DefaultUsageThresholds], "default");
}

/** Plain-text report for /context-warnings. */
export function describeUsageConfig(config: UsageConfig): string {
    const sourceLabel = {
        env: `env ${UsageEnvVar}`,
        project: `project file ${config.files.project}`,
        user: `user file ${config.files.user}`,
        default: "defaults",
    }[config.source];
    const file = (path: string) => `${path}${existsSync(path) ? "" : " (not found)"}`;
    return [
        `Context usage warnings: ${config.thresholds.length ? config.thresholds.map((t) => `${t}%`).join(", ") : "off"} (from ${sourceLabel})`,
        `Precedence: ${UsageEnvVar} > project file > user file > defaults (${DefaultUsageThresholds.join(", ")}).`,
        `Project file: ${file(config.files.project)}`,
        `User file: ${file(config.files.user)}`,
        ...config.warnings.map((warning) => `Warning: ${warning}`),
        `Format: { "usageWarnings": [60, 90] } or { "usageWarnings": "off" }. Edit, then /reload to apply.`,
    ].join("\n");
}
