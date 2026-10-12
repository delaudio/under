#!/usr/bin/env bun
import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { loadState } from "./state.ts";
import { statePath } from "./config.ts";
import { openRemote } from "./bridge.ts";

export const HELP = `Under — a flexible terminal IDE\n\nUsage: under [directory] [--restore] [--no-editor]\n       under open <file> [--line N] [--column N]\n       under --help | --version\n\nCtrl-G enters application navigation; p opens the command palette.\nTools and repository tasks start only through explicit actions.\n--restore restores layout metadata with all processes initially stopped.\nunder open uses UNDER_OPEN_SOCKET inside Yazi, Hunk or task panes.\n`;
export async function main(args = process.argv.slice(2)) {
  if (args.includes("--help") || args.includes("-h")) { console.log(HELP); return; }
  if (args.includes("--version")) { console.log("0.1.0"); return; }
  if (args[0] === "open") {
    const path = args[1]; if (!path) throw new Error("under open requires a filename");
    const socket = process.env.UNDER_OPEN_SOCKET; if (!socket) throw new Error("No Under editor bridge; run this from a tool pane");
    const number = (flag: string, fallback: number, min: number) => { const i = args.indexOf(flag); const n = i < 0 ? fallback : Number(args[i + 1]); if (!Number.isInteger(n) || n < min) throw new Error(`Invalid ${flag}`); return n; };
    await openRemote(socket, resolve(path), number("--line", 1, 1), number("--column", 0, 0)); return;
  }
  for (const arg of args) if (arg.startsWith("-") && !["--restore", "--no-editor"].includes(arg)) throw new Error(`Unknown option: ${arg}`);
  const paths = args.filter(x => !x.startsWith("-")); if (paths.length > 1) throw new Error("Expected one directory");
  const cwd = resolve(paths[0] || process.cwd()); if (!(await stat(cwd)).isDirectory()) throw new Error(`Not a directory: ${cwd}`);
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Under needs an interactive terminal; use --help for usage");
  const state = args.includes("--restore") ? await loadState(statePath()) : undefined;
  const { createCliRenderer } = await import("@opentui/core"); const { App } = await import("./app.ts");
  let app: InstanceType<typeof App> | undefined; let signal: string | undefined;
  const terminate = (name: string) => { signal = name; if (app) void app.shutdown(true).catch(e => { console.error(e); app?.disposeUI(); process.exitCode = 1; }); };
  const listeners = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const s of listeners) process.on(s, () => terminate(s));
  const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: true });
  app = new App(renderer, cwd, state || undefined);
  if (signal) { await app.shutdown(true); return; }
  if (!state && !args.includes("--no-editor")) {
    try { await app.startInitial(); } catch (e) { console.error(String(e)); /* keep the usable shell UI */ }
  }
}
if (import.meta.main) main().catch(e => { console.error(`under: ${String(e)}`); process.exitCode = 1; });
