import { BoxRenderable, TextRenderable, EmbeddedTerminalRenderable, type CliRenderer, type KeyEvent, type PasteEvent } from "@opentui/core";
import { stat, writeFile, mkdtemp, rm } from "node:fs/promises";
import { basename, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chmod } from "node:fs/promises";
import { InputOwner } from "./input.ts";
import { PtyHost } from "./pty.ts";
import { Editor, type EditorSnapshot } from "./editor.ts";
import { FileBridge } from "./bridge.ts";
import { contextText, sameSnapshot, type ContextKind } from "./context.ts";
import { loadConfig, statePath, type Config, type Profile } from "./config.ts";
import { saveState, type State } from "./state.ts";
import { createWorkspace, createPane, preset, split, remove, resize, rectangles, leaf, type Pane, type Workspace } from "./model.ts";

type Runtime = { host: PtyHost; editor?: Editor; view: EmbeddedTerminalRenderable; frame: BoxRenderable; title: TextRenderable };
type Command = { name: string; action: () => void | Promise<void> };
type Modal = { kind: "palette" | "input" | "preview" | "help"; title: string; text: string; index: number; submit?: (text: string) => Promise<void> | void; cancelMode: "app" | "terminal"; snapshot?: EditorSnapshot; editor?: Editor };
export class App {
  state: State; input: InputOwner; config: Config;
  private runtimes = new Map<string, Runtime>(); private bridges = new Map<string, FileBridge>();
  private header: TextRenderable; private footer: TextRenderable; private sidebar: TextRenderable;
  private overlay: BoxRenderable; private overlayText: TextRenderable;
  private modal?: Modal; private side = true; private message = "Press Ctrl-G, then p for commands";
  private shutdownPromise?: Promise<void>; private shuttingDown = false; private disposed = false;
  private starts = new Map<string, Promise<void>>(); private actionPending = false;
  private timer: ReturnType<typeof setInterval>; private helperDir = "";
  constructor(readonly renderer: CliRenderer, cwd: string, state?: State) {
    const loaded = loadConfig(cwd); this.config = loaded.config; this.input = new InputOwner(this.config.prefix);
    this.message = loaded.warnings.join(" | ") || this.message;
    const w = createWorkspace(cwd, this.config.preset);
    this.state = state ?? { version: 1, workspaces: [w], active: w.id };
    this.header = new TextRenderable(renderer, { id: "header", position: "absolute", left: 0, top: 0, height: 1, fg: this.config.accent });
    this.footer = new TextRenderable(renderer, { id: "footer", position: "absolute", left: 0, height: 1, fg: this.config.foreground });
    this.sidebar = new TextRenderable(renderer, { id: "sidebar", position: "absolute", left: 0, top: 1, fg: this.config.foreground,
      onMouseDown: () => { this.input.mode = "app"; this.activeRuntime()?.view.blur(); this.draw(); } });
    this.overlay = new BoxRenderable(renderer, { id: "overlay", position: "absolute", border: true, backgroundColor: this.config.background, zIndex: 100, visible: false,
      onMouseDown: event => { event.stopPropagation(); }, onMouseScroll: event => { if (this.modal) { this.modal.index = Math.max(0, this.modal.index + (event.scroll?.direction === "up" ? -1 : 1)); this.draw(); } event.stopPropagation(); } });
    this.overlayText = new TextRenderable(renderer, { id: "overlay-text", fg: this.config.foreground }); this.overlay.add(this.overlayText);
    for (const v of [this.header, this.footer, this.sidebar, this.overlay]) renderer.root.add(v);
    renderer.keyInput.on("keypress", this.onKey); renderer.keyInput.on("paste", this.onPaste);
    renderer.on("resize", this.draw);
    this.timer = setInterval(this.draw, 300); this.draw();
  }
  workspace() { return this.state.workspaces.find(w => w.id === this.state.active)!; }
  tab() { const w = this.workspace(); return w.tabs.find(t => t.id === w.activeTab)!; }
  private activeRuntime() { return this.runtimes.get(this.tab().focused); }
  private editor(w: Workspace = this.workspace()) { for (const t of w.tabs) for (const p of t.panes) { const r = this.runtimes.get(p.id); if (r?.editor) return { pane: p, runtime: r }; } throw new Error("Start a Neovim pane in this workspace first"); }
  async startInitial() { const p = this.tab().panes.find(p => p.kind === "nvim"); if (p) await this.start(p); }
  private async bridge(w: Workspace) {
    let b = this.bridges.get(w.id); if (b) return b;
    b = new FileBridge(); await b.start(async (path, line, column) => {
      if (this.shuttingDown) throw new Error("Under is shutting down");
      const e = this.editor(w); await e.runtime.editor!.openFile(path, line, column);
      this.state.active = w.id; w.activeTab = w.tabs.find(t => t.panes.some(p => p.id === e.pane.id))!.id;
      this.tab().focused = e.pane.id; this.input.mode = "terminal"; this.draw();
    }); this.bridges.set(w.id, b); return b;
  }
  private async helpers() {
    if (this.helperDir) return;
    this.helperDir = await mkdtemp(join(tmpdir(), "under-helper-"));
    const script = `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${fileURLToPath(new URL("./main.ts", import.meta.url)).replaceAll("'", "'\\''")}' open "$@"\n`;
    await writeFile(join(this.helperDir, "nvim"), script); await chmod(join(this.helperDir, "nvim"), 0o700);
  }
  start(pane: Pane): Promise<void> {
    if (this.starts.has(pane.id)) return Promise.reject(new Error("Pane is starting"));
    const pending = this.startPane(pane).finally(() => this.starts.delete(pane.id)); this.starts.set(pane.id, pending); return pending;
  }
  private async startPane(pane: Pane) {
    if (this.shuttingDown) throw new Error("Under is shutting down");
    if (this.runtimes.has(pane.id)) throw new Error("Pane already started; stop it before restarting");
    const w = this.workspace(); const { config, warnings } = loadConfig(w.path); this.config = config;
    const profile = pane.kind === "task" ? config.tasks[pane.profile] : config.profiles[pane.profile];
    if (!profile) throw new Error(`Configure ${pane.profile} in .under.json or the user config`);
    if (!Bun.which(profile.argv[0]!)) throw new Error(`Missing executable ${profile.argv[0]}; install it or configure its argv`);
    if (!(await stat(w.path)).isDirectory()) throw new Error(`Not a directory: ${w.path}`);
    await this.helpers(); const bridge = await this.bridge(w);
    if (this.shuttingDown) throw new Error("Launch cancelled during shutdown");
    let command: Profile = { ...profile, env: { ...profile.env, UNDER_OPEN_SOCKET: bridge.path, EDITOR: join(this.helperDir, "nvim"), VISUAL: join(this.helperDir, "nvim") } };
    if (pane.kind === "task" && config.tasks[pane.profile]?.shell) command = { ...command, argv: [process.env.SHELL || "/bin/sh", "-lc", profile.argv.join(" ")] };
    const frame = new BoxRenderable(this.renderer, { id: `frame-${pane.id}`, position: "absolute", border: true, borderColor: config.accent });
    const title = new TextRenderable(this.renderer, { id: `title-${pane.id}`, height: 1, fg: config.accent });
    let host: PtyHost; let editor: Editor | undefined;
    try { if (pane.kind === "nvim") { editor = await Editor.launch(command, w.path); host = editor.host; } else host = new PtyHost(command, w.path); }
    catch (e) { frame.destroy(); title.destroy(); throw e; }
    if (this.shuttingDown) { editor ? await editor.dispose() : await host.close(); frame.destroy(); title.destroy(); throw new Error("Launch cancelled during shutdown"); }
    const view = new EmbeddedTerminalRenderable(this.renderer, { id: pane.id, width: "100%", flexGrow: 1, maxScrollback: 5000,
      onData: bytes => host.write(bytes), onTerminalResize: (cols, rows) => host.resize(cols, rows),
      onMouseDown: () => { if (!this.modal) { this.tab().focused = pane.id; this.input.mode = "terminal"; this.draw(); } } });
    frame.add(title); frame.add(view); this.renderer.root.add(frame);
    this.runtimes.set(pane.id, { host, editor, frame, title, view }); host.attach(bytes => view.write(bytes)); this.draw();
    if (editor) {
      try { await editor.ready(); } catch (e) { await editor.dispose(); this.runtimes.delete(pane.id); frame.destroyRecursively(); throw e; }
    }
    this.message = warnings.join(" | ") || `Started ${pane.profile}`;
  }
  private async stop(pane: Pane) {
    const r = this.runtimes.get(pane.id); if (!r) return;
    if (r.editor && r.host.phase === "running") await r.editor.quit();
    r.editor ? await r.editor.dispose() : await r.host.close();
    this.runtimes.delete(pane.id); r.frame.destroyRecursively(); this.draw();
  }
  private async add(kind: Pane["kind"], profile: string = kind, axis: "row" | "column" = "row") {
    const tab = this.tab(), pane = createPane(kind, profile); tab.panes.push(pane); tab.layout = split(tab.layout, tab.focused, pane.id, axis); tab.focused = pane.id;
    this.draw(); await this.start(pane); this.input.mode = "terminal"; this.draw();
  }
  private commands(): Command[] {
    const cmd = (name: string, action: Command["action"]) => ({ name, action });
    return [
      cmd("Start focused pane", () => this.start(this.tab().panes.find(p => p.id === this.tab().focused)!)),
      cmd("Stop focused pane", () => this.stop(this.tab().panes.find(p => p.id === this.tab().focused)!)),
      cmd("Restart focused pane", async () => { const p = this.tab().panes.find(p => p.id === this.tab().focused)!; await this.stop(p); await this.start(p); }),
      cmd("Open file in Neovim", () => this.ask("File path", async text => { await this.editor().runtime.editor!.openFile(resolve(this.workspace().path, text)); })),
      cmd("Add Neovim", () => this.add("nvim")), cmd("Add Yazi", () => this.add("yazi")), cmd("Add Hunk live review", () => this.add("hunk")),
      cmd("Split right with shell", () => this.add("shell")), cmd("Split below with shell", () => this.add("shell", "shell", "column")),
      ...Object.keys(this.config.profiles).filter(k => !["nvim", "yazi", "hunk", "shell"].includes(k)).map(k => cmd(`Start agent: ${k}`, () => this.add("agent", k))),
      ...Object.keys(this.config.tasks).map(k => cmd(`Run task: ${k}${this.config.tasks[k]?.shell ? " (shell command)" : ""}`, () => this.add("task", k))),
      ...(["code", "review", "run"] as const).map(name => cmd(`New ${name} tab`, () => { const t = preset(name); this.workspace().tabs.push(t); this.workspace().activeTab = t.id; this.draw(); })),
      cmd("Next tab", () => this.cycleTab()), cmd("Next workspace", () => this.cycleWorkspace()),
      cmd("Open workspace", () => this.ask("Directory path", async text => { const path = resolve(this.workspace().path, text); if (!(await stat(path)).isDirectory()) throw new Error("Not a directory"); const w = createWorkspace(path); this.state.workspaces.push(w); this.state.active = w.id; this.config = loadConfig(path).config; this.draw(); })),
      cmd("Move pane to new tab", () => { const t = this.tab(); if (t.panes.length < 2) throw new Error("Split first"); const p = t.panes.find(p => p.id === t.focused)!; t.layout = remove(t.layout, p.id)!; t.panes = t.panes.filter(x => x.id !== p.id); t.focused = t.panes[0]!.id; const n = preset("run"); n.panes = [p]; n.layout = leaf(p); n.focused = p.id; n.name = p.profile; this.workspace().tabs.push(n); this.workspace().activeTab = n.id; this.draw(); }),
      cmd("Close focused pane", async () => { const t = this.tab(); if (t.panes.length === 1) throw new Error("Use Quit to close the last pane"); const p = t.panes.find(p => p.id === t.focused)!; await this.stop(p); t.panes = t.panes.filter(x => x.id !== p.id); t.layout = remove(t.layout, p.id)!; t.focused = t.panes[0]!.id; this.draw(); }),
      cmd("Toggle zoom", () => { this.tab().zoom = !this.tab().zoom; this.draw(); }), cmd("Grow focused pane", () => { this.tab().layout = resize(this.tab().layout, this.tab().focused, .05); this.draw(); }),
      cmd("Shrink focused pane", () => { this.tab().layout = resize(this.tab().layout, this.tab().focused, -.05); this.draw(); }),
      cmd("Toggle sidebar", () => { this.side = !this.side; this.draw(); }),
      ...(["file", "selection", "diagnostics"] as const).map(k => cmd(`Preview ${k} context for agent`, () => this.preview(k))),
      cmd("Save workspace layout", () => saveState(statePath(), this.state)),
      cmd("Reload configuration", () => { const l = loadConfig(this.workspace().path); this.config = l.config; this.input.prefix = l.config.prefix; this.message = l.warnings.join(" | ") || "Configuration reloaded; new panes use new profiles"; this.draw(); }),
      cmd("Shortcut help", () => this.help()), cmd("Quit Under", () => this.shutdown()),
    ];
  }
  private ask(title: string, submit: Modal["submit"]) { this.openModal({ kind: "input", title, text: "", index: 0, submit, cancelMode: "app" }); }
  private help() { this.openModal({ kind: "help", title: "Under shortcuts", text: `${this.input.prefix}: application navigation\nPrefix twice: forward literal prefix\nEscape: return to terminal / dismiss modal\np: command palette  Tab/j/k: cycle panes\nt: next tab  w: next workspace  z: zoom\n[ / ]: resize focused split  b: sidebar\nq: safe quit\n\nUse the palette to start tools, open files, run tasks,\nmove panes and preview context.\nNative terminal keys remain owned by the focused tool.`, index: 0, cancelMode: "app" }); }
  private async preview(kind: ContextKind) {
    const editor = this.editor().runtime.editor!; const snapshot = await editor.snapshot(); const text = contextText(snapshot, kind);
    const target = this.tab().panes.find(p => p.kind === "agent" && this.runtimes.get(p.id)?.host.phase === "running");
    if (!target) throw new Error("Start an agent in the current tab first");
    this.openModal({ kind: "preview", title: `Context for ${target.profile} — Enter pastes; submit in native CLI`, text, index: 0, snapshot, editor, cancelMode: "app", submit: async () => {
      if (!sameSnapshot(snapshot, await editor.snapshot())) throw new Error("Editor context changed; generate a new preview");
      const r = this.runtimes.get(target.id); if (!r || r.host.phase !== "running") throw new Error("Target agent is no longer running");
      r.host.write(r.view.encodePaste(new TextEncoder().encode(text)));
      this.tab().focused = target.id; this.input.mode = "terminal"; this.message = "Context pasted. Review and submit in the agent CLI.";
    } });
  }
  private openModal(modal: Modal) { modal.cancelMode = this.input.mode === "terminal" ? "terminal" : "app"; this.modal = modal; this.input.mode = "modal"; this.activeRuntime()?.view.blur(); this.draw(); }
  private closeModal() { const previous = this.modal?.cancelMode ?? "app"; this.modal = undefined; this.input.mode = previous; this.draw(); }
  private palette() { this.openModal({ kind: "palette", title: "Commands", text: "", index: 0, cancelMode: "app" }); }
  private choices() { return this.commands().filter(c => c.name.toLowerCase().includes(this.modal?.text.toLowerCase() ?? "")); }
  private cycleTab() { const w = this.workspace(); w.activeTab = w.tabs[(w.tabs.findIndex(t => t.id === w.activeTab) + 1) % w.tabs.length]!.id; this.draw(); }
  private cycleWorkspace() { this.state.active = this.state.workspaces[(this.state.workspaces.findIndex(w => w.id === this.state.active) + 1) % this.state.workspaces.length]!.id; this.config = loadConfig(this.workspace().path).config; this.draw(); }
  private run(action: Command["action"]) {
    if (this.shuttingDown || this.actionPending) { this.message = "An action is already pending"; return; }
    this.actionPending = true;
    Promise.resolve().then(action).catch(e => { this.message = String(e); this.draw(); }).finally(() => { this.actionPending = false; });
  }
  private onPaste = (event: PasteEvent) => {
    if (this.input.mode !== "terminal") {
      event.preventDefault(); event.stopPropagation();
      if (this.modal?.kind === "input" || this.modal?.kind === "palette") {
        const text = new TextDecoder().decode(event.bytes).replace(/[\x00-\x1f\x7f]/g, "");
        if (Buffer.byteLength(this.modal.text + text) <= 16384) this.modal.text += text;
        this.draw();
      }
    }
  };
  private onKey = (key: KeyEvent) => {
    const decision = this.input.handle(key);
    if (decision === "forward") return;
    key.preventDefault(); key.stopPropagation();
    if (decision === "literal") { this.activeRuntime()?.host.write(this.input.literal()); this.draw(); return; }
    if (this.modal) {
      const m = this.modal;
      if (key.name === "escape") { this.closeModal(); return; }
      if (key.name === "return" || key.name === "enter") {
        if (m.kind === "palette") { const c = this.choices()[m.index]; this.closeModal(); if (c) this.run(c.action); }
        else if (m.submit) { this.closeModal(); this.run(() => m.submit!(m.text)); } else this.closeModal();
      } else if (["up", "down", "pageup", "pagedown"].includes(key.name)) {
        const delta = key.name === "up" ? -1 : key.name === "down" ? 1 : key.name === "pageup" ? -10 : 10;
        m.index = Math.max(0, Math.min(m.index + delta, m.kind === "palette" ? Math.max(0, this.choices().length - 1) : Math.max(0, m.text.split("\n").length - 1)));
      } else if (m.kind === "input" || m.kind === "palette") {
        if (key.name === "backspace") m.text = [...m.text].slice(0, -1).join("");
        else if (!key.ctrl && !key.meta && key.sequence && m.text.length < 16384 && [...key.sequence].every(c => c >= " " && c !== "\x7f")) m.text += key.sequence;
        m.index = 0;
      }
      this.draw(); return;
    }
    if (this.input.mode === "app") {
      this.activeRuntime()?.view.blur(); const t = this.tab();
      if (["tab", "j", "k"].includes(key.name)) { const step = key.name === "k" || key.shift ? -1 : 1; t.focused = t.panes[(t.panes.findIndex(p => p.id === t.focused) + step + t.panes.length) % t.panes.length]!.id; }
      else if (key.name === "p") this.palette(); else if (key.name === "t") this.cycleTab(); else if (key.name === "w") this.cycleWorkspace();
      else if (key.name === "z") t.zoom = !t.zoom; else if (key.name === "b") this.side = !this.side;
      else if (key.name === "[") t.layout = resize(t.layout, t.focused, -.05); else if (key.name === "]") t.layout = resize(t.layout, t.focused, .05);
      else if (key.name === "q") this.run(() => this.shutdown()); else if (key.name === "?") this.help();
    }
    this.draw();
  };
  draw = () => {
    if (this.disposed) return;
    const width = this.renderer.width, height = this.renderer.height, w = this.workspace(), t = this.tab();
    const side = this.side && width >= 90 ? 22 : 0;
    this.header.width = width; this.header.content = ` under_  ${basename(w.path)}  | ${w.tabs.map(x => `${x.id === t.id ? "•" : " "}${x.name}`).join("  ")}`;
    this.sidebar.visible = side > 0; this.sidebar.width = side; this.sidebar.height = Math.max(1, height - 2);
    this.sidebar.content = this.state.workspaces.map(x => `${x.id === w.id ? "›" : " "} ${basename(x.path)}`).join("\n") + "\n\n" + t.panes.map(p => `${p.id === t.focused ? "›" : " "} ${p.profile}\n  ${this.runtimes.get(p.id)?.host.phase ?? "not started"}`).join("\n");
    this.footer.top = Math.max(0, height - 1); this.footer.width = width;
    this.footer.content = `${this.input.mode.toUpperCase()} | ${this.message.replace(/[\x00-\x1f\x7f]/g, " ")}`;
    const rect = { x: side, y: 1, width: Math.max(1, width - side), height: Math.max(1, height - 2) };
    const layout = t.zoom || width < 60 || height < 12 ? { pane: t.focused } : t.layout;
    const cells = rectangles(layout, rect);
    for (const [id, r] of this.runtimes) {
      const cell = cells.get(id); r.frame.visible = !!cell;
      if (!cell) { r.view.blur(); continue; }
      r.frame.left = cell.x; r.frame.top = cell.y; r.frame.width = cell.width; r.frame.height = cell.height;
      const pane = t.panes.find(p => p.id === id)!;
      r.title.content = `${pane.profile} [${r.host.phase}${r.host.exitCode !== null ? `:${r.host.exitCode}` : ""}]`;
      if (id === t.focused && this.input.mode === "terminal") r.view.focus(); else r.view.blur();
    }
    // A dormant pane is visible as a placeholder, without executing anything.
    const focused = this.runtimes.get(t.focused);
    if (!focused && !this.modal) { this.overlay.visible = true; this.overlay.left = side; this.overlay.top = 2; this.overlay.width = Math.max(1, width - side); this.overlay.height = 5;
      this.overlayText.content = `${t.panes.find(p => p.id === t.focused)?.profile} is not started.\n${this.input.prefix}, p → Start focused pane`; }
    else this.overlay.visible = !!this.modal;
    if (this.modal) {
      const m = this.modal; const rows = Math.max(1, height - 7);
      this.overlay.left = Math.min(3, Math.max(0, width - 8)); this.overlay.top = 2; this.overlay.width = Math.max(1, width - 6); this.overlay.height = Math.max(3, height - 4);
      const lines = m.kind === "palette" ? this.choices().map((c, i) => `${i === m.index ? "›" : " "} ${c.name}`) : m.text.split("\n");
      const start = m.kind === "palette" ? Math.max(0, m.index - rows + 1) : m.index;
      this.overlayText.content = `${m.title}\n${m.kind === "palette" || m.kind === "input" ? "> " + m.text + "\n" : ""}${lines.slice(start, start + rows).join("\n")}\nEsc cancel · ↑↓ scroll · Enter select`;
    }
  };
  async shutdown(force = false) {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = (async () => {
      await Promise.allSettled(this.starts.values());
      if (!force) {
        for (const r of this.runtimes.values()) if (r.editor && r.host.phase === "running") { const modified = await r.editor.modified(); if (modified.length) throw new Error(`Save modified buffers before quitting: ${modified.join(", ")}`); }
        // Quit editors before touching any other tools. A refused quit preserves agents.
        for (const r of this.runtimes.values()) if (r.editor && r.host.phase === "running") await r.editor.quit();
      }
      await saveState(statePath(), this.state);
      const errors: unknown[] = [];
      for (const r of this.runtimes.values()) { try { r.editor ? await r.editor.dispose() : await r.host.close(); } catch (e) { errors.push(e); } }
      for (const b of this.bridges.values()) await b.close();
      if (this.helperDir) await rm(this.helperDir, { recursive: true, force: true });
      this.disposeUI(); if (errors.length) throw new AggregateError(errors, "Process cleanup failed");
    })().catch(e => { this.shuttingDown = false; this.shutdownPromise = undefined; throw e; });
    return this.shutdownPromise;
  }
  disposeUI() { if (this.disposed) return; this.disposed = true; clearInterval(this.timer); this.renderer.keyInput.off("keypress", this.onKey); this.renderer.keyInput.off("paste", this.onPaste); this.renderer.off("resize", this.draw); this.renderer.destroy(); }
}
