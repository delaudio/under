import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import {
  PANE_KINDS,
  TEMPLATE_KEYS,
  type NumberLayout,
  type PaneKind,
  type Template,
  type TemplateSlot,
} from "./model.ts";

export type Profile = { argv: string[]; env?: Record<string, string> };
export type Task = Profile & { shell?: boolean };
export type Config = {
  prefix: string;
  preset: string;
  background: string;
  foreground: string;
  accent: string;
  profiles: Record<string, Profile>;
  tasks: Record<string, Task>;
  templates: Record<string, Template>;
};
export const defaults: Config = {
  prefix: "ctrl+g",
  preset: "code",
  background: "#101014",
  foreground: "#dddde5",
  accent: "#b7a7e8",
  profiles: {
    nvim: { argv: ["nvim"] },
    yazi: { argv: ["yazi"] },
    hunk: { argv: ["hunk", "diff", "--watch"] },
    "hunk-staged": { argv: ["hunk", "diff", "--staged", "--watch"] },
    codex: { argv: ["codex"] },
    claude: { argv: ["claude"] },
    opencode: { argv: ["opencode"] },
    shell: { argv: [process.env.SHELL || "/bin/sh"] },
  },
  tasks: {},
  templates: {},
};
export const userConfigPath = () =>
  join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "under",
    "config.json",
  );
export const statePath = () =>
  join(
    process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
    "under",
    "state.json",
  );
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const ID_PATTERN = /^[a-z][a-z0-9_-]*$/;
const isIndex = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0;
function numberLayout(value: unknown, depth = 0): NumberLayout {
  if (isIndex(value)) return value;
  if (!record(value)) throw new Error("layout must be an index or a split");
  if (depth > 30) throw new Error("layout is too deep");
  if (value.axis !== "row" && value.axis !== "column")
    throw new Error("layout.axis must be row or column");
  const { ratio } = value;
  if (typeof ratio !== "number" || ratio < 0.15 || ratio > 0.85)
    throw new Error("layout.ratio must be between 0.15 and 0.85");
  return {
    axis: value.axis,
    ratio,
    first: numberLayout(value.first, depth + 1),
    second: numberLayout(value.second, depth + 1),
  };
}
const templateSlots = (value: unknown): TemplateSlot[] => {
  if (!Array.isArray(value) || !value.length)
    throw new Error("panes must be a non-empty array");
  return value.map((entry, index) => {
    if (!record(entry)) throw new Error(`panes.${index} must be an object`);
    if (!PANE_KINDS.includes(entry.kind as PaneKind))
      throw new Error(`panes.${index}.kind must be a pane kind`);
    if (
      entry.profile !== undefined &&
      (typeof entry.profile !== "string" || !ID_PATTERN.test(entry.profile))
    )
      throw new Error(`panes.${index}.profile is invalid`);
    return {
      kind: entry.kind as PaneKind,
      ...(typeof entry.profile === "string"
        ? { profile: entry.profile }
        : entry.kind === "agent"
          ? {}
          : { profile: String(entry.kind) }),
    };
  });
};
const shapeIndices = (shape: NumberLayout): number[] =>
  typeof shape === "number"
    ? [shape]
    : [...shapeIndices(shape.first), ...shapeIndices(shape.second)];
