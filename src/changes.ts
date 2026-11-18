import { lstat, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import stringWidth from "string-width";
import { StyledText, type TextChunk, fg } from "@opentui/core";
import type { DiffPane } from "./editor.ts";
import type { Palette } from "./theme.ts";

/**
 * One row of the Changes list, as VS Code's Source Control shows it: a file is
 * listed once under Staged for its index change and once under Changes for its
 * working-tree change.
 */
export type Change = {
  /** Path relative to the repository root, as Git prints it. */
  path: string;
  /** Source of a rename or copy, relative to the repository root. */
  orig?: string;
  staged: boolean;
  /** M modified, A added, D deleted, R renamed, C copied, T type change,
   * U untracked, ! conflicted. */
  status: string;
};

/** Larger blobs are not loaded into a diff. */
export const DIFF_MAX_BYTES = 8 * 1024 * 1024;

const decoder = new TextDecoder();

/** Run Git without a shell; resolves stdout, rejects with Git's message. */
async function git(
  cwd: string,
  args: string[],
  options: { limit?: number; allowFailure?: boolean } = {},
): Promise<{ code: number; out: Uint8Array }> {
  const child = Bun.spawn({
    // Paths are literal, so a name with * or : is never read as a pathspec.
    cmd: ["git", "--no-pager", "--literal-pathspecs", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 10_000);
  // Drain stderr alongside stdout so a chatty Git never blocks on a full pipe.
  const stderr = new Response(child.stderr).text();
  try {
    const reader = child.stdout.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (options.limit !== undefined && size > options.limit) {
        child.kill();
        void reader.cancel().catch(() => {});
        void stderr.catch(() => {});
        throw new Error("File is too large to compare");
      }
      chunks.push(value);
    }
    const error = await stderr;
    const code = await child.exited;
    if (timedOut) throw new Error(`git ${args[0]} timed out`);
    if (code !== 0 && !options.allowFailure)
      throw new Error(error.trim() || `git ${args[0]} failed`);
    return { code, out: Buffer.concat(chunks) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Repository root of `cwd`, or undefined outside a Git working tree. Git prints
 * the resolved path; it is re-expressed through `cwd` (e.g. `/var/…` rather than
 * `/private/var/…`) so paths match the buffers Under opened from the workspace.
 */
export async function repositoryRoot(cwd: string) {
  const { code, out } = await git(cwd, ["rev-parse", "--show-toplevel"], {
    allowFailure: true,
  });
  if (code !== 0) return undefined;
  const root = decoder.decode(out).trim();
  const real = await realpath(cwd).catch(() => cwd);
  const up = relative(real, root);
  if (up !== "" && !up.split("/").every((part) => part === "..")) return root;
  // A symlinked workspace below the root has a different lexical parent; keep
  // the workspace's spelling only when it still names the same directory.
  const candidate = resolve(cwd, up);
  return (await realpath(candidate).catch(() => "")) === root ? candidate : root;
}

/** Submodules and nested repositories are listed as directories. */
async function refuseDirectory(path: string) {
  // lstat: a symlink to a directory is an ordinary entry, not a submodule.
  const info = await lstat(path).catch(() => undefined);
  if (info?.isDirectory())
    throw new Error("Submodules and nested repositories cannot be compared here");
}

/** Parse `git status --porcelain=v1 -z` into Staged and Changes rows. */
export function parseStatus(raw: string): Change[] {
  const fields = raw.split("\0");
  const changes: Change[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    if (field.length < 4) continue;
    const x = field[0]!;
    const y = field[1]!;
    const path = field.slice(3);
    // A rename or copy is followed by its source path.
    const orig = x === "R" || x === "C" ? fields[++i] : undefined;
    if (x === "!") continue;
    if (x === "?") {
      changes.push({ path, staged: false, status: "U" });
      continue;
    }
    const conflict =
      x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
    if (conflict) {
      changes.push({ path, staged: false, status: "!" });
      continue;
    }
    if (x !== " ")
      changes.push({ path, staged: true, status: x, ...(orig ? { orig } : {}) });
    if (y !== " ") changes.push({ path, staged: false, status: y });
  }
  const order = (c: Change) => `${c.staged ? 0 : 1}\0${c.path}`;
  return changes.sort((a, b) => order(a).localeCompare(order(b), "en"));
}

export async function gitStatus(root: string): Promise<Change[]> {
  const { out } = await git(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--no-renames",
  ]);
  return parseStatus(decoder.decode(out));
}

async function hasHead(root: string) {
  const { code } = await git(root, ["rev-parse", "--verify", "-q", "HEAD"], {
    allowFailure: true,
  });
  return code === 0;
}

/** Text of a blob (`HEAD:path` or `:path`); empty when it does not exist. */
async function blob(root: string, spec: string) {
  const { code, out } = await git(root, ["cat-file", "blob", spec], {
    limit: DIFF_MAX_BYTES,
    allowFailure: true,
  });
  if (code !== 0) return "";
  if (out.subarray(0, 8192).includes(0))
    throw new Error("Binary files cannot be compared as text");
  return decoder.decode(out);
}


/** What a diff of `change` shows on each side: Git's version on the left,
 * the editable file (or the index, for a staged change) on the right. */
export async function diffSides(
  root: string,
  change: Change,
): Promise<{ left: DiffPane; right: DiffPane }> {
  const name = basename(change.path);
  const file = join(root, change.path);
  if (change.staged) {
    const base = change.orig ?? change.path;
    const head =
      change.status === "A" || !(await hasHead(root))
        ? ""
        : await blob(root, `HEAD:${base}`);
    const index = change.status === "D" ? "" : await blob(root, `:0:${change.path}`);
    return {
      left: { kind: "text", name: `under-diff://HEAD/${base}`, text: head, label: `${basename(base)} (HEAD)` },
      right: { kind: "text", name: `under-diff://index/${change.path}`, text: index, label: `${name} (Index)` },
    };
  }
  const left =
    change.status === "U"
      ? ""
      : change.status === "!"
        ? await blob(root, `HEAD:${change.path}`)
        : await blob(root, `:0:${change.path}`);
  const leftLabel =
    change.status === "!"
      ? `${name} (HEAD)`
      : change.status === "U"
        ? `${name} (Untracked)`
        : `${name} (Index)`;
  // Submodules first: Bun.file() reports a directory as missing.
  await refuseDirectory(file);
  // A deletion, or a conflict where both sides deleted the file.
  if (change.status === "D" || !(await Bun.file(file).exists()))
    return {
      left: { kind: "text", name: `under-diff://index/${change.path}`, text: left, label: leftLabel },
      right: { kind: "text", name: `under-diff://deleted/${change.path}`, text: "", label: `${name} (Deleted)` },
    };
  const size = Bun.file(file).size;
  if (size > DIFF_MAX_BYTES) throw new Error("File is too large to compare");
  const head = new Uint8Array(await Bun.file(file).slice(0, 8192).arrayBuffer());
  if (head.includes(0)) throw new Error("Binary files cannot be compared as text");
  return {
    left: {
      kind: "text",
      name: `under-diff://${change.status === "!" ? "HEAD" : "index"}/${change.path}`,
      text: left,
      label: leftLabel,
    },
    right: { kind: "file", path: file, label: `${name} (Working Tree)` },
  };
}

/** Images can be larger than text worth diffing. */
export const IMAGE_MAX_BYTES = 32 * 1024 * 1024;

/** One side of an image diff: a label and the image (bytes from Git, or the
 * working file's path), absent when that side has no image. */
export type ImageSide = { label: string; source?: Uint8Array | string };

/** The two versions of an image change, as `diffSides` pairs text. */
export async function imageSides(
  root: string,
  change: Change,
): Promise<{ left: ImageSide; right: ImageSide }> {
  const read = async (spec: string) => {
    const { code, out } = await git(root, ["cat-file", "blob", spec], {
      limit: IMAGE_MAX_BYTES,
      allowFailure: true,
    });
    return code === 0 ? out : undefined;
  };
  if (change.staged) {
    const base = change.orig ?? change.path;
    const head =
      change.status === "A" || !(await hasHead(root))
        ? undefined
        : await read(`HEAD:${base}`);
    const index = change.status === "D" ? undefined : await read(`:0:${change.path}`);
    return { left: { label: "HEAD", source: head }, right: { label: "Index", source: index } };
  }
  const left =
    change.status === "U"
      ? undefined
      : await read(change.status === "!" ? `HEAD:${change.path}` : `:0:${change.path}`);
  const label = change.status === "!" ? "HEAD" : "Index";
  if (change.status === "D")
    return { left: { label, source: left }, right: { label: "Deleted" } };
  const file = join(root, change.path);
  await refuseDirectory(file);
  if (Bun.file(file).size > IMAGE_MAX_BYTES) throw new Error("Image is too large to compare");
  return { left: { label, source: left }, right: { label: "Working Tree", source: file } };
}

export async function stage(root: string, change: Change) {
  await git(root, ["add", "-A", "--", change.path]);
}

export async function unstage(root: string, change: Change) {
  const paths = change.orig ? [change.orig, change.path] : [change.path];
  if (await hasHead(root))
    await git(root, ["restore", "--staged", "--", ...paths]);
  else await git(root, ["rm", "--cached", "-q", "-r", "--", ...paths]);
}

/** Drop a working-tree change: restore the index version, or delete an
 * untracked file. Staged changes and conflicts are left alone. */
export async function discard(root: string, change: Change) {
  if (change.staged) throw new Error("Unstage the change before discarding it");
  if (change.status === "!")
    throw new Error("Resolve the conflict in the editor instead");
  // An intent-to-add entry has an empty index blob; restoring would empty it.
  if (change.status === "A")
    throw new Error("Unstage the intent-to-add entry before discarding it");
  await refuseDirectory(join(root, change.path));
  if (change.status === "U") {
    await rm(join(root, change.path));
    return;
  }
  await git(root, ["restore", "--worktree", "--", change.path]);
}

export async function stageAll(root: string) {
  await git(root, ["add", "-A", "--", "."]);
}

export async function unstageAll(root: string) {
  if (await hasHead(root)) await git(root, ["restore", "--staged", "--", "."]);
  else
    await git(root, ["rm", "--cached", "-q", "-r", "--ignore-unmatch", "--", "."]);
}

/** The Changes list of one workspace, refreshed from `git status`. */
export class ChangesList {
  root?: string;
  entries: Change[] = [];
  selected = 0;
  error = "";
  /** True until the first load finishes, so the panel never flashes "No changes". */
  loading = true;
  loaded = false;
  private generation = 0;
  /** `fixture` rows make a fixed list that never runs Git. */
  constructor(
    readonly workspace: string,
    private readonly fixture?: Change[],
  ) {
    if (fixture) {
      this.root = workspace;
      this.entries = structuredClone(fixture);
      this.loaded = true;
      this.loading = false;
    }
  }
  current(): Change | undefined {
    return this.entries[this.selected];
  }
  /** Reload from Git; the selection stays on the same row (path and group)
   * when it can. A load overtaken by a newer one resolves with that one,
   * so a caller never continues with a list the newer load has not filled. */
  load(): Promise<boolean> {
    if (this.fixture) return Promise.resolve(false);
    this.latest = this.run();
    return this.latest;
  }
  private latest?: Promise<boolean>;
  private async run(): Promise<boolean> {
    const generation = ++this.generation;
    const keep = this.current();
    this.loading = !this.loaded;
    try {
      // The root is looked up once; polls then cost a single `git status`.
      const root = this.root ?? (await repositoryRoot(this.workspace));
      if (!root) throw new Error("Not a Git working tree");
      const entries = await gitStatus(root);
      if (generation !== this.generation) return this.latest!;
      const same =
        root === this.root &&
        JSON.stringify(entries) === JSON.stringify(this.entries);
      this.root = root;
      this.entries = entries;
      const index = keep
        ? entries.findIndex((e) => e.path === keep.path && e.staged === keep.staged)
        : -1;
      this.selected =
        index >= 0 ? index : Math.max(0, Math.min(this.selected, entries.length - 1));
      const changed = !same || this.error !== "";
      this.error = "";
      return changed;
    } catch (e) {
      if (generation !== this.generation) return this.latest!;
      const message = e instanceof Error ? e.message : String(e);
      this.root = undefined;
      const changed = message !== this.error;
      this.error = message;
      this.entries = [];
      return changed;
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.loaded = true;
      }
    }
  }
  move(delta: number) {
    this.selected = Math.max(
      0,
      Math.min(this.entries.length - 1, this.selected + delta),
    );
  }
  /** Workspace-relative label pieces of a row: file name and its directory. */
  label(change: Change) {
    const full = this.root ? join(this.root, change.path) : change.path;
    const shown = relative(this.workspace, full) || basename(full);
    const dir = dirname(shown);
    return { name: basename(shown), dir: dir === "." ? "" : dir };
  }
}

const clean = (text: string) => text.replace(/[\x00-\x1f\x7f]/g, "\uFFFD");

/** Cut `text` to `width` columns, marking a cut with an ellipsis. */
function fit(text: string, width: number) {
  if (width <= 0) return "";
  if (stringWidth(text) <= width) return text;
  let out = "";
  for (const char of text) {
    if (stringWidth(out + char) > width - 1) break;
    out += char;
  }
  return `${out}…`;
}

/** Glyph a row shows at its right edge; a click there stages or unstages. */
export const STAGE_GLYPH = "+";
export const UNSTAGE_GLYPH = "−";

/**
 * Lay out the Changes list in `width` × `height` cells: a title, Staged and
 * Changes groups with a coloured status letter, file name and dimmed directory,
 * and a key hint. `rows` maps a line of the panel to the entry it shows.
 */
export function changesView(
  list: ChangesList,
  width: number,
  height: number,
  focused: boolean,
  colors: Palette,
): { text: StyledText; rows: Map<number, number> } {
  const chunks: TextChunk[] = [];
  const rows = new Map<number, number>();
  const ink = focused ? colors.accent : colors.foreground;
  const line = (...parts: TextChunk[]) => {
    if (chunks.length) chunks.push(fg(ink)("\n"));
    chunks.push(...parts);
  };
  line(fg(ink)(` Changes · ${focused ? "FOCUS" : "Ctrl-G f"}`));
  const hint = [" Enter diff · s stage", " x discard · v layout"];
  const room = Math.max(1, height - 1 - hint.length - 1);
  if (list.loading) line(fg(colors.muted)(" Loading…"));
  else if (list.error) line(fg(colors.muted)(` ${fit(clean(list.error), width - 2)}`));
  else if (!list.entries.length) line(fg(colors.muted)(" No changes"));
  else {
    // Headers and entries as one scrollable column.
    const items: Array<{ header: string } | { index: number }> = [];
    const staged = list.entries.filter((e) => e.staged).length;
    const unstaged = list.entries.length - staged;
    list.entries.forEach((entry, index) => {
      if (index === 0 && entry.staged) items.push({ header: `STAGED (${staged})` });
      if (!entry.staged && (index === 0 || list.entries[index - 1]!.staged))
        items.push({ header: `CHANGES (${unstaged})` });
      items.push({ index });
    });
    const at = items.findIndex((item) => "index" in item && item.index === list.selected);
    const start = Math.max(0, Math.min(at - room + 1, items.length - room));
    const shown = items.slice(start, start + room);
    shown.forEach((item, i) => {
      if ("header" in item) {
        line(fg(colors.muted)(` ${fit(item.header, width - 2)}`));
        return;
      }
      rows.set(1 + i, item.index);
      const entry = list.entries[item.index]!;
      const selected = item.index === list.selected;
      const { name, dir } = list.label(entry);
      const tint =
        entry.status === "A" || entry.status === "U"
          ? colors.added
          : entry.status === "D" || entry.status === "!"
            ? colors.removed
            : colors.changed;
      const glyph = entry.staged ? UNSTAGE_GLYPH : STAGE_GLYPH;
      const body = Math.max(1, width - 6);
      const shownName = fit(clean(name), body);
      const rest = body - stringWidth(shownName);
      const shownDir = dir && rest > 2 ? ` ${fit(clean(dir), rest - 1)}` : "";
      const pad = " ".repeat(Math.max(0, body - stringWidth(shownName) - stringWidth(shownDir)));
      line(
        fg(selected ? colors.accent : colors.muted)(selected ? "›" : " "),
        fg(tint)(entry.status),
        fg(colors.foreground)(` ${shownName}`),
        fg(colors.muted)(`${shownDir}${pad} `),
        fg(colors.muted)(glyph),
      );
    });
  }
  line(fg(ink)(""));
  for (const h of hint) line(fg(colors.muted)(fit(h, width)));
  return { text: new StyledText(chunks), rows };
}
