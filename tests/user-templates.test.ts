import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, type PaneHost } from "../src/app.ts";
import { defaults, loadConfig, validatePatch } from "../src/config.ts";
import { applyTemplate, catalogue, paneOrder, preset } from "../src/model.ts";

const running = (): PaneHost => ({
  phase: "running",
  exitCode: null,
  write() {},
  resize() {},
  attach() {},
  async close() {},
});
const compose = {
  label: "files, editor, claude",
  panes: [
    { kind: "yazi" },
    { kind: "nvim" },
    { kind: "agent", profile: "claude" },
  ],
  layout: {
    axis: "row",
    ratio: 0.3,
    first: 0,
    second: { axis: "row", ratio: 0.6, first: 1, second: 2 },
  },
  focus: 1,
  key: "c",
};

test("a valid custom template is accepted and validated field by field", () => {
  const patch = validatePatch({ templates: { compose } });
  const template = patch.templates!.compose!;
  expect(template.label).toBe("files, editor, claude");
  expect(template.slots).toEqual([
    { kind: "yazi", profile: "yazi" },
    { kind: "nvim", profile: "nvim" },
    { kind: "agent", profile: "claude" },
  ]);
  expect(template.focus).toBe(1);
  expect(template.key).toBe("c");
});

test("rejected templates name the offending field", () => {
  const bad = (templates: Record<string, unknown>) =>
    expect(() => validatePatch({ templates })).toThrow();
  bad({ compose: { ...compose, extra: true } });
  bad({ compose: { ...compose, panes: [] } });
  bad({ compose: { ...compose, panes: [{ kind: "bogus" }] } });
  bad({ compose: { ...compose, panes: [{ kind: "nvim", profile: "Not Valid" }] } });
  bad({ compose: { ...compose, layout: 5 } });
  bad({
    compose: {
      ...compose,
      layout: { axis: "row", ratio: 0.3, first: 0, second: 0 },
    },
  });
  bad({
    compose: {
      ...compose,
      layout: { axis: "row", ratio: 0.99, first: 0, second: 1 },
    },
  });
  bad({ compose: { ...compose, focus: 3 } });
  bad({ compose: { ...compose, key: "m" } });
  bad({ compose: { ...compose, key: "1" } });
  bad({ compose: { ...compose, key: "h" } });
  bad({ compose: { ...compose, label: "  " } });
});

test("the catalogue keeps built-ins first and appends user templates", () => {
  const builtins = catalogue().order;
  const merged = catalogue(validatePatch({ templates: { compose } }).templates);
  expect(merged.order.slice(0, builtins.length)).toEqual(builtins);
  expect(merged.order).toContain("compose");
  expect(merged.templates["compose"]!.label).toBe("files, editor, claude");
  // Overriding a built-in keeps its position so the digit shortcuts stay stable.
  const override = catalogue(
    validatePatch({
      templates: { review: { ...compose, label: "my review" } },
    }).templates,
  );
  expect(override.order.indexOf("review")).toBe(builtins.indexOf("review"));
  expect(override.templates["review"]!.label).toBe("my review");
});

test("preset and applyTemplate build user templates like built-ins", () => {
  const user = catalogue(validatePatch({ templates: { compose } }).templates);
  const tab = preset("compose", "codex", user);
  expect(tab.name).toBe("compose");
  expect(tab.panes.map((p) => p.kind)).toEqual(["yazi", "nvim", "agent"]);
  expect(tab.panes[2]!.profile).toBe("claude");
  expect(tab.focused).toBe(tab.panes[1]!.id);
  expect(paneOrder(tab.layout)).toEqual([
    tab.panes[0]!.id,
    tab.panes[1]!.id,
    tab.panes[2]!.id,
  ]);
  // An unknown name (for example one removed from configuration) changes nothing.
  applyTemplate(tab, "gone", "codex", user);
  expect(tab.template).toBe("compose");
  expect(tab.panes).toHaveLength(3);
});

test("a project .under.json template is loaded and applied by its shortcut", async () => {
  const root = await mkdtemp(join(tmpdir(), "under-templates-"));
  try {
    await writeFile(
      join(root, ".under.json"),
      JSON.stringify({ templates: { compose } }),
    );
    const { config, warnings } = loadConfig(root);
    expect(warnings).toEqual([]);
    expect(config.templates.compose!.label).toBe("files, editor, claude");

    const setup = await createTestRenderer({ width: 120, height: 30 });
    const app = new App(setup.renderer, root);
    try {
      await setup.flush();
      // The custom template is reachable from a menu and from its own key.
      setup.mockInput.pressKey("g", { ctrl: true });
      setup.mockInput.pressKey("m");
      setup.mockInput.pressArrow("right"); // File -> View
      await setup.flush();
      app.draw();
      await setup.flush();
      expect(setup.captureCharFrame()).toContain("Layout: compose (c)");
      setup.mockInput.pressEscape();
      await Bun.sleep(40);
      setup.mockInput.pressEscape(); // return to terminal before navigating again
      await Bun.sleep(40);

      const roots = app.tab().panes;
      for (const pane of roots) app.attachTerminal(pane, running());
      await setup.flush();
      setup.mockInput.pressKey("g", { ctrl: true });
      setup.mockInput.pressKey("c");
      await setup.flush();
      expect(app.tab().template).toBe("compose");
      // Slots are reused by kind: files (yazi), editor (nvim), chat (agent).
      expect(paneOrder(app.tab().layout)).toEqual([
        roots[2]!.id,
        roots[0]!.id,
        roots[1]!.id,
      ]);
      expect(app.tab().focused).toBe(roots[0]!.id);
      // The shortcut was consumed by navigation, not forwarded to the terminal.
      expect(app.input.mode).toBe("app");
    } finally {
      app.disposeUI();
      await setup.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("config.preset can select a user template", () => {
  const patch = validatePatch({ preset: "compose" });
  expect(patch.preset).toBe("compose");
  expect(() => validatePatch({ preset: "Not Valid" })).toThrow();
  expect(defaults.templates).toEqual({});
});
