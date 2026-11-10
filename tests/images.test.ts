import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { ImageRenderable } from "@opentui/core";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, type PaneEditor, type PaneHost } from "../src/app.ts";
import { defaults } from "../src/config.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAIAAAA8r+mnAAAAEklEQVR4nGP4z8CAFWEXJUsCAFpeH+EeQoQoAAAAAElFTkSuQmCC",
  "base64",
);

test("Quick Open displays an image without Neovim, resizes and releases it on Escape", async () => {
  const root = await mkdtemp(join(tmpdir(), "under-image-"));
  const setup = await createTestRenderer({ width: 100, height: 24 });
  const app = new App(setup.renderer, root, undefined, {
    config: defaults, files: [], quickFiles: ["photo È.PNG"],
  });
  try {
    await writeFile(join(root, "photo È.PNG"), png);
    await setup.flush();
    const originalFrame = setup.renderer.root.findDescendantById(`placeholder-${app.tab().focused}`)!;
    const originalBounds = [originalFrame.x, originalFrame.y, originalFrame.width, originalFrame.height];
    setup.mockInput.pressKey("g", { ctrl: true });
    setup.mockInput.pressKey("o");
    setup.mockInput.pressEnter();
    await Bun.sleep(30);
    const view = setup.renderer.root.findDescendantById("image-preview") as ImageRenderable;
    await view.loadPromise;
    await setup.flush();
    expect(view.image?.width).toBe(8);
    expect(view.image?.height).toBe(4);
    expect(view.visible).toBe(true);
    const frame = setup.renderer.root.findDescendantById("image-frame")!;
    expect([frame.x, frame.y, frame.width, frame.height]).toEqual(
      originalBounds,
    );
    expect(frame.width).toBeLessThan(100);
    expect(setup.captureCharFrame()).toContain("Agent chat");
    expect(setup.captureCharFrame()).toContain("Files");
    // Assert that decoded pixels reach the terminal, not just the title.
    expect(setup.captureSpans().lines.some((line) =>
      line.spans.some((span) =>
        [span.fg, span.bg].some((color) =>
          color.toInts().slice(0, 3).join(",") === "255,0,0",
        ),
      ),
    )).toBe(true);
    expect(setup.captureCharFrame()).toContain("Image · photo È.PNG");
    expect(setup.captureCharFrame()).toContain("8 × 4");
    expect(app.input.mode).toBe("terminal");
    const viewport = setup.renderer.root.findDescendantById("image-viewport")!;
    const fittedWidth = view.width;
    for (let i = 0; i < 4; i++) setup.mockInput.pressKey("+");
    await setup.flush();
    expect(view.width).toBeGreaterThan(fittedWidth * 2);
    const centeredX = view.x;
    setup.mockInput.pressArrow("right");
    await setup.flush();
    expect(view.x).toBe(centeredX - 4);
    // Dragging follows the pointer and never reaches the editor underneath.
    const x = viewport.x + 10, y = viewport.y + 5;
    const beforeDrag = view.x;
    await setup.mockMouse.drag(x, y, x + 3, y + 1);
    await setup.flush();
    expect(view.x).toBe(beforeDrag + 3);
    const beforeWheel = view.width;
    await setup.mockMouse.scroll(x, y, "up");
    await setup.flush();
    expect(view.width).toBeGreaterThan(beforeWheel);
    // Red pixels must be clipped to the image area, including while zoomed.
    for (const [row, line] of setup.captureSpans().lines.entries()) {
      if (row >= viewport.y && row < viewport.y + viewport.height) continue;
      expect(line.spans.some((span) => [span.fg, span.bg].some(
        (color) => color.toInts().slice(0, 3).join(",") === "255,0,0",
      ))).toBe(false);
    }
    for (let i = 0; i < 30; i++) setup.mockInput.pressKey("+");
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("800% fit");
    setup.mockInput.pressKey("0");
    await setup.flush();
    expect(view.width).toBe(fittedWidth);
    expect(setup.captureCharFrame()).toContain("100% fit");
    for (let i = 0; i < 5; i++) setup.mockInput.pressKey("-");
    await setup.flush();
    expect(view.width).toBe(fittedWidth);
    setup.resize(50, 15);
    await setup.flush();
    expect(setup.renderer.root.findDescendantById("image-viewport")!.width).toBe(48);
    expect(view.height).toBeGreaterThan(0);
    setup.mockInput.pressEscape();
    await Bun.sleep(40);
    await setup.flush();
    expect(view.image).toBeNull();
    expect(view.source).toBeUndefined();
    expect(view.visible).toBe(false);
    expect(app.input.mode).not.toBe("modal");
  } finally {
    app.disposeUI();
    await setup.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("the fallback file list reports corrupt images in the viewer instead of opening binary text", async () => {
  const root = await mkdtemp(join(tmpdir(), "under-image-error-"));
  const setup = await createTestRenderer({ width: 100, height: 24 });
  const path = join(root, "broken.png");
  await writeFile(path, "not an image");
  const app = new App(setup.renderer, root, undefined, {
    config: defaults, files: [{ name: "broken.png", path, directory: false }],
  });
  try {
    setup.mockInput.pressKey("g", { ctrl: true });
    setup.mockInput.pressKey("f");
    setup.mockInput.pressEnter();
    await Bun.sleep(30);
    const view = setup.renderer.root.findDescendantById("image-preview") as ImageRenderable;
    await view.loadPromise;
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("Cannot display this image");
    expect(view.image).toBeNull();
    expect(app.input.mode).toBe("terminal");
    setup.mockInput.pressEnter();
    await setup.flush();
    expect(app.input.mode).toBe("terminal");
  } finally {
    app.disposeUI();
    await setup.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.env.UNDER_NO_SOCKETS === "1" || !Bun.which("yazi"))(
  "native Yazi opens images through the bridge without starting Neovim",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "under-image-yazi-"));
    const path = join(root, "photo.png");
    await writeFile(path, png);
    const setup = await createTestRenderer({ width: 100, height: 24 });
    const config = structuredClone(defaults);
    config.profiles.yazi = { argv: ["yazi", path], env: { YAZI_CONFIG_HOME: root } };
    const app = new App(setup.renderer, root, undefined, { config, files: [] });
    const wait = async (predicate: () => boolean) => {
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        await Bun.sleep(40);
        await setup.flush();
        if (predicate()) return;
      }
      throw new Error("Timed out waiting for Yazi image preview");
    };
    try {
      const pane = app.tab().panes.find((pane) => pane.kind === "yazi")!;
      await app.start(pane);
      await wait(() => setup.captureCharFrame().includes("photo.png"));
      setup.mockInput.pressKey("g", { ctrl: true });
      setup.mockInput.pressKey("f");
      setup.mockInput.pressEnter();
      const view = setup.renderer.root.findDescendantById("image-preview") as ImageRenderable;
      await wait(() => view.image?.width === 8);
      expect(app.input.mode).toBe("terminal");
      expect(setup.captureCharFrame()).toContain("Image · photo.png");
      setup.mockInput.pressEscape();
      await wait(() => view.source === undefined);
      expect(app.tab().panes.find((p) => p.id === app.tab().focused)?.kind).toBe("nvim");
      expect(view.image).toBeNull();
    } finally {
      await app.shutdown(true);
      await setup.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
  10000,
);

test("image uses the editor pane while other tools work, and a text file restores Neovim", async () => {
  const root = await mkdtemp(join(tmpdir(), "under-image-pane-"));
  const setup = await createTestRenderer({ width: 120, height: 30 });
  const app = new App(setup.renderer, root, undefined, {
    config: defaults, files: [], quickFiles: ["photo.png", "source.ts"],
  });
  const editorKeys: string[] = [], agentKeys: string[] = [], opened: string[] = [];
  const host = (keys: string[]): PaneHost => ({
    phase: "running", exitCode: null,
    write: (bytes) => keys.push(new TextDecoder().decode(bytes)),
    attach() {}, resize() {}, async close() {},
  });
  const editor: PaneEditor = {
    async openFile(path) { opened.push(path); },
    async ready() {}, async modified() { return ["unsaved.ts"]; },
    async quit() { throw new Error("Must not quit the editor"); },
    async dispose() {}, abortInitialization() {},
    async snapshot() { throw new Error("Not needed"); },
  };
  try {
    await writeFile(join(root, "photo.png"), png);
    const editorPane = app.tab().panes.find((p) => p.kind === "nvim")!;
    const agentPane = app.tab().panes.find((p) => p.kind === "agent")!;
    const terminal = app.attachTerminal(editorPane, host(editorKeys), editor);
    app.attachTerminal(agentPane, host(agentKeys));
    terminal.view.write("unsaved editor buffer");
    await setup.flush();
    const bounds = [terminal.frame.x, terminal.frame.y, terminal.frame.width, terminal.frame.height];
    setup.mockInput.pressKey("g", { ctrl: true });
    setup.mockInput.pressKey("o");
    setup.mockInput.pressEnter();
    await Bun.sleep(40);
    const view = setup.renderer.root.findDescendantById("image-preview") as ImageRenderable;
    await view.loadPromise;
    await setup.flush();
    const frame = setup.renderer.root.findDescendantById("image-frame")!;
    expect([frame.x, frame.y, frame.width, frame.height]).toEqual(bounds);
    expect(terminal.frame.visible).toBe(false);
    setup.mockInput.pressKey("x");
    expect(editorKeys).toEqual([]);
    setup.mockInput.pressArrow("right", { ctrl: true });
    expect(app.tab().focused).toBe(agentPane.id);
    setup.mockInput.pressKey("x");
    await setup.flush();
    expect(agentKeys).toContain("x");
    expect(frame.visible).toBe(true);
    // Menus must not dismiss the image; selecting text restores this same editor.
    setup.mockInput.pressKey("g", { ctrl: true });
    setup.mockInput.pressKey("o");
    await setup.mockInput.typeText("source");
    setup.mockInput.pressEnter();
    await Bun.sleep(40);
    await setup.flush();
    expect(opened).toEqual([join(root, "source.ts")]);
    expect(app.tab().focused).toBe(editorPane.id);
    expect(terminal.frame.visible).toBe(true);
    expect(view.source).toBeUndefined();
    expect(setup.captureCharFrame()).toContain("unsaved editor buffer");
  } finally {
    app.disposeUI();
    await setup.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
