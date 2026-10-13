#!/usr/bin/env bun
import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { loadState } from "./state.ts";
import { statePath } from "./config.ts";
import { openRemote, reviewRemote } from "./bridge.ts";

export const HELP = `Under — a flexible terminal IDE\n\nUsage: under [directory] [--restore] [--no-editor]\n       under open <file> [--line N] [--column N]\n       under review-here [--staged] [--ref <rev>] [--to <rev>]\n       under --help | --version\n\nCtrl-G enters application navigation; m opens the top menu, p the palette.\nFiles are on the left, Neovim in the centre and agent chat on the right.\nClick Agent to choose a provider; Ctrl-G f focuses files.\nCtrl-G h shows the shortcuts; Ctrl-G then 1-9 applies a layout template.\nTools and repository tasks start only through explicit actions.\n--restore restores layout metadata with all processes initially stopped.\nunder open uses UNDER_OPEN_SOCKET inside Yazi, Hunk or task panes.\nunder review-here asks Under to review the current directory in Hunk.\n`;
export async function main(args = process.argv.slice(2)) {
  if (!Bun.semver.satisfies(Bun.version, ">=1.4.3"))
    throw new Error(
      `Under requires Bun >= 1.4.3; found ${Bun.version}. Run: bun upgrade`,
    );
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return;
  }
  if (args.includes("--version")) {
    console.log("0.1.0");
    return;
  }
  if (args[0] === "open") {
    let path = args[1];
    let editorLine = 1;
    if (path && /^\+\d+$/.test(path)) {
      editorLine = Number(path.slice(1));
      path = args[2];
    }
    if (!path) throw new Error("under open requires a filename");
    const socket = process.env.UNDER_OPEN_SOCKET;
    if (!socket)
      throw new Error("No Under editor bridge; run this from a tool pane");
    const number = (flag: string, fallback: number, min: number) => {
      const i = args.indexOf(flag);
      const n = i < 0 ? fallback : Number(args[i + 1]);
      if (!Number.isInteger(n) || n < min) throw new Error(`Invalid ${flag}`);
      return n;
    };
    await openRemote(
      socket,
      resolve(path),
      number("--line", editorLine, 1),
      number("--column", 0, 0),
    );
    return;
  }
  if (args[0] === "review-here") {
    const socket = process.env.UNDER_OPEN_SOCKET;
    if (!socket)
      throw new Error("No Under bridge; run this from a tool pane");
    const value = (flag: string) => {
      const index = args.indexOf(flag);
      if (index < 0) return undefined;
      const next = args[index + 1];
      if (!next || next.startsWith("-")) throw new Error(`Invalid ${flag}`);
      return next;
    };
    const ref = value("--ref");
    const to = value("--to");
    await reviewRemote(socket, {
      dir: process.cwd(),
      ...(args.includes("--staged") ? { staged: true } : {}),
      ...(ref ? { ref } : {}),
      ...(to ? { to } : {}),
    });
    return;
  }
  for (const arg of args)
    if (arg.startsWith("-") && !["--restore", "--no-editor"].includes(arg))
      throw new Error(`Unknown option: ${arg}`);
  const paths = args.filter((x) => !x.startsWith("-"));
  if (paths.length > 1) throw new Error("Expected one directory");
  const cwd = resolve(paths[0] || process.cwd());
  if (!(await stat(cwd)).isDirectory())
    throw new Error(`Not a directory: ${cwd}`);
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "Under needs an interactive terminal; use --help for usage",
    );
  const state = args.includes("--restore")
    ? await loadState(statePath())
    : undefined;
  const { createCliRenderer } = await import("@opentui/core");
  const { App } = await import("./app.ts");
  let app: InstanceType<typeof App> | undefined;
  let signal: string | undefined;
  const terminate = (name: string) => {
    signal = name;
    if (app)
      void app.shutdown(true).catch((e) => {
        console.error(e);
        app?.disposeUI();
        process.exitCode = 1;
      });
  };
  const listeners = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const s of listeners) process.on(s, () => terminate(s));
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useMouse: true,
  });
  app = new App(renderer, cwd, state || undefined);
  if (signal) {
    await app.shutdown(true);
    return;
  }
  if (!args.includes("--restore") && !args.includes("--no-editor")) {
    try {
      await app.startInitial();
    } catch (e) {
      app.report(String(e));
    }
  }
}
if (import.meta.main)
  main().catch((e) => {
    console.error(`under: ${String(e)}`);
    process.exitCode = 1;
  });
