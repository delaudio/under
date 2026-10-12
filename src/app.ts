import {
  BoxRenderable,
  TextRenderable,
  EmbeddedTerminalRenderable,
  type CliRenderer,
  type KeyEvent,
  type PasteEvent,
} from "@opentui/core";
import { stat, writeFile, mkdtemp, rm, readFile } from "node:fs/promises";
import { basename, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { yaziConfig } from "./yazi.ts";
import { repaint } from "./repaint.ts";
import { terminalResponse } from "./terminal.ts";
import { FileBrowser, displayName, type FileEntry } from "./files.ts";
import { MENU_LABELS, menuSlots, wrapText, type MenuLabel } from "./menu.ts";
import { chmod } from "node:fs/promises";
import { InputOwner } from "./input.ts";
import { PtyHost } from "./pty.ts";
import { Editor, type EditorSnapshot } from "./editor.ts";
import { FileBridge } from "./bridge.ts";
import { fileDiff } from "./git.ts";
import { contextText, sameSnapshot, type ContextKind } from "./context.ts";
import { loadConfig, statePath, type Config, type Profile } from "./config.ts";
import { saveState, type State } from "./state.ts";
import {
  createWorkspace,
  createPane,
  preset,
  split,
  remove,
  resize,
  rectangles,
  leaf,
  type Pane,
  type Workspace,
} from "./model.ts";

export type PaneEditor = Pick<
  Editor,
  | "snapshot"
  | "openFile"
  | "ready"
  | "modified"
  | "quit"
  | "dispose"
  | "abortInitialization"
>;
export type PaneHost = Pick<
  PtyHost,
  "phase" | "exitCode" | "write" | "resize" | "attach" | "close"
>;
type Runtime = {
  host: PaneHost;
  editor?: PaneEditor;
  view: EmbeddedTerminalRenderable;
  frame: BoxRenderable;
  title: TextRenderable;
};
type Command = {
  name: string;
  action: () => void | Promise<void>;
  disabled?: string;
  checked?: boolean;
};
type Modal = {
  kind: "palette" | "menu" | "input" | "preview" | "help";
  menu?: MenuLabel;
  title: string;
  text: string;
  index: number;
  submit?: (text: string) => Promise<void> | void;
  cancelMode: "app" | "terminal";
  snapshot?: EditorSnapshot;
  editor?: PaneEditor;
};
export class App {
  state: State;
  input: InputOwner;
  config: Config;
  private runtimes = new Map<string, Runtime>();
  private bridges = new Map<string, FileBridge>();
  private placeholders = new Map<
    string,
    { frame: BoxRenderable; text: TextRenderable }
  >();
  private header: TextRenderable;
  private footer: TextRenderable;
  private sidebar: TextRenderable;
  private overlay: BoxRenderable;
  private overlayText: TextRenderable;
  private modal?: Modal;
  private side = true;
  private filesFocused = false;
  private browsers = new Map<string, FileBrowser>();
  private menuButtons: TextRenderable[] = [];
  private menuStart = 0;
  private chatHidden = false;
  private message = "Ctrl-G m: menu · f: files · p: commands";
  private shutdownPromise?: Promise<void>;
  private shuttingDown = false;
  private disposed = false;
  private starts = new Map<string, Promise<void>>();
  private actionPending = false;
  private timer: ReturnType<typeof setInterval>;
  private helperDir = "";
  private yaziDirectories = new Set<string>();

  constructor(
    readonly renderer: CliRenderer,
    cwd: string,
    state?: State,
    private readonly options: {
      config?: Config;
      files?: FileEntry[];
      available?: (command: string) => boolean;
    } = {},
  ) {
    const loaded = options.config
      ? { config: structuredClone(options.config), warnings: [] }
      : loadConfig(cwd);
    this.config = loaded.config;
    this.input = new InputOwner(this.config.prefix);
    renderer.setBackgroundColor(this.config.background);
    this.message = loaded.warnings.join(" | ") || this.message;
    const w = createWorkspace(cwd, this.config.preset);
    this.state = state ?? { version: 1, workspaces: [w], active: w.id };
    this.header = new TextRenderable(renderer, {
      id: "header",
      position: "absolute",
      left: 0,
      top: 0,
      height: 1,
      fg: this.config.accent,
    });
    this.footer = new TextRenderable(renderer, {
      id: "footer",
      position: "absolute",
      left: 0,
      height: 1,
      fg: this.config.foreground,
    });
    this.sidebar = new TextRenderable(renderer, {
      id: "sidebar",
      position: "absolute",
      left: 0,
      top: 1,
      fg: this.config.foreground,
      onMouseDown: (event) => {
        event.stopPropagation();
        if (this.modal) return;
        this.filesFocused = true;
        this.side = true;
        this.input.mode = "app";
        const browser = this.fileBrowser();
        const rows = Math.max(1, this.sidebar.height - 4);
        const start = Math.max(0, browser.selected - rows + 1);
        const index = start + event.y - this.sidebar.y - 2;
        if (index >= 0 && index < browser.entries.length) {
          browser.selected = index;
          this.run(() => this.openSelectedFile());
        }
        this.draw();
      },
      onMouseScroll: (event) => {
        event.stopPropagation();
        if (this.modal) return;
        this.fileBrowser().move(event.scroll?.direction === "up" ? -1 : 1);
        this.filesFocused = true;
        this.input.mode = "app";
        this.draw();
      },
    });
    this.overlay = new BoxRenderable(renderer, {
      id: "overlay",
      position: "absolute",
      border: true,
      backgroundColor: this.config.background,
      zIndex: 100,
      visible: false,
      onMouseDown: (event) => {
        event.stopPropagation();
        if (!this.modal || !["menu", "palette"].includes(this.modal.kind))
          return;
        const index =
          this.menuStart +
          event.y -
          this.overlay.y -
          (this.modal.kind === "menu" ? 2 : 3);
        const choice = this.choices()[index];
        if (choice) {
          if (choice.disabled) {
            this.report(choice.disabled);
            return;
          }
          this.closeModal();
          this.run(
            choice.action,
            choice.name === "Quit Under" || choice.name === "Shortcut help",
          );
        }
      },
      onMouseScroll: (event) => {
        if (this.modal) {
          this.modal.index = Math.max(
            0,
            Math.min(
              this.modal.index + (event.scroll?.direction === "up" ? -1 : 1),
              this.modal.kind === "menu" || this.modal.kind === "palette"
                ? this.choices().length - 1
                : this.modalLines().length - 1,
            ),
          );
          this.draw();
        }
        event.stopPropagation();
      },
    });
    this.overlayText = new TextRenderable(renderer, {
      id: "overlay-text",
      wrapMode: "none",
      fg: this.config.foreground,
    });
    this.overlay.add(this.overlayText);
    for (const v of [this.header, this.footer, this.sidebar, this.overlay])
      renderer.root.add(v);
    for (const label of MENU_LABELS) {
      const button = new TextRenderable(renderer, {
        id: `menu-${label}`,
        position: "absolute",
        height: 1,
        zIndex: 110,
        content: ` ${label} `,
        fg: this.config.foreground,
        bg: "#20202a",
        onMouseDown: (event) => {
          event.stopPropagation();
          if (!this.modal || this.modal.kind === "menu") this.openMenu(label);
        },
      });
      this.menuButtons.push(button);
      renderer.root.add(button);
    }
    renderer.keyInput.on("keypress", this.onKey);
    renderer.keyInput.on("paste", this.onPaste);
    renderer.on("resize", this.draw);
    this.timer = setInterval(this.draw, 300);
    this.draw();
  }
  workspace() {
    return this.state.workspaces.find((w) => w.id === this.state.active)!;
  }
  report(message: string) {
    this.message = message;
    this.draw();
  }
  editorSnapshot(): Promise<EditorSnapshot> {
    return this.editor().runtime.editor!.snapshot();
  }
  tab() {
    const w = this.workspace();
    return w.tabs.find((t) => t.id === w.activeTab)!;
  }
  private activeRuntime() {
    return this.runtimes.get(this.tab().focused);
  }
  private editor(w: Workspace = this.workspace()) {
    for (const t of w.tabs)
      for (const p of t.panes) {
        const r = this.runtimes.get(p.id);
        if (r?.editor) return { pane: p, runtime: r };
      }
    throw new Error("Start a Neovim pane in this workspace first");
  }
  fileBrowser() {
    const workspace = this.workspace();
    let browser = this.browsers.get(workspace.id);
    if (!browser) {
      browser = new FileBrowser(workspace.path);
      this.browsers.set(workspace.id, browser);
      if (this.options.files)
        browser.entries = structuredClone(this.options.files);
      else void browser.load().then(() => this.draw());
    }
    return browser;
  }
  async refreshFiles() {
    await this.fileBrowser().load();
    this.draw();
  }
  private async openSelectedFile() {
    const browser = this.fileBrowser();
    const entry = browser.entries[browser.selected];
    if (!entry) return;
    if (entry.directory) {
      await browser.load(entry.path);
      this.draw();
      return;
    }
    const e = this.editor();
    await e.runtime.editor!.openFile(entry.path);
    this.workspace().activeTab = this.workspace().tabs.find((t) =>
      t.panes.some((p) => p.id === e.pane.id),
    )!.id;
    this.tab().focused = e.pane.id;
    this.filesFocused = false;
    this.input.mode = "terminal";
    this.report(`Opened ${displayName(entry.name)}`);
  }
  private focusFiles() {
    this.side = true;
    const pane = this.tab().panes.find(
      (p) =>
        p.kind === "yazi" && this.runtimes.get(p.id)?.host.phase === "running",
    );
    this.filesFocused = !pane;
    if (pane) this.tab().focused = pane.id;
    this.input.mode = pane ? "terminal" : "app";
    this.draw();
  }
  private async openYazi() {
    const pane = this.tab().panes.find((p) => p.kind === "yazi");
    if (!pane) {
      await this.add("yazi");
      return;
    }
    const runtime = this.runtimes.get(pane.id);
    if (runtime && runtime.host.phase !== "running") await this.stop(pane);
    if (!this.runtimes.has(pane.id)) await this.start(pane);
    this.focusFiles();
  }
  async openReview(staged: boolean) {
    const profile = staged ? "hunk-staged" : "hunk";
    const command = this.config.profiles[profile];
    if (
      !command ||
      !(
        this.options.available?.(command.argv[0]!) ??
        !!Bun.which(command.argv[0]!)
      )
    )
      throw new Error("Install Hunk or configure its profile to view diffs");
    const workspace = this.workspace();
    const git = Bun.spawn({
      cmd: ["git", "rev-parse", "--is-inside-work-tree"],
      cwd: workspace.path,
      stdout: "pipe",
      stderr: "pipe",
    });
    const inside = await new Response(git.stdout).text();
    if ((await git.exited) !== 0 || inside.trim() !== "true")
      throw new Error("Diff review requires a Git working tree");
    let tab = workspace.tabs.find((t) =>
      t.panes.some((p) => p.kind === "hunk" && p.profile === profile),
    );
    if (!tab) {
      tab = preset("review");
      tab.name = staged ? "staged diff" : "working diff";
      tab.panes[0]!.profile = profile;
      workspace.tabs.push(tab);
    }
    const pane = tab.panes.find(
      (p) => p.kind === "hunk" && p.profile === profile,
    )!;
    workspace.activeTab = tab.id;
    tab.focused = pane.id;
    this.filesFocused = false;
    this.input.mode = "terminal";
    const runtime = this.runtimes.get(pane.id);
    if (runtime && runtime.host.phase !== "running") await this.stop(pane);
    if (!this.runtimes.has(pane.id)) await this.start(pane);
    this.draw();
  }
  async startInitial() {
    let project: { profiles?: Record<string, unknown> } = {};
    // Project-local command overrides always require the explicit Start action.
    try {
      project = JSON.parse(
        await readFile(join(this.workspace().path, ".under.json"), "utf8"),
      );
      if (project.profiles?.nvim) {
        this.message =
          "Project overrides Neovim: inspect .under.json, then Start focused pane";
        this.draw();
        return;
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        this.message = "Inspect invalid project config before starting tools";
        return;
      }
    }
    const p = this.tab().panes.find((p) => p.kind === "nvim");
    if (p) await this.start(p);
    const files = this.tab().panes.find((p) => p.kind === "yazi");
    if (files && !project.profiles?.yazi) {
      try {
        await this.start(files);
      } catch (e) {
        this.report(`Files fallback: ${String(e)}`);
      }
    }
  }
  private async bridge(w: Workspace) {
    let b = this.bridges.get(w.id);
    if (b) return b;
    b = new FileBridge();
    await b.start(async (path, line, column) => {
      if (this.shuttingDown) throw new Error("Under is shutting down");
      const e = this.editor(w);
      await e.runtime.editor!.openFile(path, line, column);
      this.state.active = w.id;
      w.activeTab = w.tabs.find((t) =>
        t.panes.some((p) => p.id === e.pane.id),
      )!.id;
      this.tab().focused = e.pane.id;
      this.filesFocused = false;
      if (!this.modal) this.input.mode = "terminal";
      this.message = `Opened ${displayName(basename(path))}`;
      this.draw();
    });
    this.bridges.set(w.id, b);
    return b;
  }
  private async helpers() {
    if (this.helperDir) return;
    this.helperDir = await mkdtemp(join(tmpdir(), "under-helper-"));
    const script = `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${fileURLToPath(new URL("./main.ts", import.meta.url)).replaceAll("'", "'\\''")}' open "$@"\n`;
    await writeFile(join(this.helperDir, "nvim"), script);
    await chmod(join(this.helperDir, "nvim"), 0o700);
  }
  start(pane: Pane): Promise<void> {
    if (this.starts.has(pane.id))
      return Promise.reject(new Error("Pane is starting"));
    const pending = this.startPane(pane).finally(() =>
      this.starts.delete(pane.id),
    );
    this.starts.set(pane.id, pending);
    return pending;
  }
  private async startPane(pane: Pane) {
    if (this.shuttingDown) throw new Error("Under is shutting down");
    if (this.runtimes.has(pane.id))
      throw new Error("Pane already started; stop it before restarting");
    const w = this.workspace();
    const { config, warnings } = loadConfig(w.path);
    this.config = config;
    const profile =
      pane.kind === "task"
        ? config.tasks[pane.profile]
        : config.profiles[pane.profile];
    if (!profile)
      throw new Error(
        `Configure ${pane.profile} in .under.json or the user config`,
      );
    if (!Bun.which(profile.argv[0]!))
      throw new Error(
        `Missing executable ${profile.argv[0]}; install it or configure its argv`,
      );
    if (!(await stat(w.path)).isDirectory())
      throw new Error(`Not a directory: ${w.path}`);
    await this.helpers();
    const bridge = await this.bridge(w);
    if (this.shuttingDown) throw new Error("Launch cancelled during shutdown");
    let command: Profile = {
      ...profile,
      env: {
        ...profile.env,
        UNDER_OPEN_SOCKET: bridge.path,
        EDITOR: join(this.helperDir, "nvim"),
        VISUAL: join(this.helperDir, "nvim"),
      },
    };
    if (pane.kind === "yazi") {
      const directory = await yaziConfig(
        join(this.helperDir, "nvim"),
        profile.env,
      );
      this.yaziDirectories.add(directory);
      command.env = { ...command.env, YAZI_CONFIG_HOME: directory };
    }
    if (pane.kind === "task" && config.tasks[pane.profile]?.shell)
      command = {
        ...command,
        argv: [process.env.SHELL || "/bin/sh", "-lc", profile.argv.join(" ")],
      };
    let host: PtyHost;
    let editor: Editor | undefined;
    if (pane.kind === "nvim") {
      editor = await Editor.launch(command, w.path);
      host = editor.host;
    } else host = new PtyHost(command, w.path);
    if (this.shuttingDown) {
      editor ? await editor.dispose() : await host.close();
      throw new Error("Launch cancelled during shutdown");
    }
    const { frame } = this.attachTerminal(pane, host, editor);
    if (editor) {
      try {
        await editor.ready();
      } catch (e) {
        await editor.dispose();
        this.runtimes.delete(pane.id);
        frame.destroyRecursively();
        throw e;
      }
    }
    this.message = warnings.join(" | ") || `Started ${pane.profile}`;
  }
  /** Attach a PTY adapter; deterministic previews use the same production pane. */
  attachTerminal(pane: Pane, host: PaneHost, editor?: PaneEditor) {
    const frame = new BoxRenderable(this.renderer, {
      id: `frame-${pane.id}`,
      position: "absolute",
      border: true,
      borderColor: this.config.accent,
      flexDirection: "column",
      overflow: "hidden",
    });
    const title = new TextRenderable(this.renderer, {
      id: `title-${pane.id}`,
      height: 1,
      flexShrink: 0,
      fg: this.config.accent,
    });
    const view = new EmbeddedTerminalRenderable(this.renderer, {
      id: pane.id,
      width: "100%",
      flexGrow: 1,
      minHeight: 1,
      maxScrollback: 5000,
      onData: (bytes, source) =>
        host.write(source === "response" ? terminalResponse(bytes) : bytes),
      onTerminalResize: (cols, rows) => host.resize(cols, rows),
      onMouseDown: () => {
        if (!this.modal) {
          this.tab().focused = pane.id;
          this.filesFocused = false;
          this.input.mode = "terminal";
          this.draw();
        }
      },
    });
    frame.add(title);
    frame.add(view);
    this.renderer.root.add(frame);
    this.runtimes.set(pane.id, { host, editor, frame, title, view });
    // Yazi may finish launching after the user has focused the fallback list.
    // Transfer that focus along with the visible browser, preserving modal input.
    if (
      pane.kind === "yazi" &&
      this.filesFocused &&
      this.tab().panes.some((p) => p.id === pane.id)
    ) {
      this.tab().focused = pane.id;
      this.filesFocused = false;
      if (!this.modal) this.input.mode = "terminal";
    }
    host.attach((bytes) => view.write(bytes));
    this.draw();
    return { frame, view };
  }
  private async stop(pane: Pane) {
    const r = this.runtimes.get(pane.id);
    if (!r) return;
    if (r.editor && r.host.phase === "running") await r.editor.quit();
    r.editor ? await r.editor.dispose() : await r.host.close();
    this.runtimes.delete(pane.id);
    r.frame.destroyRecursively();
    this.draw();
  }
  private async add(
    kind: Pane["kind"],
    profile: string = kind,
    axis: "row" | "column" = "row",
  ) {
    const tab = this.tab(),
      pane = createPane(kind, profile);
    tab.panes.push(pane);
    tab.layout = split(tab.layout, tab.focused, pane.id, axis);
    tab.focused = pane.id;
    this.draw();
    await this.start(pane);
    this.input.mode = "terminal";
    this.draw();
  }
  private async startAgent(profile: string) {
    const existing = this.tab().panes.find(
      (p) => p.kind === "agent" && !this.runtimes.has(p.id),
    );
    this.chatHidden = false;
    this.filesFocused = false;
    if (!existing) {
      await this.add("agent", profile);
      return;
    }
    existing.profile = profile;
    this.tab().focused = existing.id;
    this.input.mode = "terminal";
    this.draw();
    await this.start(existing);
  }
  private commands(): Command[] {
    const cmd = (name: string, action: Command["action"]) => ({ name, action });
    const commands: Command[] = [
      cmd("Start focused pane", () =>
        this.start(this.tab().panes.find((p) => p.id === this.tab().focused)!),
      ),
      cmd("Stop focused pane", () =>
        this.stop(this.tab().panes.find((p) => p.id === this.tab().focused)!),
      ),
      cmd("Restart focused pane", async () => {
        const p = this.tab().panes.find((p) => p.id === this.tab().focused)!;
        await this.stop(p);
        await this.start(p);
      }),
      cmd("Open file in Neovim", () =>
        this.ask("File path", async (text) => {
          const editor = this.editor();
          await editor.runtime.editor!.openFile(
            resolve(this.workspace().path, text),
          );
          this.workspace().activeTab = this.workspace().tabs.find((t) =>
            t.panes.some((p) => p.id === editor.pane.id),
          )!.id;
          this.tab().focused = editor.pane.id;
          this.filesFocused = false;
          this.input.mode = "terminal";
          this.draw();
        }),
      ),
      cmd("Add Neovim", () => this.add("nvim")),
      cmd("Add Yazi", () => this.openYazi()),
      cmd("Working tree diff", () => this.openReview(false)),
      cmd("Staged diff", () => this.openReview(true)),
      cmd("Redraw terminals", () => repaint(this.renderer)),
      cmd("Add Hunk live review", () => this.add("hunk")),
      cmd("Add Hunk staged review", () => this.add("hunk", "hunk-staged")),
      cmd("Split right with shell", () => this.add("shell")),
      cmd("Split below with shell", () => this.add("shell", "shell", "column")),
      ...Object.keys(this.config.profiles)
        .filter(
          (k) => !["nvim", "yazi", "hunk", "hunk-staged", "shell"].includes(k),
        )
        .map((k) => cmd(`Start agent: ${k}`, () => this.startAgent(k))),
      ...Object.keys(this.config.tasks).map((k) =>
        cmd(
          `Run task: ${k}${this.config.tasks[k]?.shell ? " (shell command)" : ""}`,
          () => this.add("task", k),
        ),
      ),
      ...(["code", "review", "run"] as const).map((name) =>
        cmd(`New ${name} tab`, () => {
          const t = preset(name);
          this.workspace().tabs.push(t);
          this.workspace().activeTab = t.id;
          this.draw();
        }),
      ),
      cmd("Next tab", () => this.cycleTab()),
      cmd("Next workspace", () => this.cycleWorkspace()),
      cmd("Close current tab", async () => {
        const w = this.workspace(),
          t = this.tab();
        if (w.tabs.length === 1)
          throw new Error("Use Close workspace or Quit for the last tab");
        await this.checkEditors(t.panes);
        for (const p of t.panes) await this.stop(p);
        w.tabs = w.tabs.filter((x) => x.id !== t.id);
        w.activeTab = w.tabs[0]!.id;
        this.draw();
      }),
      cmd("Close current workspace", async () => {
        if (this.state.workspaces.length === 1)
          throw new Error("Use Quit for the last workspace");
        const w = this.workspace();
        const panes = w.tabs.flatMap((t) => t.panes);
        await this.checkEditors(panes);
        for (const p of panes) await this.stop(p);
        await this.bridges.get(w.id)?.close();
        this.bridges.delete(w.id);
        this.state.workspaces = this.state.workspaces.filter(
          (x) => x.id !== w.id,
        );
        this.state.active = this.state.workspaces[0]!.id;
        this.draw();
      }),
      cmd("Open workspace", () =>
        this.ask("Directory path", async (text) => {
          const path = resolve(this.workspace().path, text);
          if (!(await stat(path)).isDirectory())
            throw new Error("Not a directory");
          const w = createWorkspace(path);
          this.state.workspaces.push(w);
          this.state.active = w.id;
          this.config = loadConfig(path).config;
          this.draw();
        }),
      ),
      cmd("Move pane to new tab", () => {
        const t = this.tab();
        if (t.panes.length < 2) throw new Error("Split first");
        const p = t.panes.find((p) => p.id === t.focused)!;
        t.layout = remove(t.layout, p.id)!;
        t.panes = t.panes.filter((x) => x.id !== p.id);
        t.focused = t.panes[0]!.id;
        const n = preset("run");
        n.panes = [p];
        n.layout = leaf(p);
        n.focused = p.id;
        n.name = p.profile;
        this.workspace().tabs.push(n);
        this.workspace().activeTab = n.id;
        this.draw();
      }),
      cmd("Close focused pane", async () => {
        const t = this.tab();
        if (t.panes.length === 1)
          throw new Error("Use Quit to close the last pane");
        const p = t.panes.find((p) => p.id === t.focused)!;
        await this.stop(p);
        t.panes = t.panes.filter((x) => x.id !== p.id);
        t.layout = remove(t.layout, p.id)!;
        t.focused = t.panes[0]!.id;
        this.draw();
      }),
      cmd("Toggle zoom", () => {
        this.tab().zoom = !this.tab().zoom;
        this.draw();
      }),
      cmd("Grow focused pane", () => {
        this.tab().layout = resize(this.tab().layout, this.tab().focused, 0.05);
        this.draw();
      }),
      cmd("Shrink focused pane", () => {
        this.tab().layout = resize(
          this.tab().layout,
          this.tab().focused,
          -0.05,
        );
        this.draw();
      }),
      cmd("Refresh files", () => this.refreshFiles()),
      cmd("Focus files", () => this.focusFiles()),
      cmd("Toggle chat", () => {
        this.chatHidden = !this.chatHidden;
        this.draw();
      }),
      cmd("Toggle sidebar", () => {
        this.side = !this.side;
        if (!this.side) this.filesFocused = false;
        this.draw();
      }),
      ...(["file", "selection", "diagnostics"] as const).map((k) =>
        cmd(`Preview ${k} context for agent`, () => this.preview(k)),
      ),
      cmd("Preview current file diff for agent", () => this.preview("diff")),
      cmd("Save workspace layout", () => saveState(statePath(), this.state)),
      cmd("Reload configuration", () => {
        const l = loadConfig(this.workspace().path);
        this.config = l.config;
        this.input.prefix = l.config.prefix;
        this.message =
          l.warnings.join(" | ") ||
          "Configuration reloaded; new panes use new profiles";
        this.draw();
      }),
      cmd("Shortcut help", () => this.help()),
      cmd("Quit Under", () => this.shutdown()),
    ];
    const runtime = this.activeRuntime();
    for (const command of commands) {
      if (command.name === "Start focused pane" && runtime)
        command.disabled = "Already started; choose Restart";
      if (command.name === "Stop focused pane" && !runtime)
        command.disabled = "This pane is not running";
      if (command.name === "Toggle sidebar") command.checked = this.side;
      if (command.name === "Toggle chat") command.checked = !this.chatHidden;
      if (command.name === "Toggle zoom") command.checked = this.tab().zoom;
      if (command.name.startsWith("Start agent:")) {
        const profile = this.config.profiles[command.name.slice(13)];
        if (
          !profile ||
          !(this.options.available ?? Bun.which)(profile.argv[0]!)
        )
          command.disabled = `Install ${profile?.argv[0] ?? "agent CLI"} or configure its profile`;
      }
      if (
        (this.actionPending || this.starts.size) &&
        !["Quit Under", "Shortcut help"].includes(command.name)
      )
        command.disabled = "A tool/action is starting; wait for completion";
    }
    return commands;
  }
  private ask(title: string, submit: Modal["submit"]) {
    this.openModal({
      kind: "input",
      title,
      text: "",
      index: 0,
      submit,
      cancelMode: "app",
    });
  }
  private async checkEditors(panes: Pane[]) {
    for (const pane of panes) {
      const r = this.runtimes.get(pane.id);
      if (
        r?.editor &&
        r.host.phase === "running" &&
        (await r.editor.modified()).length
      )
        throw new Error("Save modified buffers before closing this layout");
    }
  }
  private help() {
    this.openModal({
      kind: "help",
      title: "Under shortcuts",
      text: `${this.input.prefix}: application navigation\nPrefix twice: forward literal prefix\nEscape: return to terminal / dismiss modal\nm: top menu  p: command palette  Tab/j/k: cycle panes\nf: files (native Yazi keys; fallback arrows/j/k/Enter)\nr: working tree diff  s: staged diff  l: redraw\nEnter on idle chat: choose and start agent\nt: next tab  w: next workspace  z: zoom\n[ / ]: resize focused split  b: sidebar\nq: safe quit\n\nUse the palette to start tools, open files, run tasks,\nmove panes and preview context.\nNative terminal keys remain owned by the focused tool.`,
      index: 0,
      cancelMode: "app",
    });
  }
  private async preview(kind: ContextKind | "diff") {
    const editor = this.editor().runtime.editor!;
    const snapshot = await editor.snapshot();
    const cwd = this.workspace().path;
    const diff =
      kind === "diff" ? await fileDiff(cwd, snapshot.path) : undefined;
    if (diff === "") throw new Error("No unstaged diff for the current file");
    const text =
      diff !== undefined
        ? `Working tree diff (disk content, not unsaved buffer): ${snapshot.path}\n\n${diff}`
        : contextText(snapshot, kind as ContextKind);
    const target = this.tab().panes.find(
      (p) =>
        p.kind === "agent" && this.runtimes.get(p.id)?.host.phase === "running",
    );
    if (!target) throw new Error("Start an agent in the current tab first");
    this.openModal({
      kind: "preview",
      title: `Context for ${target.profile} — Enter pastes; submit in native CLI`,
      text,
      index: 0,
      snapshot,
      editor,
      cancelMode: "app",
      submit: async () => {
        if (!sameSnapshot(snapshot, await editor.snapshot()))
          throw new Error("Editor context changed; generate a new preview");
        if (diff !== undefined && diff !== (await fileDiff(cwd, snapshot.path)))
          throw new Error("Diff changed; generate a new preview");
        const r = this.runtimes.get(target.id);
        if (!r || r.host.phase !== "running")
          throw new Error("Target agent is no longer running");
        r.host.write(r.view.encodePaste(new TextEncoder().encode(text)));
        this.tab().focused = target.id;
        this.input.mode = "terminal";
        this.message = "Context pasted. Review and submit in the agent CLI.";
      },
    });
  }
  private openModal(modal: Modal) {
    modal.cancelMode = this.input.mode === "terminal" ? "terminal" : "app";
    this.modal = modal;
    this.input.mode = "modal";
    this.activeRuntime()?.view.blur();
    this.draw();
  }
  private closeModal() {
    const previous = this.modal?.cancelMode ?? "app";
    this.modal = undefined;
    this.input.mode = previous;
    this.draw();
  }
  private palette() {
    this.openModal({
      kind: "palette",
      title: "Commands",
      text: "",
      index: 0,
      cancelMode: "app",
    });
  }
  private openMenu(label: MenuLabel) {
    const cancelMode =
      this.modal?.cancelMode ??
      (this.input.mode === "terminal" ? "terminal" : "app");
    this.openModal({
      kind: "menu",
      menu: label,
      title: label,
      text: "",
      index: 0,
      cancelMode,
    });
    this.modal!.cancelMode = cancelMode;
  }
  private choices() {
    return this.commands().filter((c) => {
      if (this.modal?.kind !== "menu")
        return c.name
          .toLowerCase()
          .includes(this.modal?.text.toLowerCase() ?? "");
      const label = this.modal.menu;
      if (label === "File")
        return /^(Open |New |Next |Close current|Save |Quit)/.test(c.name);
      if (label === "View")
        return /^(Toggle |Grow |Shrink |Move |Close focused|Focus files|Refresh files)/.test(
          c.name,
        );
      if (label === "Review")
        return /^(Working tree diff|Staged diff)$/.test(c.name);
      if (label === "Tools")
        return /^(Start focused|Stop |Restart |Add |Split |Run task|Reload|Redraw)/.test(
          c.name,
        );
      if (label === "Agent") return /^(Start agent|Preview )/.test(c.name);
      return c.name === "Shortcut help" || c.name === "Reload configuration";
    });
  }
  private modalLines() {
    const m = this.modal;
    if (!m) return [];
    if (m.kind === "palette" || m.kind === "menu")
      return this.choices().map(
        (c, i) =>
          `${i === m.index ? "›" : " "} ${c.checked === undefined ? "" : c.checked ? "[✓] " : "[ ] "}${c.name}${c.disabled ? " (unavailable)" : ""}`,
      );
    if (m.kind === "input") return [];
    return wrapText(m.text, Math.max(1, this.renderer.width - 2));
  }
  private cycleTab() {
    const w = this.workspace();
    w.activeTab =
      w.tabs[
        (w.tabs.findIndex((t) => t.id === w.activeTab) + 1) % w.tabs.length
      ]!.id;
    this.draw();
  }
  private cycleWorkspace() {
    this.state.active =
      this.state.workspaces[
        (this.state.workspaces.findIndex((w) => w.id === this.state.active) +
          1) %
          this.state.workspaces.length
      ]!.id;
    this.config = loadConfig(this.workspace().path).config;
    this.draw();
  }
  private run(action: Command["action"], allowPending = false) {
    if (
      this.shuttingDown ||
      (!allowPending && (this.actionPending || this.starts.size))
    ) {
      this.message = "An action is already pending";
      return;
    }
    this.actionPending = true;
    Promise.resolve()
      .then(action)
      .catch((e) => {
        this.message = String(e);
        this.draw();
      })
      .finally(() => {
        this.actionPending = false;
      });
  }
  private onPaste = (event: PasteEvent) => {
    if (this.input.mode !== "terminal") {
      event.preventDefault();
      event.stopPropagation();
      if (this.modal?.kind === "input" || this.modal?.kind === "palette") {
        const text = new TextDecoder()
          .decode(event.bytes)
          .replace(/[\x00-\x1f\x7f]/g, "");
        if (Buffer.byteLength(this.modal.text + text) <= 16384)
          this.modal.text += text;
        this.draw();
      }
    }
  };
  private onKey = (key: KeyEvent) => {
    const decision = this.input.handle(key);
    if (decision === "forward") {
      if (!this.activeRuntime() && ["return", "enter"].includes(key.name)) {
        key.preventDefault();
        key.stopPropagation();
        if (
          this.tab().panes.find((p) => p.id === this.tab().focused)?.kind ===
          "agent"
        )
          this.openMenu("Agent");
        else
          this.run(() =>
            this.start(
              this.tab().panes.find((p) => p.id === this.tab().focused)!,
            ),
          );
      }
      return;
    }
    key.preventDefault();
    key.stopPropagation();
    if (this.input.mode === "terminal") this.filesFocused = false;
    if (decision === "literal") {
      this.activeRuntime()?.host.write(this.input.literal());
      this.draw();
      return;
    }
    if (this.modal) {
      const m = this.modal;
      if (key.name === "escape") {
        this.closeModal();
        return;
      }
      if (m.kind === "menu" && ["left", "right"].includes(key.name)) {
        const index = MENU_LABELS.indexOf(m.menu!);
        this.openMenu(
          MENU_LABELS[
            (index + (key.name === "right" ? 1 : -1) + MENU_LABELS.length) %
              MENU_LABELS.length
          ]!,
        );
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        if (m.kind === "palette" || m.kind === "menu") {
          const c = this.choices()[m.index];
          if (c?.disabled) {
            this.report(c.disabled);
            return;
          }
          this.closeModal();
          if (c)
            this.run(
              c.action,
              c.name === "Quit Under" || c.name === "Shortcut help",
            );
        } else if (m.submit) {
          this.closeModal();
          this.run(() => m.submit!(m.text));
        } else this.closeModal();
      } else if (["up", "down", "pageup", "pagedown"].includes(key.name)) {
        const delta =
          key.name === "up"
            ? -1
            : key.name === "down"
              ? 1
              : key.name === "pageup"
                ? -10
                : 10;
        m.index = Math.max(
          0,
          Math.min(
            m.index + delta,
            m.kind === "palette" || m.kind === "menu"
              ? Math.max(0, this.choices().length - 1)
              : Math.max(0, this.modalLines().length - 1),
          ),
        );
      } else if (m.kind === "input" || m.kind === "palette") {
        if (key.name === "backspace")
          m.text = [...m.text].slice(0, -1).join("");
        else if (
          !key.ctrl &&
          !key.meta &&
          key.sequence &&
          m.text.length < 16384 &&
          [...key.sequence].every((c) => c >= " " && c !== "\x7f")
        )
          m.text += key.sequence;
        m.index = 0;
      }
      this.draw();
      return;
    }
    if (this.input.mode === "app") {
      this.activeRuntime()?.view.blur();
      const t = this.tab();
      if (
        this.filesFocused &&
        !["tab", "m", "p", "f", "b"].includes(key.name)
      ) {
        if (["j", "down"].includes(key.name)) this.fileBrowser().move(1);
        if (["k", "up"].includes(key.name)) this.fileBrowser().move(-1);
        if (["enter", "return", "right"].includes(key.name))
          this.run(() => this.openSelectedFile());
        if (key.name === "r") this.run(() => this.refreshFiles());
        if (key.name === "left")
          this.run(async () => {
            const browser = this.fileBrowser();
            if (browser.directory !== browser.root)
              await browser.load(resolve(browser.directory, ".."));
            this.draw();
          });
        this.draw();
        return;
      }
      if (key.name === "tab" && this.filesFocused) {
        this.filesFocused = false;
        this.draw();
        return;
      }
      if (["tab", "j", "k"].includes(key.name)) {
        this.filesFocused = false;
        const step = key.name === "k" || key.shift ? -1 : 1;
        t.focused =
          t.panes[
            (t.panes.findIndex((p) => p.id === t.focused) +
              step +
              t.panes.length) %
              t.panes.length
          ]!.id;
      } else if (key.name === "m") this.openMenu("File");
      else if (key.name === "f") this.focusFiles();
      else if (key.name === "r") this.run(() => this.openReview(false));
      else if (key.name === "s") this.run(() => this.openReview(true));
      else if (key.name === "l") repaint(this.renderer);
      else if (["return", "enter"].includes(key.name)) {
        const pane = t.panes.find((p) => p.id === t.focused)!;
        if (pane.kind === "agent" && !this.activeRuntime())
          this.openMenu("Agent");
        else {
          this.input.mode = "terminal";
          this.filesFocused = false;
        }
      } else if (key.name === "p") this.palette();
      else if (key.name === "t") this.cycleTab();
      else if (key.name === "w") this.cycleWorkspace();
      else if (key.name === "z") t.zoom = !t.zoom;
      else if (key.name === "b") {
        this.side = !this.side;
        if (!this.side) this.filesFocused = false;
      } else if (key.name === "[")
        t.layout = resize(t.layout, t.focused, -0.05);
      else if (key.name === "]") t.layout = resize(t.layout, t.focused, 0.05);
      else if (key.name === "q") this.run(() => this.shutdown(), true);
      else if (key.name === "?") this.help();
    }
    this.draw();
  };
  draw = () => {
    if (this.disposed) return;
    const width = this.renderer.width,
      height = this.renderer.height,
      w = this.workspace(),
      t = this.tab();
    const navbar = menuSlots(width);
    for (const [index, slot] of navbar.slots.entries()) {
      const button = this.menuButtons[index]!;
      button.left = slot.x;
      button.top = slot.y;
      button.width = slot.width;
      button.fg =
        this.modal?.menu === slot.label
          ? this.config.accent
          : this.config.foreground;
    }
    const top = navbar.height + 1;
    const nativeFiles = t.panes.find(
      (p) =>
        p.kind === "yazi" && this.runtimes.get(p.id)?.host.phase === "running",
    );
    if (!this.side && t.panes.find((p) => p.id === t.focused)?.kind === "yazi")
      t.focused = t.panes.find((p) => p.kind !== "yazi")?.id ?? t.focused;
    const side =
      !nativeFiles && this.side && (width >= 80 || this.filesFocused) && !t.zoom
        ? Math.min(24, width)
        : 0;
    this.header.top = navbar.height;
    this.header.width = width;
    this.header.content = ` under_  ${displayName(basename(w.path))}  | ${w.tabs.map((x) => `${x.id === t.id ? "•" : " "}${x.name}`).join("  ")}`;
    this.sidebar.visible = side > 0;
    this.sidebar.top = top;
    this.sidebar.width = side;
    this.sidebar.height = Math.max(1, height - top - 1);
    const browser = this.fileBrowser();
    const fileRows = Math.max(1, this.sidebar.height - 4);
    const fileStart = Math.max(0, browser.selected - fileRows + 1);
    this.sidebar.fg = this.filesFocused
      ? this.config.accent
      : this.config.foreground;
    this.sidebar.content =
      ` Files · ${this.filesFocused ? "FOCUS" : "Ctrl-G f"}\n ${displayName(basename(browser.directory))}/\n` +
      (browser.loading
        ? " Loading…"
        : browser.error
          ? " Cannot read directory\n Refresh: Ctrl-G f, r"
          : browser.entries.length
            ? browser.entries
                .slice(fileStart, fileStart + fileRows)
                .map(
                  (entry, i) =>
                    `${i + fileStart === browser.selected ? "›" : " "} ${entry.directory ? "▸ " : "  "}${displayName(entry.name)}`,
                )
                .join("\n")
            : " Empty directory") +
      "\n\n Enter open · r reload";
    this.footer.top = Math.max(0, height - 1);
    this.footer.width = width;
    this.footer.content = `${this.filesFocused && this.input.mode === "app" ? "FILES" : this.input.mode.toUpperCase()} | ${width < 80 ? "Ctrl-G f: files · Tab: panes | " : ""}${this.message.replace(/[\x00-\x1f\x7f]/g, " ")}`;
    const rect = {
      x: side,
      y: top,
      width: Math.max(1, width - side),
      height: Math.max(1, height - top - 1),
    };
    const layout =
      t.zoom || width < 60 || height < 12 ? { pane: t.focused } : t.layout;
    let visibleLayout = layout;
    for (const p of t.panes.filter((p) => p.kind === "yazi")) {
      if (
        this.runtimes.get(p.id)?.host.phase !== "running" ||
        !this.side ||
        (width < 80 && t.focused !== p.id)
      )
        visibleLayout = remove(visibleLayout, p.id) ?? visibleLayout;
    }
    if (this.chatHidden && !t.zoom) {
      for (const p of t.panes.filter((p) => p.kind === "agent"))
        visibleLayout = remove(visibleLayout, p.id) ?? visibleLayout;
      if (t.panes.find((p) => p.id === t.focused)?.kind === "agent")
        t.focused = t.panes.find((p) => p.kind !== "agent")?.id ?? t.focused;
    }
    let cells =
      side >= width
        ? new Map<string, import("./model.ts").Rect>()
        : rectangles(visibleLayout, rect);
    if (!cells.has(t.focused) && side < width)
      cells = new Map([[t.focused, rect]]);
    const allPaneIds = new Set(
      this.state.workspaces.flatMap((w) =>
        w.tabs.flatMap((t) => t.panes.map((p) => p.id)),
      ),
    );
    for (const [id, placeholder] of this.placeholders)
      if (!allPaneIds.has(id)) {
        placeholder.frame.destroyRecursively();
        this.placeholders.delete(id);
      }
    for (const placeholder of this.placeholders.values())
      placeholder.frame.visible = false;
    for (const [id, cell] of cells) {
      if (this.runtimes.has(id)) continue;
      let placeholder = this.placeholders.get(id);
      if (!placeholder) {
        const frame = new BoxRenderable(this.renderer, {
          id: `placeholder-${id}`,
          position: "absolute",
          border: true,
          borderColor: this.config.accent,
        });
        const text = new TextRenderable(this.renderer, {
          id: `placeholder-text-${id}`,
          fg: this.config.foreground,
        });
        frame.add(text);
        this.renderer.root.add(frame);
        placeholder = { frame, text };
        this.placeholders.set(id, placeholder);
      }
      placeholder.frame.visible = true;
      placeholder.frame.left = cell.x;
      placeholder.frame.top = cell.y;
      placeholder.frame.width = cell.width;
      placeholder.frame.height = cell.height;
      const p = t.panes.find((p) => p.id === id)!;
      placeholder.text.content =
        p.kind === "agent"
          ? ` Agent chat\n\n Choose provider\n Codex · Claude\n OpenCode · custom\n\n [ Start agent ]\n Click or Ctrl-G Enter\n\n Native CLI login\n and permissions`
          : `${p.profile} · not started\n\nClick then Enter\nto start\n\n${this.input.prefix}, m: menu`;
      placeholder.frame.onMouseDown = (event) => {
        event.stopPropagation();
        if (!this.modal) {
          t.focused = id;
          this.filesFocused = false;
          this.input.mode = "terminal";
          if (p.kind === "agent") this.openMenu("Agent");
          else this.draw();
        }
      };
    }
    for (const [id, r] of this.runtimes) {
      const cell = cells.get(id);
      r.frame.visible = !!cell;
      if (!cell) {
        r.view.blur();
        continue;
      }
      r.frame.left = cell.x;
      r.frame.top = cell.y;
      r.frame.width = cell.width;
      r.frame.height = cell.height;
      r.frame.borderColor = id === t.focused ? this.config.accent : "#3a3a44";
      const pane = t.panes.find((p) => p.id === id)!;
      r.title.content = `${pane.profile} [${r.host.phase}${r.host.exitCode !== null ? `:${r.host.exitCode}` : ""}]`;
      if (
        id === t.focused &&
        this.input.mode === "terminal" &&
        !this.filesFocused
      )
        r.view.focus();
      else r.view.blur();
    }
    // A dormant pane is visible as a placeholder, without executing anything.
    this.overlay.visible = !!this.modal;
    if (this.modal) {
      const m = this.modal;
      const isMenu = m.kind === "menu";
      const slot = navbar.slots.find((slot) => slot.label === m.menu);
      this.overlay.width = isMenu ? Math.max(1, Math.min(48, width)) : width;
      this.overlay.left = isMenu
        ? Math.max(0, Math.min(slot?.x ?? 0, width - this.overlay.width))
        : 0;
      this.overlay.top = navbar.height;
      this.overlay.height = Math.max(
        1,
        isMenu
          ? Math.min(this.choices().length + 4, height - navbar.height - 1)
          : height - navbar.height - 1,
      );
      const rows = Math.max(
        1,
        this.overlay.height -
          (m.kind === "palette" || m.kind === "input" ? 5 : 4),
      );
      const lines = this.modalLines();
      const start =
        m.kind === "palette" || isMenu
          ? Math.max(0, m.index - rows + 1)
          : Math.min(m.index, Math.max(0, lines.length - rows));
      this.menuStart = start;
      this.overlayText.content = `${m.title}\n${m.kind === "palette" || m.kind === "input" ? "> " + m.text + "\n" : ""}${lines.slice(start, start + rows).join("\n")}\n${isMenu ? (this.overlay.width < 40 ? "←→ menu · ↑↓ Enter Esc" : "←→ menu · ↑↓ select · Enter · Esc") : this.overlay.width < 40 ? "↑↓ scroll · Enter · Esc" : "Esc cancel · ↑↓ scroll · Enter select"}`;
    }
  };
  async shutdown(force = false): Promise<void> {
    if (this.shutdownPromise)
      return force
        ? this.shutdownPromise.catch(() => this.shutdown(true))
        : this.shutdownPromise;
    this.shuttingDown = true;
    for (const id of this.starts.keys())
      this.runtimes.get(id)?.editor?.abortInitialization();
    this.shutdownPromise = (async () => {
      await Promise.allSettled(this.starts.values());
      try {
        await saveState(statePath(), this.state);
      } catch (e) {
        // A persistence failure must never prevent forced resource cleanup.
        if (!force) throw e;
        this.message = `Layout could not be saved: ${String(e)}`;
      }
      if (!force) {
        for (const r of this.runtimes.values())
          if (r.editor && r.host.phase === "running") {
            const modified = await r.editor.modified();
            if (modified.length)
              throw new Error(
                `Save modified buffers before quitting: ${modified.join(", ")}`,
              );
          }
        // Quit editors before touching any other tools. A refused quit preserves agents.
        for (const r of this.runtimes.values())
          if (r.editor && r.host.phase === "running") await r.editor.quit();
      }
      const errors: unknown[] = [];
      for (const r of this.runtimes.values()) {
        try {
          r.editor ? await r.editor.dispose() : await r.host.close();
        } catch (e) {
          errors.push(e);
        }
      }
      for (const b of this.bridges.values()) await b.close();
      if (this.helperDir)
        await rm(this.helperDir, { recursive: true, force: true });
      for (const directory of this.yaziDirectories)
        await rm(directory, { recursive: true, force: true });
      this.yaziDirectories.clear();
      this.disposeUI();
      if (errors.length)
        throw new AggregateError(errors, "Process cleanup failed");
    })().catch((e) => {
      this.shuttingDown = false;
      this.shutdownPromise = undefined;
      throw e;
    });
    return this.shutdownPromise;
  }
  disposeUI() {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    this.renderer.keyInput.off("keypress", this.onKey);
    this.renderer.keyInput.off("paste", this.onPaste);
    this.renderer.off("resize", this.draw);
    this.renderer.destroy();
  }
}
