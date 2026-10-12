import { randomUUID } from "node:crypto";
export type PaneKind = "nvim" | "yazi" | "hunk" | "agent" | "shell" | "task";
export type Pane = { id: string; kind: PaneKind; profile: string };
export type Layout =
  | { pane: string }
  | { axis: "row" | "column"; ratio: number; first: Layout; second: Layout };
export type Tab = {
  id: string;
  name: string;
  panes: Pane[];
  layout: Layout;
  focused: string;
  zoom: boolean;
};
export type Workspace = {
  id: string;
  path: string;
  tabs: Tab[];
  activeTab: string;
};
export const uid = () => randomUUID();
export const leaf = (pane: Pane): Layout => ({ pane: pane.id });
export function createPane(kind: PaneKind, profile: string = kind): Pane {
  return { id: uid(), kind, profile };
}
export function preset(name: "code" | "review" | "run", agent = "codex"): Tab {
  const panes =
    name === "run"
      ? [createPane("shell")]
      : [
          createPane(name === "code" ? "nvim" : "hunk"),
          createPane("agent", agent),
        ];
  return {
    id: uid(),
    name,
    panes,
    focused: panes[0]!.id,
    zoom: false,
    layout:
      panes.length === 1
        ? leaf(panes[0]!)
        : {
            axis: "row",
            ratio: 0.65,
            first: leaf(panes[0]!),
            second: leaf(panes[1]!),
          },
  };
}
export function createWorkspace(
  path: string,
  name: "code" | "review" | "run" = "code",
): Workspace {
  const tabs = [preset(name)];
  return { id: uid(), path, tabs, activeTab: tabs[0]!.id };
}
export function split(
  layout: Layout,
  target: string,
  pane: string,
  axis: "row" | "column",
): Layout {
  if ("pane" in layout)
    return layout.pane === target
      ? { axis, ratio: 0.5, first: layout, second: { pane } }
      : layout;
  return {
    ...layout,
    first: split(layout.first, target, pane, axis),
    second: split(layout.second, target, pane, axis),
  };
}
export function remove(layout: Layout, id: string): Layout | null {
  if ("pane" in layout) return layout.pane === id ? null : layout;
  const first = remove(layout.first, id),
    second = remove(layout.second, id);
  return !first ? second : !second ? first : { ...layout, first, second };
}
export function resize(layout: Layout, target: string, delta: number): Layout {
  if ("pane" in layout) return layout;
  const has = (l: Layout): boolean =>
    "pane" in l ? l.pane === target : has(l.first) || has(l.second);
  if (has(layout.first) || has(layout.second)) {
    const child = has(layout.first) ? layout.first : layout.second;
    if ("pane" in child)
      return {
        ...layout,
        ratio: Math.min(
          0.85,
          Math.max(0.15, layout.ratio + (has(layout.first) ? delta : -delta)),
        ),
      };
    return {
      ...layout,
      first: resize(layout.first, target, delta),
      second: resize(layout.second, target, delta),
    };
  }
  return layout;
}
export type Rect = { x: number; y: number; width: number; height: number };
export function rectangles(layout: Layout, rect: Rect): Map<string, Rect> {
  const out = new Map<string, Rect>();
  function walk(l: Layout, r: Rect) {
    if ("pane" in l) {
      out.set(l.pane, r);
      return;
    }
    const size = l.axis === "row" ? r.width : r.height;
    // Collapse to the first child at tiny sizes; callers can zoom/focus others.
    if (size < 8) {
      walk(l.first, r);
      return;
    }
    const a = Math.max(4, Math.min(size - 4, Math.floor(size * l.ratio)));
    if (l.axis === "row") {
      walk(l.first, { ...r, width: a });
      walk(l.second, { ...r, x: r.x + a, width: size - a });
    } else {
      walk(l.first, { ...r, height: a });
      walk(l.second, { ...r, y: r.y + a, height: size - a });
    }
  }
  walk(layout, rect);
  return out;
}
