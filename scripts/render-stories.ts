import { mkdir, writeFile } from "node:fs/promises";
import { TextAttributes } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { App, type PaneHost, type PaneEditor } from "../src/app.ts";
import { defaults } from "../src/config.ts";
import { MENU_LABELS, menuSlots } from "../src/menu.ts";
import {
  preset,
  splitHandles,
  type Template,
  type TemplateName,
} from "../src/model.ts";
import { catalog } from "../storybook/catalog.ts";
import type { Phase } from "../src/pty.ts";

const encoder = new TextEncoder();
const editorOutput =
  "\x1b[2J\x1b[H\x1b[38;2;183;167;232mconst\x1b[0m greeting = \x1b[38;2;140;210;170m'Hello è界'\x1b[0m;\r\n\r\n\x1b[1mUnder workspace\x1b[0m\r\n\x1b[3mEdit files, review changes, ask an agent.\x1b[0m\r\n\x1b[4mUnicode and terminal colors\x1b[0m";
class FixtureHost implements PaneHost {
  exitCode: number | null;
  constructor(
    public phase: Phase,
    private output: string,
  ) {
    this.exitCode = phase === "exited" ? 0 : null;
  }
  attach(sink: (bytes: Uint8Array) => void) {
    sink(encoder.encode(this.output));
  }
  write() {
    throw new Error("A visual fixture must never execute a command");
  }
  resize() {}
  async close() {}
}
const fixtureEditor: PaneEditor = {
  async snapshot() {
    return {
      path: "/fixtures/project/welcome.ts",
      lines: ["const greeting = 'Hello è界';"],
      cursor: [1, 0],
      changedtick: 1,
      modified: true,
      selection: [],
      diagnostics: [],
    };
  },
  async openFile() {
    throw new Error("Preview editor is read-only");
  },
  async ready() {},
  async modified() {
    return [];
  },
  async quit() {},
  async dispose() {},
  abortInitialization() {},
};
const agentOutput =
  "\x1b[2J\x1b[H\x1b[38;2;140;210;170mAgent session\x1b[0m\r\n\r\n> Explain welcome.ts\r\n\r\nReview and submit in\r\nthe native CLI.";
const yaziOutput =
  "\x1b[2J\x1b[H\x1b[38;2;140;210;170mproject/\x1b[0m\r\n\r\n\x1b[1;38;2;183;167;232m> src/\x1b[0m\r\n  stories/\r\n  README.md\r\n  package.json\r\n  welcome.ts\r\n\r\nYazi native pane\r\nUser theme and keys";
const hunkOutput =
  "\x1b[2J\x1b[H\x1b[1mworking tree\x1b[0m\r\n\r\n\x1b[38;2;140;210;170m+welcome.ts\x1b[0m\r\n@@ -1,3 +1,4 @@\r\n const greeting = 'Hello';";
const shellOutput =
  "\x1b[2J\x1b[H$ bun run check\r\n 43 pass\r\n";
const fixtureOutput = (kind: string) =>
  ({
    nvim: editorOutput,
    agent: agentOutput,
    yazi: yaziOutput,
    hunk: hunkOutput,
    shell: shellOutput,
  })[kind] ?? editorOutput;
