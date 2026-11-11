import { crc32, deflate } from "node:zlib";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export type ImagePoint = { x: number; y: number };
/** Coordinates are fractions of the original image, independent of zoom/pan. */
export type ImageBox = { start: ImagePoint; end: ImagePoint };
export const ANNOTATION_COLOR = [255, 0, 0, 255] as const;
export function imagePoint(
  x: number,
  y: number,
  left: number,
  top: number,
  width: number,
  height: number,
): ImagePoint {
  return {
    x: Math.max(0, Math.min(1, (x - left) / width)),
    y: Math.max(0, Math.min(1, (y - top) / height)),
  };
}
export function boxBounds(box: ImageBox) {
  return {
    left: Math.min(box.start.x, box.end.x),
    top: Math.min(box.start.y, box.end.y),
    width: Math.abs(box.end.x - box.start.x),
    height: Math.abs(box.end.y - box.start.y),
  };
}
/** Translate the whole box without changing its size or leaving the image. */
export function moveBox(box: ImageBox, dx: number, dy: number): ImageBox {
  const bounds = boxBounds(box);
  dx = Math.max(-bounds.left, Math.min(1 - bounds.left - bounds.width, dx));
  dy = Math.max(-bounds.top, Math.min(1 - bounds.top - bounds.height, dy));
  return {
    start: { x: box.start.x + dx, y: box.start.y + dy },
    end: { x: box.end.x + dx, y: box.end.y + dy },
  };
}
/** Work on a copy; neither the decoder's pixels nor the original file are edited. */
export function annotatePixels(
  source: Uint8Array,
  width: number,
  height: number,
  boxes: ImageBox[],
) {
  if (source.length !== width * height * 4)
    throw new Error("Invalid image pixels");
  const pixels = new Uint8Array(source);
  const stroke = Math.max(2, Math.round(Math.min(width, height) / 200));
  for (const box of boxes) {
    const b = boxBounds(box);
    const x0 = Math.max(0, Math.min(width - 1, Math.floor(b.left * width)));
    const y0 = Math.max(0, Math.min(height - 1, Math.floor(b.top * height)));
    const x1 = Math.max(
      x0,
      Math.min(width - 1, Math.ceil((b.left + b.width) * width) - 1),
    );
    const y1 = Math.max(
      y0,
      Math.min(height - 1, Math.ceil((b.top + b.height) * height) - 1),
    );
    for (let y = y0; y <= y1; y++) {
      if (y - y0 < stroke || y1 - y < stroke) {
        for (let x = x0; x <= x1; x++)
          pixels.set(ANNOTATION_COLOR, (y * width + x) * 4);
      } else {
        for (let x = x0; x <= Math.min(x1, x0 + stroke - 1); x++)
          pixels.set(ANNOTATION_COLOR, (y * width + x) * 4);
        for (let x = Math.max(x0, x1 - stroke + 1); x <= x1; x++)
          pixels.set(ANNOTATION_COLOR, (y * width + x) * 4);
      }
    }
  }
  return pixels;
}
const compress = promisify(deflate);
function chunk(type: string, bytes: Uint8Array) {
  const body = Buffer.concat([Buffer.from(type), bytes]);
  const result = Buffer.alloc(body.length + 8);
  result.writeUInt32BE(bytes.length, 0);
  body.copy(result, 4);
  result.writeUInt32BE(crc32(body), result.length - 4);
  return result;
}
export async function encodePng(
  pixels: Uint8Array,
  width: number,
  height: number,
) {
  if (pixels.length !== width * height * 4)
    throw new Error("Invalid image pixels");
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6; // RGBA, straight alpha.
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++)
    rows.set(
      pixels.subarray(y * width * 4, (y + 1) * width * 4),
      y * (width * 4 + 1) + 1,
    );
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", await compress(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
export async function exportAnnotatedImage(
  pixels: Uint8Array,
  width: number,
  height: number,
  boxes: ImageBox[],
) {
  const png = await encodePng(
    annotatePixels(pixels, width, height, boxes),
    width,
    height,
  );
  const directory = await mkdtemp(join(tmpdir(), "under-annotation-"));
  const path = join(directory, "annotated.png");
  await writeFile(path, png, { mode: 0o600 });
  // Keep the copy after the viewer closes: a chat may read its path later.
  return { path, png };
}
export function imageClipboardCommand(
  path: string,
  platform = process.platform,
  env = process.env,
  which = Bun.which,
): string[] {
  if (env.SSH_CONNECTION || env.SSH_TTY)
    throw new Error(
      "Image clipboard unavailable over SSH; use p to copy the PNG path",
    );
  if (platform === "darwin")
    return [
      "osascript",
      "-e",
      "on run argv\nset the clipboard to (read (POSIX file (item 1 of argv)) as «class PNGf»)\nend run",
      path,
    ];
  if (platform === "linux" && env.WAYLAND_DISPLAY && which("wl-copy"))
    return ["wl-copy", "--type", "image/png"];
  if (platform === "linux" && env.DISPLAY && which("xclip"))
    return ["xclip", "-selection", "clipboard", "-t", "image/png", "-i"];
  throw new Error("Image clipboard unavailable; use p to copy the PNG path");
}
export async function copyImageToClipboard(path: string, png: Uint8Array) {
  const cmd = imageClipboardCommand(path);
  const child = Bun.spawn({
    cmd,
    stdin: cmd[0] === "osascript" ? "ignore" : new Blob([Uint8Array.from(png)]),
    stdout: "ignore",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    const [exit, error] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    if (exit !== 0)
      throw new Error(
        `Could not copy PNG: ${error.trim() || "clipboard timed out"}`,
      );
  } finally {
    clearTimeout(timer);
  }
}
