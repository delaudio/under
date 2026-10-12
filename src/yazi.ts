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

/** Preserve native configuration with an IDE sidebar layout and editor bridge. */
export async function yaziConfig(
  editor: string,
  env: Record<string, string> = {},
) {
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
    for (const name of entries.filter((name) => name !== "yazi.toml"))
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
          run: `'${editor.replaceAll("'", "'\\''")}' %s`,
          desc: "Open in Under Neovim",
          block: true,
          for: "unix",
        },
      ],
    };
    await writeFile(join(directory, "yazi.toml"), stringify(config));
    return directory;
  } catch (e) {
    await rm(directory, { recursive: true, force: true });
    throw e;
  }
}
