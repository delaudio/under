import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";

export type Profile = { argv: string[]; env?: Record<string, string> };
export type Task = Profile & { shell?: boolean };
export type Config = {
  prefix: string; preset: "code" | "review" | "run";
  background: string; foreground: string; accent: string;
  profiles: Record<string, Profile>; tasks: Record<string, Task>;
};
export const defaults: Config = {
  prefix: "ctrl+g", preset: "code", background: "#101014", foreground: "#dddde5", accent: "#b7a7e8",
  profiles: { nvim: { argv: ["nvim"] }, yazi: { argv: ["yazi"] }, hunk: { argv: ["hunk", "diff", "--watch"] },
    "hunk-staged": { argv: ["hunk", "diff", "--staged", "--watch"] },
    codex: { argv: ["codex"] }, claude: { argv: ["claude"] }, opencode: { argv: ["opencode"] },
    shell: { argv: [process.env.SHELL || "/bin/sh"] } }, tasks: {},
};
export const userConfigPath = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "under", "config.json");
export const statePath = () => join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "under", "state.json");
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export function validatePatch(value: unknown): Partial<Config> {
  if (!record(value)) throw new Error("configuration must be an object");
  const patch: Partial<Config> = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === "prefix") {
      if (typeof v !== "string" || !/^ctrl\+[a-z]$/.test(v)) throw new Error("prefix must be ctrl+<letter>");
      patch.prefix = v;
    } else if (key === "preset") {
      if (!["code", "review", "run"].includes(String(v))) throw new Error("preset must be code, review or run");
      patch.preset = v as Config["preset"];
    } else if (["background", "foreground", "accent"].includes(key)) {
      if (typeof v !== "string" || !/^#[0-9a-f]{6}$/i.test(v)) throw new Error(`${key} must be #RRGGBB`);
      (patch as Record<string, unknown>)[key] = v;
    } else if (key === "profiles" || key === "tasks") {
      if (!record(v)) throw new Error(`${key} must be an object`);
      const entries: Record<string, Profile | Task> = {};
      for (const [id, entry] of Object.entries(v)) {
        if (!/^[a-z][a-z0-9_-]*$/.test(id) || !record(entry)) throw new Error(`${key}.${id}: invalid profile`);
        if (!Array.isArray(entry.argv) || !entry.argv.length || entry.argv.some(a => typeof a !== "string" || a.includes("\0")) || !entry.argv[0]) throw new Error(`${key}.${id}.argv: expected nonempty string array`);
        if (entry.env !== undefined && (!record(entry.env) || Object.values(entry.env).some(x => typeof x !== "string"))) throw new Error(`${key}.${id}.env: expected string values`);
        if (entry.shell !== undefined && (key !== "tasks" || typeof entry.shell !== "boolean")) throw new Error(`${key}.${id}.shell: invalid`);
        if (Object.keys(entry).some(k => !["argv", "env", "shell"].includes(k))) throw new Error(`${key}.${id}: unknown option`);
        entries[id] = { argv: entry.argv as string[], ...(entry.env ? { env: entry.env as Record<string, string> } : {}), ...(entry.shell !== undefined ? { shell: entry.shell as boolean } : {}) };
      }
      (patch as Record<string, unknown>)[key] = entries;
    } else throw new Error(`unknown option ${key}`);
  }
  return patch;
}
export function loadConfig(cwd: string): { config: Config; warnings: string[] } {
  let config = structuredClone(defaults); const warnings: string[] = [];
  for (const path of [userConfigPath(), resolve(cwd, ".under.json")]) {
    try {
      const patch = validatePatch(JSON.parse(readFileSync(path, "utf8")));
      config = { ...config, ...patch, profiles: { ...config.profiles, ...patch.profiles }, tasks: { ...config.tasks, ...patch.tasks } };
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`${path}: ${String(e)}`); }
  }
  return { config, warnings };
}
