import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readFile,
  realpath,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { App } from "../src/app.ts";
import { defaults } from "../src/config.ts";
import { FileBrowser } from "../src/files.ts";
import { menuSlots } from "../src/menu.ts";
import { PtyHost } from "../src/pty.ts";
import { EmbeddedTerminalRenderable } from "@opentui/core";

const tick = () => Bun.sleep(40);
test("files list directories first, navigate within the project and preserve actual filenames", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "under-files-")));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, ".git"));
    await writeFile(join(root, "quote ' è.ts"), "first\n");
    const browser = new FileBrowser(root);
    await browser.load();
    expect(browser.entries.map((e) => e.name)).toEqual(["src", "quote ' è.ts"]);
    await browser.load(join(root, "src"));
    expect(browser.entries[0]!.name).toBe("..");
    await expect(browser.load(resolve(root, ".."))).rejects.toThrow("outside");
  } finally {
    await rm(root, { recursive: true });
  }
});

test("the shortcut help opens from h and from ? and Escape returns ownership", async () => {
  const setup = await createTestRenderer({ width: 120, height: 30 });
  const app = new App(setup.renderer, "/fixtures/project", undefined, {
    config: defaults,
    files: [],
  });
  try {
    await setup.flush();
    // Entering navigation must be visible, not just a mode change.
    setup.mockInput.pressKey("g", { ctrl: true });
    await setup.flush();
    expect(app.input.mode).toBe("app");
    const footer = setup.captureCharFrame().split("\n").at(-2) ?? "";
    expect(footer).toContain("NAV |");
    expect(footer).toContain("h: help");
    setup.mockInput.pressEscape();
    await Bun.sleep(40);

    for (const key of ["h", "?"]) {
      setup.mockInput.pressKey("g", { ctrl: true });
      setup.mockInput.pressKey(key);
      await setup.flush();
      expect(app.input.mode).toBe("modal");
      expect(setup.captureCharFrame()).toContain("Under shortcuts");
      setup.mockInput.pressEscape();
      await Bun.sleep(40);
      expect(app.input.mode).toBe("app");
      setup.mockInput.pressEscape();
      await Bun.sleep(40);
      expect(app.input.mode).toBe("terminal");
    }
  } finally {
    app.disposeUI();
    await setup.dispose();
  }
});

test("menus use correct mouse coordinates after wrap/resize, disabled actions stay open and Escape restores ownership", async () => {
  const setup = await createTestRenderer({ width: 120, height: 30 });
  const app = new App(setup.renderer, "/fixtures/project", undefined, {
    config: defaults,
    files: [],
    available: () => false,
  });
  try {
    await setup.flush();
    const agent = menuSlots(120).slots.find((s) => s.label === "Agent")!;
    await setup.mockMouse.click(agent.x + 1, agent.y);
    await setup.flush();
    expect(app.input.mode).toBe("modal");
    expect(setup.captureCharFrame()).toContain("Start agent: codex");
    setup.mockInput.pressEnter();
    await setup.flush();
    expect(app.input.mode).toBe("modal");
    expect(setup.captureCharFrame()).toContain("Install codex");
    setup.mockInput.pressEscape();
    await tick();
    expect(app.input.mode).toBe("terminal");
    setup.resize(24, 10);
    await setup.flush();
    const view = menuSlots(24).slots.find((s) => s.label === "View")!;
    await setup.mockMouse.click(view.x + 1, view.y);
    await setup.flush();
    setup.mockInput.pressArrow("right");
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("Tools");
    setup.mockInput.pressEscape();
    await tick();
    setup.mockInput.pressKey("g", { ctrl: true });
    setup.mockInput.pressKey("f");
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("Empty directory");
    setup.mockInput.pressEscape();
    await tick();
    expect(app.input.mode).toBe("terminal");
  } finally {
    app.disposeUI();
    await setup.dispose();
  }
});

test.skipIf(process.env.UNDER_NO_SOCKETS === "1" || !Bun.which("nvim"))(
  "launcher loads normal isolated Neovim config, edits/saves Unicode and restores focus after menus",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "under-launcher-")),
    );
    const project = join(root, "project"),
      xdg = join(root, "config");
    await mkdir(project);
    await mkdir(join(xdg, "nvim"), { recursive: true });
    await writeFile(
      join(xdg, "nvim", "init.lua"),
      'vim.opt.swapfile = false\nvim.opt.mouse = "a"\nvim.opt.laststatus = 2\nvim.opt.statusline = "UNDER_LAUNCHER_READY"\n',
    );
    await writeFile(join(project, "welcome.ts"), "first\n");
    const setup = await createTestRenderer({ width: 120, height: 30 });
    const host = new PtyHost(
      {
        argv: [resolve("under"), project],
        env: {
          XDG_CONFIG_HOME: xdg,
          YAZI_CONFIG_HOME: join(xdg, "yazi"),
          XDG_STATE_HOME: join(root, "state"),
          XDG_DATA_HOME: join(root, "data"),
          XDG_CACHE_HOME: join(root, "cache"),
        },
      },
      project,
      120,
      30,
    );
    const view = new EmbeddedTerminalRenderable(setup.renderer, {
      id: "launcher",
      width: 120,
      height: 30,
      onData: (b) => host.write(b),
      onTerminalResize: (c, r) => host.resize(c, r),
    });
    setup.renderer.root.add(view);
    host.attach((b) => view.write(b));
    view.focus();
    const send = async (text: string) => {
      host.write(new TextEncoder().encode(text));
      await tick();
      await setup.flush();
    };
    const waitFor = async (text: string) => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        await tick();
        await setup.flush();
        if (view.screen().text.includes(text)) return;
      }
      expect(view.screen().text).toContain(text);
    };
    try {
      await waitFor("UNDER_LAUNCHER_READY");
      if (Bun.which("yazi")) await waitFor("yazi [running]");
      else expect(view.screen().text).toContain("welcome.ts");
      expect(view.screen().text).toContain("Choose provider");
      if (Bun.which("yazi")) {
        await waitFor("yazi [running]");
        await waitFor("1/1"); // Yazi finished loading the isolated single-file directory
      }
      await send("\x07");
      await send("f");
      await send("\r"); // native Yazi opens through the editor bridge
      await waitFor("Opened welcome.ts");
      await send("iHello è界");
      await send("\x1b");
      await send(":w\r");
      expect(await readFile(join(project, "welcome.ts"), "utf8")).toContain(
        "Hello è界",
      );
      await send("\x07");
      await send("m");
      await waitFor("Open file in Neovim");
      await send("\x1b");
      await tick();
      await send("\x1b");
      await send("A again");
      await send("\x1b");
      await send(":w\r");
      expect(await readFile(join(project, "welcome.ts"), "utf8")).toContain(
        "again",
      );
      view.width = 80;
      view.height = 24;
      await setup.flush();
      await tick();
      await send("\x07");
      await send("p");
      await waitFor("Commands");
      await send("\x1b");
      await tick();
      await send("\x1b");
      await send("\x07");
      await send("q");
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Launcher did not exit")), 5000),
      );
      expect(await Promise.race([host.process.exited, timeout])).toBe(0);
    } finally {
      await host.close();
      await setup.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
  20_000,
);
