import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseLocation,
  pathCandidates,
  resolvePathLink,
} from "../src/pathlink.ts";

test("parses a trailing line and column", () => {
  expect(parseLocation("src/a.ts:12:3,")).toEqual({
    path: "src/a.ts",
    line: 12,
    column: 2,
  });
  expect(parseLocation("(src/a.ts)")?.path).toBe("src/a.ts");
  expect(parseLocation("app/[lang]/page.tsx")?.path).toBe("app/[lang]/page.tsx");
});

test("joins a path that the agent wrapped over indented lines", async () => {
  const root = await mkdtemp(join(tmpdir(), "under-pathlink-"));
  await mkdir(join(root, "apps/web/app/[lang]/suppliers"), { recursive: true });
  const file = join(root, "apps/web/app/[lang]/suppliers/page.tsx");
  await writeFile(file, "");
  const lines = [
    "  La pagina è qui:",
    "  apps/web/app/[lang]/supp",
    "  liers/page.tsx",
    "",
  ];
  for (const [row, col] of [
    [1, 5],
    [2, 4],
  ] as const) {
    const link = await resolvePathLink(pathCandidates(lines, row, col), [root]);
    expect(link?.path).toBe(file);
  }
  expect(
    await resolvePathLink(pathCandidates(lines, 0, 4), [root]),
  ).toBeUndefined();
});

test("maps a web route to its page source", async () => {
  const { routeFile } = await import("../src/pathlink.ts");
  const files = [
    "apps/web/src/app/[lang]/dashboard/page.tsx",
    "apps/web/src/app/[lang]/(shop)/dashboard/suppliers/page.tsx",
  ];
  expect(routeFile("/[lang]/dashboard/suppliers", files)).toBe(files[1]);
  expect(routeFile("/[lang]/dashboard/", files)).toBe(files[0]);
  expect(routeFile("/[lang]/nope", files)).toBeUndefined();

  const lines = [
    "  La route è /[lang]/dashboard/supplier-managemen",
    "  t/suppliers.",
  ];
  const root = await mkdtemp(join(tmpdir(), "under-route-"));
  const page = "src/app/[lang]/dashboard/supplier-management/suppliers/page.tsx";
  const link = await resolvePathLink(pathCandidates(lines, 0, 20), [root], async () => [page]);
  expect(link?.path).toBe(join(root, page));
});
