import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { App, type PaneHost } from "../src/app.ts";
import { defaults } from "../src/config.ts";
import { Editor } from "../src/editor.ts";
import { terminalResponse } from "../src/terminal.ts";

test("terminal responses reject unimplemented resize events and preserve other capabilities", () => {
  const encoder = new TextEncoder(),
    decoder = new TextDecoder();
  for (const state of [1, 2, 3, 4]) {
    const packet = encoder.encode(
      `\x1b[?2026;2$y\x1b[?2048;${state}$y\x1b[?62;22c`,
    );
    expect(decoder.decode(terminalResponse(packet))).toBe(
      "\x1b[?2026;2$y\x1b[?2048;0$y\x1b[?62;22c",
    );
  }
  for (const input of [
    "\x1b[?2048;0$y",
    "\x1b[1;1:1B",
    "è界",
    "\x1b[?62;22c",
  ]) {
    const packet = encoder.encode(input);
    expect(terminalResponse(packet)).toBe(packet);
  }
});

test.skipIf(process.env.UNDER_NO_SOCKETS === "1" || !Bun.which("nvim"))(
  "real Neovim arrow scrolling stays aligned with its pane across startup, resize and zoom",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "under-arrows-"));
    const file = join(directory, "rows.ts");
    await writeFile(
      file,
      Array.from(
        { length: 120 },
        (_, index) => `ROW${String(index + 1).padStart(3, "0")} alpha è界`,
      ).join("\n") + "\n",
    );
    const setup = await createTestRenderer({ width: 150, height: 40 });
    const app = new App(setup.renderer, directory, undefined, {
      config: defaults,
      files: [],
    });
    const editor = await Editor.launch(
      {
        argv: [
          "nvim",
          "--clean",
          "--cmd",
          "set number relativenumber cursorline nowrap scrolloff=4",
        ],
      },
      directory,
    );
    const fakeHost: PaneHost = {
      phase: "running",
      exitCode: null,
      write() {},
      resize() {},
      attach() {},
      async close() {},
    };
    try {
      const pane = app.attachTerminal(app.tab().panes[0]!, editor.host, editor);
      app.attachTerminal(app.tab().panes[2]!, fakeHost);
      const chat = app.attachTerminal(app.tab().panes[1]!, fakeHost);
      await editor.ready();
      await editor.openFile(file);
      const geometry = async () => {
        const deadline = Date.now() + 4000;
        let actual: number[] = [];
        do {
          await setup.flush();
          await Bun.sleep(30);
          actual = await editor.rpc!.call<number[]>("nvim_exec_lua", [
            "return {vim.o.columns, vim.o.lines}",
            [],
          ]);
          if (actual[0] === pane.view.width && actual[1] === pane.view.height)
            break;
        } while (Date.now() < deadline);
        expect(actual).toEqual([pane.view.width, pane.view.height]);
      };
      const aligned = async () => {
        await Bun.sleep(80);
        await setup.flush();
        const visible = pane.view
          .screen()
          .lines.flatMap((line) => line.match(/ROW\d{3}/g) ?? []);
        expect(visible.length).toBeGreaterThan(2);
        expect(new Set(visible).size).toBe(visible.length);
        for (let index = 1; index < visible.length; index++)
          expect(Number(visible[index]!.slice(3))).toBe(
            Number(visible[index - 1]!.slice(3)) + 1,
          );
        const local = pane.view.screen().cursor,
          physical = setup.renderer.getCursorState();
        expect(physical.visible).toBe(true);
        expect(physical.x).toBe(pane.view.x + local.x + 1);
        expect(physical.y).toBe(pane.view.y + local.y + 1);
        expect((await editor.snapshot()).modified).toBe(false);
      };
      await geometry();
      for (let index = 0; index < 80; index++) {
        setup.mockInput.pressArrow(index < 65 ? "down" : "up");
        if (index % 10 === 0)
          chat.view.write("\r\nbackground session output\x1b[?25l");
        await Bun.sleep(10);
      }
      expect((await editor.snapshot()).cursor[0]).toBe(51);
      await aligned();
      for (const [width, height] of [
        [120, 32],
        [80, 24],
        [50, 15],
        [150, 40],
      ]) {
        setup.resize(width!, height!);
        await geometry();
        setup.mockInput.pressArrow("down");
        await Bun.sleep(25);
        setup.mockInput.pressArrow("up");
        await aligned();
      }
      for (let index = 0; index < 2; index++) {
        setup.mockInput.pressKey("g", { ctrl: true });
        setup.mockInput.pressKey("z");
        setup.mockInput.pressEscape();
        await geometry();
        await aligned();
      }
      expect((await editor.snapshot()).cursor[0]).toBe(51);
    } finally {
      await app.shutdown(true);
      await setup.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
  20_000,
);
