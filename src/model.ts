import { randomUUID } from "node:crypto";
export type PaneKind = "nvim" | "yazi" | "hunk" | "agent" | "shell" | "task";
export const PANE_KINDS: PaneKind[] = [
  "nvim",
  "yazi",
  "hunk",
  "agent",
  "shell",
  "task",
];
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
  /** Template that produced the visible arrangement, when one is applied. */
  template?: string;
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
export type TemplateName =
  | "chat"
  | "code"
  | "files-editor"
  | "review"
  | "files-review"
  | "editor-chat"
  | "editor"
  | "run"
  | "editor-chat-stack";
export type TemplateSlot = { kind: PaneKind; profile?: string };
/** Serialized split tree a configuration file can express: leaves are slot indexes. */
export type NumberLayout =
  | number
  | {
      axis: "row" | "column";
      ratio: number;
      first: NumberLayout;
      second: NumberLayout;
    };
export type Template = {
  label: string;
  /** Panes the template shows, in tab order; reused panes keep their identity. */
  slots: TemplateSlot[];
  /** Slot that receives focus when the current focus is not part of the template. */
  focus: number;
  /** Arrangement over slot indexes, kept as data so templates stay serializable. */
  shape: NumberLayout;
  /** Optional extra shortcut key, from TEMPLATE_KEYS. */
  key?: string;
};
export type Catalogue = {
  templates: Record<string, Template>;
  /** Built-ins first, then user templates in declaration order. */
  order: string[];
};
/** Keys navigation does not own, available to user-defined layout templates. */
export const TEMPLATE_KEYS = [..."acdeghinouvxy"];
export const shapeToLayout = (
  shape: NumberLayout,
  id: (index: number) => string,
): Layout =>
  typeof shape === "number"
    ? { pane: id(shape) }
    : {
        axis: shape.axis,
        ratio: shape.ratio,
        first: shapeToLayout(shape.first, id),
        second: shapeToLayout(shape.second, id),
      };
/** Shortcut order: the digit after the navigation prefix applies each template. */
export const TEMPLATE_ORDER: TemplateName[] = [
  "chat",
  "code",
  "files-editor",
  "review",
  "files-review",
  "editor-chat",
  "editor",
  "run",
  "editor-chat-stack",
];
const row = (
  ratio: number,
  first: NumberLayout,
  second: NumberLayout,
): NumberLayout => ({ axis: "row", ratio, first, second });
const column = (
  ratio: number,
  first: NumberLayout,
  second: NumberLayout,
): NumberLayout => ({ axis: "column", ratio, first, second });
export const TEMPLATES: Record<TemplateName, Template> = {
  chat: {
    label: "chat only",
    slots: [{ kind: "agent" }],
    focus: 0,
    shape: 0,
  },
  code: {
    label: "files, editor, chat",
    slots: [
      { kind: "nvim", profile: "nvim" },
      { kind: "agent" },
      { kind: "yazi", profile: "yazi" },
    ],
    focus: 0,
    shape: row(0.26, 2, row(0.65, 0, 1)),
  },
  "files-editor": {
    label: "files, editor",
    slots: [
      { kind: "yazi", profile: "yazi" },
      { kind: "nvim", profile: "nvim" },
    ],
    focus: 1,
    shape: row(0.3, 0, 1),
  },
  review: {
    label: "hunk, chat",
    slots: [
      { kind: "hunk", profile: "hunk" },
      { kind: "agent" },
    ],
    focus: 0,
    shape: row(0.65, 0, 1),
  },
  "files-review": {
    label: "files, hunk, chat",
    slots: [
      { kind: "yazi", profile: "yazi" },
      { kind: "hunk", profile: "hunk" },
      { kind: "agent" },
    ],
    focus: 1,
    shape: row(0.26, 0, row(0.65, 1, 2)),
  },
  "editor-chat": {
    label: "editor, chat",
    slots: [
      { kind: "nvim", profile: "nvim" },
      { kind: "agent" },
    ],
    focus: 0,
    shape: row(0.65, 0, 1),
  },
  editor: {
    label: "editor only",
    slots: [{ kind: "nvim", profile: "nvim" }],
    focus: 0,
    shape: 0,
  },
  run: {
    label: "shell only",
    slots: [{ kind: "shell", profile: "shell" }],
    focus: 0,
    shape: 0,
  },
  "editor-chat-stack": {
    label: "editor above chat",
    slots: [
      { kind: "nvim", profile: "nvim" },
      { kind: "agent" },
    ],
    focus: 0,
    shape: column(0.6, 0, 1),
  },
};
const slotProfile = (slot: TemplateSlot, agent: string) =>
  slot.kind === "agent"
    ? (slot.profile ?? agent)
    : (slot.profile ?? slot.kind);
/** Merge user templates over the built-ins; an override keeps its position. */
export function catalogue(custom: Record<string, Template> = {}): Catalogue {
  return {
    templates: { ...TEMPLATES, ...custom },
    order: [
      ...TEMPLATE_ORDER,
      ...Object.keys(custom).filter((name) => !(name in TEMPLATES)),
    ],
  };
}
export const BUILTIN_CATALOGUE: Catalogue = catalogue();
/** Pane ids in layout order, which is also the visible pane order. */
export function paneOrder(layout: Layout): string[] {
  return "pane" in layout
    ? [layout.pane]
    : [...paneOrder(layout.first), ...paneOrder(layout.second)];
}
export function preset(
  name: string = "code",
  agent = "codex",
  c: Catalogue = BUILTIN_CATALOGUE,
): Tab {
  const template = c.templates[name] ?? c.templates["code"]!;
  const templateName = c.templates[name] ? name : "code";
  const panes = template.slots.map((slot) =>
    createPane(slot.kind, slotProfile(slot, agent)),
  );
  return {
    id: uid(),
    name: templateName,
    panes,
    focused: panes[template.focus]!.id,
    zoom: false,
    layout: shapeToLayout(template.shape, (index) => panes[index]!.id),
    template: templateName,
  };
}
/** Show the template's panes and arrange them. Never stops or restarts a pane. */
export function applyTemplate(
  tab: Tab,
  name: string,
  agent = "codex",
  c: Catalogue = BUILTIN_CATALOGUE,
): void {
  const template = c.templates[name];
  // A stored template can disappear when configuration changes; keep the tab.
  if (!template) return;
  const shown = new Set(paneOrder(tab.layout));
  const used = new Set<string>();
  const chosen = template.slots.map((slot) => {
    const pool = tab.panes.filter(
      (pane) => pane.kind === slot.kind && !used.has(pane.id),
    );
    const reuse =
      pool.find((pane) => shown.has(pane.id)) ??
      pool.find((pane) => pane.profile === slotProfile(slot, agent)) ??
      pool[0];
    if (reuse) {
      used.add(reuse.id);
      return reuse;
    }
    const pane = createPane(slot.kind, slotProfile(slot, agent));
    tab.panes.push(pane);
    return pane;
  });
  tab.layout = shapeToLayout(template.shape, (index) => chosen[index]!.id);
  tab.template = name;
  tab.zoom = false;
  if (!chosen.some((pane) => pane.id === tab.focused))
    tab.focused = chosen[template.focus]!.id;
}
export function createWorkspace(
  path: string,
  name: string = "code",
  c: Catalogue = BUILTIN_CATALOGUE,
): Workspace {
  const tabs = [preset(name, "codex", c)];
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
