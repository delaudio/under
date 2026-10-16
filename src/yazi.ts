import {
  mkdtemp,
  readdir,
  readFile,
  writeFile,
  symlink,
  rm,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse, stringify } from "smol-toml";

/** Yazi before 25.12.29 expands shell-style "$@" opener arguments; later
 * releases replace that scheme with %s shell formatting. Emit the token the
 * installed Yazi understands so the editor bridge receives the selected path.
 * Unknown versions assume the current %s formatting.
 */
export function yaziOpenerCommand(editor: string, version: string): string {
  const quoted = `'${editor.replaceAll("'", "'\\''")}'`;
  const match = /(\d+)\.(\d+)/.exec(version);
  const legacy =
    !!match &&
    (Number(match[1]) < 25 ||
      (Number(match[1]) === 25 && Number(match[2]) < 12));
  return legacy ? `${quoted} "$@"` : `${quoted} %s`;
}

/** Read the installed Yazi version; an empty result selects current formatting. */
export function yaziVersion(binary: string): string {
  try {
    const probe = Bun.spawnSync({
      cmd: [binary, "--version"],
      stdout: "pipe",
      stderr: "ignore",
    });
    return new TextDecoder().decode(probe.stdout);
  } catch {
    return "";
  }
}

/** Review bindings Under adds to Yazi, on keys the default keymap leaves free. */
export const REVIEW_BINDINGS = [
  { on: "R", args: "", desc: "Review this directory in Under Hunk" },
  { on: "C", args: "--staged", desc: "Review staged changes in Under Hunk" },
] as const;

/** Key Under sends to Yazi to reveal the path in `reveal.txt` of its config
 * directory. Yazi only tells child processes its instance id, so the binding
 * runs `ya emit` from inside Yazi instead of addressing the instance from
 * outside. */
export const REVEAL_KEY = "<F20>";
export const REVEAL_KEY_BYTES = "\x1b[34~";
export const REVEAL_FILE = "reveal.txt";

const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** Preserve native configuration with an IDE sidebar layout, editor bridge and
 * review bindings that report the directory Yazi is currently showing. */
export async function yaziConfig(options: {
  editor: string;
  /** Under CLI helper used by the review bindings. */
  tool?: string;
  env?: Record<string, string>;
  version?: string;
}) {
  const { editor, tool, env = {}, version = "" } = options;
  const source = resolve(
    env.YAZI_CONFIG_HOME ||
      process.env.YAZI_CONFIG_HOME ||
      join(
        env.XDG_CONFIG_HOME ||
          process.env.XDG_CONFIG_HOME ||
          join(homedir(), ".config"),
        "yazi",
      ),
  );
  const directory = await mkdtemp(join(tmpdir(), "under-yazi-"));
  try {
    let entries: string[] = [];
    try {
      entries = await readdir(source);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    for (const name of entries.filter(
      (name) => !["yazi.toml", "keymap.toml"].includes(name),
    ))
      await symlink(join(source, name), join(directory, name));
    const config = entries.includes("yazi.toml")
      ? parse(await readFile(join(source, "yazi.toml"), "utf8"))
      : {};
    const manager = config.mgr ?? config.manager;
    if (
      manager !== undefined &&
      (typeof manager !== "object" || Array.isArray(manager))
    )
      throw new Error("Invalid Yazi manager configuration");
    // Legacy Yazi uses [manager]; current releases use [mgr]. Preserve either.
    const managerKey =
      config.manager !== undefined && config.mgr === undefined
        ? "manager"
        : "mgr";
    config[managerKey] = {
      ...(manager as Record<string, any>),
      ratio: [0, 1, 0],
    };
    const opener = config.opener;
    if (
      opener !== undefined &&
      (typeof opener !== "object" || Array.isArray(opener))
    )
      throw new Error("Invalid Yazi opener configuration");
    config.opener = {
      ...(opener as Record<string, any>),
      edit: [
        {
          run: yaziOpenerCommand(editor, version),
          desc: "Open in Under Neovim",
          block: true,
          for: "unix",
        },
      ],
    };
    await writeFile(join(directory, "yazi.toml"), stringify(config));

    // Key bindings live in keymap.toml. Keep the user's file, add the review
    // bindings on keys they have not already taken, and never shadow theirs.
    const keymap = entries.includes("keymap.toml")
      ? parse(await readFile(join(source, "keymap.toml"), "utf8"))
      : {};
    const mgr = record(keymap.mgr) ? keymap.mgr : {};
    const taken = new Set<string>();
    for (const list of ["keymap", "prepend_keymap", "append_keymap"]) {
      const value = mgr[list];
      if (Array.isArray(value))
        for (const entry of value)
          if (record(entry) && typeof entry.on === "string")
            taken.add(entry.on);
    }
    const quoted = tool?.replaceAll("'", "'\\''");
    const bindings: { on: string; run: string; desc: string }[] = quoted
      ? REVIEW_BINDINGS.filter((binding) => !taken.has(binding.on)).map(
          (binding) => ({
            on: binding.on,
            run: `shell '${quoted}' review-here ${binding.args}`.trim(),
            desc: binding.desc,
          }),
        )
      : [];
    const ya = Bun.which("ya");
    // Skip when the path could not be quoted safely or the user owns the key.
    if (
      ya &&
      !taken.has(REVEAL_KEY) &&
      /^[\w/.+-]+$/.test(directory) &&
      /^[\w/.+-]+$/.test(ya)
    )
      bindings.push({
        on: REVEAL_KEY,
        run: `shell --orphan '${ya} emit reveal "$(cat ${join(directory, REVEAL_FILE)})"'`,
        desc: "Reveal the file Under asks for",
      });
    if (entries.includes("keymap.toml") || bindings.length) {
      if (bindings.length)
        mgr.prepend_keymap = [
          ...bindings,
          ...(Array.isArray(mgr.prepend_keymap) ? mgr.prepend_keymap : []),
        ];
      keymap.mgr = mgr;
      await writeFile(join(directory, "keymap.toml"), stringify(keymap));
    }
    return directory;
  } catch (e) {
    await rm(directory, { recursive: true, force: true });
    throw e;
  }
}
