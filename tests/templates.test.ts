import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { App, type PaneEditor, type PaneHost } from "../src/app.ts";
import { defaults } from "../src/config.ts";
import {
  applyTemplate,
  paneOrder,
  preset,
  TEMPLATE_ORDER,
  TEMPLATES,
  type Layout,
} from "../src/model.ts";

const running = (): PaneHost => ({
  phase: "running",
  exitCode: null,
  write() {},
  resize() {},
  attach() {},
  async close() {},
});
const kinds = (tab: { panes: { kind: string }[] }) =>
  tab.panes.map((pane) => pane.kind);
const leaves = (layout: Layout) => paneOrder(layout);

test("every template is complete and preset() builds it in slot order", () => {
  for (const name of TEMPLATE_ORDER) {
    const template = TEMPLATES[name];
    const tab = preset(name);
    expect(tab.template).toBe(name);
    expect(tab.panes).toHaveLength(template.slots.length);
    expect(tab.focused).toBe(tab.panes[template.focus]!.id);
    // The layout references every slot exactly once.
    const ids = leaves(tab.layout);
    expect([...ids].sort()).toEqual(tab.panes.map((p) => p.id).sort());
    expect(new Set(ids).size).toBe(ids.length);
  }
});

test("the default code template keeps its historical composition", () => {
  const tab = preset("code");
  expect(kinds(tab)).toEqual(["nvim", "agent", "yazi"]);
  expect(tab.panes[1]!.profile).toBe("codex");
  expect(tab.focused).toBe(tab.panes[0]!.id);
  const layout = tab.layout as Extract<Layout, { axis: string }>;
  expect(layout).toMatchObject({ axis: "row", ratio: 0.26 });
  expect(leaves(layout)).toEqual([
    tab.panes[2]!.id,
    tab.panes[0]!.id,
    tab.panes[1]!.id,
  ]);
});

test("applying a template shows and hides panes without recreating them", () => {
  const tab = preset("code");
  const [editor, chat, files] = tab.panes;
  applyTemplate(tab, "chat");
  expect(tab.template).toBe("chat");
  // Hidden panes stay in the tab, untouched.
  expect(tab.panes).toHaveLength(3);
  expect(leaves(tab.layout)).toEqual([chat!.id]);
  expect(tab.focused).toBe(chat!.id);
  // Going back reuses the very same panes, so state such as a chat thread and
  // unsaved editor buffers survives.
  applyTemplate(tab, "code");
  expect(tab.panes).toHaveLength(3);
  expect(tab.panes[0]).toBe(editor!);
  expect(tab.panes[1]).toBe(chat!);
  expect(tab.panes[2]).toBe(files!);
  expect(leaves(tab.layout)).toEqual([files!.id, editor!.id, chat!.id]);
});

test("a template that needs an absent pane adds a stopped placeholder only", () => {
  const tab = preset("editor");
  const before = tab.panes.length;
  applyTemplate(tab, "review");
  expect(tab.panes).toHaveLength(before + 2);
  const added = tab.panes.slice(before).map((pane) => pane.kind);
  expect(added).toEqual(["hunk", "agent"]);
  expect(leaves(tab.layout)).toEqual([
    tab.panes[before]!.id,
    tab.panes[before + 1]!.id,
  ]);
  // Reusing the same kinds later does not add more panes.
  applyTemplate(tab, "files-review");
  expect(tab.panes).toHaveLength(before + 3);
});

test("a template reuses a hidden pane of the right kind instead of adding one", () => {
  const tab = preset("code");
  applyTemplate(tab, "editor"); // hides files and chat
  const editor = tab.panes[0]!;
  applyTemplate(tab, "files-editor");
  expect(tab.panes).toHaveLength(3);
  expect(tab.panes[0]).toBe(editor);
  expect(leaves(tab.layout)).toEqual([tab.panes[2]!.id, editor.id]);
});

