import { expect, test } from "bun:test";
import { NativeImage } from "@opentui/core";
import {
  imagePoint,
  boxBounds,
  moveBox,
  annotatePixels,
  encodePng,
  imageClipboardCommand,
} from "../src/image-annotations.ts";

test("annotation coordinates survive reverse dragging and clamp to image edges", () => {
  expect(imagePoint(35, 45, 10, 20, 100, 50)).toEqual({ x: 0.25, y: 0.5 });
  expect(imagePoint(-10, 100, 10, 20, 100, 50)).toEqual({ x: 0, y: 1 });
  expect(
    boxBounds({ start: { x: 0.8, y: 0.9 }, end: { x: 0.2, y: 0.3 } }).left,
  ).toBe(0.2);
});

test("annotated PNG preserves resolution, alpha, interior pixels and the source", async () => {
  const original = new Uint8Array(40 * 30 * 4);
  for (let i = 0; i < original.length; i += 4)
    original.set([50, 60, 70, 128], i);
  const copy = original.slice();
  const annotated = annotatePixels(original, 40, 30, [
    { start: { x: 0.2, y: 0.2 }, end: { x: 0.8, y: 0.8 } },
  ]);
  expect(original).toEqual(copy);
  const image = NativeImage.decode(await encodePng(annotated, 40, 30));
  try {
    expect([image.width, image.height]).toEqual([40, 30]);
    const pixels = new Uint8Array(original.length);
    image.copyTo(pixels);
    expect([...pixels.slice((6 * 40 + 8) * 4, (6 * 40 + 8) * 4 + 4)]).toEqual([
      255, 0, 0, 255,
    ]);
    expect([
      ...pixels.slice((15 * 40 + 20) * 4, (15 * 40 + 20) * 4 + 4),
    ]).toEqual([50, 60, 70, 128]);
    expect([...pixels.slice(0, 4)]).toEqual([50, 60, 70, 128]);
  } finally {
    image.dispose();
  }
});

test("image clipboard uses explicit PNG format and keeps file paths out of scripts", () => {
  const path = "/tmp/quote ' image.png";
  const cmd = imageClipboardCommand(path, "darwin", {});
  expect(cmd.at(-1)).toBe(path);
  expect(cmd[2]).not.toContain(path);
  expect(cmd[2]).toContain("PNGf");
  expect(
    imageClipboardCommand(
      path,
      "linux",
      { WAYLAND_DISPLAY: "wayland-0" },
      () => "/bin/wl-copy",
    ),
  ).toEqual(["wl-copy", "--type", "image/png"]);
  expect(() =>
    imageClipboardCommand(path, "darwin", { SSH_CONNECTION: "remote" }),
  ).toThrow("SSH");
  expect(() => imageClipboardCommand(path, "linux", {}, () => null)).toThrow(
    "use p",
  );
});

test("moving a box preserves its size and clamps all edges", () => {
  const box = { start: { x: 0.2, y: 0.3 }, end: { x: 0.6, y: 0.8 } };
  const moved = moveBox(box, 0.1, -0.1);
  expect(moved.start.x).toBeCloseTo(0.3);
  expect(moved.start.y).toBeCloseTo(0.2);
  const edge = boxBounds(moveBox(box, 9, -9));
  expect(edge.left + edge.width).toBeCloseTo(1);
  expect(edge.top).toBeCloseTo(0);
  expect(edge.width).toBeCloseTo(0.4);
  expect(edge.height).toBeCloseTo(0.5);
  expect(box.start).toEqual({ x: 0.2, y: 0.3 });
});
