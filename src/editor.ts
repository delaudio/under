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
import type { DiffLayout, Profile } from "./config.ts";

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

/** One side of a diff: a real file buffer, or read-only text Under supplies. */
export type DiffPane =
  | { kind: "file"; path: string; label: string }
  | { kind: "text"; name: string; text: string; label: string };


/** "a.ts (Index)" + "a.ts (Working Tree)" → "a.ts (Index → Working Tree)". */
export function unifiedLabel(left: string, right: string) {
  const a = /^(.*) \(([^()]*)\)$/.exec(left);
  const b = /^(.*) \(([^()]*)\)$/.exec(right);
  return a && b && a[1] === b[1] ? `${a[1]} (${a[2]} → ${b[2]})` : `${left} → ${right}`;
}

/** Lua that closes Under's diff tab page; with `current` only when it is the
 * tab page the user is on, so a normal open never lands inside the diff. */
const closeDiffLua = (current: boolean) => `do
local t=vim.g.under_diff_tab
if t and vim.api.nvim_tabpage_is_valid(t) and (${current ? "t==vim.api.nvim_get_current_tabpage()" : "true"}) then
  if _G.UnderClearUnified then _G.UnderClearUnified() end
  if #vim.api.nvim_list_tabpages()>1 then
    pcall(vim.cmd,'tabclose! '..vim.api.nvim_tabpage_get_number(t))
  else
    -- Keep the real file: close the read-only sides, then end diff mode.
    for _,w in ipairs(vim.api.nvim_tabpage_list_wins(t)) do
      local name=vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(w))
      if name:find('^under%-diff://') and #vim.api.nvim_tabpage_list_wins(t)>1 then pcall(vim.api.nvim_win_close,w,true) end
    end
    for _,w in ipairs(vim.api.nvim_tabpage_list_wins(t)) do
      vim.api.nvim_win_call(w,function() vim.cmd('diffoff') end)
      vim.wo[w].winbar=''
    end
    pcall(vim.cmd,'silent! only!')
  end
  vim.g.under_diff_tab=nil
end
end
`;
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
${closeDiffLua(true)}local win=vim.api.nvim_get_current_win()
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
${closeDiffLua(true)}vim.api.nvim_set_current_buf(b)
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
  /**
   * Show `left` and `right` side by side in Neovim's diff mode, in a tab page of
   * their own that the next diff reuses, like VS Code's diff editor: matching
   * lines align, changes are highlighted and both sides scroll together. A file
   * side is the real buffer, so edits, undo, LSP and saving work as usual; a
   * text side is a read-only scratch buffer. The cursor lands on the right side
   * at the first change.
   */
  async openDiff(left: DiffPane, right: DiffPane, layout: DiffLayout = "split") {
    if (layout === "unified" && left.kind !== "text")
      throw new Error("A unified diff compares against text");
    const side = (pane: DiffPane) =>
      pane.kind === "file"
        ? { file: resolve(pane.path), label: pane.label }
        : {
            name: pane.name,
            label: pane.label,
            // Neovim stores lines; a final newline is not an extra empty line.
            lines: (pane.text.endsWith("\n") ? pane.text.slice(0, -1) : pane.text)
              .split("\n")
              // Neovim shows a DOS file without CRs; Git's text keeps them.
              .map((line) => line.replace(/\r$/, "")),
            ft: pane.name.replace(/^under-diff:\/\/[^/]+\//, ""),
          };
    await this.client().call("nvim_exec_lua", [
      `local left,right,layout,base,label=...
local ns=vim.api.nvim_create_namespace('under_unified')
-- The unified overlay lives on a real buffer, so it is removed explicitly
-- whenever the diff changes or closes.
_G.UnderClearUnified=function()
  local b=vim.g.under_unified_buf
  vim.g.under_unified_buf=nil
  pcall(vim.api.nvim_del_augroup_by_name,'UnderUnified')
  if not (b and vim.api.nvim_buf_is_valid(b)) then return end
  vim.api.nvim_buf_clear_namespace(b,ns,0,-1)
  for _,lhs in ipairs(vim.b[b].under_unified_maps or {}) do pcall(vim.keymap.del,'n',lhs,{buffer=b}) end
  vim.b[b].under_unified_maps=nil
  vim.b[b].under_unified_rows=nil
end
_G.UnderClearUnified()
vim.g.under_diff_gen=(vim.g.under_diff_gen or 0)+1
local gen=vim.g.under_diff_gen
local t=vim.g.under_diff_tab
if t and vim.api.nvim_tabpage_is_valid(t) then
  vim.api.nvim_set_current_tabpage(t)
else
  vim.cmd('tabnew')
  vim.bo.bufhidden='wipe'
  t=vim.api.nvim_get_current_tabpage()
  vim.g.under_diff_tab=t
end
pcall(vim.cmd,'diffoff!')
pcall(vim.cmd,'silent! only!')
local win=vim.api.nvim_get_current_win()
-- A placeholder lets the previous diff's scratch buffers wipe themselves.
local tmp=vim.api.nvim_create_buf(false,true)
vim.bo[tmp].bufhidden='wipe'
vim.api.nvim_win_set_buf(win,tmp)
local function buffer(side)
  if side.file then
    local b=vim.fn.bufadd(side.file)
    local shm=vim.o.shortmess; vim.opt.shortmess:append('A')
    local ok,err=pcall(vim.fn.bufload,b); vim.o.shortmess=shm
    if not ok then error(err) end
    vim.bo[b].buflisted=true
    vim.b[b].under_preview=nil
    if vim.g.under_preview_buf==b then vim.g.under_preview_buf=nil end
    return b
  end
  for _,x in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_get_name(x)==side.name then pcall(vim.api.nvim_buf_delete,x,{force=true}) end
  end
  local b=vim.api.nvim_create_buf(false,true)
  vim.api.nvim_buf_set_name(b,side.name)
  vim.api.nvim_buf_set_lines(b,0,-1,false,side.lines)
  vim.bo[b].bufhidden='wipe'
  vim.bo[b].modifiable=false
  vim.bo[b].readonly=true
  vim.bo[b].modified=false
  local ft=vim.filetype.match({filename=side.ft,buf=b})
  if ft then vim.bo[b].filetype=ft end
  -- Closing a side by hand ends diff mode on the other.
  vim.api.nvim_create_autocmd('BufWipeout',{buffer=b,once=true,callback=function()
    vim.schedule(function()
      local d=vim.g.under_diff_tab
      if vim.g.under_diff_gen~=gen or not (d and vim.api.nvim_tabpage_is_valid(d)) then return end
      for _,w in ipairs(vim.api.nvim_tabpage_list_wins(d)) do
        vim.api.nvim_win_call(w,function() vim.cmd('diffoff') end)
        vim.wo[w].winbar=''
      end
    end)
  end})
  return b
end
local rb=buffer(right)
vim.api.nvim_win_set_buf(win,rb)
if layout=='unified' then
  -- One editable window: added and changed lines are highlighted, removed
  -- lines appear above them as read-only virtual lines, refreshed as you type.
  -- Compare text, not line endings: Neovim strips CR from a DOS buffer, and a
  -- missing final newline is not a change to the last line.
  base=base:gsub('\\r\\n','\\n')
  if base~='' and base:sub(-1)~='\\n' then base=base..'\\n' end
  local old=vim.split(base,'\\n',{plain=true})
  if old[#old]=='' then table.remove(old) end
  -- Draw only in the diff window, not in other windows on the same file.
  local scoped=vim.api.nvim__ns_set~=nil and pcall(vim.api.nvim__ns_set,ns,{wins={win}})
  local diff=(vim.text and vim.text.diff) or vim.diff
  local function render()
    if not vim.api.nvim_buf_is_valid(rb) or vim.g.under_unified_buf~=rb then return end
    vim.api.nvim_buf_clear_namespace(rb,ns,0,-1)
    local lines=vim.api.nvim_buf_get_lines(rb,0,-1,false)
    local hunks=diff(base,table.concat(lines,'\\n')..'\\n',{result_type='indices'})
    local width=vim.o.columns
    local tab=string.rep(' ',vim.bo[rb].tabstop)
    local rows={}
    for _,h in ipairs(hunks) do
      local sa,ca,sb,cb=h[1],h[2],h[3],h[4]
      if ca>0 then
        local virt={}
        for i=sa,sa+ca-1 do
          local text=(old[i] or ''):gsub('\\t',tab)
          text=text..string.rep(' ',math.max(0,width-vim.fn.strdisplaywidth(text)))
          table.insert(virt,{{text,'DiffDelete'}})
        end
        -- A pure deletion sits after line sb; otherwise above the new lines.
        local row,above=sb-1,true
        if cb==0 then if sb==0 then row=0 else row,above=sb-1,false end end
        row=math.max(0,math.min(row,#lines-1))
        vim.api.nvim_buf_set_extmark(rb,ns,row,0,{virt_lines=virt,virt_lines_above=above,scoped=scoped or nil})
      end
      for r=sb-1,sb+cb-2 do vim.api.nvim_buf_set_extmark(rb,ns,r,0,{line_hl_group='DiffAdd',scoped=scoped or nil}) end
      table.insert(rows,math.max(1,math.min(cb>0 and sb or sb+1,#lines)))
    end
    vim.b[rb].under_unified_rows=rows
  end
  local function jump(dir)
    local rows=vim.b[rb].under_unified_rows or {}
    local cur=vim.api.nvim_win_get_cursor(0)[1]
    if dir>0 then
      for _,r in ipairs(rows) do if r>cur then vim.api.nvim_win_set_cursor(0,{r,0}) return end end
    else
      for i=#rows,1,-1 do if rows[i]<cur then vim.api.nvim_win_set_cursor(0,{rows[i],0}) return end end
    end
  end
  -- ]c / [c move between changes, unless the buffer already maps them.
  local maps={}
  for lhs,dir in pairs({[']c']=1,['[c']=-1}) do
    if vim.fn.maparg(lhs,'n',false,true).buffer~=1 then
      vim.keymap.set('n',lhs,function() jump(dir) end,{buffer=rb,desc='Under: next/previous change'})
      table.insert(maps,lhs)
    end
  end
  vim.b[rb].under_unified_maps=maps
  vim.g.under_unified_buf=rb
  local group=vim.api.nvim_create_augroup('UnderUnified',{clear=true})
  local pending=false
  vim.api.nvim_create_autocmd({'TextChanged','TextChangedI'},{group=group,buffer=rb,callback=function()
    if pending then return end
    pending=true
    vim.defer_fn(function() pending=false render() end,100)
  end})
  vim.api.nvim_create_autocmd('TabClosed',{group=group,callback=function()
    local d=vim.g.under_diff_tab
    if not (d and vim.api.nvim_tabpage_is_valid(d)) then _G.UnderClearUnified() end
  end})
  render()
  vim.wo[win].winbar=' '..label:gsub('%%','%%%%')
  local first=(vim.b[rb].under_unified_rows or {})[1] or 1
  vim.api.nvim_win_set_cursor(win,{first,0})
  if _G.UnderSendBuffers then _G.UnderSendBuffers() end
  return
end
vim.cmd('leftabove vsplit')
local lwin=vim.api.nvim_get_current_win()
local lb=buffer(left)
vim.api.nvim_win_set_buf(lwin,lb)
for _,pair in ipairs({{lwin,left},{win,right}}) do
  vim.api.nvim_win_call(pair[1],function() vim.cmd('diffthis') end)
  vim.wo[pair[1]].winbar=' '..pair[2].label:gsub('%%','%%%%')
end
vim.api.nvim_set_current_win(win)
pcall(vim.cmd,'diffupdate')
vim.api.nvim_win_set_cursor(win,{1,0})
if vim.fn.diff_hlID(1,1)==0 and vim.fn.diff_filler(1)==0 then pcall(vim.cmd,'normal! ]c') end
if _G.UnderSendBuffers then _G.UnderSendBuffers() end`,
      [
        side(left),
        side(right),
        layout,
        left.kind === "text" ? left.text : "",
        unifiedLabel(left.label, right.label),
      ],
    ]);
  }
  /** Whether Under's diff tab page is still open (the user may close it). */
  async diffOpen(): Promise<boolean> {
    return this.client().call<boolean>("nvim_exec_lua", [
      "local t=vim.g.under_diff_tab return t~=nil and vim.api.nvim_tabpage_is_valid(t)",
      [],
    ]);
  }
  /** Close Under's diff tab page, if it is open. */
  async closeDiff() {
    await this.client().call("nvim_exec_lua", [
      `${closeDiffLua(false)}if _G.UnderSendBuffers then _G.UnderSendBuffers() end`,
      [],
    ]);
  }
  /** Reread `path` from disk if it is loaded and unmodified (after a discard). */
  async reload(path: string) {
    await this.client().call("nvim_exec_lua", [
      `local p=...
for _,b in ipairs(vim.api.nvim_list_bufs()) do
  if vim.api.nvim_buf_get_name(b)==p and vim.api.nvim_buf_is_loaded(b) and not vim.bo[b].modified then
    -- A deleted file's buffer would otherwise recreate it on the next :w.
    if vim.fn.filereadable(p)==0 then pcall(vim.cmd,'bdelete '..b)
    else vim.api.nvim_buf_call(b,function() vim.cmd('silent! edit') end) end
  end
end`,
      [resolve(path)],
    ]);
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
