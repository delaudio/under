import { relative, isAbsolute, basename, dirname } from "node:path";
import { stat } from "node:fs/promises";

export type Worktree = {
  path: string;
  head?: string;
  /** Branch name when the worktree is on one; absent for a detached HEAD. */
  branch?: string;
  detached: boolean;
  bare: boolean;
  /** Present when Git reports the worktree as locked, with its reason. */
  locked?: string;
  /** Present when Git reports the worktree as prunable, with its reason. */
  prunable?: string;
  /** The checkout Git lists first, which owns the shared repository. */
  primary: boolean;
  /** The directory is gone, so the entry cannot be opened. */
  missing: boolean;
};

/** Parse `git worktree list --porcelain -z` output. */
export function parseWorktrees(raw: string): Worktree[] {
  const worktrees: Worktree[] = [];
  let current: Partial<Worktree> | undefined;
  const finish = () => {
    if (current?.path)
      worktrees.push({
        path: current.path,
        ...(current.head ? { head: current.head } : {}),
        ...(current.branch ? { branch: current.branch } : {}),
        detached: !!current.detached,
        bare: !!current.bare,
        ...(current.locked ? { locked: current.locked } : {}),
        ...(current.prunable ? { prunable: current.prunable } : {}),
        primary: worktrees.length === 0,
        missing: false,
      });
    current = undefined;
  };
  for (const field of raw.split("\0")) {
    if (!field) continue;
    if (field.startsWith("worktree ")) {
      finish();
      current = { path: field.slice("worktree ".length) };
      continue;
    }
    if (!current) continue;
    if (field.startsWith("HEAD ")) current.head = field.slice(5);
    else if (field.startsWith("branch "))
      current.branch = field.slice(7).replace(/^refs\/heads\//, "");
    else if (field === "detached") current.detached = true;
    else if (field === "bare") current.bare = true;
    else if (field.startsWith("locked"))
      current.locked = field.slice(6).trim() || "locked";
    else if (field.startsWith("prunable"))
      current.prunable = field.slice(8).trim() || "prunable";
  }
  finish();
  return worktrees;
}

/** Every worktree of the repository containing `cwd`, bounded in time and size.
 * Runs `git worktree list` only: discovery never executes project commands. */
export async function listWorktrees(cwd: string): Promise<Worktree[]> {
  const child = Bun.spawn({
    cmd: ["git", "--no-pager", "worktree", "list", "--porcelain", "-z"],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    const reader = child.stdout.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1024 * 1024) {
        child.kill();
        throw new Error("Too many worktrees to list");
      }
      chunks.push(value);
    }
    const error = await new Response(child.stderr).text();
    if ((await child.exited) !== 0)
      throw new Error(
        error.trim() || "This directory is not a Git working tree",
      );
    const worktrees = parseWorktrees(Buffer.concat(chunks).toString("utf8"));
    for (const worktree of worktrees)
      worktree.missing = !(await isDirectory(worktree.path));
    return worktrees;
  } finally {
    clearTimeout(timer);
  }
}

async function isDirectory(path: string) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** How to refer to a worktree in a list: branch, then its last two segments. */
export function worktreeLabel(worktree: Worktree) {
  const where = `${basename(dirname(worktree.path))}/${basename(worktree.path)}`;
  const head = worktree.branch
    ? worktree.branch
    : worktree.detached
      ? "detached HEAD"
      : "no branch";
  return `${head} · ${where}`;
}

/** Why a worktree cannot be opened, or undefined when it can. */
export function worktreeBlocker(worktree: Worktree): string | undefined {
  if (worktree.missing)
    return `Directory is missing; remove it with "git worktree prune"`;
  if (worktree.locked) return `Locked: ${worktree.locked}`;
  if (worktree.bare) return "A bare repository has no working tree";
  return undefined;
}

export async function fileDiff(
  cwd: string,
  path: string,
  staged = false,
): Promise<string> {
  const local = relative(cwd, path);
  if (isAbsolute(local) || local === ".." || local.startsWith("../"))
    throw new Error("File is outside the workspace");
  const child = Bun.spawn({
    cmd: [
      "git",
      "--no-pager",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      ...(staged ? ["--staged"] : []),
      "--",
      local,
    ],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    const reader = child.stdout.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 64 * 1024) {
        child.kill();
        throw new Error("Diff exceeds 64 KiB; choose a smaller file");
      }
      chunks.push(value);
    }
    const error = await new Response(child.stderr).text();
    if ((await child.exited) !== 0) throw new Error(error || "Git diff failed");
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    clearTimeout(timer);
  }
}
