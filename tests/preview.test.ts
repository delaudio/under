import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { mkdir, mkdtemp, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, type PaneEditor, type PaneHost } from "../src/app.ts";
import { defaults, validatePatch } from "../src/config.ts";
import { Editor } from "../src/editor.ts";
import { palette } from "../src/theme.ts";
import { bufferStrip, tabLabels } from "../src/tabs.ts";
import { HOVER_ENV, HOVER_FILE, HOVER_HOOK, yaziConfig } from "../src/yazi.ts";

const running = (): PaneHost => ({
  phase: "running",
  exitCode: null,
  write() {},
  resize() {},
  attach() {},
  async close() {},
});

test("the Yazi overlay runs the hover hook before the user's unchanged init.lua", async () => {
  const home = await mkdtemp(join(tmpdir(), "under-yazi-home-"));
  let overlay = "";
  try {
    // A trailing top-level return must stay the file's last statement.
    const user = "require('full-border'):setup()\nreturn {}\n";
    await writeFile(join(home, "init.lua"), user);
    await writeFile(join(home, HOVER_FILE), "user data");
    overlay = await yaziConfig({
      editor: "/bin/true",
      env: { YAZI_CONFIG_HOME: home },
      showHidden: true,
    });
    const init = await Bun.file(join(overlay, "init.lua")).text();
    expect(init).toBe(`${HOVER_HOOK}\n${user}`);
    // Files Under writes are never links into the user's configuration.
    expect(await Bun.file(join(overlay, HOVER_FILE)).exists()).toBe(false);
    const toml = await Bun.file(join(overlay, "yazi.toml")).text();
    expect(toml).toContain("show_hidden = true");
  } finally {
    await rm(home, { recursive: true, force: true });
    if (overlay) await rm(overlay, { recursive: true, force: true });
  }
});

const yazi = Bun.which("yazi");
test.skipIf(!yazi)(
  "real Yazi reports hovered files through the hook without touching stdout",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "under-hover-")));
    for (const name of ["a.txt", "b.txt"]) await writeFile(join(root, name), name);
    const overlay = await yaziConfig({ editor: "/bin/true", env: { YAZI_CONFIG_HOME: join(root, "none") } });
    const file = join(overlay, HOVER_FILE);
    const child = Bun.spawn([yazi!, root], {
      terminal: { cols: 80, rows: 20, data() {} },
      env: { ...process.env, YAZI_CONFIG_HOME: overlay, [HOVER_ENV]: file },
    });
    const read = async () => (await Bun.file(file).exists() ? Bun.file(file).text() : "");
    try {
      const deadline = Date.now() + 5000;
      while (!(await read()) && Date.now() < deadline) await Bun.sleep(50);
      expect(await read()).toBe(join(root, "a.txt"));
      child.terminal!.write("j");
      while ((await read()) === join(root, "a.txt") && Date.now() < deadline) await Bun.sleep(50);
      expect(await read()).toBe(join(root, "b.txt"));
    } finally {
      child.kill();
      await rm(root, { recursive: true, force: true });
      await rm(overlay, { recursive: true, force: true });
    }
  },
  15_000,
);

test("theme and preview settings are validated, and colours override the theme", () => {
  expect(defaults.theme).toBe("flat");
  expect(defaults.previewOnHover).toBe(true);
  expect(validatePatch({ theme: "classic", previewOnHover: false })).toEqual({
    theme: "classic",
    previewOnHover: false,
  });
  expect(() => validatePatch({ theme: "neon" })).toThrow("theme must be");
  expect(() => validatePatch({ editorTheme: "yes" })).toThrow("true or false");
  expect(palette({ theme: "flat" }).accent).toBe("#ffcc66");
  expect(palette({ theme: "flat", accent: "#123456" }).accent).toBe("#123456");
});

