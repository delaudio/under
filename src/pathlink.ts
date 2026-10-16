import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** A file mentioned in terminal output, with an optional `:line:column`. */
export type PathLink = { path: string; line: number; column: number };

const STOP = /[\s"'`<>|]/;
const MAX_JOIN = 3;

/** Strip decoration around a path: leading brackets, trailing punctuation and
 * unbalanced closers. Brackets inside stay, since routes use `[lang]`/`(group)`. */
function clean(token: string): string {
  let t = token.replace(/^[([{]+/, "");
  for (;;) {
    const before = t;
    t = t.replace(/[.,;:!?]+$/, "");
    if (t.endsWith(")") && count(t, "(") < count(t, ")")) t = t.slice(0, -1);
    if (t.endsWith("]") && count(t, "[") < count(t, "]")) t = t.slice(0, -1);
    if (t.endsWith("}") && count(t, "{") < count(t, "}")) t = t.slice(0, -1);
    if (t === before) return t;
  }
}
const count = (text: string, char: string) => text.split(char).length - 1;

/** Split a clicked token into its path and optional location suffix. */
export function parseLocation(token: string): PathLink | undefined {
  const text = clean(token).replace(/^file:\/\//, "");
  if (!text) return undefined;
  const match = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(text)!;
  const path = match[1]!;
  if (!path) return undefined;
  return {
    path,
    line: match[2] ? Math.max(1, Number(match[2])) : 1,
    column: match[3] ? Math.max(0, Number(match[3]) - 1) : 0,
  };
}

/** Candidate texts for the token under a cell. Claude and other TUIs re-wrap
 * long paths onto indented continuation lines, so the clicked fragment is also
 * tried joined with its neighbours. Shortest candidates come first; the caller
 * keeps the first one that exists on disk. */
export function pathCandidates(
  lines: string[],
  row: number,
  col: number,
): string[] {
  const line = lines[row]?.trimEnd();
  if (!line || col < 0 || col >= line.length || STOP.test(line[col]!)) return [];
  let start = col;
  while (start > 0 && !STOP.test(line[start - 1]!)) start--;
  let end = col;
  while (end < line.length - 1 && !STOP.test(line[end + 1]!)) end++;
  const fragment = line.slice(start, end + 1);

  // Fragments that continue on the previous / next line.
  const before: string[] = [];
  const first = start === line.search(/\S/) ? row : -1;
  for (let r = first; r > 0 && before.length < MAX_JOIN; r--) {
    const above = lines[r - 1]?.trimEnd();
    if (!above) break;
    let s = above.length - 1;
    if (STOP.test(above[s]!)) break;
    while (s > 0 && !STOP.test(above[s - 1]!)) s--;
    before.push(above.slice(s));
    if (s !== above.search(/\S/)) break;
  }
  const after: string[] = [];
  if (end === line.length - 1)
    for (let r = row + 1; r < lines.length && after.length < MAX_JOIN; r++) {
      const below = lines[r]?.trimEnd();
      if (!below) break;
      const s = below.search(/\S/);
      if (s < 0 || STOP.test(below[s]!)) break;
      let e = s;
      while (e < below.length - 1 && !STOP.test(below[e + 1]!)) e++;
      after.push(below.slice(s, e + 1));
      if (e !== below.length - 1) break;
    }

  const out: string[] = [];
  const seen = new Set<string>();
  for (let size = 0; size <= before.length + after.length; size++)
    for (let b = 0; b <= Math.min(size, before.length); b++) {
      const a = size - b;
      if (a > after.length) continue;
      const text =
        before.slice(0, b).reverse().join("") +
        fragment +
        after.slice(0, a).join("");
      if (!seen.has(text)) {
        seen.add(text);
        out.push(text);
      }
    }
  return out;
}

async function isFile(path: string) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** First candidate that names an existing file, resolved against `roots`. */
export async function resolvePathLink(
  candidates: string[],
  roots: string[],
): Promise<PathLink | undefined> {
  for (const candidate of candidates) {
    const link = parseLocation(candidate);
    if (!link) continue;
    const bases = isAbsolute(link.path)
      ? [link.path]
      : link.path.startsWith("~/")
        ? [join(homedir(), link.path.slice(2))]
        : roots.map((root) => resolve(root, link.path));
    for (const path of bases)
      if (await isFile(path)) return { ...link, path };
  }
  return undefined;
}
