import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import {
  encode,
  decode,
  decodeMultiStream,
  ExtensionCodec,
} from "@msgpack/msgpack";
import { PtyHost } from "./pty.ts";
import type { Profile } from "./config.ts";

const codec = new ExtensionCodec();
for (let type = 0; type < 3; type++)
  codec.register({ type, encode: () => null, decode: (data) => decode(data) });
export class Rpc {
  private next = 1;
  private closed = false;
  private pending = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(private socket: Socket) {
    void (async () => {
      try {
        for await (const value of decodeMultiStream(socket, {
          extensionCodec: codec,
          maxStrLength: 8 * 1024 * 1024,
          maxBinLength: 8 * 1024 * 1024,
          maxArrayLength: 1_000_000,
          maxMapLength: 100_000,
        })) {
          const message = value as unknown[];
          if (message[0] !== 1) continue;
          const p = this.pending.get(Number(message[1]));
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(Number(message[1]));
            message[2]
              ? p.reject(new Error(JSON.stringify(message[2])))
              : p.resolve(message[3]);
          }
        }
        this.dispose();
      } catch (e) {
        this.dispose(new Error(`Invalid RPC stream: ${String(e)}`));
      }
    })();
    socket.on("error", (e) => this.dispose(e));
    socket.on("close", () => this.dispose());
  }
  call<T = unknown>(
    method: string,
    args: unknown[] = [],
    timeout = 5000,
  ): Promise<T> {
    if (this.closed)
      return Promise.reject(new Error("Neovim RPC disconnected"));
    return new Promise((resolve, reject) => {
      const id = this.next++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, timeout);
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
      this.socket.write(encode([0, id, method, args]));
    });
  }
  dispose(error = new Error("Neovim RPC disconnected")) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.socket.destroy();
  }
}
export type EditorSnapshot = {
  path: string;
  lines: string[];
  cursor: [number, number];
  changedtick: number;
  modified: boolean;
  selection: string[];
  diagnostics: unknown[];
  selectionRange?: { start: [number, number]; finish: [number, number] };
};
export class Editor {
  rpc?: Rpc;
  private token = randomUUID();
  private disposed = false;
  private initialized = false;
  private constructor(
    readonly host: PtyHost,
    private dir: string,
    private socketPath: string,
  ) {}
  static async launch(profile: Profile, cwd: string) {
    const dir = await mkdtemp(join(tmpdir(), "under-nvim-"));
    const socket = join(dir, "rpc.sock");
    try {
      const token = randomUUID();
      const host = new PtyHost(
        {
          ...profile,
          argv: [...profile.argv, "--listen", socket],
          env: { ...profile.env, UNDER_EDITOR_TOKEN: token },
        },
        cwd,
      );
      const editor = new Editor(host, dir, socket);
      editor.token = token;
      return editor;
    } catch (e) {
      await rm(dir, { recursive: true });
      throw e;
    }
  }
  async ready() {
    const deadline = Date.now() + 30_000;
    while (
      !this.disposed &&
      this.host.phase === "running" &&
      Date.now() < deadline
    ) {
      try {
        const socket = await new Promise<Socket>((ok, fail) => {
          const s = createConnection(this.socketPath);
          s.once("connect", () => {
            s.removeListener("error", fail);
            ok(s);
          });
          s.once("error", (e) => {
            s.destroy();
            fail(e);
          });
        });
        this.rpc = new Rpc(socket);
        const token = await this.rpc.call("nvim_eval", ["$UNDER_EDITOR_TOKEN"]);
        if (token !== this.token)
          throw new Error("RPC peer is not the owned editor");
        while (!this.disposed && Date.now() < deadline) {
          if (await this.rpc.call("nvim_eval", ["v:vim_did_enter"])) {
            this.initialized = true;
            return;
          }
          await Bun.sleep(30);
        }
        throw new Error(
          "Neovim initialization timed out; check the visible startup prompt",
        );
      } catch (e) {
        if (this.rpc) throw e;
        await Bun.sleep(30);
      }
    }
    throw new Error("Neovim did not open its RPC socket");
  }
  abortInitialization() {
    if (this.initialized) return;
    this.disposed = true;
    this.rpc?.dispose(new Error("Neovim initialization cancelled"));
  }
  private client() {
    if (!this.rpc) throw new Error("Neovim is not ready yet");
    return this.rpc;
  }
  async openFile(path: string, line = 1, column = 0) {
    await this.client().call("nvim_exec_lua", [
      `local p,l,c=...; local old=vim.api.nvim_get_current_buf(); local opt=vim.bo[old].bufhidden; if vim.bo[old].modified then vim.bo[old].bufhidden='hide' end; local b=vim.fn.bufadd(p); vim.fn.bufload(b); local ok,err=pcall(vim.api.nvim_set_current_buf,b); if vim.api.nvim_buf_is_valid(old) then vim.bo[old].bufhidden=opt end; if not ok then error(err) end; local n=vim.api.nvim_buf_line_count(b); local row=math.max(1,math.min(l,n)); local text=vim.api.nvim_buf_get_lines(b,row-1,row,false)[1] or ''; vim.api.nvim_win_set_cursor(0,{row,math.max(0,math.min(c,#text))}); return b`,
      [resolve(path), line, column],
    ]);
  }
  snapshot(): Promise<EditorSnapshot> {
    return this.client().call("nvim_exec_lua", [
      `local b=vim.api.nvim_get_current_buf(); local cur=vim.api.nvim_win_get_cursor(0); local mode=vim.fn.mode(); local sel={}; local range={}; if mode=='v' or mode=='V' or mode==string.char(22) then local anchor=vim.fn.getpos('v'); local finish=vim.fn.getcurpos(); sel=vim.fn.getregion(anchor,finish,{type=mode,exclusive=vim.o.selection=='exclusive'}); range={start={anchor[2],anchor[3]-1},finish={finish[2],finish[3]-1}} end; return {path=vim.api.nvim_buf_get_name(b),lines=vim.api.nvim_buf_get_lines(b,0,-1,false),cursor=cur,changedtick=vim.api.nvim_buf_get_changedtick(b),modified=vim.bo[b].modified,selection=sel,selectionRange=range,diagnostics=vim.diagnostic.get(b)}`,
      [],
    ]);
  }
  async modified(): Promise<string[]> {
    return this.client().call("nvim_exec_lua", [
      "local out={}; for _,b in ipairs(vim.api.nvim_list_bufs()) do if vim.bo[b].modified then table.insert(out,vim.api.nvim_buf_get_name(b)) end end; return out",
      [],
    ]);
  }
  async quit() {
    const modified = await this.modified();
    if (modified.length)
      throw new Error(`Save modified buffers first: ${modified.join(", ")}`);
    // A disconnect is expected only if the normal quit really exits the child.
    let refusal: unknown;
    try {
      await this.client().call("nvim_command", ["qa"]);
    } catch (e) {
      refusal = e;
    }
    const end = Date.now() + 1500;
    while (this.host.phase === "running" && Date.now() < end)
      await Bun.sleep(20);
    if (this.host.phase === "running")
      throw refusal ?? new Error("Neovim refused to quit");
  }
  async dispose() {
    this.disposed = true;
    this.rpc?.dispose();
    await this.host.close();
    await rm(this.dir, { recursive: true, force: true });
  }
}
