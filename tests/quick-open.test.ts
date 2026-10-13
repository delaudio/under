import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { App, type PaneEditor, type PaneHost } from "../src/app.ts";
import { defaults } from "../src/config.ts";
import { fuzzyScore, listFiles, rank } from "../src/search.ts";
import { createWorkspace, preset } from "../src/model.ts";

const running = (): PaneHost => ({
  phase: "running",
  exitCode: null,
  write() {},
  resize() {},
  attach() {},
  async close() {},
});
const editor = (calls: string[], path = "/fixtures/project/welcome.ts"): PaneEditor => ({
  async snapshot() {
    return {
      path,
      lines: ["const greeting = 'Hello';"],
      cursor: [1, 0],
      changedtick: 1,
      modified: true,
      selection: [],
      diagnostics: [],
    };
  },
  async openFile(file) {
    calls.push(`open:${file}`);
  },
  async ready() {},
  async modified() {
    return [path];
  },
  async quit() {
    calls.push("quit");
  },
  async dispose() {},
  abortInitialization() {},
});

test("fuzzy scoring prefers the file the fragment names", () => {
  expect(fuzzyScore("app", "src/other.ts")).toBeNull();
  expect(fuzzyScore("", "src/app.ts")).toBe(0);
  const exact = fuzzyScore("app.ts", "src/app.ts")!;
  const prefix = fuzzyScore("app", "src/app.ts")!;
  const substring = fuzzyScore("pp", "src/app.ts")!;
  const spread = fuzzyScore("app", "a/p/p/deep/file.ts")!;
  expect(exact).toBeGreaterThan(prefix);
  expect(prefix).toBeGreaterThan(substring);
  // Matching the basename beats matching characters spread across directories.
  expect(prefix).toBeGreaterThan(spread);
  // A shorter path wins when the match is equally good.
  expect(fuzzyScore("app", "app.ts")!).toBeGreaterThan(
    fuzzyScore("app", "deep/nested/app.ts")!,
  );
});

test("ranking is bounded, ordered and stable", () => {
  const paths = [
    "src/app.ts",
    "src/appendix.ts",
    "app/main.ts",
    "src/zzz/a-x-p-p.ts",
  ];
  const ranked = rank("app", paths, 10);
  expect(ranked).toHaveLength(4);
  // The file the fragment names comes first, a scattered match last.
  expect(ranked[0]).toBe("src/app.ts");
  expect(ranked.indexOf("src/app.ts")).toBeLessThan(
    ranked.indexOf("src/zzz/a-x-p-p.ts"),
  );
  expect(rank("app", paths, 1)).toEqual(["src/app.ts"]);
  expect(rank("app", paths, 2)).toHaveLength(2);
  expect(rank("nomatch", paths, 10)).toEqual([]);
  // No query keeps the incoming order, and equal scores keep their index order.
  expect(rank("", paths, 2)).toEqual(["src/app.ts", "src/appendix.ts"]);
  expect(rank("e", ["a/e.ts", "b/e.ts"], 10)).toEqual(["a/e.ts", "b/e.ts"]);
});

test("enumeration respects ignore rules and stays bounded", async () => {
  const repo = await mkdtemp(join(tmpdir(), "under-quick-git-"));
  const plain = await mkdtemp(join(tmpdir(), "under-quick-plain-"));
  try {
    await writeFile(join(repo, ".gitignore"), "ignored.txt\n");
    await writeFile(join(repo, "kept.ts"), "");
    await writeFile(join(repo, "ignored.txt"), "");
    Bun.spawnSync({ cmd: ["git", "init"], cwd: repo });
    const fromGit = await listFiles(repo);
    expect(fromGit).toContain("kept.ts");
    expect(fromGit).not.toContain("ignored.txt");

    await mkdir(join(plain, "node_modules"));
    await writeFile(join(plain, "node_modules", "vendored.ts"), "");
    await writeFile(join(plain, "app.ts"), "");
    const walked = await listFiles(plain);
    expect(walked).toContain("app.ts");
    expect(walked.some((file) => file.startsWith("node_modules"))).toBe(false);
    expect(await listFiles(plain, 1)).toHaveLength(1);
    // A missing directory is an empty result rather than a crash.
    expect(await listFiles(join(plain, "gone"))).toEqual([]);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(plain, { recursive: true, force: true });
  }
});

