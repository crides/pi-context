import type { ContextUsage, SessionBoundaryDraft, SessionEntry } from "@earendil-works/pi-coding-agent";
import { formatContextUsage } from "./utils.js";

/** Hidden custom message telling the model a usage threshold was passed. */
export const UsageWarningType = "pi-context-usage";
/** Passive record that usage fell below the last warned threshold (re-arms warnings). */
export const UsageLevelType = "pi-context-usage-level";
export const DefaultUsageThresholds = [25, 50, 75];

/** Last threshold level recorded on this path; branch-relative, so /tree and compaction re-arm naturally. */
export function lastUsageLevel(branch: readonly SessionEntry[]): number {
    for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i];
        if (entry.type === "custom" && entry.customType === UsageLevelType) {
            return Number((entry.data as { level?: unknown } | undefined)?.level) || 0;
        }
        if (entry.type === "custom_message" && entry.customType === UsageWarningType) {
            return Number((entry.details as { level?: unknown } | undefined)?.level) || 0;
        }
    }
    return 0;
}

/**
 * Drafts for a turn boundary: one warning when usage first passes a higher threshold,
 * a passive level record when usage falls below the last warned threshold, else nothing.
 */
export function usageWarningDrafts(branch: readonly SessionEntry[], usage: ContextUsage | undefined,
    thresholds: readonly number[]): SessionBoundaryDraft[] {
    const percent = usage?.percent;
    if (!thresholds.length || percent == null || !Number.isFinite(percent)) return [];
    const level = thresholds.filter((threshold) => percent >= threshold).at(-1) ?? 0;
    const last = lastUsageLevel(branch);
    if (level === last) return [];
    if (level < last) return [{ type: "custom", customType: UsageLevelType, data: { level } }];
    return [{
        type: "custom_message",
        customType: UsageWarningType,
        display: false,
        details: { level },
        content: [
            `[pi-context extension, automatic; not from the user] Context usage passed ${level}%: ${formatContextUsage(usage, true)}.`,
            "This is information, not an instruction. At the next phase boundary, consider context_timeline and whether a stale span is worth context_remove or context_compact under the compact gate.",
        ].join(" "),
    }];
}