/** A template a user could declare in .under.json, shown by the compose story. */
const userTemplate: Template = {
  label: "files, editor, claude",
  slots: [
    { kind: "yazi" },
    { kind: "nvim" },
    { kind: "agent", profile: "claude" },
  ],
  focus: 1,
  shape: {
    axis: "row",
    ratio: 0.3,
    first: 0,
    second: { axis: "row", ratio: 0.6, first: 1, second: 2 },
  },
  key: "c",
};
const frames: Record<string, unknown> = {};
const toHex = (color: { toInts(): number[] }) =>
  "#" +
  color
    .toInts()
    .slice(0, 3)
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
for (const spec of catalog) {
  const setup = await createTestRenderer({
    width: spec.width,
    height: spec.height,
  });
  const app = new App(setup.renderer, "/fixtures/project", undefined, {
    config:
      spec.state === "tpl-compose"
        ? {
            ...defaults,
            // Start from a tab without an agent pane so the template's own
            // profile is created rather than an existing pane being reused.
            preset: "editor",
            templates: { compose: userTemplate },
          }
        : defaults,
    quickFiles: spec.state.startsWith("quick")
      ? [
          "src/app.ts",
          "src/app-shell.ts",
          "src/application/index.ts",
          "src/README.md",
        ]
      : undefined,
    available: () => spec.state !== "disabled",
    files:
      spec.state === "empty"
        ? []
        : [
            { name: "src", path: "/fixtures/project/src", directory: true },
            {
              name: "README.md",
              path: "/fixtures/project/README.md",
              directory: false,
            },
            {
              name: "package.json",
              path: "/fixtures/project/package.json",
              directory: false,
            },
            {
              name: "welcome.ts",
              path: "/fixtures/project/welcome.ts",
              directory: false,
            },
          ],
  });
  const key = (name: string) => setup.mockInput.pressKey(name);
  const navigate = () => setup.mockInput.pressKey("g", { ctrl: true });
  try {
    const template = spec.state.startsWith("tpl-")
      ? (spec.state.slice(4) as TemplateName)
      : spec.state === "review-scoped"
        ? ("review" as TemplateName)
        : undefined;
    if (template) app.applyLayout(template);
    if (spec.state === "review-scoped") {
      // A review scoped to a revision, shown by the pane title and the tab name.
      const tab = app.tab();
      const hunk = tab.panes.find((pane) => pane.kind === "hunk")!;
      hunk.cwd = "/fixtures/project";
      hunk.args = ["main"];
      tab.name = "diff main";
      app.draw();
    }
    if (template) {
      // Template stories attach by kind so every slot shows its own pane.
      for (const pane of app.tab().panes)
        app.attachTerminal(
          pane,
          new FixtureHost("running", fixtureOutput(pane.kind)),
          pane.kind === "nvim" ? fixtureEditor : undefined,
        );
    } else {
      if (spec.state !== "restore" && spec.state !== "empty")
        app.attachTerminal(
          app.tab().panes[0]!,
          new FixtureHost("running", editorOutput),
          fixtureEditor,
        );
      if (
        [
          "codex",
          "claude",
          "opencode",
          "exited",
          "stopping",
          "agent-error",
          "context",
          "preview-destination",
        ].includes(spec.state)
      ) {
        const pane = app.tab().panes[1]!;
        pane.profile = ["codex", "claude", "opencode"].includes(spec.state)
          ? spec.state
          : "codex";
        const phase =
          spec.state === "agent-error"
            ? "error"
            : ["exited", "stopping"].includes(spec.state)
              ? (spec.state as Phase)
              : "running";
        app.attachTerminal(pane, new FixtureHost(phase, agentOutput));
      }
      if (!["files", "restore", "empty"].includes(spec.state)) {
        app.attachTerminal(
          app.tab().panes[2]!,
          new FixtureHost("running", yaziOutput),
        );
      }
    }
    if (spec.state === "native-files") {
      navigate();
      key("f");
    }
    if (spec.state === "resize-drag") {
      // Freeze a resize in progress so the dragged boundary is captured mid-drag.
      await setup.flush();
      const boundary = splitHandles(app.tab().layout, {
        x: 0,
        y: 2,
        width: spec.width,
        height: spec.height - 3,
      })[0]!.boundary;
      await setup.mockMouse.pressDown(boundary, 12);
      await setup.mockMouse.emitMouseEvent("drag", boundary + 14, 12);
    }
    if (spec.state === "context") {
      navigate();
      key("p");
      await setup.mockInput.typeText("Preview file context");
      setup.mockInput.pressEnter();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (spec.state === "navigation") navigate();
    if (spec.state === "quick" || spec.state === "quick-narrow") {
      navigate();
      key("o");
      await setup.mockInput.typeText("app");
    }
    if (spec.state === "destinations") {
      navigate();
      key("g");
    }
    if (spec.state === "preview-destination") {
      // A second running agent in another tab makes the destination ambiguous.
      const tab = preset("editor-chat");
      app.workspace().tabs.push(tab);
      app.attachTerminal(
        tab.panes.find((pane) => pane.kind === "agent")!,
        new FixtureHost("running", agentOutput),
      );
      navigate();
      key("p");
      await setup.mockInput.typeText("Preview file context");
      setup.mockInput.pressEnter();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (spec.state === "files") {
      navigate();
      key("f");
      setup.mockInput.pressArrow("down");
    }
    if (spec.state === "hidden") {
      navigate();
      key("b");
    }
    if (spec.state === "palette") {
      navigate();
      key("p");
    }
    if (spec.state === "help") {
      navigate();
      key("?");
    }
    if (spec.state === "error")
      app.report(
        "Neovim initialization failed. Check configuration; Tools → Restart.",
      );
    if (spec.state === "restore")
      app.report("Layout restored. Start tools explicitly from the menu.");
    const menu =
      MENU_LABELS.find((label) => label === spec.state) ??
      (spec.state === "disabled"
        ? "Agent"
        : spec.state === "scroll" || spec.state === "form"
          ? "File"
          : undefined);
    if (menu) {
      await setup.flush();
      const slot = menuSlots(spec.width).slots.find(
        (slot) => slot.label === menu,
      )!;
      await setup.mockMouse.click(slot.x + 1, slot.y);
      if (spec.state === "scroll")
        for (let i = 0; i < 8; i++) setup.mockInput.pressArrow("down");
      if (spec.state === "form") {
        setup.mockInput.pressEnter();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await setup.mockInput.typeText("welcome.ts");
      }
    }
    app.draw();
    await setup.flush();
    const captured = setup.captureSpans();
    const text = setup.captureCharFrame();
    if (
      !menu &&
      ![
        "palette",
        "help",
        "context",
        "quick",
        "quick-narrow",
        "destinations",
        "preview-destination",
      ].includes(spec.state) &&
      !text.includes("under_")
    )
      throw new Error(`Missing workspace in ${spec.id}`);
    if (spec.state === "context" && !text.includes("Context for codex"))
      throw new Error("Missing context preview");
    if (spec.state.startsWith("quick") && !text.includes("src/app.ts"))
      throw new Error(`Missing quick open results in ${spec.id}`);
    if (spec.state === "destinations" && !text.includes("code"))
      throw new Error("Missing destinations");
    if (spec.state === "preview-destination" && !text.includes("Choose the agent"))
      throw new Error("Missing destination picker");
    if (spec.state === "form" && !text.includes("File path"))
      throw new Error("Missing file form");
    if (menu && !text.includes(menu))
      throw new Error(`Missing menu in ${spec.id}`);
    frames[spec.id] = {
      cols: captured.cols,
      rows: captured.rows,
      lines: captured.lines.map((line) => ({
        spans: line.spans.map((span) => ({
          text: span.text,
          width: span.width,
          fg: toHex(span.fg),
          bg: toHex(span.bg),
          bold: !!(span.attributes & TextAttributes.BOLD),
          italic: !!(span.attributes & TextAttributes.ITALIC),
          underline: !!(span.attributes & TextAttributes.UNDERLINE),
        })),
      })),
    };
  } finally {
    app.disposeUI();
    await setup.dispose();
  }
}
const storySource = await Bun.file(
  "storybook/stories/Workspace.stories.ts",
).text();
for (const spec of catalog)
  if (!storySource.includes(`export const ${spec.export} `))
    throw new Error(`Missing story: ${spec.export}`);
if ((storySource.match(/export const /g) ?? []).length !== catalog.length)
  throw new Error("Story/catalog count mismatch");
await mkdir("storybook/generated", { recursive: true });
await writeFile("storybook/generated/frames.json", JSON.stringify(frames));
console.log(`Captured ${catalog.length} production TUI frames.`);
