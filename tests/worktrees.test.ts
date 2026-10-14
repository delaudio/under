import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/app.ts";
import { defaults } from "../src/config.ts";
import {
  listWorktrees,
  parseWorktrees,
  worktreeBlocker,
  worktreeLabel,
  type Worktree,
} from "../src/git.ts";

const git = (args: string[], cwd: string) => {
  // Never depend on the developer's or runner's global Git identity.
  const result = Bun.spawnSync({
    cmd: [
      "git",
      "-c",
      "user.name=Under Test",
      "-c",
      "user.email=test@under.invalid",
      ...args,
    ],
    cwd,
  });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
};

test("Git's machine-readable worktree output is parsed field by field", () => {
  const raw = [
    "worktree /repo",
    "HEAD 1111111111111111111111111111111111111111",
    "branch refs/heads/main",
    "",
    "worktree /repo/wt-a",
    "HEAD 2222222222222222222222222222222222222222",
    "branch refs/heads/feature/x",
    "",
    "worktree /repo/wt-b",
    "HEAD 3333333333333333333333333333333333333333",
    "detached",
    "",
    "worktree /repo/wt-c",
    "HEAD 4444444444444444444444444444444444444444",
    "branch refs/heads/locked",
    "locked in use",
    "",
  ].join("\0");
  const worktrees = parseWorktrees(raw);
  expect(worktrees).toHaveLength(4);
  expect(worktrees[0]).toMatchObject({
    path: "/repo",
    branch: "main",
    primary: true,
    detached: false,
    missing: false,
  });
  expect(worktrees[1]!.branch).toBe("feature/x");
  expect(worktrees[1]!.primary).toBe(false);
  expect(worktrees[2]!.detached).toBe(true);
  expect(worktrees[2]!.branch).toBeUndefined();
  expect(worktrees[3]!.locked).toBe("in use");
  expect(worktreeBlocker(worktrees[3]!)).toContain("Locked");
  expect(worktreeLabel(worktrees[2]!)).toContain("detached HEAD");
});

test.skipIf(!Bun.which("git"))(
  "a real repository reports its primary, linked and detached worktrees",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "under-wt-")));
    // Spaces and Unicode must survive discovery.
    const repo = join(root, "repo con spazi è");
    try {
      await mkdir(repo);
      git(["init", "-q"], repo);
      git(["commit", "-q", "--allow-empty", "-m", "one"], repo);
      const linked = join(root, "wt con spazi");
      const detached = join(root, "wt-detached");
      git(["worktree", "add", "-q", "-b", "feature", linked], repo);
      git(["worktree", "add", "-q", "--detach", detached], repo);

      const worktrees = await listWorktrees(repo);
      expect(worktrees).toHaveLength(3);
      expect(worktrees[0]!.primary).toBe(true);
      expect(worktrees[0]!.path).toBe(repo);
      const feature = worktrees.find((entry) => entry.branch === "feature")!;
      expect(feature.path).toBe(linked);
      expect(worktreeBlocker(feature)).toBeUndefined();
      const head = worktrees.find((entry) => entry.detached)!;
      expect(head.path).toBe(detached);
      expect(worktreeLabel(head)).toContain("detached HEAD");

      // A directory that disappears stays listed but cannot be opened.
      await rm(detached, { recursive: true, force: true });
      const stale = (await listWorktrees(repo)).find(
        (entry) => entry.path === detached,
      )!;
      expect(stale.missing).toBe(true);
      expect(worktreeBlocker(stale)).toContain("missing");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(!Bun.which("git"))(
  "the worktree picker opens a checkout, reuses an open one and starts nothing",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "under-wt-app-")));
    const repo = join(root, "repo");
    const linked = join(root, "wt-a");
    try {
      await mkdir(repo);
      git(["init", "-q"], repo);
      git(["commit", "-q", "--allow-empty", "-m", "one"], repo);
      git(["worktree", "add", "-q", "-b", "feature", linked], repo);

      const setup = await createTestRenderer({ width: 120, height: 30 });
      const app = new App(setup.renderer, repo, undefined, {
        config: defaults,
        files: [],
      });
      try {
        await setup.flush();
        // Drive the real command path from the palette.
        setup.mockInput.pressKey("g", { ctrl: true });
        setup.mockInput.pressKey("p");
        await setup.flush();
        await setup.mockInput.typeText("Open a worktree");
        setup.mockInput.pressEnter();
        await Bun.sleep(60);
        await setup.flush();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("Worktrees of");
        expect(frame).toContain("feature");

        const items = (app as any).worktreeItems() as {
          name: string;
          disabled?: string;
        }[];
        expect(items).toHaveLength(2);
        expect(items.some((item) => item.name.includes("primary"))).toBe(true);

        setup.mockInput.pressArrow("down");
        setup.mockInput.pressEnter();
        await Bun.sleep(40);
        await setup.flush();
        expect(app.state.workspaces).toHaveLength(2);
        expect(app.workspace().path).toBe(linked);
        // Opening a worktree starts no tool.
        const runtimes = (app as any).runtimes as Map<string, unknown>;
        expect(app.tab().panes.every((pane) => !runtimes.has(pane.id))).toBe(
          true,
        );

        // The same checkout is reused rather than opened twice.
        await (app as any).openWorktrees();
        const again = (app as any).worktreeItems() as {
          name: string;
          action: () => void;
        }[];
        const openEntry = again.find((item) => item.name.includes("feature"))!;
        expect(openEntry.name).toContain("open");
        openEntry.action();
        expect(app.state.workspaces).toHaveLength(2);
        expect(app.workspace().path).toBe(linked);
      } finally {
        app.disposeUI();
        await setup.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("an unusable worktree is listed with the reason it cannot be opened", async () => {
  const setup = await createTestRenderer({ width: 120, height: 30 });
  const worktrees: Worktree[] = [
    {
      path: "/fixtures/project",
      branch: "main",
      detached: false,
      bare: false,
      primary: true,
      missing: false,
    },
    {
      path: "/fixtures/gone",
      detached: true,
      bare: false,
      primary: false,
      missing: true,
    },
  ];
  const app = new App(setup.renderer, "/fixtures/project", undefined, {
    config: defaults,
    files: [],
    worktrees,
  });
  try {
    await (app as any).openWorktrees();
    await setup.flush();
    const items = (app as any).worktreeItems() as {
      name: string;
      disabled?: string;
    }[];
    expect(items[0]!.disabled).toBeUndefined();
    expect(items[1]!.disabled).toContain("missing");
    expect(setup.captureCharFrame()).toContain("Worktrees of");
  } finally {
    app.disposeUI();
    await setup.dispose();
  }
});

test("a folder outside Git reports why worktrees cannot be listed", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "under-wt-plain-")));
  const setup = await createTestRenderer({ width: 100, height: 24 });
  const app = new App(setup.renderer, dir, undefined, {
    config: defaults,
    files: [],
  });
  try {
    await (app as any).openWorktrees();
    await setup.flush();
    expect((app as any).modal).toBeUndefined();
    expect(String((app as any).message).toLowerCase()).toContain("git");
  } finally {
    app.disposeUI();
    await setup.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
