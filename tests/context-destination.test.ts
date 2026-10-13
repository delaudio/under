import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { App, type PaneEditor, type PaneHost } from "../src/app.ts";
import { defaults } from "../src/config.ts";
import { preset, type Tab } from "../src/model.ts";
import type { EditorSnapshot } from "../src/editor.ts";

const snapshot = (tick: number): EditorSnapshot => ({
  path: "/fixtures/project/welcome.ts",
  lines: [`const greeting = "v${tick}";`],
  cursor: [1, 0],
  changedtick: tick,
  modified: true,
  selection: [],
  diagnostics: [],
});

async function harness() {
  const setup = await createTestRenderer({ width: 120, height: 30 });
  const app = new App(setup.renderer, "/fixtures/project", undefined, {
    config: defaults,
    files: [],
  });
  const writes = new Map<string, string[]>();
  const hosts = new Map<string, PaneHost>();
  const host = (id: string): PaneHost => {
    const value: PaneHost = {
      phase: "running",
      exitCode: null,
      write(bytes) {
        writes.set(id, [...(writes.get(id) ?? []), new TextDecoder().decode(bytes)]);
      },
      resize() {},
      attach() {},
      async close() {},
    };
    hosts.set(id, value);
    return value;
  };
  let tick = 1;
  const editor: PaneEditor = {
    async snapshot() {
      return snapshot(tick);
    },
    async openFile() {},
    async ready() {},
    async modified() {
      return ["/fixtures/project/welcome.ts"];
    },
    async quit() {},
    async dispose() {},
    abortInitialization() {},
  };
  return {
    setup,
    app,
    writes,
    hosts,
    editor,
    host,
    bump: () => tick++,
    agentTab: () => {
      const tab: Tab = preset("editor-chat");
      app.workspace().tabs.push(tab);
      const pane = tab.panes.find((entry) => entry.kind === "agent")!;
      app.attachTerminal(pane, host(`agent-${app.workspace().tabs.length - 1}`));
      return { tab, pane, id: `agent-${app.workspace().tabs.length - 1}` };
    },
  };
}

test("a preview with several agents asks which one receives it and routes across tabs", async () => {
  const { setup, app, writes, editor, host, agentTab } = await harness();
  try {
    const first = app.workspace().tabs[0]!.panes.find((p) => p.kind === "agent")!;
    app.attachTerminal(app.tab().panes[0]!, host("editor"), editor);
    app.attachTerminal(first, host("agent-0"));
    const second = agentTab();
    await setup.flush();

    // Drive the real command path: palette -> Preview file context.
    setup.mockInput.pressKey("g", { ctrl: true });
    setup.mockInput.pressKey("p");
    await setup.flush();
    await setup.mockInput.typeText("Preview file context");
    setup.mockInput.pressEnter();
    await Bun.sleep(30);
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("Choose the agent");

    // Two agents share the profile, so the labels must still differ.
    const items = (app as any).agentItems().map((item: any) => item.name);
    expect(items).toHaveLength(2);
    expect(new Set(items).size).toBe(2);
    expect(items[1]).toContain('tab "editor-chat"');

    setup.mockInput.pressArrow("down");
    setup.mockInput.pressEnter();
    await Bun.sleep(30);
    await setup.flush();
    const preview = setup.captureCharFrame();
    expect(preview).toContain("Context for");
    expect(preview).toContain('tab "editor-chat"');
    expect(preview).toContain("welcome.ts");

    setup.mockInput.pressEnter();
    await Bun.sleep(30);
    const pasted = (writes.get(second.id) ?? []).join("");
    expect(pasted).toContain("Context: file");
    expect(writes.get("agent-0")).toBeUndefined();
    // The paste goes to the chosen pane and focuses its tab, without submitting.
    expect(app.workspace().activeTab).toBe(second.tab.id);
    expect(second.tab.focused).toBe(second.pane.id);
    expect(app.input.mode).toBe("terminal");
    expect(pasted.endsWith("\r") || pasted.endsWith("\n")).toBe(false);

    // The choice is remembered for this workspace, so the next preview is direct.
    await (app as any).preview("file");
    await Bun.sleep(20);
    await setup.flush();
    expect((app as any).modal?.kind).toBe("preview");
    // The remembered destination is now in the active tab, so no tab suffix.
    expect(setup.captureCharFrame()).toContain("Context for codex · pane 2");
    expect(setup.captureCharFrame()).toContain("Context: file");
  } finally {
    app.disposeUI();
    await setup.dispose();
  }
});

test("a destination that exits is reported instead of silently retargeting", async () => {
  const { setup, app, editor, host, hosts, agentTab, bump } = await harness();
  try {
    app.attachTerminal(app.tab().panes[0]!, host("editor"), editor);
    const first = agentTab();
    const second = agentTab();
    const third = agentTab();
    await setup.flush();

    // Remember the first destination.
    await (app as any).preview("file");
    setup.mockInput.pressEnter();
    await Bun.sleep(20);
    await setup.flush();
    expect((app as any).modal?.kind).toBe("preview");
    setup.mockInput.pressEnter();
    await Bun.sleep(30);
    expect(app.workspace().activeTab).toBe(first.tab.id);

    // It exits while another two are still running: a new choice is required.
    (hosts.get(first.id) as { phase: string }).phase = "exited";
    await (app as any).preview("file");
    await Bun.sleep(20);
    await setup.flush();
    expect((app as any).modal?.kind).toBe("agents");
    expect(setup.captureCharFrame()).toContain("Choose the agent");

    // Choosing the second and stopping it before confirming is reported too.
    setup.mockInput.pressEnter();
    await Bun.sleep(20);
    await setup.flush();
    (hosts.get(second.id) as { phase: string }).phase = "exited";
    bump();
    setup.mockInput.pressEnter();
    await Bun.sleep(30);
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("no longer running");
    expect(third.tab.id).not.toBe(app.workspace().activeTab);
  } finally {
    app.disposeUI();
    await setup.dispose();
  }
});

test("changed context invalidates a preview that already has a destination", async () => {
  const { setup, app, editor, host, agentTab, bump } = await harness();
  try {
    app.attachTerminal(app.tab().panes[0]!, host("editor"), editor);
    agentTab();
    await setup.flush();
    await (app as any).preview("file");
    await Bun.sleep(20);
    await setup.flush();
    expect((app as any).modal?.kind).toBe("preview");
    bump();
    setup.mockInput.pressEnter();
    await Bun.sleep(30);
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("Editor context changed");
  } finally {
    app.disposeUI();
    await setup.dispose();
  }
});

test("no running destination is reported without starting an agent", async () => {
  const { setup, app, editor, host } = await harness();
  try {
    app.attachTerminal(app.tab().panes[0]!, host("editor"), editor);
    await setup.flush();
    const before = app.tab().panes.length;
    await expect((app as any).preview("file")).rejects.toThrow(
      "No running agent",
    );
    // Nothing was started or added.
    expect(app.tab().panes).toHaveLength(before);
    expect((app as any).runtimes.size).toBe(1);
  } finally {
    app.disposeUI();
    await setup.dispose();
  }
});