test("quick open filters, opens in the editor and keeps modified buffers", async () => {
  const calls: string[] = [];
  const setup = await createTestRenderer({ width: 120, height: 30 });
  const app = new App(setup.renderer, "/fixtures/project", undefined, {
    config: defaults,
    files: [],
    quickFiles: ["src/app.ts", "src/other.ts", "README.md"],
  });
  const host: PaneHost = { ...running(), write: (bytes) => calls.push(`write:${new TextDecoder().decode(bytes)}`) };
  try {
    app.attachTerminal(app.tab().panes[0]!, host, editor(calls));
    await setup.flush();
    setup.mockInput.pressKey("g", { ctrl: true });
    setup.mockInput.pressKey("o");
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("Quick open");
    await setup.mockInput.typeText("app");
    await setup.flush();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("src/app.ts");
    expect(frame).not.toContain("README.md");
    // Keys belong to the modal, never to the focused tool.
    expect(calls.filter((call) => call.startsWith("write:"))).toEqual([]);
    setup.mockInput.pressEnter();
    await Bun.sleep(30);
    await setup.flush();
    expect(calls).toContain(`open:${resolve("/fixtures/project", "src/app.ts")}`);
    expect(calls).not.toContain("quit");
    expect(app.input.mode).toBe("terminal");

    // With an empty query the file just opened is the first destination.
    setup.mockInput.pressKey("g", { ctrl: true });
    setup.mockInput.pressKey("o");
    await setup.flush();
    const recent = setup
      .captureCharFrame()
      .split("\n")
      .find((line) => line.startsWith("│›"))!;
    expect(recent).toContain("src/app.ts");
  } finally {
    app.disposeUI();
    await setup.dispose();
  }
});

test("quick open enumerates a real directory and cancels cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "under-quick-real-"));
  const setup = await createTestRenderer({ width: 100, height: 24 });
  try {
    await writeFile(join(root, "alpha.ts"), "");
    await writeFile(join(root, "beta.ts"), "");
    const app = new App(setup.renderer, root, undefined, {
      config: defaults,
      files: [],
    });
    try {
      app.attachTerminal(app.tab().panes[0]!, running(), editor([]));
      await setup.flush();
      // Closing before enumeration finishes must not leave stale results behind.
      setup.mockInput.pressKey("g", { ctrl: true });
      setup.mockInput.pressKey("o");
      setup.mockInput.pressEscape();
      await Bun.sleep(120);
      // Escape left navigation mode, so return to the terminal before the prefix.
      setup.mockInput.pressEscape();
      await Bun.sleep(40);
      setup.mockInput.pressKey("g", { ctrl: true });
      setup.mockInput.pressKey("o");
      const deadline = Date.now() + 3000;
      let listed = false;
      while (!listed && Date.now() < deadline) {
        await Bun.sleep(50);
        await setup.flush();
        listed = setup.captureCharFrame().includes("alpha.ts");
      }
      expect(listed).toBe(true);
    } finally {
      app.disposeUI();
    }
  } finally {
    await setup.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("the destination switcher reaches every workspace and tab without restarting tools", async () => {
  const setup = await createTestRenderer({ width: 120, height: 30 });
  const app = new App(setup.renderer, "/fixtures/project", undefined, {
    config: defaults,
    files: [],
  });
  const closed: string[] = [];
  const host = (id: string): PaneHost => ({
    ...running(),
    async close() {
      closed.push(id);
    },
  });
  try {
    app.attachTerminal(app.tab().panes[0]!, host("editor"));
    // A second, idle tab in this workspace and a second workspace.
    const extra = preset("run");
    app.workspace().tabs.push(extra);
    const other = createWorkspace("/fixtures/second");
    app.state.workspaces.push(other);
    app.draw();
    await setup.flush();

    setup.mockInput.pressKey("g", { ctrl: true });
    setup.mockInput.pressKey("g");
    await setup.flush();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Go to workspace or tab");
    expect(frame).toContain("code");
    expect(frame).toContain("run · shell · idle");
    expect(frame).toContain("second");

    // Filter down to the idle tab and go there.
    await setup.mockInput.typeText("run");
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("run · shell · idle");
    setup.mockInput.pressEnter();
    await Bun.sleep(30);
    await setup.flush();
    expect(app.tab().id).toBe(extra.id);
    expect(app.state.active).toBe(app.workspace().id);
    expect(app.input.mode).toBe("terminal");
    // Focusing a destination is not a lifecycle action.
    expect(closed).toEqual([]);
  } finally {
    app.disposeUI();
    await setup.dispose();
  }
});
