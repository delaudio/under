import frames from "./generated/frames.json";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "./preview.css";

export function terminalPreview(id: keyof typeof frames) {
  const frame = frames[id];
  if (!frame)
    throw new Error(`Missing native frame ${id}; run storybook:frames.`);
  const root = document.createElement("div");
  root.className = "terminal-frame";
  root.dataset.visualSnapshotRoot = "";
  root.dataset.frameId = id;
  root.role = "img";
  root.setAttribute(
    "aria-label",
    `Under terminal: ${id}, ${frame.cols}×${frame.rows}`,
  );
  root.style.width = `${frame.cols * 9}px`;
  root.style.height = `${frame.rows * 20}px`;
  for (const row of frame.lines) {
    const line = document.createElement("div");
    line.className = "terminal-line";
    for (const cell of row.spans) {
      const span = document.createElement("span");
      span.textContent = cell.text;
      Object.assign(span.style, {
        width: `${cell.width * 9}px`,
        color: cell.fg,
        background: cell.bg,
        fontWeight: cell.bold ? "700" : "400",
        fontStyle: cell.italic ? "italic" : "normal",
        textDecoration: cell.underline ? "underline" : "none",
      });
      line.append(span);
    }
    root.append(line);
  }
  return root;
}
