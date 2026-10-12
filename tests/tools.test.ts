import { test, expect } from "bun:test";
import { EmbeddedTerminalRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { PtyHost } from "../src/pty.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const tool of ["codex", "claude", "opencode"]) {
  test.skipIf(!Bun.which(tool))(`${tool} CLI executes in a real embedded PTY`, async () => {
    const setup = await createTestRenderer({ width: 100, height: 30 });
    const host = new PtyHost({ argv: [tool, "--help"] }, process.cwd());
    const view = new EmbeddedTerminalRenderable(setup.renderer, { id: `cli-${tool}`, width: 100, height: 30, onData: b => host.write(b) });
    try {
      setup.renderer.root.add(view); host.attach(b => view.write(b));
      const code = await host.process.exited; await setup.flush();
      expect(code).toBe(0); expect(view.screen().text.length).toBeGreaterThan(20);
    } finally { await host.close(); await setup.dispose(); }
  }, 20_000);
}
for (const tool of ["yazi", "hunk"]) {
  test.skipIf(!Bun.which(tool) || process.env.UNDER_NO_SOCKETS === "1")(`${tool} interactive UI renders inside an embedded PTY`, async () => {
    const dir = await mkdtemp(join(tmpdir(), `under-${tool}-`));
    await writeFile(join(dir, "sample.ts"), "const under = true;\n");
    Bun.spawnSync({ cmd: ["git", "init"], cwd: dir });
    const setup = await createTestRenderer({ width: 100, height: 30 });
    const host = new PtyHost({ argv: tool === "hunk" ? [tool, "diff", "--watch", "--no-extensions"] : [tool] }, dir);
    const view = new EmbeddedTerminalRenderable(setup.renderer, { id: `cli-${tool}`, width: 100, height: 30, onData: b => host.write(b), onTerminalResize: (c, r) => host.resize(c, r) });
    try {
      setup.renderer.root.add(view); host.attach(b => view.write(b)); view.focus();
      const end = Date.now() + 12_000;
      while (Date.now() < end) { await Bun.sleep(100); await setup.flush(); if (view.screen().text.includes("sample.ts")) break; }
      expect(view.screen().text).toContain("sample.ts"); expect(host.phase).toBe("running");
      view.width = 60; view.height = 20; await setup.flush(); await Bun.sleep(100); await setup.flush();
      expect(host.phase).toBe("running");
      if (tool === "hunk") { await writeFile(join(dir, "sample.ts"), "const under = 'refreshed';\n"); await Bun.sleep(800); await setup.flush(); expect(view.screen().text).toContain("refreshed"); }
    } finally { await host.close(); await setup.dispose(); await rm(dir, { recursive: true, force: true }); }
  }, 20_000);
}
