import {
  mkdtemp,
  readdir,
  readFile,
  writeFile,
  symlink,
  rm,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
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

/** Environment variable naming the file Under's hover hook writes. */
export const HOVER_ENV = "UNDER_HOVER_FILE";
/** Name of the hover file inside the overlay. */
export const HOVER_FILE = "under-hover.txt";

/** Prepended to the user's init.lua in Under's overlay (a trailing top-level
 * `return` in the user's file would make appended code a syntax error). When `UNDER_HOVER_FILE`
 * is set, it writes the hovered path to that file each time it changes. It only
 * subscribes to an event, so Yazi's stdout and the programs it starts are left
 * alone, and a Yazi without the `ps` API simply skips it. */
export const HOVER_HOOK = `
-- Added by Under: report the hovered file for previews.
pcall(function()
  local out = os.getenv("${HOVER_ENV}")
  if not out or out == "" then return end
  local last
  ps.sub("hover", function()
    local h = cx.active.current.hovered
    local url = h and tostring(h.url) or ""
    if url == last then return end
    last = url
    local f = io.open(out, "w")
    if f then f:write(url) f:close() end
  end)
end)
`;

/** Review bindings Under adds to Yazi, on keys the default keymap leaves free. */
export const REVIEW_BINDINGS = [
  { on: "R", args: "", desc: "Review this directory in Under Hunk" },
  { on: "C", args: "--staged", desc: "Review staged changes in Under Hunk" },
] as const;

/** Key Under sends to Yazi to reveal the path in `reveal.txt` of its config
 * directory. Yazi only tells child processes its instance id, so the binding
 * runs `ya emit` from inside Yazi instead of addressing the instance from
 * outside. */
export const REVEAL_KEY = "<C-S-F12>";
export const REVEAL_KEY_BYTES = "\x1b[24;6~";
export const REVEAL_FILE = "reveal.txt";

/** Keys Under sends to Yazi to show or hide dotfiles explicitly, so its state
 * cannot drift from Under's the way `hidden toggle` could. */
export const HIDDEN_KEYS = {
  show: { on: "<C-S-F11>", bytes: "\x1b[23;6~" },
  hide: { on: "<C-S-F10>", bytes: "\x1b[21;6~" },
} as const;

const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const BINDINGS_FILE = "under-bindings.json";
/** Keys Under bound in an overlay; a key the user already owns is not sent. */
export function installedBindings(overlay: string): string[] {
  try {
    const value = JSON.parse(readFileSync(join(overlay, BINDINGS_FILE), "utf8"));
    return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** The user's Yazi configuration directory. */
export function yaziSource(env: Record<string, string> = {}) {
  return resolve(
    env.YAZI_CONFIG_HOME ||
      process.env.YAZI_CONFIG_HOME ||
      join(
        env.XDG_CONFIG_HOME ||
          process.env.XDG_CONFIG_HOME ||
          join(homedir(), ".config"),
        "yazi",
      ),
  );
}

/** Whether the user's Yazi starts with dotfiles shown (`show_hidden`). */
export function yaziShowsHidden(env: Record<string, string> = {}): boolean {
  try {
    const config = parse(
      readFileSync(join(yaziSource(env), "yazi.toml"), "utf8"),
    );
    const manager = config.mgr ?? config.manager;
    return record(manager) && manager.show_hidden === true;
  } catch {
    return false;
  }
}

/** Preserve native configuration with an IDE sidebar layout, editor bridge and
 * review bindings that report the directory Yazi is currently showing. */
export async function yaziConfig(options: {
  editor: string;
  /** Under CLI helper used by the review bindings. */
  tool?: string;
  env?: Record<string, string>;
  version?: string;
  /** Start with dotfiles shown or hidden, overriding `show_hidden`. */
  showHidden?: boolean;
}) {
  const { editor, tool, env = {}, version = "", showHidden } = options;
  const source = yaziSource(env);
  const directory = await mkdtemp(join(tmpdir(), "under-yazi-"));
  try {
    let entries: string[] = [];
    try {
      entries = await readdir(source);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    for (const name of entries.filter(
      // Files Under writes are never links into the user's configuration.
      (name) =>
        ![
          "yazi.toml",
          "keymap.toml",
          "init.lua",
          REVEAL_FILE,
          HOVER_FILE,
          BINDINGS_FILE,
        ].includes(name),
    ))
      await symlink(join(source, name), join(directory, name));
    // Run the hover hook first, then the user's init.lua unchanged.
    const init = entries.includes("init.lua")
      ? await readFile(join(source, "init.lua"), "utf8")
      : "";
    await writeFile(join(directory, "init.lua"), `${HOVER_HOOK}\n${init}`);
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
      ...(showHidden === undefined ? {} : { show_hidden: showHidden }),
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
    // Route image opens through Under instead of Yazi's external image opener.
    const open = record(config.open) ? config.open : {};
    open.prepend_rules = [
      { mime: "image/*", use: "edit" },
      ...(Array.isArray(open.prepend_rules) ? open.prepend_rules : []),
    ];
    config.open = open;
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
    for (const [mode, key] of Object.entries(HIDDEN_KEYS))
      if (!taken.has(key.on))
        bindings.push({
          on: key.on,
          run: `hidden ${mode}`,
          desc: `${mode === "show" ? "Show" : "Hide"} hidden files (Under)`,
        });
    await writeFile(
      join(directory, BINDINGS_FILE),
      JSON.stringify(bindings.map((binding) => binding.on)),
    );
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
