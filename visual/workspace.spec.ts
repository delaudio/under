import { test, expect } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import { catalog } from "../storybook/catalog";
import frames from "../storybook/generated/frames.json" with { type: "json" };

const storyId = (entry: (typeof catalog)[number]) =>
  `under-workspace--${entry.export.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}`;
test("catalog, production frames, stories and baselines stay in sync", async ({
  request,
}, info) => {
  expect(Object.keys(frames).sort()).toEqual(catalog.map((c) => c.id).sort());
  const index = await (
    await request.get("http://127.0.0.1:6017/index.json")
  ).json();
  expect(Object.keys(index.entries).sort()).toEqual(
    catalog.map(storyId).sort(),
  );
  if (info.config.updateSnapshots === "none") {
    const directory = `visual/baselines/${process.platform}`;
    expect(
      existsSync(directory),
      "Create and review baselines for this platform explicitly",
    ).toBe(true);
    expect(
      readdirSync(directory)
        .filter((name) => name.endsWith(".png"))
        .sort(),
    ).toEqual(catalog.map((c) => `${c.id}.png`).sort());
  }
});
for (const spec of catalog) {
  test(spec.id, async ({ page }) => {
    await page.goto(
      `http://127.0.0.1:6017/iframe.html?id=${storyId(spec)}&viewMode=story`,
    );
    const terminal = page.locator("[data-visual-snapshot-root]");
    await expect(terminal).toHaveCount(1);
    await expect(terminal).toHaveAttribute("data-frame-id", spec.id);
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await expect(terminal).toHaveScreenshot(`${spec.id}.png`);
  });
}
