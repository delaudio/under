import { relative, isAbsolute } from "node:path";
export async function fileDiff(cwd: string, path: string, staged = false): Promise<string> {
  const local = relative(cwd, path);
  if (isAbsolute(local) || local === ".." || local.startsWith("../")) throw new Error("File is outside the workspace");
  const child = Bun.spawn({ cmd: ["git", "--no-pager", "diff", "--no-ext-diff", "--no-textconv", ...(staged ? ["--staged"] : []), "--", local], cwd, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    const reader = child.stdout.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 64 * 1024) { child.kill(); throw new Error("Diff exceeds 64 KiB; choose a smaller file"); } chunks.push(value); }
    const error = await new Response(child.stderr).text(); if (await child.exited !== 0) throw new Error(error || "Git diff failed");
    return Buffer.concat(chunks).toString("utf8");
  } finally { clearTimeout(timer); }
}
