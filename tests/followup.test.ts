import { test, expect } from "bun:test";
import { EmbeddedTerminalRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "smol-toml";
import { App, type PaneHost } from "../src/app.ts";
import { defaults } from "../src/config.ts";
import { yaziConfig, yaziOpenerCommand } from "../src/yazi.ts";
import { menuSlots } from "../src/menu.ts";

test("a late Yazi launch transfers fallback file focus and receives native keys", async () => {
  const setup = await createTestRenderer({ width: 120, height: 30 });
  const app = new App(setup.renderer, "/fixtures/project", undefined, {
    config: defaults,
    files: [],
  });
  const writes: Uint8Array[] = [];
  try {
    setup.mockInput.pressKey("g", { ctrl: true });
    setup.mockInput.pressKey("f");
    expect(app.input.mode).toBe("app");
    app.attachTerminal(app.tab().panes[2]!, {
      phase: "running",
      exitCode: null,
      write(bytes) {
        writes.push(bytes);
      },
      resize() {},
      attach() {},
      async close() {},
    });
    await setup.flush();
    expect(app.tab().focused).toBe(app.tab().panes[2]!.id);
    expect(app.input.mode).toBe("terminal");
    setup.mockInput.pressKey("e");
    await setup.flush();
    expect(
      writes.some((bytes) => new TextDecoder().decode(bytes) === "e"),
    ).toBe(true);
  } finally {
    app.disposeUI();
    await setup.dispose();
  }
});

test("Yazi opener command uses the placeholder syntax of the installed version", () => {
  const legacy = yaziOpenerCommand("/opt/helper ' è/nvim", "Version: 25.5.31");
  expect(legacy).toBe("'/opt/helper '\\'' è/nvim' \"$@\"");
  for (const version of ["Version: 25.12.29", "Version: 26.9.1", ""])
    expect(yaziOpenerCommand("/bin/helper", version)).toBe("'/bin/helper' %s");
});

test("Yazi overlay preserves configuration with a single-column layout and editor bridge", async () => {
  const root = await mkdtemp(join(tmpdir(), "under-yazi-test-"));
  let overlay = "";
  const original =
    '[mgr]\nshow_hidden = true\nratio = [1, 4, 3]\n[opener]\nedit = [{ run = "false", block = true }]\nplay = [{ run = "player %s" }]\n[open]\nprepend_rules = [{ url = "*.wav", use = "play" }]\n';
  try {
    await writeFile(join(root, "yazi.toml"), original);
    await writeFile(
      join(root, "theme.toml"),
      '[mgr]\ncwd = { fg = "#abcdef" }\n',
    );
    await writeFile(join(root, "keymap.toml"), "# custom bindings\n");
    await mkdir(join(root, "plugins"));
    overlay = await yaziConfig({
      editor: "/tmp/helper ' è/nvim",
      env: { YAZI_CONFIG_HOME: root },
      version: "Version: 25.5.31",
    });
    const result = parse(await readFile(join(overlay, "yazi.toml"), "utf8"));
    expect(result.mgr).toEqual({ show_hidden: true, ratio: [0, 1, 0] });
    expect(result.open).toEqual(parse(original).open);
    expect((result.opener as any).play).toEqual(
      (parse(original).opener as any).play,
    );
    expect((result.opener as any).edit[0].run).toContain('"$@"');
    expect(await realpath(join(overlay, "plugins"))).toBe(
      await realpath(join(root, "plugins")),
    );
    expect(await readFile(join(overlay, "theme.toml"), "utf8")).toContain(
      "#abcdef",
    );
    expect(await readFile(join(root, "yazi.toml"), "utf8")).toBe(original);
  } finally {
    if (overlay) await rm(overlay, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("only the focused visible terminal owns the cursor; menus hide it and resizing remaps it", async () => {
  const setup = await createTestRenderer({ width: 120, height: 30 });
  const app = new App(setup.renderer, "/fixtures/project", undefined, {
    config: defaults,
    files: [],
  });
  const host: PaneHost = {
    phase: "running",
    exitCode: null,
    write() {},
    resize() {},
    attach() {},
    async close() {},
  };
  const editor = app.attachTerminal(app.tab().panes[0]!, host);
  const chat = app.attachTerminal(app.tab().panes[1]!, host);
  const files = app.attachTerminal(app.tab().panes[2]!, host);
  const cursor = () => {
    const c = setup.renderer.getCursorState();
    expect(c.visible).toBe(true);
    expect(c.x).toBe(editor.view.x + 7);
    expect(c.y).toBe(editor.view.y + 3);
  };
  try {
    editor.view.write("\x1b[2J\x1b[Hè界 text\x1b[3;7H\x1b[?25h");
    chat.view.write("\x1b[2J\x1b[Hbackground\x1b[8;9H\x1b[?25h");
    files.view.write("\x1b[2J\x1b[Hfolders\x1b[?25l");
    await setup.flush();
    cursor();
    for (let i = 0; i < 12; i++) {
      chat.view.write(`\r\n${"wrapping background ".repeat(8)}\x1b[?25l`);
      editor.view.write("\x1b[3;7H"); // cursor-only output, no changed cells
      await setup.flush();
      cursor();
    }
    const menu = menuSlots(120).slots.find((s) => s.label === "Review")!;
    await setup.mockMouse.click(menu.x + 1, menu.y);
    await setup.flush();
    expect(setup.renderer.getCursorState().visible).toBe(false);
    setup.mockInput.pressEscape();
    await Bun.sleep(40);
    await setup.flush();
    cursor();
    setup.resize(80, 24);
    await setup.flush();
    cursor();
    setup.resize(50, 15);
    await setup.flush();
    cursor();
    expect(chat.frame.visible).toBe(false);
    expect(files.frame.visible).toBe(false);
    editor.view.write("\x1b[2J\x1b[Hclean frame\x1b[3;7H");
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("clean frame");
    expect(setup.captureCharFrame()).not.toContain("background");
  } finally {
    app.disposeUI();
    await setup.dispose();
  }
});

test.skipIf(
  process.env.UNDER_NO_SOCKETS === "1" ||
    !Bun.which("nvim") ||
    !Bun.which("yazi") ||
    !Bun.which("hunk"),
)(
  "native themed Yazi opens in the existing editor; Hunk reviews reuse tabs and retain modified buffers",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "under-followup-")),
    );
    const project = join(root, "project"),
      config = join(root, "yazi");
    await mkdir(project);
    await mkdir(config);
    const file = join(project, "quote ' è.ts");
    await writeFile(file, "staged-content\n");
    Bun.spawnSync({ cmd: ["git", "init"], cwd: project });
    Bun.spawnSync({ cmd: ["git", "add", "."], cwd: project });
    await writeFile(file, "working-content\n");
    await writeFile(
      join(config, "theme.toml"),
      '[mgr]\ncwd = { fg = "#abcdef" }\n',
    );
    await writeFile(
      join(config, "keymap.toml"),
      '[mgr]\nprepend_keymap = [{ on = "e", run = "open", desc = "Edit custom" }]\n',
    );
    await writeFile(
      join(config, "yazi.toml"),
      '[opener]\nedit = [{ run = "false", block = true }]\n',
    );
    await writeFile(
      join(project, ".under.json"),
      JSON.stringify({
        profiles: {
          nvim: { argv: ["nvim", "--clean"] },
          yazi: { argv: ["yazi", file], env: { YAZI_CONFIG_HOME: config } },
        },
      }),
    );
    const setup = await createTestRenderer({ width: 150, height: 35 });
    const app = new App(setup.renderer, project);
    const code = app.tab();
    const wait = async (predicate: () => boolean | Promise<boolean>) => {
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        await Bun.sleep(40);
        await setup.flush();
        try {
          if (await predicate()) return;
        } catch (e) {
          // A live native frame can hold the output lease during capture.
          if ((e as { status?: number }).status !== -13) throw e;
        }
      }
      throw new Error("Timed out waiting for the native terminal state");
    };
    try {
      await app.start(code.panes[0]!);
      await app.start(code.panes[2]!);
      await wait(() => setup.captureCharFrame().includes("yazi [running]"));
      await wait(() =>
        setup
          .captureSpans()
          .lines.some((line) =>
            line.spans.some(
              (span) =>
                span.fg.toInts().slice(0, 3).join(",") === "171,205,239",
            ),
          ),
      );
      await wait(() => setup.captureCharFrame().includes("quote ' è.ts"));
      setup.mockInput.pressKey("g", { ctrl: true });
      setup.mockInput.pressKey("f");
      await setup.flush();
      expect(app.tab().focused).toBe(code.panes[2]!.id);
      setup.mockInput.pressKey("e"); // retain the user's custom native edit binding
      await wait(async () => (await app.editorSnapshot()).path === file);
      expect(app.tab().focused).toBe(code.panes[0]!.id);
      expect(app.input.mode).toBe("terminal");
      const editorView = setup.renderer.root.findDescendantById(
        code.panes[0]!.id,
      ) as EmbeddedTerminalRenderable;
      const background = app.attachTerminal(code.panes[1]!, {
        phase: "running",
        exitCode: null,
        write() {},
        resize() {},
        attach() {},
        async close() {},
      });
      for (const key of ["l", "l", "h", "$", "0"]) {
        setup.mockInput.pressKey(key);
        background.view.write(
          "\r\nbackground output ".repeat(40) + "\x1b[?25l",
        );
        await Bun.sleep(50);
        await setup.flush();
        const local = editorView.screen().cursor,
          cursor = setup.renderer.getCursorState();
        expect(cursor.visible).toBe(true);
        expect(cursor.x).toBe(editorView.x + local.x + 1);
        expect(cursor.y).toBe(editorView.y + local.y + 1);
      }
      setup.mockInput.pressKey("g", { ctrl: true });
      setup.mockInput.pressKey("b");
      await setup.flush();
      expect(
        setup.renderer.root.findDescendantById(`frame-${code.panes[2]!.id}`)!
          .visible,
      ).toBe(false);
      setup.mockInput.pressKey("f");
      await setup.flush();
      expect(app.tab().focused).toBe(code.panes[2]!.id);
      expect(setup.captureCharFrame()).toContain("yazi [running]");
      setup.mockInput.pressKey("g", { ctrl: true });
      setup.mockInput.pressKey("tab");
      setup.mockInput.pressEscape();
      await Bun.sleep(40);
      await setup.flush();
      expect(app.tab().focused).toBe(code.panes[0]!.id);
      setup.mockInput.pressKey("i");
      await setup.mockInput.typeText("unsaved-");
      setup.mockInput.pressEscape();
      await Bun.sleep(100);
      expect((await app.editorSnapshot()).modified).toBe(true);
      await app.openReview();
      await wait(() => setup.captureCharFrame().includes("working-content"));
      const working = app.tab().id;
      await app.openReview();
      expect(app.tab().id).toBe(working);
      expect(app.workspace().tabs.length).toBe(2);
      await app.openReview({ staged: true });
      await wait(() => setup.captureCharFrame().includes("staged-content"));
      expect(app.tab().id).not.toBe(working);
      await app.openReview({ staged: true });
      expect(app.workspace().tabs.length).toBe(3);
      expect((await app.editorSnapshot()).modified).toBe(true);
      expect(await readFile(file, "utf8")).toBe("working-content\n");
      expect(await readFile(join(config, "yazi.toml"), "utf8")).toContain(
        'run = "false"',
      );
      await expect(app.shutdown()).rejects.toThrow("Save modified buffers");
    } finally {
      await app.shutdown(true);
      await setup.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
  25_000,
);

test("Review reports missing Hunk and non-Git directories without creating tabs", async () => {
  const root = await mkdtemp(join(tmpdir(), "under-nongit-"));
  const setup = await createTestRenderer({ width: 80, height: 24 });
  const app = new App(setup.renderer, root, undefined, {
    config: defaults,
    files: [],
    available: () => false,
  });
  try {
    await expect(app.openReview()).rejects.toThrow("Install Hunk");
    expect(app.workspace().tabs.length).toBe(1);
  } finally {
    app.disposeUI();
    await setup.dispose();
    await rm(root, { recursive: true });
  }
  const second = await createTestRenderer({ width: 80, height: 24 });
  const nongit = await mkdtemp(join(tmpdir(), "under-nongit-"));
  const present = new App(second.renderer, nongit, undefined, {
    config: defaults,
    files: [],
    available: () => true,
  });
  try {
    await expect(present.openReview({ staged: true })).rejects.toThrow("Git working tree");
    expect(present.workspace().tabs.length).toBe(1);
  } finally {
    present.disposeUI();
    await second.dispose();
    await rm(nongit, { recursive: true });
  }
});
