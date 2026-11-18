import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { mkdtemp, readFile, rm, symlink, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { join } from "node:path";
import { App, type PaneEditor, type PaneHost } from "../src/app.ts";
import { defaults, validatePatch } from "../src/config.ts";
import { Editor, unifiedLabel, type DiffPane } from "../src/editor.ts";
import { palette } from "../src/theme.ts";
import {
  ChangesList,
  changesView,
  diffSides,
  imageSides,
  discard,
  gitStatus,
  parseStatus,
  stage,
  stageAll,
  unstage,
  unstageAll,
} from "../src/changes.ts";

const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
};

/** A repository with one commit and every kind of change. */
async function repository() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "under-changes-")));
  git(root, "init", "-q");
  await writeFile(join(root, "edited.ts"), "one\ntwo\nthree\n");
  await writeFile(join(root, "gone.ts"), "bye\n");
  await writeFile(join(root, "both.ts"), "a\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "init");
  await writeFile(join(root, "edited.ts"), "one\nTWO\nthree\n");
  await rm(join(root, "gone.ts"));
  await writeFile(join(root, "both.ts"), "a\nstaged\n");
  git(root, "add", "both.ts");
  await writeFile(join(root, "both.ts"), "a\nstaged\nworking\n");
  await writeFile(join(root, "new [x].ts"), "fresh\n");
  return root;
}

test("git status rows split into Staged and Changes, as VS Code lists them", () => {
  const raw = [
    "M  both.ts",
    "MM twice.ts",
    " D gone.ts",
    "?? new.ts",
    "UU conflict.ts",
    "R  new-name.ts",
    "old-name.ts",
    "!! ignored.ts",
    "",
  ].join("\0");
  expect(parseStatus(raw)).toEqual([
    { path: "both.ts", staged: true, status: "M" },
    { path: "new-name.ts", orig: "old-name.ts", staged: true, status: "R" },
    { path: "twice.ts", staged: true, status: "M" },
    { path: "conflict.ts", staged: false, status: "!" },
    { path: "gone.ts", staged: false, status: "D" },
    { path: "new.ts", staged: false, status: "U" },
    { path: "twice.ts", staged: false, status: "M" },
  ]);
});

