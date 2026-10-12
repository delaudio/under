import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspace, createPane, split, remove, rectangles, resize } from "../src/model.ts";
import { validatePatch, loadConfig } from "../src/config.ts";
import { validateState, saveState, loadState } from "../src/state.ts";
import { InputOwner } from "../src/input.ts";
import { contextText, sameSnapshot } from "../src/context.ts";
import { FileBridge, openRemote } from "../src/bridge.ts";
import { main } from "../src/main.ts";
import { fileDiff } from "../src/git.ts";
import { createServer, createConnection, type Socket } from "node:net";
import { Rpc } from "../src/editor.ts";

test("configuration validates commands, prefix and unknown keys", () => {
  expect(validatePatch({ profiles: { example: { argv: ["echo", "a ' $() unicode è"] } } }).profiles!.example!.argv[1]).toContain("$()");
  for (const v of [{ prefix: "escape" }, { tasks: { bad: { argv: [] } } }, { profiles: { bad: { argv: ["x"], env: { KEY: 5 } } } }, { arbitrary: true }]) expect(() => validatePatch(v)).toThrow();
});
test("malformed project configuration reports a warning without losing defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "under-config-"));
  try { await writeFile(join(dir, ".under.json"), '{"prefix":1}'); const result = loadConfig(dir); expect(result.warnings.length).toBe(1); expect(result.config.profiles.nvim!.argv[0]).toBe("nvim"); }
  finally { await rm(dir, { recursive: true }); }
});
test("prefix preserves native input and modal ownership", () => {
  const owner = new InputOwner(); const key = (name: string, ctrl = false) => ({ name, ctrl });
  expect(owner.handle(key("escape"))).toBe("forward");
  expect(owner.handle(key("g", true))).toBe("consume");
  expect(owner.handle(key("g", true))).toBe("literal"); expect(owner.literal()[0]).toBe(7);
  expect(owner.mode).toBe("terminal"); owner.mode = "modal";
  expect(owner.handle(key("g", true))).toBe("consume"); expect(owner.mode).toBe("modal");
});
test("nested splits cover all panes with positive geometry and remove cleanly", () => {
  const w = createWorkspace("/tmp"), t = w.tabs[0]!, p = createPane("shell");
  t.layout = split(t.layout, t.focused, p.id, "column"); t.panes.push(p);
  for (const [width, height] of [[120, 30], [80, 24], [50, 15]]) {
    const r = rectangles(t.layout, { x: 0, y: 0, width: width!, height: height! });
    expect(r.size).toBe(3); for (const c of r.values()) { expect(c.width).toBeGreaterThan(0); expect(c.height).toBeGreaterThan(0); }
  }
  t.layout = resize(t.layout, p.id, 100); expect(JSON.stringify(t.layout)).toContain("0.15");
  t.layout = remove(t.layout, p.id)!; expect(rectangles(t.layout, { x: 0, y: 0, width: 80, height: 24 }).size).toBe(2);
});
test("state roundtrip and corruption validation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "under-state-")); const w = createWorkspace("/tmp"); const state = { version: 1 as const, workspaces: [w], active: w.id };
  try {
    await saveState(join(dir, "state.json"), state); expect(await loadState(join(dir, "state.json"))).toEqual(state);
    expect(() => validateState({ ...state, version: 2 })).toThrow();
    const duplicate = structuredClone(state); duplicate.workspaces[0]!.tabs[0]!.panes[1]!.id = duplicate.workspaces[0]!.tabs[0]!.panes[0]!.id;
    expect(() => validateState(duplicate)).toThrow();
    const leaked: any = structuredClone(state); leaked.workspaces[0].secret = "not metadata";
    expect(JSON.stringify(validateState(leaked))).not.toContain("secret");
  } finally { await rm(dir, { recursive: true }); }
});
test("context includes live buffer status, rejects oversized or absent selections", () => {
  const s = { path: "/tmp/è.ts", lines: ["const x = 1"], cursor: [1, 0] as [number, number], changedtick: 1, modified: true, selection: [], diagnostics: [] };
  expect(contextText(s, "file")).toContain("unsaved");
  expect(() => contextText(s, "selection")).toThrow(); expect(() => contextText(s, "file", 1)).toThrow();
  expect(sameSnapshot(s, { ...s, changedtick: 2 })).toBe(false);
});
test.skipIf(process.env.UNDER_NO_SOCKETS === "1")("editor bridge isolates two instances and supports arbitrary filenames", async () => {
  const a = new FileBridge(), b = new FileBridge(); const first: string[] = [], second: string[] = [];
  try {
    await a.start(async p => { first.push(p); }); await b.start(async p => { second.push(p); });
    await openRemote(a.path, "/tmp/a ' è.ts", 2, 1); await openRemote(b.path, "/tmp/b.ts");
    expect(first).toEqual(["/tmp/a ' è.ts"]); expect(second).toEqual(["/tmp/b.ts"]);
    await expect(openRemote(a.path, "relative.ts")).rejects.toThrow();
  } finally { await a.close(); await b.close(); }
});
test("CLI invalid options reject without starting tools", async () => { await expect(main(["--invalid"])).rejects.toThrow("Unknown option"); });
test("bounded Git context scopes paths and distinguishes staged changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "under-git-")); const path = join(dir, "quote ' è.ts");
  try {
    Bun.spawnSync({ cmd: ["git", "init"], cwd: dir }); await writeFile(path, "first\n"); Bun.spawnSync({ cmd: ["git", "add", "--", path], cwd: dir });
    expect(await fileDiff(dir, path, true)).toContain("+first"); await writeFile(path, "second\n"); expect(await fileDiff(dir, path)).toContain("+second");
    await expect(fileDiff(dir, "/other/project.ts")).rejects.toThrow("outside");
  } finally { await rm(dir, { recursive: true }); }
});
test.skipIf(process.env.UNDER_NO_SOCKETS === "1")("RPC times out pending requests and rejects immediately on disposal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "under-rpc-")); const path = join(dir, "silent.sock");
  let peer: Socket | undefined; const server = createServer(s => { peer = s; s.on("data", () => {}); });
  await new Promise<void>(ok => server.listen(path, ok));
  const socket = await new Promise<Socket>(ok => { const s = createConnection(path, () => ok(s)); }); const rpc = new Rpc(socket);
  try {
    await expect(rpc.call("silent", [], 25)).rejects.toThrow("RPC timeout");
    const pending = rpc.call("pending", [], 5000); rpc.dispose(); await expect(pending).rejects.toThrow("disconnected");
  } finally { rpc.dispose(); peer?.destroy(); await new Promise<void>(ok => server.close(() => ok())); await rm(dir, { recursive: true }); }
});
