import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export type FileEntry = { name: string; path: string; directory: boolean };
export const displayName = (name: string) =>
  name.replace(/[\x00-\x1f\x7f]/g, "�");

/** A directory browser, not a recursive scan of the user's checkout. */
export class FileBrowser {
  directory: string;
  entries: FileEntry[] = [];
  selected = 0;
  error = "";
  loading = false;
  private generation = 0;
  constructor(readonly root: string) {
    this.directory = root;
  }
  async load(directory = this.directory) {
    const path = resolve(directory);
    const within = relative(this.root, path);
    if (within === ".." || within.startsWith("../"))
      throw new Error("Directory is outside this workspace");
    const generation = ++this.generation;
    this.loading = true;
    try {
      const entries = (await readdir(path, { withFileTypes: true }))
        .filter((e) => ![".git", ".under", "node_modules"].includes(e.name))
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
      this.selected = 0;
      this.error = "";
    } catch (e) {
      if (generation === this.generation) this.error = String(e);
    } finally {
      if (generation === this.generation) this.loading = false;
    }
  }
  move(delta: number) {
    this.selected = Math.max(
      0,
      Math.min(this.entries.length - 1, this.selected + delta),
    );
  }
}
