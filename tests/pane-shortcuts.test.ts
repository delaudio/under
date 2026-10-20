import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { App, type PaneHost } from "../src/app.ts";
import { defaults } from "../src/config.ts";
import { paneOrder } from "../src/model.ts";

test("direct pane shortcuts wrap, focus native input and respect modals and hidden panes", async () => {
  const setup = await createTestRenderer({ width: 120, height: 30 });
  const app = new App(setup.renderer, "/fixtures/project", undefined, {
    config: defaults,
    files: [],
  });
  const writes = new Map<string, string[]>();
  try {
    for (const pane of app.tab().panes) {
      const received: string[] = [];
      writes.set(pane.id, received);
      const host: PaneHost = {
        phase: "running",
        exitCode: null,
        write(bytes) { received.push(new TextDecoder().decode(bytes)); },
        resize() {},
        attach() {},
        async close() {},
      };
      app.attachTerminal(pane, host);
    }
    const order = paneOrder(app.tab().layout);
    app.tab().focused = order[0]!;
    app.input.mode = "terminal";
    app.draw();
    await setup.flush();
    setup.mockInput.pressArrow("left", { ctrl: true });
    expect(app.tab().focused).toBe(order.at(-1)!);
    expect(String(app.input.mode)).toBe("terminal");
    setup.mockInput.pressKey("x");
    expect(writes.get(order.at(-1)!)).toEqual(["x"]);
    setup.mockInput.pressArrow("right", { ctrl: true });
    expect(app.tab().focused).toBe(order[0]!);
    expect(writes.get(order[0]!)).toEqual([]);

    setup.mockInput.pressKey("g", { ctrl: true });
    setup.mockInput.pressArrow("right", { ctrl: true });
    expect(String(app.input.mode)).toBe("terminal");
    expect(app.tab().focused).toBe(order[1]!);
    setup.mockInput.pressKey("g", { ctrl: true });
    setup.mockInput.pressKey("p");
    setup.mockInput.pressArrow("right", { ctrl: true });
    expect(app.tab().focused).toBe(order[1]!);
    expect(String(app.input.mode)).toBe("modal");
    setup.mockInput.pressEscape();

    app.applyLayout("editor");
    const focused = app.tab().focused;
    setup.mockInput.pressArrow("right", { ctrl: true });
    expect(app.tab().focused).toBe(focused);
    setup.mockInput.pressArrow("left", { ctrl: true });
    expect(app.tab().focused).toBe(focused);
  } finally {
    await app.shutdown(true);
    await setup.dispose();
  }
});