function customTemplate(name: string, value: unknown): Template {
  if (!record(value)) throw new Error("template must be an object");
  const unknown = Object.keys(value).find(
    (key) => !["label", "panes", "layout", "focus", "key"].includes(key),
  );
  if (unknown) throw new Error(`unknown option ${unknown}`);
  const entries = templateSlots(value.panes);
  const shape = numberLayout(value.layout);
  const used = shapeIndices(shape);
  if (
    used.length !== entries.length ||
    new Set(used).size !== entries.length ||
    used.some((index) => index >= entries.length)
  )
    throw new Error("layout must reference every pane exactly once");
  const focus = value.focus === undefined ? 0 : value.focus;
  if (!isIndex(focus) || focus >= entries.length)
    throw new Error("focus is out of range");
  if (value.key !== undefined && typeof value.key !== "string")
    throw new Error("key must be a string");
  if (typeof value.key === "string" && !TEMPLATE_KEYS.includes(value.key))
    throw new Error(`key must be one of ${TEMPLATE_KEYS.join(", ")}`);
  const label = value.label === undefined ? name : value.label;
  if (typeof label !== "string" || !label.trim())
    throw new Error("label must be a non-empty string");
  return {
    label,
    slots: entries,
    focus,
    shape,
    ...(typeof value.key === "string" ? { key: value.key } : {}),
  };
}
export function validatePatch(value: unknown): Partial<Config> {
  if (!record(value)) throw new Error("configuration must be an object");
  const patch: Partial<Config> = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === "prefix") {
      if (typeof v !== "string" || !/^ctrl\+[a-z]$/.test(v))
        throw new Error("prefix must be ctrl+<letter>");
      patch.prefix = v;
    } else if (key === "preset") {
      if (typeof v !== "string" || !ID_PATTERN.test(v))
        throw new Error("preset must be a template name");
      patch.preset = v;
    } else if (key === "templates") {
      if (!record(v)) throw new Error("templates must be an object");
      const templates: Record<string, Template> = {};
      for (const [id, entry] of Object.entries(v)) {
        if (!ID_PATTERN.test(id)) throw new Error(`invalid template name ${id}`);
        try {
          templates[id] = customTemplate(id, entry);
        } catch (e) {
          throw new Error(`templates.${id}: ${String(e)}`);
        }
      }
      (patch as Record<string, unknown>).templates = templates;
    } else if (["background", "foreground", "accent"].includes(key)) {
      if (typeof v !== "string" || !/^#[0-9a-f]{6}$/i.test(v))
        throw new Error(`${key} must be #RRGGBB`);
      (patch as Record<string, unknown>)[key] = v;
    } else if (key === "profiles" || key === "tasks") {
      if (!record(v)) throw new Error(`${key} must be an object`);
      const entries: Record<string, Profile | Task> = {};
      for (const [id, entry] of Object.entries(v)) {
        if (!/^[a-z][a-z0-9_-]*$/.test(id) || !record(entry))
          throw new Error(`${key}.${id}: invalid profile`);
        if (
          !Array.isArray(entry.argv) ||
          !entry.argv.length ||
          entry.argv.some((a) => typeof a !== "string" || a.includes("\0")) ||
          !entry.argv[0]
        )
          throw new Error(`${key}.${id}.argv: expected nonempty string array`);
        if (
          entry.env !== undefined &&
          (!record(entry.env) ||
            Object.values(entry.env).some((x) => typeof x !== "string"))
        )
          throw new Error(`${key}.${id}.env: expected string values`);
        if (
          entry.shell !== undefined &&
          (key !== "tasks" || typeof entry.shell !== "boolean")
        )
          throw new Error(`${key}.${id}.shell: invalid`);
        if (
          Object.keys(entry).some((k) => !["argv", "env", "shell"].includes(k))
        )
          throw new Error(`${key}.${id}: unknown option`);
        entries[id] = {
          argv: entry.argv as string[],
          ...(entry.env ? { env: entry.env as Record<string, string> } : {}),
          ...(entry.shell !== undefined
            ? { shell: entry.shell as boolean }
            : {}),
        };
      }
      (patch as Record<string, unknown>)[key] = entries;
    } else throw new Error(`unknown option ${key}`);
  }
  return patch;
}
export function loadConfig(cwd: string): {
  config: Config;
  warnings: string[];
} {
  let config = structuredClone(defaults);
  const warnings: string[] = [];
  for (const path of [userConfigPath(), resolve(cwd, ".under.json")]) {
    try {
      const patch = validatePatch(JSON.parse(readFileSync(path, "utf8")));
      config = {
        ...config,
        ...patch,
        profiles: { ...config.profiles, ...patch.profiles },
        tasks: { ...config.tasks, ...patch.tasks },
        templates: { ...config.templates, ...patch.templates },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        warnings.push(`${path}: ${String(e)}`);
    }
  }
  return { config, warnings };
}
