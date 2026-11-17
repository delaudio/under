import { basename, dirname } from "node:path";
import stringWidth from "string-width";
import { StyledText, type TextChunk } from "@opentui/core";
import { bg, bold, fg, italic } from "@opentui/core";
import type { EditorBuffers } from "./editor.ts";
import type { Palette } from "./theme.ts";

/** A clickable column range of the strip: the tab body selects, the glyph
 * after the name closes. */
export type TabHit = { start: number; end: number; id: number; close: boolean };

const CLOSE = "×";
const MODIFIED = "●";
const SEPARATOR = "▏";

/** Basenames, with the parent directory added where two tabs would read alike. */
export function tabLabels(paths: string[]): string[] {
  const parts = paths.map((p) => p.split("/").filter(Boolean));
  const depth = paths.map(() => 1);
  const label = (i: number) => parts[i]!.slice(-depth[i]!).join("/");
  // Add parent directories only to labels that still collide.
  for (let round = 0; round < 32; round++) {
    const labels = paths.map((_, i) => label(i));
    let grew = false;
    labels.forEach((l, i) => {
      if (labels.filter((x) => x === l).length > 1 && depth[i]! < parts[i]!.length) {
        depth[i]!++;
        grew = true;
      }
    });
    if (!grew) break;
  }
  return paths.map((path, i) => label(i) || basename(path) || dirname(path));
}

/**
 * Lay out the editor's buffers as tabs in `width` columns, as Fresh does: the
 * current buffer is always visible, a preview is italic, and a modified buffer
 * shows ● where the close button would be (closing it is refused). Tabs that do
 * not fit are replaced by ‹ / › markers.
 */
export function bufferStrip(
  state: EditorBuffers,
  width: number,
  colors: Palette,
): { text: StyledText; hits: TabHit[] } {
  const labels = tabLabels(state.buffers.map((b) => b.name)).map((label) =>
    label.replace(/[\x00-\x1f\x7f]/g, "�"),
  );
  const cells = labels.map((label) => ` ${label} x `);
  const widths = cells.map((c) => stringWidth(c) + 1);
  const current = Math.max(
    0,
    state.buffers.findIndex((b) => b.id === state.current),
  );
  // Grow a window around the current tab, preferring the tabs after it.
  let first = current;
  let last = current;
  let used = widths[current] ?? 0;
  const room = Math.max(0, width - 2);
  for (let grew = true; grew; ) {
    grew = false;
    if (last + 1 < widths.length && used + widths[last + 1]! <= room) {
      used += widths[++last]!;
      grew = true;
    }
    if (first > 0 && used + widths[first - 1]! <= room) {
      used += widths[--first]!;
      grew = true;
    }
  }
  const chunks: TextChunk[] = [];
  const hits: TabHit[] = [];
  let column = 0;
  const push = (chunk: TextChunk, text: string) => {
    chunks.push(chunk);
    column += stringWidth(text);
  };
  if (first > 0) push(fg(colors.muted)("‹"), "‹");
  for (let i = first; i <= last && i < state.buffers.length; i++) {
    const buffer = state.buffers[i]!;
    const active = buffer.id === state.current;
    const back = active ? colors.background : colors.surface;
    const ink = active ? colors.foreground : colors.muted;
    let name: TextChunk = fg(ink)(` ${labels[i]} `);
    if (active) name = bold(name);
    if (buffer.preview) name = italic(name);
    const start = column;
    push(bg(back)(name), ` ${labels[i]} `);
    const glyph = buffer.modified ? MODIFIED : CLOSE;
    const close = column;
    push(
      bg(back)(fg(buffer.modified ? colors.accent : colors.muted)(`${glyph} `)),
      `${glyph} `,
    );
    hits.push({ start, end: close, id: buffer.id, close: false });
    hits.push({ start: close, end: column, id: buffer.id, close: true });
    push(fg(colors.border)(SEPARATOR), SEPARATOR);
  }
  if (last < state.buffers.length - 1) push(fg(colors.muted)("›"), "›");
  return { text: new StyledText(chunks), hits };
}
