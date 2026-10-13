import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { App, type PaneHost } from "../src/app.ts";
import { defaults } from "../src/config.ts";
import {
  clampRatio,
  rectangles,
  setSplitRatio,
  splitHandles,
  MAX_RATIO,
  MIN_RATIO,
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
const row = (ratio: number, first: Layout, second: Layout): Layout => ({
  axis: "row",
  ratio,
  first,
  second,
});
const area = { x: 0, y: 2, width: 120, height: 27 };

test("split handles describe every boundary with the geometry panes use", () => {
  const layout = row(
    0.26,
    { pane: "files" },
    row(0.65, { pane: "editor" }, { pane: "chat" }),
  );
  expect(splitHandles(layout, area)).toEqual([
    {
      path: [],
      axis: "row",
      boundary: 31,
      span: { start: 2, end: 29 },
      origin: 0,
      size: 120,
    },
    {
      path: ["second"],
      axis: "row",
      boundary: 88,
      span: { start: 2, end: 29 },
      origin: 31,
      size: 89,
    },
  ]);
  // The boundary is exactly where the pane rectangles meet.
  const cells = rectangles(layout, area);
  expect(cells.get("files")!.x + cells.get("files")!.width).toBe(31);
  expect(cells.get("editor")!.x).toBe(31);
  expect(cells.get("editor")!.x + cells.get("editor")!.width).toBe(88);
});

test("split handles cover column splits and skip collapsed splits", () => {
  const column: Layout = { axis: "column", ratio: 0.5, first: { pane: "a" }, second: { pane: "b" } };
  const [handle] = splitHandles(column, { x: 4, y: 0, width: 40, height: 20 });
  expect(handle!.axis).toBe("column");
  expect(handle!.boundary).toBe(10);
  expect(handle!.span).toEqual({ start: 4, end: 44 });
  expect(handle!.origin).toBe(0);
  expect(handle!.size).toBe(20);
  // Splits below the minimum collapse to one pane, so they expose no handle.
  expect(splitHandles(row(0.5, { pane: "a" }, { pane: "b" }), { x: 0, y: 0, width: 7, height: 20 })).toEqual([]);
});

test("setSplitRatio only touches the targeted split and clamps the ratio", () => {
  const layout = row(
    0.26,
    { pane: "files" },
    row(0.65, { pane: "editor" }, { pane: "chat" }),
  );
  const widened = setSplitRatio(layout, ["second"], 0.4) as Extract<Layout, { axis: string }>;
  expect(widened.ratio).toBe(0.26);
  expect((widened.second as Extract<Layout, { axis: string }>).ratio).toBe(0.4);
  expect(setSplitRatio(layout, [], 0.01)).toMatchObject({ ratio: MIN_RATIO });
  expect(setSplitRatio(layout, [], 0.99)).toMatchObject({ ratio: MAX_RATIO });
  expect(clampRatio(0.5)).toBe(0.5);
});

test("dragging a pane border resizes the split without stealing focus or input", async () => {
  const setup = await createTestRenderer({ width: 120, height: 30 });
  const app = new App(setup.renderer, "/fixtures/project", undefined, {
    config: defaults,
    files: [],
  });
  const writes: Uint8Array[] = [];
  const host: PaneHost = { ...running(), write: (bytes) => writes.push(bytes) };
  const [editor, chat, files] = app.tab().panes;
  try {
    app.attachTerminal(editor!, host);
    app.attachTerminal(chat!, host);
    app.attachTerminal(files!, host);
    await setup.flush();
    const before = app.tab().layout as Extract<Layout, { axis: string }>;
    expect(before.ratio).toBeCloseTo(0.26, 5);

    // Grab the files|editor boundary at its first cell and drag it right.
    await setup.mockMouse.drag(31, 15, 50, 15);
    await setup.flush();
    const after = app.tab().layout as Extract<Layout, { axis: string }>;
    expect(after.ratio).toBeCloseTo(50 / 120, 5);
    expect(rectangles(after, area).get(files!.id)!.width).toBe(50);
    expect(
      (setup.renderer.root.findDescendantById(`frame-${files!.id}`) as { width: number })
        .width,
    ).toBe(50);
    // The drag is a resize, not a focus change or terminal input.
    expect(app.tab().focused).toBe(editor!.id);
    expect(app.input.mode).toBe("terminal");
    expect(writes).toEqual([]);
  } finally {
    app.disposeUI();
    await setup.dispose();
  }
});

test("drag resizing clamps at the minimum and maximum and releases capture", async () => {
  const setup = await createTestRenderer({ width: 120, height: 30 });
  const app = new App(setup.renderer, "/fixtures/project", undefined, {
    config: defaults,
    files: [],
  });
  const [editor, chat, files] = app.tab().panes;
  const boundary = (index: number) => {
    const handles = splitHandles(app.tab().layout, area);
    expect(handles).toHaveLength(2);
    return handles[index]!.boundary;
  };
  const inner = () =>
    (app.tab().layout as Extract<Layout, { axis: string }>).second as Extract<
      Layout,
      { axis: string }
    >;
  try {
    app.attachTerminal(editor!, running());
    app.attachTerminal(chat!, running());
    app.attachTerminal(files!, running());
    await setup.flush();
    // Grab the editor|chat boundary where it is and drag it to the far right.
    await setup.mockMouse.drag(boundary(1), 15, 119, 15);
    await setup.flush();
    expect(inner().ratio).toBe(MAX_RATIO);
    // Grab it again at its new position and drag it to the far left.
    await setup.mockMouse.drag(boundary(1), 15, 0, 15);
    await setup.flush();
    expect(inner().ratio).toBe(MIN_RATIO);
    // Keyboard resize keeps working on the same boundary after a drag.
    setup.mockInput.pressKey("g", { ctrl: true });
    setup.mockInput.pressKey("]");
    await setup.flush();
    expect(inner().ratio).toBeCloseTo(MIN_RATIO + 0.05, 5);
  } finally {
    app.disposeUI();
    await setup.dispose();
  }
});
