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
  /** Receives Neovim's `rpcnotify` messages addressed to this channel. */
  onNotification?: (method: string, params: unknown[]) => void;
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
          if (message[0] === 2) {
            try {
              this.onNotification?.(String(message[1]), message[2] as unknown[]);
            } catch {
              /* a consumer error must not end the RPC stream */
            }
            continue;
          }
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
    const promise = this.closed
      ? Promise.reject<T>(new Error("Neovim RPC disconnected"))
      : new Promise<T>((resolve, reject) => {
          const id = this.next++;
          const timer = setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`RPC timeout: ${method}`));
          }, timeout);
          this.pending.set(id, {
            resolve: (v) => resolve(v as T),
            reject,
            timer,
          });
          this.socket.write(encode([0, id, method, args]));
        });
    // A disconnect or timeout during teardown can reject a request whose caller
    // has already moved on. Observe it here so awaiting callers still receive the
    // error without the teardown race surfacing as an unhandled rejection.
    void promise.catch(() => {});
    return promise;
  }
  get disposed() {
    return this.closed;
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
/** One listed file buffer, as shown in Under's editor tab strip. */
export type EditorBuffer = {
  id: number;
  name: string;
  modified: boolean;
  preview: boolean;
};
export type EditorBuffers = { current: number; buffers: EditorBuffer[] };
export class Editor {
  rpc?: Rpc;
  private token = randomUUID();
  private disposed = false;
  private initialized = false;
  private connecting?: Socket;
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
          this.connecting = s;
          const timer = setTimeout(
            () => s.destroy(new Error("RPC connection timed out")),
            1000,
          );
          s.once("connect", () => {
            clearTimeout(timer);
            this.connecting = undefined;
            s.removeListener("error", fail);
            ok(s);
          });
          s.once("error", (e) => {
            clearTimeout(timer);
            this.connecting = undefined;
            s.destroy();
            fail(e);
          });
        });
        if (this.disposed) {
          socket.destroy();
          throw new Error("Neovim initialization cancelled");
        }
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
    this.connecting?.destroy(new Error("Neovim initialization cancelled"));
    this.rpc?.dispose(new Error("Neovim initialization cancelled"));
  }
  private client() {
    if (!this.rpc) throw new Error("Neovim is not ready yet");
    return this.rpc;
  }
  /**
   * Open a file in the current window, preserving every other buffer.
   *
   * A `preview` open follows Fresh's preview tabs: a buffer this call had to
   * create is marked ephemeral and the next preview replaces it, so scanning a
   * directory does not pile up buffers. Editing the buffer, or any normal open
   * of it, promotes it to a regular buffer. A preview never deletes a buffer that
   * is modified, already existed, or is shown in another window. Resolves to
   * false when a preview was skipped because no normal window could take it.
   */
  async openFile(
    path: string,
    line = 1,
    column = 0,
    preview = false,
  ): Promise<boolean> {
    const opened = await this.client().call<number>("nvim_exec_lua", [
      `local p,l,c,preview=...
if not vim.g.under_preview_au then
  vim.g.under_preview_au=true
  vim.api.nvim_create_autocmd({'BufModifiedSet','InsertEnter'},{group=vim.api.nvim_create_augroup('UnderPreview',{clear=true}),callback=function(a)
    if vim.b[a.buf].under_preview and (a.event=='InsertEnter' or vim.bo[a.buf].modified) then
      vim.b[a.buf].under_preview=nil
      if vim.g.under_preview_buf==a.buf then vim.g.under_preview_buf=nil end
      if _G.UnderSendBuffers then _G.UnderSendBuffers() end
    end
  end})
end
local win=vim.api.nvim_get_current_win()
if preview then
  -- A passive preview must not hijack a picker, quickfix, terminal or pinned
  -- window, nor move the user out of it: load into a normal window of this tab
  -- page without making it current, or skip the preview.
  local function normal(w)
    local b=vim.api.nvim_win_get_buf(w)
    return vim.api.nvim_win_get_config(w).relative=='' and vim.bo[b].buftype=='' and not (vim.fn.exists('+winfixbuf')==1 and vim.wo[w].winfixbuf)
  end
  if not normal(0) then
    local target=nil
    for _,w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do if normal(w) then target=w break end end
    if not target then return 0 end
    win=target
  end
end
local function open()
-- Match the exact name: bufnr() would read [ * ? { in a path as a pattern.
local existing=-1
for _,x in ipairs(vim.api.nvim_list_bufs()) do if vim.api.nvim_buf_get_name(x)==p then existing=x break end end
-- Any buffer already loaded (listed, or held by an LSP or plugin) is the
-- user's: a preview never marks it ephemeral or deletes it.
local existed=existing>0 and (vim.fn.buflisted(existing)==1 or vim.fn.bufloaded(existing)==1)
local old=vim.api.nvim_get_current_buf(); local opt=vim.bo[old].bufhidden
if vim.bo[old].modified then vim.bo[old].bufhidden='hide' end
local b=vim.fn.bufadd(p)
-- A swap-file prompt would block Neovim invisibly while focus is in Yazi.
local shm=vim.o.shortmess; if preview then vim.opt.shortmess:append('A') end
local loaded,lerr=pcall(vim.fn.bufload,b); vim.o.shortmess=shm
if not loaded then if vim.api.nvim_buf_is_valid(old) then vim.bo[old].bufhidden=opt end; error(lerr) end
vim.bo[b].buflisted=true
local ok,err=pcall(vim.api.nvim_set_current_buf,b)
if vim.api.nvim_buf_is_valid(old) then vim.bo[old].bufhidden=opt end
if not ok then error(err) end
-- A preview of a buffer the user already has keeps its cursor where it was.
if not (preview and existed) then
  local n=vim.api.nvim_buf_line_count(b); local row=math.max(1,math.min(l,n))
  local text=vim.api.nvim_buf_get_lines(b,row-1,row,false)[1] or ''
  vim.api.nvim_win_set_cursor(0,{row,math.max(0,math.min(c,#text))})
end
local prev=vim.g.under_preview_buf
if preview then
  if not existed then vim.b[b].under_preview=true end
  if prev and prev~=b and vim.api.nvim_buf_is_valid(prev) and vim.b[prev].under_preview and not vim.bo[prev].modified and #vim.fn.win_findbuf(prev)==0 then pcall(vim.api.nvim_buf_delete,prev,{}) end
  vim.g.under_preview_buf=vim.b[b].under_preview and b or nil
else
  vim.b[b].under_preview=nil
  if prev==b then vim.g.under_preview_buf=nil end
end
return b
end
local b
if win==vim.api.nvim_get_current_win() then b=open() else b=vim.api.nvim_win_call(win,open) end
if _G.UnderSendBuffers then _G.UnderSendBuffers() end
return b`,
      [resolve(path), line, column, preview],
    ]);
    return opened !== 0;
  }
  /**
   * Report the listed file buffers and the current one whenever they change.
   * Autocommands coalesce through `vim.schedule`, so one notification follows a
   * burst of events (an open that also deletes a preview, for example).
   */
  async watchBuffers(handler: (state: EditorBuffers) => void) {
    const rpc = this.client();
    rpc.onNotification = (method, params) => {
      const state = params[0] as Partial<EditorBuffers> | undefined;
      // An empty Lua list can arrive as an empty map.
      if (method === "under_buffers" && state)
        handler({
          current: Number(state.current),
          buffers: Array.isArray(state.buffers) ? state.buffers : [],
        });
    };
    const [channel] = await rpc.call<[number]>("nvim_get_api_info");
    await rpc.call("nvim_exec_lua", [
      `local chan=...
local pending=false
local function send()
  if pending then return end
  pending=true
  vim.schedule(function()
    pending=false
    local list={}
    for _,b in ipairs(vim.api.nvim_list_bufs()) do
      local name=vim.api.nvim_buf_get_name(b)
      if vim.bo[b].buflisted and vim.bo[b].buftype=='' and name~='' then
        table.insert(list,{id=b,name=name,modified=vim.bo[b].modified,preview=vim.b[b].under_preview==true})
      end
    end
    pcall(vim.rpcnotify,chan,'under_buffers',{current=vim.api.nvim_get_current_buf(),buffers=list})
  end)
end
_G.UnderSendBuffers=send
vim.api.nvim_create_autocmd({'BufEnter','BufAdd','BufDelete','BufWipeout','BufModifiedSet','BufFilePost','InsertEnter'},{group=vim.api.nvim_create_augroup('UnderBuffers',{clear=true}),callback=send})
send()`,
      [channel],
    ]);
  }
  /** Show a buffer in the current window; choosing a tab keeps a preview. */
  async selectBuffer(id: number) {
    await this.client().call("nvim_exec_lua", [
      `local b=...
if not vim.api.nvim_buf_is_valid(b) then return end
vim.api.nvim_set_current_buf(b)
vim.b[b].under_preview=nil
if vim.g.under_preview_buf==b then vim.g.under_preview_buf=nil end
if _G.UnderSendBuffers then _G.UnderSendBuffers() end`,
      [id],
    ]);
  }
  /**
   * Close a buffer without closing windows: each window showing it switches to
   * the alternate (or another listed) buffer first. A modified buffer is refused
   * rather than discarded.
   */
  async closeBuffer(id: number) {
    const result = await this.client().call<string>("nvim_exec_lua", [
      `local b=...
if not vim.api.nvim_buf_is_valid(b) then return 'ok' end
if vim.bo[b].modified then return 'modified' end
local alt=nil
local hash=vim.fn.bufnr('#')
if hash>0 and hash~=b and vim.fn.buflisted(hash)==1 then alt=hash end
if not alt then
  for _,x in ipairs(vim.api.nvim_list_bufs()) do
    if x~=b and vim.fn.buflisted(x)==1 then alt=x break end
  end
end
if not alt then alt=vim.api.nvim_create_buf(true,false) end
for _,w in ipairs(vim.fn.win_findbuf(b)) do vim.api.nvim_win_set_buf(w,alt) end
if vim.g.under_preview_buf==b then vim.g.under_preview_buf=nil end
-- :bdelete, not a wipe, so marks and undo history survive a reopen.
vim.cmd.bdelete(b)
return 'ok'`,
      [id],
    ]);
    if (result === "modified")
      throw new Error("Save or discard the buffer's changes before closing it");
  }
  /** Make Under's colour schemes available and optionally switch to one. */
  async useRuntime(directory: string, colorscheme?: string) {
    await this.client().call("nvim_exec_lua", [
      `local dir,scheme=...; vim.opt.runtimepath:append((dir:gsub(',','\\\\,'))); if scheme then vim.cmd.colorscheme(scheme) end`,
      [directory, colorscheme ?? null],
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
    // Neovim closes its editor socket as it exits. Bun's PTY exit event is a
    // secondary signal that can trail that close under load, so wait for either
    // and fall back to the process table before reporting a refusal. dispose()
    // reaps any group that lingers after the socket closes.
    const end = Date.now() + 5000;
    while (
      this.host.phase === "running" &&
      !this.rpc?.disposed &&
      Date.now() < end
    ) {
      await Bun.sleep(20);
      if (Date.now() > end - 3000) await this.host.confirmExit();
    }
    if (this.host.phase === "running" && !this.rpc?.disposed)
      throw refusal ?? new Error("Neovim refused to quit");
  }
  async dispose() {
    this.disposed = true;
    this.rpc?.dispose();
    await this.host.close();
    await rm(this.dir, { recursive: true, force: true });
  }
}
