import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { ImageRenderable, NativeImage } from "@opentui/core";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { App, type PaneEditor, type PaneHost } from "../src/app.ts";
import { encodePng } from "../src/image-annotations.ts";
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

test("drawing and undo export independent PNG copies while the original stays unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "under-annotate-ui-"));
  const setup = await createTestRenderer({ width: 120, height: 30 });
  const copies: string[] = [];
  const path = join(root, "original.png");
  const pixels = new Uint8Array(100 * 80 * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set([40, 50, 60, 255], i);
  const original = await encodePng(pixels, 100, 80);
  await writeFile(path, original);
  const app = new App(setup.renderer, root, undefined, {
    config: defaults, files: [], quickFiles: ["original.png"],
    copyImage: async (path) => { copies.push(path); },
  });
  const wait = async (predicate: () => boolean) => {
    for (let i = 0; i < 100; i++) {
      await Bun.sleep(10);
      await setup.flush();
      if (predicate()) return;
    }
    throw new Error("Timed out waiting for image export");
  };
  try {
    setup.mockInput.pressKey("g", { ctrl: true });
    setup.mockInput.pressKey("o");
    setup.mockInput.pressEnter();
    const view = setup.renderer.root.findDescendantById("image-preview") as ImageRenderable;
    await wait(() => !!view.image);
    setup.mockInput.pressKey("a");
    await setup.flush();
    const start = { x: view.x + 5, y: view.y + 3 };
    const interiorColor = () => {
      let column = 0;
      for (const span of setup.captureSpans().lines[start.y + 3]!.spans) {
        if (column + span.width > start.x + 6) return span.bg.toInts();
        column += span.width;
      }
      throw new Error("Image interior is outside the captured frame");
    };
    const beforeAnnotation = interiorColor();
    expect(beforeAnnotation.slice(0, 3)).toEqual([40, 50, 60]);
    await setup.mockMouse.drag(start.x, start.y, start.x + 12, start.y + 6);
    await setup.flush();
    expect(setup.renderer.root.findDescendantById("image-annotation-0")?.visible).toBe(true);
    expect(interiorColor()).toEqual(beforeAnnotation);
    setup.mockInput.pressKey("+");
    await setup.flush();
    const rectangle = setup.renderer.root.findDescendantById("image-annotation-0")!;
    const originalBox = { x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height };
    await setup.mockMouse.drag(rectangle.x + 3, rectangle.y + 2, rectangle.x + 6, rectangle.y + 3);
    await setup.flush();
    expect(rectangle.x).toBe(originalBox.x + 3);
    expect(rectangle.y).toBe(originalBox.y + 1);
    expect([rectangle.width, rectangle.height]).toEqual([originalBox.width, originalBox.height]);
    expect(setup.renderer.root.findDescendantById("image-annotation-1")).toBeUndefined();
    setup.mockInput.pressKey("c");
    await wait(() => copies.length === 1);
    const annotated = NativeImage.decode(await readFile(copies[0]!));
    try {
      expect([annotated.width, annotated.height]).toEqual([100, 80]);
      const output = new Uint8Array(pixels.length);
      annotated.copyTo(output);
      expect(output).not.toEqual(pixels);
      expect(output.some((value, index) => index % 4 === 0 && value === 255)).toBe(true);
    } finally { annotated.dispose(); }
    expect(await readFile(path)).toEqual(original);
    setup.mockInput.pressKey("u");
    await setup.flush();
    expect(setup.renderer.root.findDescendantById("image-annotation-0")?.visible).toBe(false);
    setup.mockInput.pressKey("c");
    await wait(() => copies.length === 2);
    const clean = NativeImage.decode(await readFile(copies[1]!));
    try {
      const output = new Uint8Array(pixels.length);
      clean.copyTo(output);
      expect(output).toEqual(pixels);
    } finally { clean.dispose(); }
    let copiedPath = "";
    setup.renderer.copyToClipboardOSC52 = (path) => { copiedPath = path; return true; };
    setup.mockInput.pressKey("p");
    await wait(() => !!copiedPath);
    copies.push(copiedPath);
    expect(copiedPath).toContain("under-annotation-");
    expect((await readFile(copiedPath)).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(copies[0]).not.toBe(copies[1]);
    expect(await readFile(path)).toEqual(original);
  } finally {
    app.disposeUI();
    await setup.dispose();
    await rm(root, { recursive: true, force: true });
    for (const copy of copies) await rm(dirname(copy), { recursive: true, force: true });
  }
});
