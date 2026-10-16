import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "smol-toml";
import { App } from "../src/app.ts";
import { defaults } from "../src/config.ts";
import { FileBridge, reviewRemote, type ReviewTarget } from "../src/bridge.ts";
import { PtyHost } from "../src/pty.ts";
import { validateState, saveState, loadState } from "../src/state.ts";
import { createWorkspace, withArgs } from "../src/model.ts";
import { yaziConfig } from "../src/yazi.ts";

test("extra pane arguments land before a trailing --watch", () => {
  expect(withArgs(["hunk", "diff", "--watch"], ["main"])).toEqual([
    "hunk",
    "diff",
    "main",
    "--watch",
  ]);
  expect(withArgs(["hunk", "diff", "--watch", "--no-extensions"], ["a", "b"])).toEqual([
    "hunk",
    "diff",
    "a",
    "b",
    "--watch",
    "--no-extensions",
  ]);
  expect(withArgs(["hunk", "diff"], ["main"])).toEqual([
    "hunk",
    "diff",
    "main",
  ]);
  const argv = ["hunk", "diff", "--watch"];
  expect(withArgs(argv, [])).toBe(argv);
  expect(withArgs(argv, undefined)).toBe(argv);
});

test("a pane working directory and arguments survive save and restore", async () => {
  const dir = await mkdtemp(join(tmpdir(), "under-scope-state-"));
  try {
    const workspace = createWorkspace("/tmp");
    const pane = workspace.tabs[0]!.panes[0]!;
    pane.cwd = "/tmp/somewhere-else";
    pane.args = ["main"];
    const state = { version: 1 as const, workspaces: [workspace], active: workspace.id };
    await saveState(join(dir, "state.json"), state);
    expect(await loadState(join(dir, "state.json"))).toEqual(state);
    const relative = structuredClone(state);
    relative.workspaces[0]!.tabs[0]!.panes[0]!.cwd = "not-absolute";
    expect(() => validateState(relative)).toThrow("working directory");
    const badArgs = structuredClone(state);
    badArgs.workspaces[0]!.tabs[0]!.panes[0]!.args = [1 as unknown as string];
    expect(() => validateState(badArgs)).toThrow("arguments");
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("the bridge accepts a review target and refuses an invalid directory", async () => {
  const bridge = new FileBridge();
  const seen: ReviewTarget[] = [];
  try {
    await bridge.start({
      open: async () => {},
      review: async (target) => {
        seen.push(target);
      },
    });
    await reviewRemote(bridge.path, {
      dir: "/tmp/project",
      staged: true,
      ref: "main",
    });
    expect(seen).toEqual([{ dir: "/tmp/project", staged: true, ref: "main" }]);
    await expect(
      reviewRemote(bridge.path, { dir: "relative/path" }),
    ).rejects.toThrow("Invalid review directory");
    await expect(
      reviewRemote(bridge.path, { dir: "/tmp/project", ref: "bad\nref" }),
    ).rejects.toThrow("Invalid revision");
  } finally {
    await bridge.close();
  }
});

test("under review-here reports the directory it is run from", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "under-review-here-")));
  const bridge = new FileBridge();
  const seen: ReviewTarget[] = [];
  let host: PtyHost | undefined;
  try {
    await bridge.start({
      open: async () => {},
      review: async (target) => {
        seen.push(target);
      },
    });
    host = new PtyHost(
      {
        argv: [
          process.execPath,
          resolve("src/main.ts"),
          "review-here",
          "--staged",
        ],
        env: { UNDER_OPEN_SOCKET: bridge.path },
      },
      dir,
    );
    expect(await host.process.exited).toBe(0);
    expect(seen).toEqual([{ dir, staged: true }]);
  } finally {
    if (host) await host.close();
    await bridge.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the Yazi overlay adds review bindings without shadowing the user's keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "under-yazi-keys-"));
  try {
    await writeFile(
      join(root, "keymap.toml"),
      '[mgr]\nprepend_keymap = [\n  { on = "R", run = "plugin user", desc = "user R" },\n  { on = "z", run = "quit", desc = "user z" },\n]\n',
    );
    const overlay = await yaziConfig({
      editor: "/tmp/helper/nvim",
      tool: "/tmp/under helper/under",
      env: { YAZI_CONFIG_HOME: root },
    });
    const keymap = parse(await readFile(join(overlay, "keymap.toml"), "utf8"));
    const entries = (keymap.mgr as Record<string, unknown>).prepend_keymap as Array<Record<string, string>>;
    const ons = entries.map((entry) => entry.on);
    // The user's R wins; only C is added, and it reaches Under's helper.
    expect(ons.filter((on) => on === "R")).toHaveLength(1);
    expect(entries.find((entry) => entry.on === "R")!.desc).toBe("user R");
    expect(entries.find((entry) => entry.on === "C")!.run).toBe(
      "shell '/tmp/under helper/under' review-here --staged",
    );
    expect(entries.find((entry) => entry.on === "z")!.desc).toBe("user z");
    // The user's own file is untouched.
    expect(await readFile(join(root, "keymap.toml"), "utf8")).toContain(
      "plugin user",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the Yazi overlay writes review bindings when the user has no keymap", async () => {
  const root = await mkdtemp(join(tmpdir(), "under-yazi-empty-"));
  try {
    const overlay = await yaziConfig({
      editor: "/tmp/helper/nvim",
      tool: "/tmp/under-helper/under",
      env: { YAZI_CONFIG_HOME: root },
    });
    const keymap = parse(await readFile(join(overlay, "keymap.toml"), "utf8"));
    const ons = ((keymap.mgr as Record<string, unknown>).prepend_keymap as Array<Record<string, string>>).map(
      (entry) => entry.on,
    );
    // The reveal binding is added whenever `ya` is installed.
    expect(ons.filter((on) => on !== "<F20>")).toEqual(["R", "C"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(!Bun.which("hunk") || process.env.UNDER_NO_SOCKETS === "1")(
  "a review targets another directory and is reused per directory and revision",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "under-scope-")));
    const workspace = join(root, "main");
    const worktree = join(root, "worktree-a");
    const outside = join(root, "not-a-repo");
    for (const dir of [workspace, worktree]) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "a.ts"), "one\n");
      Bun.spawnSync({ cmd: ["git", "init"], cwd: dir });
      Bun.spawnSync({ cmd: ["git", "add", "."], cwd: dir });
    }
    await mkdir(outside, { recursive: true });
    await writeFile(
      join(workspace, ".under.json"),
      JSON.stringify({
        profiles: {
          nvim: { argv: [Bun.which("nvim") ?? "nvim", "--clean"] },
          hunk: { argv: ["hunk", "diff", "--watch", "--no-extensions"] },
        },
      }),
    );
    const setup = await createTestRenderer({ width: 150, height: 35 });
    const app = new App(setup.renderer, workspace, undefined, {
      available: () => true,
    });
    const reviewPane = () => {
      // openReview activates its tab, so the review pane is in the active tab.
      return app.tab().panes.find((pane) => pane.kind === "hunk");
    };
    try {
      await app.start(app.tab().panes[0]!);
      expect(app.workspace().tabs).toHaveLength(1);

      await app.openReview({ cwd: worktree });
      expect(app.workspace().tabs).toHaveLength(2);
      expect(reviewPane()!.cwd).toBe(worktree);
      expect(reviewPane()!.args).toBeUndefined();

      // Same directory again reuses the tab instead of stacking another.
      await app.openReview({ cwd: worktree });
      expect(app.workspace().tabs).toHaveLength(2);

      // A different directory gets its own tab.
      await app.openReview({ cwd: workspace });
      expect(app.workspace().tabs).toHaveLength(3);
      expect(reviewPane()!.cwd).toBe(workspace);

      // A revision is a distinct target too.
      await app.openReview({ cwd: worktree, from: "HEAD" });
      expect(app.workspace().tabs).toHaveLength(4);
      const revision = app
        .workspace()
        .tabs.flatMap((t) => t.panes)
        .find((pane) => pane.kind === "hunk" && pane.args?.length)!;
      expect(revision.cwd).toBe(worktree);
      expect(revision.args).toEqual(["HEAD"]);

      await expect(app.openReview({ cwd: outside })).rejects.toThrow(
        "Git working tree",
      );
      expect(app.workspace().tabs).toHaveLength(4);
    } finally {
      await app.shutdown(true).catch(() => {});
      await setup.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
  40_000,
);
