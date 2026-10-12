import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { EmbeddedTerminalRenderable } from "@opentui/core";
import { PtyHost } from "../src/pty.ts";
import { App } from "../src/app.ts";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("real PTY renders VT output, replies to terminal queries and resizes", async () => {
  const fixture = `process.stdout.write('\\x1b[?1049h\\x1b[2J\\x1b[H\\x1b[38;2;120;200;80mhello è界\\x1b[0m\\r\\n\\x1b[?2004h\\x1b[6n');process.stdin.setRawMode(true);process.stdin.on('data',d=>{if(d.toString().includes('R'))process.stdout.write('REPLY\\r\\n');if(d.toString().includes('ping'))process.stdout.write('PONG\\r\\n')});process.on('SIGWINCH',()=>process.stdout.write('SIZE:'+process.stdout.columns+'x'+process.stdout.rows+'\\r\\n'));setInterval(()=>{},1000)`;
  const setup = await createTestRenderer({ width: 80, height: 24 });
  const host = new PtyHost(
    { argv: [process.execPath, "-e", fixture] },
    process.cwd(),
  );
  const view = new EmbeddedTerminalRenderable(setup.renderer, {
    id: "vt",
    width: 80,
    height: 24,
    onData: (b) => host.write(b),
    onTerminalResize: (c, r) => host.resize(c, r),
  });
  try {
    setup.renderer.root.add(view);
    host.attach((b) => view.write(b));
    view.focus();
    await Bun.sleep(200);
    await setup.flush();
    await Bun.sleep(100);
    await setup.flush();
    expect(view.screen().text).toContain("hello è界");
    expect(view.screen().text).toContain("REPLY");
    host.write(view.encodePaste(new TextEncoder().encode("ping")));
    await Bun.sleep(100);
    await setup.flush();
    expect(view.screen().text).toContain("PONG");
    host.resize(50, 15);
    await Bun.sleep(100);
    await setup.flush();
    expect(view.screen().text).toContain("SIZE:50x15");
    view.visible = false;
    host.write(new TextEncoder().encode("ping"));
    await Bun.sleep(100);
    view.visible = true;
    await setup.flush();
    expect(view.screen().text.match(/PONG/g)!.length).toBe(2);
  } finally {
    await host.close();
    await setup.dispose();
  }
  expect(host.phase).toBe("exited");
  await host.close();
});
test("real terminal app renders narrow/wide shell and command palette", async () => {
  for (const [width, height] of [
    [120, 30],
    [80, 24],
    [50, 15],
  ]) {
    const setup = await createTestRenderer({ width, height });
    const app = new App(setup.renderer, process.cwd());
    try {
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("under_");
      setup.mockInput.pressKey("g", { ctrl: true });
      setup.mockInput.pressKey("p");
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("Commands");
      setup.mockInput.pressEscape();
      await Bun.sleep(40);
      await setup.flush();
      expect(app.input.mode).toBe("app");
      setup.mockInput.pressEscape();
      await Bun.sleep(40);
      expect(app.input.mode).toBe("terminal");
      setup.resize(50, 15);
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("under_");
    } finally {
      app.disposeUI();
      await setup.dispose();
    }
  }
});
test("full CLI responds to SIGTERM, saves metadata and restores the terminal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "under-signal-"));
  const setup = await createTestRenderer({ width: 80, height: 24 });
  const host = new PtyHost(
    {
      argv: [process.execPath, resolve("src/main.ts"), "--no-editor"],
      env: { XDG_STATE_HOME: dir, XDG_CONFIG_HOME: dir },
    },
    process.cwd(),
  );
  const view = new EmbeddedTerminalRenderable(setup.renderer, {
    id: "under-cli",
    width: 80,
    height: 24,
    onData: (b) => host.write(b),
  });
  try {
    setup.renderer.root.add(view);
    host.attach((b) => view.write(b));
    const deadline = Date.now() + 5000;
    while (!view.screen().text.includes("under_") && Date.now() < deadline) {
      await Bun.sleep(50);
      await setup.flush();
    }
    expect(view.screen().text).toContain("under_");
    host.process.kill("SIGTERM");
    const exit = await host.process.exited;
    expect(exit).toBe(0);
    const state = JSON.parse(
      await readFile(join(dir, "under", "state.json"), "utf8"),
    );
    expect(state.version).toBe(1);
    expect(state.workspaces.length).toBe(1);
  } finally {
    await host.close();
    await setup.dispose();
    await rm(dir, { recursive: true });
  }
}, 10_000);

test("cleanup accepts a denied probe only when an exited PTY group is proven absent", async () => {
  const host = new PtyHost(
    { argv: [process.execPath, "-e", "process.exit(0)"] },
    process.cwd(),
  );
  await host.process.exited;
  const originalKill = process.kill;
  try {
    process.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
      if (pid === -host.process.pid)
        throw Object.assign(new Error("Denied probe"), { code: "EPERM" });
      return originalKill(pid, signal);
    }) as typeof process.kill;
    await host.close();
    expect(host.phase).toBe("exited");
  } finally {
    process.kill = originalKill;
  }
});

test("cleanup never treats denied signals against a live PTY as successful", async () => {
  const host = new PtyHost(
    { argv: [process.execPath, "-e", "setInterval(()=>{},1000)"] },
    process.cwd(),
  );
  const originalKill = process.kill;
  try {
    process.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
      if (pid === -host.process.pid)
        throw Object.assign(new Error("Denied signal"), { code: "EPERM" });
      return originalKill(pid, signal);
    }) as typeof process.kill;
    await expect(host.close()).rejects.toThrow("Denied signal");
    expect(host.phase).toBe("error");
  } finally {
    process.kill = originalKill;
    originalKill(-host.process.pid, "SIGKILL");
    await host.process.exited;
  }
});
