import { DynamicBorder, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, Text } from "@earendil-works/pi-tui";

/** Minimal theme surface used by overlay bodies; the identity theme yields plain text. */
export interface OverlayTheme {
    fg(color: any, text: string): string;
    bold(text: string): string;
}

const plainTheme: OverlayTheme = { fg: (_color, text) => text, bold: (text) => text };

/**
 * Show command output without entering model context.
 * TUI: a scrollable overlay (↑/↓, PgUp/PgDn, Home/End; q/Esc/Enter close).
 * Other modes (RPC, JSON, print) cannot host terminal components, so the
 * same lines are sent as plain text through notify.
 */
export async function showTextOverlay(
    ctx: ExtensionCommandContext,
    title: string,
    buildBody: (theme: OverlayTheme) => string[],
): Promise<void> {
    if (ctx.mode !== "tui") {
        ctx.ui.notify(buildBody(plainTheme).join("\n"), "info");
        return;
    }
    await ctx.ui.custom((tui, theme, _kb, done) => {
        const border = () => new DynamicBorder((s: string) => theme.fg("accent", s));
        const header = new Container();
        header.addChild(border());
        header.addChild(new Text(theme.fg("accent", theme.bold(` ${title}`)), 1, 0));
        const body = new Container();
        for (const line of buildBody(theme)) body.addChild(new Text(line, 1, 0));

        let offset = 0;
        let page = Number.POSITIVE_INFINITY;
        let total = 0;
        const scrollable = () => total > page;

        return {
            render(width: number) {
                const head = header.render(width);
                const lines = body.render(width);
                total = lines.length;
                const rows = (tui as { terminal?: { rows?: number } })?.terminal?.rows;
                // Header + footer (hint + border) + a little margin around the overlay.
                page = rows ? Math.max(3, rows - head.length - 4) : Number.POSITIVE_INFINITY;
                offset = Math.max(0, Math.min(offset, total - Math.min(page, total)));
                const visible = scrollable() ? lines.slice(offset, offset + page) : lines;
                const hint = scrollable()
                    ? ` ↑/↓ PgUp/PgDn Home/End scroll · q/Esc close · lines ${offset + 1}-${offset + visible.length} of ${total}`
                    : " Press any key to close";
                const footer = new Container();
                footer.addChild(new Text(theme.fg("dim", hint), 1, 0));
                footer.addChild(border());
                return [...head, ...visible, ...footer.render(width)];
            },
            invalidate() {
                header.invalidate();
                body.invalidate();
            },
            handleInput(data: string) {
                if (!scrollable() || data === "q" || matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
                    done(undefined);
                    return;
                }
                const before = offset;
                if (matchesKey(data, Key.up) || data === "k") offset -= 1;
                else if (matchesKey(data, Key.down) || data === "j") offset += 1;
                else if (matchesKey(data, Key.pageUp)) offset -= page;
                else if (matchesKey(data, Key.pageDown) || data === " ") offset += page;
                else if (matchesKey(data, Key.home) || data === "g") offset = 0;
                else if (matchesKey(data, Key.end) || data === "G") offset = total;
                offset = Math.max(0, Math.min(offset, total - page));
                if (offset !== before) (tui as { requestRender?: () => void })?.requestRender?.();
            },
        };
    }, { overlay: true });
}
