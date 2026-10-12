import { createServer, createConnection, type Server } from "node:net";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
export class FileBridge {
  private server?: Server; path = ""; private dir = "";
  async start(open: (path: string, line: number, column: number) => Promise<void>) {
    this.dir = await mkdtemp(join(tmpdir(), "under-open-")); this.path = join(this.dir, "open.sock");
    this.server = createServer(socket => {
      let data = ""; socket.setTimeout(5000, () => socket.destroy());
      socket.on("data", async bytes => {
        data += bytes.toString(); if (Buffer.byteLength(data) > 16384) { socket.destroy(); return; }
        if (!data.includes("\n")) return;
        socket.removeAllListeners("data");
        try {
          const v = JSON.parse(data.split("\n")[0]!);
          if (typeof v.path !== "string" || !v.path.startsWith("/") || !Number.isInteger(v.line) || v.line < 1 || !Number.isInteger(v.column) || v.column < 0) throw new Error("Invalid file location");
          await open(v.path, v.line, v.column); socket.end(JSON.stringify({ ok: true }) + "\n");
        } catch (e) { socket.end(JSON.stringify({ error: String(e) }) + "\n"); }
      });
    });
    await new Promise<void>((ok, fail) => { this.server!.once("error", fail); this.server!.listen(this.path, ok); });
    await chmod(this.path, 0o600);
  }
  async close() { if (this.server) await new Promise<void>(ok => this.server!.close(() => ok())); if (this.dir) await rm(this.dir, { recursive: true, force: true }); }
}
export async function openRemote(socketPath: string, path: string, line = 1, column = 0) {
  return new Promise<void>((ok, fail) => {
    const s = createConnection(socketPath); let data = "";
    s.setTimeout(6000, () => { s.destroy(); fail(new Error("Editor bridge timed out")); });
    s.on("connect", () => s.write(JSON.stringify({ path, line, column }) + "\n"));
    s.on("error", fail); s.on("data", b => { data += b; });
    s.on("end", () => { try { const r = JSON.parse(data); r.ok ? ok() : fail(new Error(r.error)); } catch (e) { fail(e); } });
  });
}
