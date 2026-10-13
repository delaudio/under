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
  if (name === "code") panes.push(createPane("yazi"));
  const main: Layout =
    panes.length === 1
      ? leaf(panes[0]!)
      : {
          axis: "row",
          ratio: 0.65,
          first: leaf(panes[0]!),
          second: leaf(panes[1]!),
        };
  return {
    id: uid(),
    name,
    panes,
    focused: panes[0]!.id,
    zoom: false,
    layout:
      name === "code"
        ? { axis: "row", ratio: 0.26, first: leaf(panes[2]!), second: main }
        : main,
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
export const MIN_RATIO = 0.15;
export const MAX_RATIO = 0.85;
/** Keep a split ratio inside the range the state validator accepts. */
export const clampRatio = (value: number) =>
  Math.min(MAX_RATIO, Math.max(MIN_RATIO, value));
export function resize(layout: Layout, target: string, delta: number): Layout {
  if ("pane" in layout) return layout;
  const has = (l: Layout): boolean =>
    "pane" in l ? l.pane === target : has(l.first) || has(l.second);
  if (has(layout.first) || has(layout.second)) {
    const child = has(layout.first) ? layout.first : layout.second;
    if ("pane" in child)
      return {
        ...layout,
        ratio: clampRatio(
          layout.ratio + (has(layout.first) ? delta : -delta),
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
export type SplitPath = ("first" | "second")[];
export type SplitHandle = {
  path: SplitPath;
  axis: "row" | "column";
  /** Boundary coordinate on the split axis, in absolute cells. */
  boundary: number;
  /** Absolute start and end of the handle along the cross axis. */
  span: { start: number; end: number };
  /** Split-axis origin and size, used to turn a pointer cell into a fraction. */
  origin: number;
  size: number;
};
/** Draggable boundaries a layout exposes, mirroring rectangles() geometry. */
export function splitHandles(layout: Layout, rect: Rect): SplitHandle[] {
  const handles: SplitHandle[] = [];
  const walk = (l: Layout, r: Rect, path: SplitPath) => {
    if ("pane" in l) return;
    const size = l.axis === "row" ? r.width : r.height;
    if (size < 8) return;
    const first = Math.max(4, Math.min(size - 4, Math.floor(size * l.ratio)));
    const row = l.axis === "row";
    handles.push({
      path,
      axis: l.axis,
      boundary: (row ? r.x : r.y) + first,
      span: row
        ? { start: r.y, end: r.y + r.height }
        : { start: r.x, end: r.x + r.width },
      origin: row ? r.x : r.y,
      size,
    });
    if (row) {
      walk(l.first, { ...r, width: first }, [...path, "first"]);
      walk(
        l.second,
        { ...r, x: r.x + first, width: size - first },
        [...path, "second"],
      );
    } else {
      walk(l.first, { ...r, height: first }, [...path, "first"]);
      walk(
        l.second,
        { ...r, y: r.y + first, height: size - first },
        [...path, "second"],
      );
    }
  };
  walk(layout, rect, []);
  return handles;
}
/** Set the ratio of the split at `path`, clamped to the safe range. */
export function setSplitRatio(
  layout: Layout,
  path: SplitPath,
  fraction: number,
): Layout {
  if ("pane" in layout) return layout;
  const [head, ...rest] = path;
  if (head === undefined) return { ...layout, ratio: clampRatio(fraction) };
  return head === "first"
    ? { ...layout, first: setSplitRatio(layout.first, rest, fraction) }
    : { ...layout, second: setSplitRatio(layout.second, rest, fraction) };
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
