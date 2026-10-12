import type { EditorSnapshot } from "./editor.ts";
export type ContextKind = "file" | "selection" | "diagnostics";
export function contextText(snapshot: EditorSnapshot, kind: ContextKind, maxBytes = 64 * 1024) {
  if (!snapshot.path) throw new Error("Current buffer has no filename");
  if (kind === "selection" && !snapshot.selection.length) throw new Error("Select text in Neovim Visual mode first");
  const range = kind === "selection" && snapshot.selectionRange?.start ? `\nSelection: ${snapshot.selectionRange.start.join(":")}–${snapshot.selectionRange.finish.join(":")} (1-based rows, 0-based byte columns)` : "";
  const payload = `File: ${snapshot.path}\nCursor: ${snapshot.cursor[0]}:${snapshot.cursor[1] + 1}\nBuffer: ${snapshot.modified ? "unsaved" : "saved"}\nContext: ${kind}${range}\n\n` +
    (kind === "diagnostics" ? JSON.stringify(snapshot.diagnostics, null, 2) : (kind === "selection" ? snapshot.selection : snapshot.lines).join("\n"));
  if (Buffer.byteLength(payload) > maxBytes) throw new Error(`Context exceeds ${maxBytes} bytes; select a smaller range`);
  return payload;
}
export function sameSnapshot(a: EditorSnapshot, b: EditorSnapshot) { return a.path === b.path && a.changedtick === b.changedtick && JSON.stringify(a.selection) === JSON.stringify(b.selection) && JSON.stringify(a.cursor) === JSON.stringify(b.cursor) && JSON.stringify(a.diagnostics) === JSON.stringify(b.diagnostics); }