test("changes stage, unstage and discard per file, with literal paths", async () => {
  const root = await repository();
  try {
    expect(await gitStatus(root)).toEqual([
      { path: "both.ts", staged: true, status: "M" },
      { path: "both.ts", staged: false, status: "M" },
      { path: "edited.ts", staged: false, status: "M" },
      { path: "gone.ts", staged: false, status: "D" },
      { path: "new [x].ts", staged: false, status: "U" },
    ]);
    // Left is the index, right the real file; a staged row compares HEAD and index.
    const edited = await diffSides(root, { path: "edited.ts", staged: false, status: "M" });
    expect(edited.left).toMatchObject({ kind: "text", text: "one\ntwo\nthree\n", label: "edited.ts (Index)" });
    expect(edited.right).toEqual({ kind: "file", path: join(root, "edited.ts"), label: "edited.ts (Working Tree)" });
    const staged = await diffSides(root, { path: "both.ts", staged: true, status: "M" });
    expect([staged.left, staged.right].map((s) => s.kind === "text" && s.text)).toEqual(["a\n", "a\nstaged\n"]);
    const gone = await diffSides(root, { path: "gone.ts", staged: false, status: "D" });
    expect(gone.right).toMatchObject({ kind: "text", text: "" });
    const untracked = await diffSides(root, { path: "new [x].ts", staged: false, status: "U" });
    expect(untracked.left).toMatchObject({ kind: "text", text: "" });

    // A bracket in the name is not a pathspec pattern.
    await stage(root, { path: "new [x].ts", staged: false, status: "U" });
    await stage(root, { path: "gone.ts", staged: false, status: "D" });
    let rows = await gitStatus(root);
    expect(rows).toContainEqual({ path: "new [x].ts", staged: true, status: "A" });
    expect(rows).toContainEqual({ path: "gone.ts", staged: true, status: "D" });
    await unstage(root, { path: "gone.ts", staged: true, status: "D" });
    expect(await gitStatus(root)).toContainEqual({ path: "gone.ts", staged: false, status: "D" });

    await discard(root, { path: "edited.ts", staged: false, status: "M" });
    expect(await readFile(join(root, "edited.ts"), "utf8")).toBe("one\ntwo\nthree\n");
    await expect(discard(root, { path: "both.ts", staged: true, status: "M" })).rejects.toThrow("Unstage");
    await unstage(root, { path: "new [x].ts", staged: true, status: "A" });
    await discard(root, { path: "new [x].ts", staged: false, status: "U" });
    expect(await Bun.file(join(root, "new [x].ts")).exists()).toBe(false);

    await stageAll(root);
    rows = await gitStatus(root);
    expect(rows.every((row) => row.staged)).toBe(true);
    await unstageAll(root);
    rows = await gitStatus(root);
    expect(rows.every((row) => !row.staged)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the root keeps the workspace's spelling of a symlinked path", async () => {
  // On macOS the temporary directory is a symlink into /private.
  const outer = await mkdtemp(join(tmpdir(), "under-changes-link-"));
  const workspace = join(outer, "sub");
  try {
    git(outer, "init", "-q");
    await Bun.write(join(workspace, "a.ts"), "a\n");
    const list = new ChangesList(workspace);
    await list.load();
    expect(list.root).toBe(outer);
    expect(list.label(list.entries[0]!)).toEqual({ name: "a.ts", dir: "" });
    // A workspace that is itself a link into the repository never resolves
    // to the link's own parent, which may be another directory entirely.
    const elsewhere = await mkdtemp(join(tmpdir(), "under-changes-elsewhere-"));
    try {
      await symlink(workspace, join(elsewhere, "linked"));
      const linked = new ChangesList(join(elsewhere, "linked"));
      await linked.load();
      expect(linked.root).toBe(await realpath(outer));
      expect(linked.entries).toEqual([{ path: "sub/a.ts", staged: false, status: "U" }]);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  } finally {
    await rm(outer, { recursive: true, force: true });
  }
});

test("staging works before the first commit", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "under-changes-empty-")));
  try {
    git(root, "init", "-q");
    await writeFile(join(root, "a.ts"), "a\n");
    await stage(root, { path: "a.ts", staged: false, status: "U" });
    expect(await gitStatus(root)).toEqual([{ path: "a.ts", staged: true, status: "A" }]);
    const sides = await diffSides(root, { path: "a.ts", staged: true, status: "A" });
    expect(sides.left).toMatchObject({ text: "" });
    await unstage(root, { path: "a.ts", staged: true, status: "A" });
    expect(await gitStatus(root)).toEqual([{ path: "a.ts", staged: false, status: "U" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the Changes panel groups rows, keeps the selection visible and maps clicks", async () => {
  const root = await repository();
  try {
    const list = new ChangesList(root);
    await list.load();
    list.selected = 3;
    const view = changesView(list, 30, 20, true, palette(defaults));
    const lines = view.text.chunks.map((c) => c.text).join("").split("\n");
    expect(lines[0]).toBe(" Changes · FOCUS");
    expect(lines[1]).toBe(" STAGED (1)");
    expect(lines[2]).toStartWith(" M both.ts");
    expect(lines[2]).toEndWith("−");
    expect(lines[3]).toBe(" CHANGES (4)");
    expect(lines[6]).toStartWith("›D gone.ts");
    expect(lines[6]).toEndWith("+");
    expect([...view.rows]).toEqual([
      [2, 0],
      [4, 1],
      [5, 2],
      [6, 3],
      [7, 4],
    ]);
    for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(30);
    // A short panel scrolls to the selection.
    list.selected = 4;
    const short = changesView(list, 30, 7, false, palette(defaults));
    expect(short.text.chunks.map((c) => c.text).join("")).toContain("new [x].ts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the diff layout is validated and labels merge for a unified diff", () => {
  expect(defaults.diffLayout).toBe("split");
  expect(validatePatch({ diffLayout: "unified" })).toEqual({ diffLayout: "unified" });
  expect(() => validatePatch({ diffLayout: "inline" })).toThrow("diffLayout");
  expect(unifiedLabel("a.ts (HEAD)", "a.ts (Index)")).toBe("a.ts (HEAD → Index)");
  expect(unifiedLabel("old.ts (HEAD)", "new.ts (Index)")).toBe("old.ts (HEAD) → new.ts (Index)");
});

test("a template can show the Changes list; d applies the built-in one", () => {
  expect(validatePatch({ templates: { mine: { panes: [{ kind: "nvim" }], layout: 0, sidebar: "changes" } } })).toEqual({
    templates: { mine: { label: "mine", slots: [{ kind: "nvim", profile: "nvim" }], focus: 0, shape: 0, sidebar: "changes" } },
  });
  expect(() => validatePatch({ templates: { mine: { panes: [{ kind: "nvim" }], layout: 0, sidebar: "git" } } })).toThrow("sidebar");
});

const running = (): PaneHost => ({
  phase: "running",
  exitCode: null,
  write() {},
  resize() {},
  attach() {},
  async close() {},
});

test("the Changes layout diffs the row under the cursor and stages from the keyboard", async () => {
  const root = await repository();
  const setup = await createTestRenderer({ width: 140, height: 30 });
  const app = new App(setup.renderer, root, undefined, { config: defaults, files: [] });
  const diffs: Array<[DiffPane, DiffPane, string | undefined]> = [];
  const reloaded: string[] = [];
  const editor: PaneEditor = {
    async openFile() {},
    async openDiff(left, right, layout) {
      diffs.push([left, right, layout]);
    },
    async reload(path) {
      reloaded.push(path);
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
  const label = (pane?: DiffPane) => pane?.label;
  try {
    const pane = app.tab().panes.find((p) => p.kind === "nvim")!;
    app.attachTerminal(pane, running(), editor);
    setup.mockInput.pressKey("g", { ctrl: true });
    setup.mockInput.pressKey("d");
    const until = async (check: () => boolean) => {
      const end = Date.now() + 5000;
      while (!check()) {
        if (Date.now() > end) throw new Error(`Timed out waiting for ${check}`);
        await Bun.sleep(20);
      }
    };
    await until(() => diffs.length > 0);
    expect(app.input.mode).toBe("app");
    expect(label(diffs[0]?.[1])).toBe("both.ts (Index)");
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("STAGED (1)");

    // Moving settles on one row before the diff loads.
    setup.mockInput.pressKey("j");
    setup.mockInput.pressKey("j");
    await until(() => diffs.length > 1);
    await Bun.sleep(150);
    expect(diffs.map((d) => label(d[1]))).toEqual(["both.ts (Index)", "edited.ts (Working Tree)"]);

    // s stages the row; the list and the diff follow.
    setup.mockInput.pressKey("s");
    await until(() => app.changesList().entries.some((e) => e.path === "edited.ts" && e.staged));
    expect(app.changesList().entries.find((e) => e.path === "edited.ts")!.staged).toBe(true);
    // The selection stays in Changes, on the next row, as in VS Code.
    expect(app.changesList().current()).toEqual({ path: "gone.ts", staged: false, status: "D" });

    // x asks before discarding; Enter confirms.
    const gone = app.changesList().entries.findIndex((e) => e.path === "gone.ts");
    app.changesList().selected = gone;
    setup.mockInput.pressKey("x");
    await until(() => setup.captureCharFrame().includes("Discard changes to gone.ts"));
    setup.mockInput.pressEnter();
    await until(() => !app.changesList().entries.some((e) => e.path === "gone.ts"));
    expect(await readFile(join(root, "gone.ts"), "utf8")).toBe("bye\n");
    expect(reloaded).toEqual([join(root, "gone.ts")]);

    // v switches to the unified layout and redraws the same row.
    const before = diffs.length;
    setup.mockInput.pressKey("v");
    await until(() => diffs.length > before);
    expect(diffs.at(-1)![2]).toBe("unified");

    // Enter opens the diff in the editor and gives it the keyboard.
    setup.mockInput.pressEnter();
    await until(() => app.input.mode === "terminal");
    expect(app.tab().focused).toBe(pane.id);
  } finally {
    app.disposeUI();
    await setup.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

const nvim = process.env.UNDER_TEST_NVIM || Bun.which("nvim");
test.skipIf(!nvim || process.env.UNDER_NO_SOCKETS === "1")(
  "Neovim shows a diff side by side in its own tab page, editing the real file",
  async () => {
    const root = await repository();
    const editor = await Editor.launch({ argv: [nvim!, "--clean"] }, root);
    editor.host.attach(() => {});
    const lua = <T,>(code: string, args: unknown[] = []) =>
      editor.rpc!.call<T>("nvim_exec_lua", [code, args]);
    const layout = () =>
      lua<unknown>(
        `local out={}
for _,w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
  local b=vim.api.nvim_win_get_buf(w)
  table.insert(out,{vim.fs.basename(vim.api.nvim_buf_get_name(b)),vim.wo[w].diff,vim.bo[b].modifiable,vim.wo[w].winbar,w==vim.api.nvim_get_current_win()})
end
return {#vim.api.nvim_list_tabpages(),out}`,
      );
    try {
      await editor.ready();
      await editor.openFile(join(root, "both.ts"));
      const sides = await diffSides(root, { path: "edited.ts", staged: false, status: "M" });
      await editor.openDiff(sides.left, sides.right);
      expect(await layout()).toEqual([
        2,
        [
          ["edited.ts", true, false, " edited.ts (Index)", false],
          ["edited.ts", true, true, " edited.ts (Working Tree)", true],
        ],
      ]);
      // The cursor starts on the first change.
      expect((await editor.snapshot()).cursor[0]).toBe(2);
      // The right side is the real file buffer.
      expect((await editor.snapshot()).path).toBe(join(root, "edited.ts"));
      // The next diff reuses the tab page and drops the old scratch buffer.
      const staged = await diffSides(root, { path: "both.ts", staged: true, status: "M" });
      await editor.openDiff(staged.left, staged.right);
      const [tabs, wins] = (await layout()) as [number, unknown[][]];
      expect(tabs).toBe(2);
      expect(wins.map((w) => [w[0], w[2]])).toEqual([
        ["both.ts", false],
        ["both.ts", false],
      ]);
      expect(
        await lua<number>(
          "local n=0 for _,b in ipairs(vim.api.nvim_list_bufs()) do if vim.api.nvim_buf_get_name(b):find('under%-diff://') then n=n+1 end end return n",
        ),
      ).toBe(2);
      // Unified: one editable window over the real file; added lines are
      // highlighted and removed lines shown above them as virtual lines.
      await editor.openDiff(sides.left, sides.right, "unified");
      const overlay = () =>
        lua<unknown>(
          `local ns=vim.api.nvim_create_namespace('under_unified')
local out={}
for _,m in ipairs(vim.api.nvim_buf_get_extmarks(0,ns,0,-1,{details=true})) do
  local d=m[4]
  table.insert(out,{m[2]+1,d.line_hl_group or '',d.virt_lines and vim.trim(d.virt_lines[1][1][1]) or ''})
end
return {#vim.api.nvim_tabpage_list_wins(0),vim.wo.winbar,vim.fn.line('.'),vim.fn.maparg(']c','n')~='',out}`,
        );
      expect(await overlay()).toEqual([
        1,
        " edited.ts (Index → Working Tree)",
        2,
        true,
        [
          [2, "", "two"],
          [2, "DiffAdd", ""],
        ],
      ]);
      expect((await editor.snapshot()).path).toBe(join(root, "edited.ts"));
      // The overlay is drawn only in the diff window.
      expect(
        await lua<boolean>(
          "if not vim.api.nvim__ns_get then return true end local ns=vim.api.nvim_create_namespace('under_unified') local w=vim.api.nvim__ns_get(ns).wins return #w==1 and w[1]==vim.api.nvim_get_current_win()",
        ),
      ).toBe(true);
      // Line endings and a missing final newline are not changes.
      await editor.openDiff(
        { kind: "text", name: "under-diff://index/edited.ts", text: "one\r\ntwo\r\nthree", label: "edited.ts (Index)" },
        sides.right,
        "unified",
      );
      expect(((await overlay()) as unknown[])[4]).toEqual([
        [2, "", "two"],
        [2, "DiffAdd", ""],
      ]);
      await editor.openDiff(sides.left, sides.right, "unified");
      // Typing the old text back clears the overlay as you edit.
      await editor.rpc!.call("nvim_buf_set_lines", [0, 1, 2, false, ["two"]]);
      await lua("vim.api.nvim_exec_autocmds('TextChanged',{buffer=0})");
      await Bun.sleep(300);
      expect(((await overlay()) as unknown[])[4]).toEqual([]);
      await lua("vim.cmd('silent! undo')");
      // Closing removes the overlay and Under's ]c from the real buffer.
      await editor.closeDiff();
      const cleared = (await overlay()) as unknown[];
      expect([cleared[3], cleared[4]]).toEqual([false, []]);
      await editor.openDiff(sides.left, sides.right);
      // A normal open leaves the diff tab page.
      await editor.openFile(join(root, "edited.ts"));
      expect(((await layout()) as [number])[0]).toBe(1);
      await editor.openDiff(sides.left, sides.right);
      await editor.closeDiff();
      expect(((await layout()) as [number])[0]).toBe(1);
      expect(
        await lua<number>(
          "local n=0 for _,b in ipairs(vim.api.nvim_list_bufs()) do if vim.api.nvim_buf_get_name(b):find('under%-diff://') then n=n+1 end end return n",
        ),
      ).toBe(0);
      await editor.quit();
    } finally {
      await editor.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
  20_000,
);

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAIAAAA8r+mnAAAAEklEQVR4nGP4z8CAFWEXJUsCAFpeH+EeQoQoAAAAAElFTkSuQmCC",
  "base64",
);

/** A solid-colour RGB PNG of the given size. */
function solidPng(width: number, height: number) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", Buffer.from(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("an image change shows both versions side by side in Under's viewer", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "under-image-diff-")));
  git(root, "init", "-q");
  await writeFile(join(root, "pic.png"), png);
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "init");
  // The working copy is resized.
  await writeFile(join(root, "pic.png"), solidPng(12, 6));
  await writeFile(join(root, "new.png"), png);
  const sides = await imageSides(root, { path: "pic.png", staged: false, status: "M" });
  expect(sides.left.label).toBe("Index");
  expect(Buffer.from(sides.left.source as Uint8Array).equals(png)).toBe(true);
  expect(sides.right).toEqual({ label: "Working Tree", source: join(root, "pic.png") });
  const added = await imageSides(root, { path: "new.png", staged: false, status: "U" });
  expect(added.left.source).toBeUndefined();

  const setup = await createTestRenderer({ width: 140, height: 30 });
  const app = new App(setup.renderer, root, undefined, { config: defaults, files: [] });
  const diffs: unknown[] = [];
  const editor: PaneEditor = {
    async openFile() {},
    async openDiff(...args) {
      diffs.push(args);
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
  const until = async (check: () => boolean) => {
    const end = Date.now() + 5000;
    while (!check()) {
      if (Date.now() > end)
        throw new Error(`Timed out waiting for ${check}\n${setup.captureCharFrame()}`);
      await Bun.sleep(20);
      await setup.flush();
    }
  };
  try {
    const pane = app.tab().panes.find((p) => p.kind === "nvim")!;
    app.attachTerminal(pane, running(), editor);
    app.applyLayout("changes");
    await until(() => setup.captureCharFrame().includes("Image diff · new.png"));
    expect(setup.captureCharFrame()).toContain("Index: none");
    setup.mockInput.pressKey("j");
    await until(() => setup.captureCharFrame().includes("Image diff · pic.png"));
    await until(() => /Index: 8 × 4\s+→\s+Working Tree: 12 × 6/.test(setup.captureCharFrame()));
    // The list keeps the keyboard; no Neovim diff was opened for images.
    expect(app.input.mode).toBe("app");
    expect(diffs).toEqual([]);
    // Keys the list does not use still reach navigation: 6 applies a layout.
    setup.mockInput.pressKey("6");
    expect(app.tab().template).toBe("editor-chat");
  } finally {
    app.disposeUI();
    await setup.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
