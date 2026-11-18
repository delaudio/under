import { readdir } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

export type FileEntry = { name: string; path: string; directory: boolean };

/** Extensions Under shows in its image viewer instead of Neovim. */
export const IMAGE_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp",
  ".tif", ".tiff", ".ico", ".avif", ".heic",
];
export const isImagePath = (path: string) =>
  IMAGE_EXTENSIONS.includes(extname(path).toLowerCase());
export const displayName = (name: string) =>
  name.replace(/[\x00-\x1f\x7f]/g, "�");

/** Names Git ignores among `names` in `directory`; empty outside a repository
 * or when Git is unavailable, so a failure never hides files. */
export async function gitIgnored(
  directory: string,
  names: string[],
): Promise<Set<string>> {
  if (!names.length) return new Set();
  try {
    const probe = Bun.spawn({
      cmd: ["git", "check-ignore", "-z", "--stdin"],
      cwd: directory,
      stdin: new TextEncoder().encode(names.join("\0") + "\0"),
      stdout: "pipe",
      stderr: "ignore",
    });
    const timer = setTimeout(() => probe.kill(), 2000);
    const output = await new Response(probe.stdout).text();
    clearTimeout(timer);
    // Exit 1 means "nothing ignored"; 128 means "not a repository".
    if ((await probe.exited) > 1) return new Set();
    return new Set(output.split("\0").filter(Boolean));
  } catch {
    return new Set();
  }
}

/** A directory browser, not a recursive scan of the user's checkout. */
export class FileBrowser {
  directory: string;
  entries: FileEntry[] = [];
  selected = 0;
  error = "";
  loading = false;
  /** Show dotfiles, as Yazi's `show_hidden`. */
  showHidden = false;
  /** Show files Git ignores; hidden by default, as in Fresh. */
  showIgnored = false;
  private generation = 0;
  constructor(readonly root: string) {
    this.directory = root;
  }
  async load(directory = this.directory, select?: string) {
    const path = resolve(directory);
    const within = relative(this.root, path);
    if (within === ".." || within.startsWith("../"))
      throw new Error("Directory is outside this workspace");
    const generation = ++this.generation;
    this.loading = true;
    try {
      let listed = (await readdir(path, { withFileTypes: true })).filter(
        (e) =>
          ![".git", ".under", "node_modules"].includes(e.name) &&
          (this.showHidden || !e.name.startsWith(".")),
      );
      if (!this.showIgnored) {
        const ignored = await gitIgnored(
          path,
          listed.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)),
        );
        listed = listed.filter(
          (e) => !ignored.has(e.name) && !ignored.has(`${e.name}/`),
        );
      }
      const entries = listed
        .map((e) => ({
          name: e.name,
          path: join(path, e.name),
          directory: e.isDirectory(),
        }))
        .sort(
          (a, b) =>
            Number(b.directory) - Number(a.directory) ||
            a.name.localeCompare(b.name, "en"),
        );
      if (generation !== this.generation) return;
      this.directory = path;
      this.entries =
        path === resolve(this.root)
          ? entries
          : [
              { name: "..", path: resolve(path, ".."), directory: true },
              ...entries,
            ];
      this.selected = Math.max(
        0,
        select ? this.entries.findIndex((e) => e.path === resolve(select)) : 0,
      );
      this.error = "";
    } catch (e) {
      if (generation === this.generation) this.error = String(e);
    } finally {
      if (generation === this.generation) this.loading = false;
    }
  }
  /** Select a file, loading its directory when needed; false outside the root. */
  async reveal(path: string) {
    const file = resolve(path);
    const within = relative(this.root, dirname(file));
    if (within === ".." || within.startsWith("../")) return false;
    if (dirname(file) !== this.directory) await this.load(dirname(file), file);
    else {
      const index = this.entries.findIndex((e) => e.path === file);
      if (index >= 0) this.selected = index;
    }
    return this.entries[this.selected]?.name === basename(file);
  }
  move(delta: number) {
    this.selected = Math.max(
      0,
      Math.min(this.entries.length - 1, this.selected + delta),
    );
  }
}