test("the digit shortcut applies a layout by hiding panes and keeping them running", async () => {
  const setup = await createTestRenderer({ width: 120, height: 30 });
  const app = new App(setup.renderer, "/fixtures/project", undefined, {
    config: defaults,
    files: [],
  });
  const closed: string[] = [];
  const host = (id: string): PaneHost => ({
    ...running(),
    async close() {
      closed.push(id);
    },
  });
  const [editor, chat, files] = app.tab().panes;
  try {
    app.attachTerminal(editor!, host("editor"));
    app.attachTerminal(chat!, host("chat"));
    app.attachTerminal(files!, host("files"));
    await setup.flush();
    expect(
      (setup.renderer.root.findDescendantById(`frame-${files!.id}`) as { visible: boolean })
        .visible,
    ).toBe(true);

    setup.mockInput.pressKey("g", { ctrl: true });
    setup.mockInput.pressKey("1"); // Layout: chat
    await setup.flush();
    expect(app.tab().template).toBe("chat");
    expect(leaves(app.tab().layout)).toEqual([chat!.id]);
    expect(app.tab().focused).toBe(chat!.id);
    for (const pane of [editor!, files!])
      expect(
        (setup.renderer.root.findDescendantById(`frame-${pane.id}`) as { visible: boolean })
          .visible,
      ).toBe(false);
    // Hiding is not stopping: nothing was closed and every pane still runs.
    expect(closed).toEqual([]);
    expect(app.tab().panes.map((p) => p.id)).toEqual([
      editor!.id,
      chat!.id,
      files!.id,
    ]);

    // Going back shows them again, still the same panes and processes.
    setup.mockInput.pressKey("2"); // Layout: code
    await setup.flush();
    for (const pane of [editor!, chat!, files!])
      expect(
        (setup.renderer.root.findDescendantById(`frame-${pane.id}`) as { visible: boolean })
          .visible,
      ).toBe(true);
    expect(closed).toEqual([]);
  } finally {
    app.disposeUI();
    await setup.dispose();
  }
});

test("hiding and re-showing a pane keeps its live output and never quits the editor", async () => {
  const setup = await createTestRenderer({ width: 120, height: 30 });
  const app = new App(setup.renderer, "/fixtures/project", undefined, {
    config: defaults,
    files: [],
  });
  const calls: string[] = [];
  const editor: PaneEditor = {
    async snapshot() {
      return {
        path: "/fixtures/project/welcome.ts",
        lines: ["const greeting = 'Hello';"],
        cursor: [1, 0],
        changedtick: 1,
        modified: true,
        selection: [],
        diagnostics: [],
      };
    },
    async openFile() {},
    async ready() {},
    async modified() {
      calls.push("modified");
      return ["/fixtures/project/welcome.ts"];
    },
    async quit() {
      calls.push("quit");
    },
    async dispose() {},
    abortInitialization() {},
  };
  const [editorPane, chatPane, filesPane] = app.tab().panes;
  try {
    const editorView = app.attachTerminal(editorPane!, running(), editor).view;
    const chatView = app.attachTerminal(chatPane!, running()).view;
    app.attachTerminal(filesPane!, running());
    editorView.write("\x1b[2J\x1b[HUNSAVED=1");
    chatView.write("\x1b[2J\x1b[Hthread-so-far");
    await setup.flush();

    setup.mockInput.pressKey("g", { ctrl: true });
    setup.mockInput.pressKey("7"); // Layout: editor — hides the chat
    await setup.flush();
    expect(leaves(app.tab().layout)).toEqual([editorPane!.id]);
    setup.mockInput.pressKey("1"); // Layout: chat — hides the editor, shows the chat
    await setup.flush();
    expect(leaves(app.tab().layout)).toEqual([chatPane!.id]);
    expect(chatView.screen().text).toContain("thread-so-far");

    setup.mockInput.pressKey("2"); // Layout: code
    await setup.flush();
    expect(editorView.screen().text).toContain("UNSAVED=1");
    // Nothing was closed or reloaded, so no quit was attempted on the editor.
    expect(calls).toEqual([]);
  } finally {
    app.disposeUI();
    await setup.dispose();
  }
});

test("a template needing an absent kind shows a stopped placeholder", async () => {
  const setup = await createTestRenderer({ width: 120, height: 30 });
  const app = new App(setup.renderer, "/fixtures/project", undefined, {
    config: defaults,
    files: [],
  });
  try {
    app.attachTerminal(app.tab().panes[0]!, running());
    const before = app.tab().panes.length;
    setup.mockInput.pressKey("g", { ctrl: true });
    setup.mockInput.pressKey("4"); // Layout: review — hunk + chat
    await setup.flush();
    // The chat pane is reused; only the absent hunk pane is added.
    expect(app.tab().panes).toHaveLength(before + 1);
    expect(app.tab().panes[before]!.kind).toBe("hunk");
    const hunk = app.tab().panes.find((pane) => pane.kind === "hunk")!;
    expect(leaves(app.tab().layout)).toContain(hunk.id);
    // It exists as a placeholder and was never started.
    expect(
      setup.renderer.root.findDescendantById(`frame-${hunk.id}`),
    ).toBeFalsy();
    expect(setup.captureCharFrame()).toContain("hunk");
  } finally {
    app.disposeUI();
    await setup.dispose();
  }
});
