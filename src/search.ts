import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** Directories Quick Open never descends into on a plain directory walk. */
export const IGNORED_DIRECTORIES = [
  ".git",
  ".under",
  "node_modules",
  "dist",
  "build",
  "target",
  ".cache",
  ".venv",
  "vendor",
];

/** Ranking of a query against a path: higher is better, `null` is no match.
 * Consecutive characters, word starts and matches near the basename score best,
 * and shorter paths win ties so a fragment prefers the file it names. */
export function fuzzyScore(query: string, text: string): number | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  const haystack = text.toLowerCase();
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const character of needle) {
    const at = haystack.indexOf(character, from);
    if (at < 0) return null;
    score += 2;
    if (at === previous + 1) score += 6;
    const before = haystack[at - 1];
    if (at === 0 || before === "/" || before === "-" || before === "_" || before === ".")
      score += 8;
    from = at + 1;
    previous = at;
  }
  const base = haystack.slice(haystack.lastIndexOf("/") + 1);
  if (base === needle) score += 40;
  else if (base.startsWith(needle)) score += 20;
  else if (base.includes(needle)) score += 10;
  score -= Math.floor(haystack.length / 8);
  return score;
}

/** Rank paths by fuzzy score, bounded and stable for equal scores. */
export function rank(query: string, paths: string[], limit: number): string[] {
  if (!query.trim()) return paths.slice(0, limit);
  const scored: { path: string; score: number; index: number }[] = [];
  paths.forEach((path, index) => {
    const score = fuzzyScore(query, path);
    if (score !== null) scored.push({ path, score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, limit).map((entry) => entry.path);
}

async function gitFiles(root: string, limit: number): Promise<string[] | null> {
  try {
    const probe = Bun.spawn({
      cmd: ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      cwd: root,
      stdout: "pipe",
      stderr: "ignore",
    });
    const bytes = await new Response(probe.stdout).arrayBuffer();
    if ((await probe.exited) !== 0) return null;
    return new TextDecoder()
      .decode(bytes)
      .split("\0")
      .filter(Boolean)
      .slice(0, limit);
  } catch {
    return null;
  }
}

async function walkFiles(root: string, limit: number): Promise<string[]> {
  const found: string[] = [];
  const queue: string[] = [""];
  let visited = 0;
  while (queue.length && found.length < limit && visited < 4000) {
    const relative = queue.shift()!;
    visited++;
    let entries;
    try {
      entries = await readdir(join(root, relative), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.includes(entry.name)) queue.push(path);
      } else if (entry.isFile()) {
        found.push(path);
        if (found.length >= limit) break;
      }
    }
  }
  return found;
}

/** Candidate files for Quick Open, relative to the root and bounded.
 *
 * Git repositories use `git ls-files --cached --others --exclude-standard`, so
 * the repository's ignore rules decide what is offered. Anything else is walked
 * with a fixed skip list. Either way the result is capped. */
export async function listFiles(root: string, limit = 20000): Promise<string[]> {
  const fromGit = await gitFiles(root, limit);
  if (fromGit) return fromGit;
  return walkFiles(root, limit);
}
