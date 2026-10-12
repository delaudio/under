import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Workspace, Layout } from "./model.ts";
export type State = { version: 1; workspaces: Workspace[]; active: string };
export async function saveState(path: string, state: State) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, path);
}
export function validateState(v: any): State {
  if (
    v?.version !== 1 ||
    !Array.isArray(v.workspaces) ||
    typeof v.active !== "string"
  )
    throw new Error("Unsupported workspace state");
  const ids = new Set<string>();
  function id(x: unknown) {
    if (typeof x !== "string" || !x || ids.has(x))
      throw new Error("Invalid or duplicate ID");
    ids.add(x);
  }
  for (const w of v.workspaces) {
    id(w.id);
    if (
      typeof w.path !== "string" ||
      !w.path.startsWith("/") ||
      !Array.isArray(w.tabs) ||
      !w.tabs.length
    )
      throw new Error("Invalid workspace");
    for (const t of w.tabs) {
      id(t.id);
      if (
        typeof t.name !== "string" ||
        typeof t.zoom !== "boolean" ||
        !Array.isArray(t.panes) ||
        !t.panes.length
      )
        throw new Error("Invalid tab");
      for (const p of t.panes) {
        id(p.id);
        if (
          !["nvim", "yazi", "hunk", "agent", "shell", "task"].includes(
            p.kind,
          ) ||
          typeof p.profile !== "string"
        )
          throw new Error("Invalid pane");
      }
      const leaves = new Set<string>();
      function tree(l: Layout, depth: number) {
        if (!l || depth > 30) throw new Error("Invalid layout");
        if ("pane" in l) {
          if (!t.panes.some((p: any) => p.id === l.pane) || leaves.has(l.pane))
            throw new Error("Invalid layout reference");
          leaves.add(l.pane);
        } else {
          if (
            !["row", "column"].includes(l.axis) ||
            !Number.isFinite(l.ratio) ||
            l.ratio < 0.15 ||
            l.ratio > 0.85
          )
            throw new Error("Invalid split");
          tree(l.first, depth + 1);
          tree(l.second, depth + 1);
        }
      }
      tree(t.layout, 0);
      if (leaves.size !== t.panes.length || !leaves.has(t.focused))
        throw new Error("Invalid focus or pane list");
    }
    if (!w.tabs.some((t: any) => t.id === w.activeTab))
      throw new Error("Invalid active tab");
  }
  if (!v.workspaces.some((w: any) => w.id === v.active))
    throw new Error("Invalid active workspace");
  // Whitelist metadata, stripping unknown properties rather than retaining secrets.
  const cleanLayout = (l: Layout): Layout =>
    "pane" in l
      ? { pane: l.pane }
      : {
          axis: l.axis,
          ratio: l.ratio,
          first: cleanLayout(l.first),
          second: cleanLayout(l.second),
        };
  return {
    version: 1,
    active: v.active,
    workspaces: v.workspaces.map((w: any) => ({
      id: w.id,
      path: w.path,
      activeTab: w.activeTab,
      tabs: w.tabs.map((t: any) => ({
        id: t.id,
        name: t.name,
        focused: t.focused,
        zoom: t.zoom,
        layout: cleanLayout(t.layout),
        panes: t.panes.map((p: any) => ({
          id: p.id,
          kind: p.kind,
          profile: p.profile,
        })),
      })),
    })),
  };
}
export async function loadState(path: string): Promise<State | null> {
  try {
    return validateState(JSON.parse(await readFile(path, "utf8")));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
