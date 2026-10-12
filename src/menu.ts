import stringWidth from "string-width";
export const MENU_LABELS = [
  "File",
  "View",
  "Review",
  "Tools",
  "Agent",
  "Help",
] as const;
export type MenuLabel = (typeof MENU_LABELS)[number];
export function menuSlots(width: number) {
  let x = 0,
    y = 0;
  const slots = MENU_LABELS.map((label) => {
    const size = Math.min(width, label.length + 2);
    if (x + size > width) {
      x = 0;
      y++;
    }
    const slot = { label, x, y, width: size };
    x += size;
    return slot;
  });
  return { slots, height: y + 1 };
}

/** Wrap by terminal cells, preserving Unicode grapheme clusters. */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  for (const logical of text.replaceAll("\t", "  ").split("\n")) {
    let line = "",
      cells = 0;
    for (const { segment } of segmenter.segment(logical)) {
      const size = stringWidth(segment);
      if (cells + size > Math.max(1, width) && line) {
        lines.push(line);
        line = "";
        cells = 0;
      }
      line += segment;
      cells += size;
    }
    lines.push(line);
  }
  return lines;
}
