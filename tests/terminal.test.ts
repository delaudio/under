import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { EmbeddedTerminalRenderable } from "@opentui/core";
import { PtyHost } from "../src/pty.ts";
import { App } from "../src/app.ts";

test("real PTY renders VT output, replies to terminal queries and resizes", async () => {
  const fixture = `process.stdout.write('\\x1b[?1049h\\x1b[2J\\x1b[H\\x1b[38;2;120;200;80mhello è界\\x1b[0m\\r\\n\\x1b[?2004h\\x1b[6n');process.stdin.setRawMode(true);process.stdin.on('data',d=>{if(d.toString().includes('R'))process.stdout.write('REPLY\\r\\n');if(d.toString().includes('ping'))process.stdout.write('PONG\\r\\n')});process.on('SIGWINCH',()=>process.stdout.write('SIZE:'+process.stdout.columns+'x'+process.stdout.rows+'\\r\\n'));setInterval(()=>{},1000)`;
  const setup = await createTestRenderer({ width: 80, height: 24 }); const host = new PtyHost({ argv: [process.execPath, "-e", fixture] }, process.cwd());
  const view = new EmbeddedTerminalRenderable(setup.renderer, { id: "vt", width: 80, height: 24, onData: b => host.write(b), onTerminalResize: (c, r) => host.resize(c, r) });
  try {
    setup.renderer.root.add(view); host.attach(b => view.write(b)); view.focus();
    await Bun.sleep(200); await setup.flush(); await Bun.sleep(100); await setup.flush();
    expect(view.screen().text).toContain("hello è界"); expect(view.screen().text).toContain("REPLY");
    host.write(view.encodePaste(new TextEncoder().encode("ping"))); await Bun.sleep(100); await setup.flush(); expect(view.screen().text).toContain("PONG");
    host.resize(50, 15); await Bun.sleep(100); await setup.flush(); expect(view.screen().text).toContain("SIZE:50x15");
    view.visible = false; host.write(new TextEncoder().encode("ping")); await Bun.sleep(100); view.visible = true; await setup.flush(); expect(view.screen().text.match(/PONG/g)!.length).toBe(2);
  } finally { await host.close(); await setup.dispose(); }
  expect(host.phase).toBe("exited"); await host.close();
});
test("real terminal app renders narrow/wide shell and command palette", async () => {
  for (const [width, height] of [[120, 30], [80, 24], [50, 15]]) {
    const setup = await createTestRenderer({ width, height }); const app = new App(setup.renderer, process.cwd());
    try {
      await setup.flush(); expect(setup.captureCharFrame()).toContain("under_");
      setup.mockInput.pressKey("g", { ctrl: true }); setup.mockInput.pressKey("p"); await setup.flush(); expect(setup.captureCharFrame()).toContain("Commands");
      setup.mockInput.pressEscape(); await Bun.sleep(40); await setup.flush(); expect(app.input.mode).toBe("app");
      setup.mockInput.pressEscape(); await Bun.sleep(40); expect(app.input.mode).toBe("terminal");
      setup.resize(50, 15); await setup.flush(); expect(setup.captureCharFrame()).toContain("under_");
    } finally { app.disposeUI(); await setup.dispose(); }
  }
});