test("moving through the fallback file list previews files without leaving it", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "under-preview-")));
  await writeFile(join(root, "a.ts"), "a\n");
  await writeFile(join(root, "b.ts"), "b\n");
  await writeFile(join(root, "blob.bin"), new Uint8Array([1, 0, 2]));
  const setup = await createTestRenderer({ width: 120, height: 30 });
  const app = new App(setup.renderer, root, undefined, {
    config: defaults,
    files: [
      { name: "a.ts", path: join(root, "a.ts"), directory: false },
      { name: "b.ts", path: join(root, "b.ts"), directory: false },
      { name: "blob.bin", path: join(root, "blob.bin"), directory: false },
    ],
  });
  const opened: string[] = [];
  const editor: PaneEditor = {
    async openFile(path, _line, _column, preview) {
      opened.push(`${preview ? "preview" : "open"}:${path}`);
    },
    async ready() {},
    async modified() {
      return [];
    },
    async quit() {},
    async dispose() {},
    abortInitialization() {},
    async snapshot() {
      throw new Error("Not needed");
    },
  };
  try {
    const pane = app.tab().panes.find((p) => p.kind === "nvim")!;
    app.attachTerminal(pane, running(), editor);
    await setup.flush();
    setup.mockInput.pressKey("g", { ctrl: true });
    setup.mockInput.pressKey("f");
    setup.mockInput.pressKey("j");
    setup.mockInput.pressKey("k");
    setup.mockInput.pressKey("j");
    await Bun.sleep(250);
    // Debounced: only the row the cursor stops on is loaded.
    expect(opened).toEqual([`preview:${join(root, "b.ts")}`]);
    expect(app.input.mode).toBe("app");
    setup.mockInput.pressKey("j");
    await Bun.sleep(250);
    await setup.flush();
    expect(opened).toHaveLength(1);
    expect(setup.captureCharFrame()).toContain("looks binary");
    setup.mockInput.pressKey("k");
    setup.mockInput.pressEnter();
    await Bun.sleep(250);
    expect(opened.at(-1)).toBe(`open:${join(root, "b.ts")}`);
    expect(app.tab().focused).toBe(pane.id);
  } finally {
    app.disposeUI();
    await setup.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

const nvim = process.env.UNDER_TEST_NVIM || Bun.which("nvim");
test.skipIf(!nvim || process.env.UNDER_NO_SOCKETS === "1")(
  "a preview buffer is replaced by the next preview until it is edited",
  async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "under-preview-nvim-")));
    const editor = await Editor.launch({ argv: [nvim!, "--clean"] }, dir);
    editor.host.attach(() => {});
    const listed = () =>
      editor.rpc!.call<string[]>("nvim_exec_lua", [
        "local out={} for _,b in ipairs(vim.api.nvim_list_bufs()) do if vim.fn.buflisted(b)==1 and vim.api.nvim_buf_get_name(b)~='' then table.insert(out,vim.fs.basename(vim.api.nvim_buf_get_name(b))) end end table.sort(out) return out",
        [],
      ]);
    try {
      await editor.ready();
      for (const name of ["kept.ts", "a.ts", "b.ts", "c.ts"])
        await writeFile(join(dir, name), `${name}\n`);
      await editor.openFile(join(dir, "kept.ts"));
      await editor.openFile(join(dir, "a.ts"), 1, 0, true);
      await editor.openFile(join(dir, "b.ts"), 1, 0, true);
      expect(await listed()).toEqual(["b.ts", "kept.ts"]);
      // Previewing a buffer the user already had keeps its cursor and never
      // closes it later.
      await writeFile(join(dir, "kept.ts"), "one\ntwo\nthree\n");
      await editor.openFile(join(dir, "kept.ts"), 3, 0);
      await editor.openFile(join(dir, "b.ts"), 1, 0, true);
      await editor.openFile(join(dir, "kept.ts"), 1, 0, true);
      expect((await editor.snapshot()).cursor[0]).toBe(3);
      await editor.openFile(join(dir, "a.ts"), 1, 0, true);
      expect(await listed()).toEqual(["a.ts", "kept.ts"]);
      // Editing promotes the preview to a normal buffer.
      await editor.rpc!.call("nvim_buf_set_lines", [0, 0, -1, false, ["edited"]]);
      await editor.openFile(join(dir, "b.ts"), 1, 0, true);
      expect(await listed()).toEqual(["a.ts", "b.ts", "kept.ts"]);
      // A normal open (Enter) also promotes it.
      await editor.openFile(join(dir, "b.ts"));
      await editor.openFile(join(dir, "c.ts"), 1, 0, true);
      expect(await listed()).toEqual(["a.ts", "b.ts", "c.ts", "kept.ts"]);
      // A floating picker keeps focus and its buffer; the preview loads into a
      // normal window without leaving the picker.
      const picker = await editor.rpc!.call<number>("nvim_exec_lua", [
        "local b=vim.api.nvim_create_buf(false,true) vim.bo[b].buftype='nofile' vim.api.nvim_open_win(b,true,{relative='editor',row=1,col=1,width=10,height=3}) return b",
        [],
      ]);
      await editor.openFile(join(dir, "kept.ts"), 1, 0, true);
      expect(
        await editor.rpc!.call<unknown>("nvim_exec_lua", [
          "local p=... local shown='' for _,w in ipairs(vim.api.nvim_list_wins()) do if vim.api.nvim_win_get_config(w).relative=='' then shown=vim.fs.basename(vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(w))) end end return {vim.api.nvim_get_current_buf()==p, vim.api.nvim_win_get_config(0).relative~='', shown}",
          [picker],
        ]),
      ).toEqual([true, true, "kept.ts"]);
      await editor.rpc!.call("nvim_command", ["close"]);
      await editor.rpc!.call("nvim_command", ["wa"]);
      await editor.quit();
    } finally {
      await editor.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
  15_000,
);

