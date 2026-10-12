import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { App } from "../src/app.ts";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.skipIf(process.env.UNDER_NO_SOCKETS === "1" || !Bun.which("nvim"))("real app launches Neovim, preserves modified work and shuts down explicitly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "under-app-"));
  await writeFile(join(dir, ".under.json"), JSON.stringify({ profiles: { nvim: { argv: [Bun.which("nvim"), "--clean"] } } }));
  const setup = await createTestRenderer({ width: 120, height: 30 }); const app = new App(setup.renderer, dir);
  try {
    await app.start(app.tab().panes[0]!); await Bun.sleep(100); await setup.flush();
    expect(setup.captureCharFrame()).toContain("nvim [running]");
    setup.mockInput.pressKey("i"); await setup.mockInput.typeText("unsaved-under-test"); setup.mockInput.pressEscape(); await Bun.sleep(100);
    await expect(app.shutdown()).rejects.toThrow("Save modified buffers");
    setup.mockInput.pressKey("g", { ctrl: true }); setup.mockInput.pressKey("p"); await setup.flush();
    expect(setup.captureCharFrame()).toContain("Commands");
    setup.mockInput.pressEscape(); await Bun.sleep(40); setup.mockInput.pressEscape(); await Bun.sleep(40);
    await app.shutdown(true);
  } finally { await app.shutdown(true).catch(() => {}); await setup.dispose(); await rm(dir, { recursive: true, force: true }); }
}, 15_000);
