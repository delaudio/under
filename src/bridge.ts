import {
  createServer,
  createConnection,
  type Server,
  type Socket,
} from "node:net";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
/** A review a tool asks Under to open, relative to the tool's own directory. */
export type ReviewTarget = {
  dir: string;
  staged?: boolean;
  /** Revision to diff against, or the `from` side when `to` is also set. */
  ref?: string;
  to?: string;
};
export type BridgeHandlers = {
  open: (path: string, line: number, column: number) => Promise<void>;
  review: (target: ReviewTarget) => Promise<void>;
};
const revision = (value: unknown) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 256 &&
  !/[\x00-\x1f\x7f]/.test(value);
export class FileBridge {
  private server?: Server;
  path = "";
  private dir = "";
  private connections = new Set<Socket>();
  async start(handlers: BridgeHandlers) {
    this.dir = await mkdtemp(join(tmpdir(), "under-open-"));
    this.path = join(this.dir, "open.sock");
    this.server = createServer((socket) => {
      this.connections.add(socket);
      socket.on("close", () => this.connections.delete(socket));
      socket.on("error", () => socket.destroy());
      let data = "";
      socket.setTimeout(5000, () => socket.destroy());
      socket.on("data", async (bytes) => {
        data += bytes.toString();
        if (Buffer.byteLength(data) > 16384) {
          socket.destroy();
          return;
        }
        if (!data.includes("\n")) return;
        socket.removeAllListeners("data");
        try {
          const v = JSON.parse(data.split("\n")[0]!);
          if (v?.kind === "review") {
            if (typeof v.dir !== "string" || !v.dir.startsWith("/"))
              throw new Error("Invalid review directory");
            if (v.staged !== undefined && typeof v.staged !== "boolean")
              throw new Error("Invalid staged flag");
            for (const key of ["ref", "to"])
              if (v[key] !== undefined && !revision(v[key]))
                throw new Error("Invalid revision");
            await handlers.review({
              dir: v.dir,
              ...(v.staged ? { staged: true } : {}),
              ...(typeof v.ref === "string" ? { ref: v.ref } : {}),
              ...(typeof v.to === "string" ? { to: v.to } : {}),
            });
          } else {
            if (
              typeof v.path !== "string" ||
              !v.path.startsWith("/") ||
              !Number.isInteger(v.line) ||
              v.line < 1 ||
              !Number.isInteger(v.column) ||
              v.column < 0
            )
              throw new Error("Invalid file location");
            await handlers.open(v.path, v.line, v.column);
          }
          socket.end(JSON.stringify({ ok: true }) + "\n");
        } catch (e) {
          socket.end(JSON.stringify({ error: String(e) }) + "\n");
        }
      });
    });
    await new Promise<void>((ok, fail) => {
      this.server!.once("error", fail);
      this.server!.listen(this.path, ok);
    });
    await chmod(this.path, 0o600);
  }
  async close() {
    for (const s of this.connections) s.destroy();
    if (this.server?.listening)
      await new Promise<void>((ok) => this.server!.close(() => ok()));
    if (this.dir) await rm(this.dir, { recursive: true, force: true });
  }
}
async function send(socketPath: string, payload: unknown) {
  return new Promise<void>((ok, fail) => {
    const s = createConnection(socketPath);
    let data = "";
    s.setTimeout(6000, () => {
      s.destroy();
      fail(new Error("Under bridge timed out"));
    });
    s.on("connect", () => s.write(JSON.stringify(payload) + "\n"));
    s.on("error", fail);
    s.on("data", (b) => {
      data += b;
    });
    s.on("end", () => {
      try {
        const r = JSON.parse(data);
        r.ok ? ok() : fail(new Error(r.error));
      } catch (e) {
        fail(e);
      }
    });
  });
}
export async function openRemote(
  socketPath: string,
  path: string,
  line = 1,
  column = 0,
) {
  return send(socketPath, { path, line, column });
}
/** Ask Under to review the given directory, as seen by the calling tool. */
export async function reviewRemote(socketPath: string, target: ReviewTarget) {
  return send(socketPath, { kind: "review", ...target });
}