test("editor tabs disambiguate names, keep the current tab visible and mark changes", () => {
  const colors = palette({ theme: "flat" });
  const state = {
    current: 3,
    buffers: [
      { id: 1, name: "/p/src/index.ts", modified: false, preview: false },
      { id: 2, name: "/p/test/index.ts", modified: true, preview: false },
      { id: 3, name: "/p/README.md", modified: false, preview: true },
    ],
  };
  const plain = (width: number) => {
    const strip = bufferStrip(state, width, colors);
    return { text: strip.text.chunks.map((c) => c.text).join(""), hits: strip.hits };
  };
  const wide = plain(80);
  expect(wide.text).toBe(" src/index.ts × ▏ test/index.ts ● ▏ README.md × ▏");
  // Two hits per tab: the body selects, the glyph closes.
  expect(wide.hits.filter((h) => h.close).map((h) => [h.id, h.start])).toEqual([
    [1, 14], [2, 32], [3, 46],
  ]);
  const narrow = plain(20);
  expect(narrow.text).toBe("‹ README.md × ▏");
  expect(tabLabels(["/a/x.ts", "/b/y.ts"])).toEqual(["x.ts", "y.ts"]);
  expect(tabLabels(["/a/src/x.ts", "/b/src/x.ts", "/c/y.ts"])).toEqual([
    "a/src/x.ts",
    "b/src/x.ts",
    "y.ts",
  ]);
});

test("clicking an editor tab selects it, its × closes it, and the file list follows", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "under-tabs-")));
  await writeFile(join(root, "a.ts"), "a\n");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "b.ts"), "b\n");
  const setup = await createTestRenderer({ width: 120, height: 30 });
  const app = new App(setup.renderer, root, undefined, { config: defaults });
  const calls: string[] = [];
  const editor: PaneEditor = {
    async openFile() {},
    async selectBuffer(id) { calls.push(`select:${id}`); },
    async closeBuffer(id) { calls.push(`close:${id}`); },
    async ready() {},
    async modified() { return []; },
    async quit() {},
    async dispose() {},
    abortInitialization() {},
    async snapshot() { throw new Error("Not needed"); },
  };
  try {
    const pane = app.tab().panes.find((p) => p.kind === "nvim")!;
    const agent = app.tab().panes.find((p) => p.kind === "agent")!;
    const { frame } = app.attachTerminal(pane, running(), editor);
    app.tab().focused = agent.id;
    app.fileBrowser();
    await Bun.sleep(100);
    app.applyBuffers(pane.id, {
      current: 2,
      buffers: [
        { id: 1, name: join(root, "a.ts"), modified: false, preview: false },
        { id: 2, name: join(root, "src", "b.ts"), modified: false, preview: false },
      ],
    });
    await Bun.sleep(150);
    await setup.flush();
    const screen = setup.captureCharFrame();
    expect(screen).toContain(" a.ts × ▏ b.ts × ▏");
    // Following the active file opened src/ in the file list and selected b.ts.
    expect(app.fileBrowser().directory).toBe(join(root, "src"));
    expect(app.fileBrowser().entries[app.fileBrowser().selected]?.name).toBe("b.ts");
    const row = frame.y + 1;
    const x = frame.x + 1;
    await setup.mockMouse.click(x + 2, row);
    await Bun.sleep(30);
    expect(calls).toContain("select:1");
    expect(app.tab().focused).toBe(pane.id);
    await setup.mockMouse.click(x + 6, row);
    await Bun.sleep(30);
    expect(calls).toContain("close:1");
  } finally {
    app.disposeUI();
    await setup.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(!nvim || process.env.UNDER_NO_SOCKETS === "1")(
  "Neovim reports its buffers and closes one without closing the window",
  async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "under-tabs-nvim-")));
    const editor = await Editor.launch({ argv: [nvim!, "--clean"] }, dir);
    editor.host.attach(() => {});
    const states: { current: number; buffers: { id: number; name: string }[] }[] = [];
    try {
      await editor.ready();
      await editor.watchBuffers((state) => states.push(state));
      for (const name of ["a.ts", "b.ts"]) await writeFile(join(dir, name), `${name}\n`);
      await editor.openFile(join(dir, "a.ts"));
      await editor.openFile(join(dir, "b.ts"));
      await Bun.sleep(100);
      const last = states.at(-1)!;
      expect(last.buffers.map((b) => b.name)).toEqual([join(dir, "a.ts"), join(dir, "b.ts")]);
      const [a, b] = last.buffers;
      expect(last.current).toBe(b!.id);
      await editor.rpc!.call("nvim_command", ["vsplit"]);
      await editor.closeBuffer(b!.id);
      await Bun.sleep(100);
      expect(states.at(-1)!.buffers.map((x) => x.id)).toEqual([a!.id]);
      expect(await editor.rpc!.call<number>("nvim_eval", ["winnr('$')"])).toBe(2);
      await editor.rpc!.call("nvim_buf_set_lines", [0, 0, -1, false, ["changed"]]);
      await expect(editor.closeBuffer(a!.id)).rejects.toThrow("Save or discard");
      await editor.selectBuffer(a!.id);
      await editor.rpc!.call("nvim_command", ["wa"]);
      await editor.quit();
    } finally {
      await editor.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
  15_000,
);
