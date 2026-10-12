import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { App } from "../src/app.ts";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPane, split } from "../src/model.ts";

test.skipIf(process.env.UNDER_NO_SOCKETS === "1" || !Bun.which("nvim"))(
  "real app launches Neovim, preserves modified work and shuts down explicitly",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "under-app-"));
    await writeFile(
      join(dir, ".under.json"),
      JSON.stringify({
        profiles: { nvim: { argv: [Bun.which("nvim"), "--clean"] } },
      }),
    );
    const setup = await createTestRenderer({ width: 120, height: 30 });
    const app = new App(setup.renderer, dir);
    try {
      await app.start(app.tab().panes[0]!);
      await Bun.sleep(100);
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("nvim [running]");
      setup.mockInput.pressKey("i");
      await setup.mockInput.typeText("unsaved-under-test");
      setup.mockInput.pressEscape();
      await Bun.sleep(100);
      await expect(app.shutdown()).rejects.toThrow("Save modified buffers");
      setup.mockInput.pressKey("g", { ctrl: true });
      setup.mockInput.pressKey("p");
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("Commands");
      setup.mockInput.pressEscape();
      await Bun.sleep(40);
      setup.mockInput.pressEscape();
      await Bun.sleep(40);
      const normalQuit = app.shutdown();
      const forcedQuit = app.shutdown(true);
      await expect(normalQuit).rejects.toThrow("Save modified buffers");
      await forcedQuit;
    } finally {
      await app.shutdown(true).catch(() => {});
      await setup.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
  15_000,
);
test.skipIf(process.env.UNDER_NO_SOCKETS === "1" || !Bun.which("nvim"))(
  "child editor wrapper routes a line location to the existing workspace editor",
  async () => {
    const dir = await realpath(
      await mkdtemp(join(tmpdir(), "under-open-integration-")),
    );
    const file = join(dir, "quote ' and è.ts");
    await writeFile(file, "first\nsecond\nthird\n");
    await writeFile(
      join(dir, ".under.json"),
      JSON.stringify({
        profiles: { nvim: { argv: [Bun.which("nvim"), "--clean"] } },
        tasks: {
          open: {
            argv: [
              process.execPath,
              resolve("src/main.ts"),
              "open",
              "+2",
              file,
            ],
          },
        },
      }),
    );
    const setup = await createTestRenderer({ width: 100, height: 30 });
    const app = new App(setup.renderer, dir);
    try {
      await app.start(app.tab().panes[0]!);
      const pane = createPane("task", "open");
      app.tab().panes.push(pane);
      app.tab().layout = split(
        app.tab().layout,
        app.tab().focused,
        pane.id,
        "row",
      );
      await app.start(pane);
      const deadline = Date.now() + 5000;
      let snapshot = await app.editorSnapshot();
      while (snapshot.path !== file && Date.now() < deadline) {
        await Bun.sleep(25);
        snapshot = await app.editorSnapshot();
      }
      expect(snapshot.path).toBe(file);
      expect(snapshot.cursor[0]).toBe(2);
      expect(snapshot.modified).toBe(false);
      await app.shutdown();
    } finally {
      await app.shutdown(true).catch(() => {});
      await setup.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
  15_000,
);
