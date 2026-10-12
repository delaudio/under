import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Editor } from "../src/editor.ts";

const nvim = process.env.UNDER_TEST_NVIM || Bun.which("nvim");
test.skipIf(!nvim || process.env.UNDER_NO_SOCKETS === "1")(
  "real Neovim PTY/RPC preserves modified buffers, paths and safe quit",
  async () => {
    const dir = await realpath(
      await mkdtemp(join(tmpdir(), "under-editor-test-")),
    );
    const editor = await Editor.launch({ argv: [nvim!, "--clean"] }, dir);
    editor.host.attach(() => {});
    try {
      await editor.ready();
      const path = join(dir, "quote ' and è.ts");
      await writeFile(path, "èunder\n");
      await editor.openFile(path);
      expect((await editor.snapshot()).path).toBe(path);
      await editor.rpc!.call("nvim_input", ["gg0v"]);
      await Bun.sleep(30);
      expect((await editor.snapshot()).selection).toEqual(["è"]);
      await editor.rpc!.call("nvim_input", ["<Esc>"]);
      await Bun.sleep(30);
      await editor.rpc!.call("nvim_buf_set_lines", [
        0,
        0,
        -1,
        false,
        ["unsaved change"],
      ]);
      expect((await editor.snapshot()).modified).toBe(true);
      await expect(editor.quit()).rejects.toThrow("Save modified");
      const next = join(dir, "other.ts");
      await writeFile(next, "next\n");
      await editor.openFile(next);
      expect(await editor.modified()).toContain(path);
      await editor.rpc!.call("nvim_command", ["wa"]);
      await editor.quit();
      expect(editor.host.phase).toBe("exited");
    } finally {
      await editor.dispose();
      await rm(dir, { recursive: true });
    }
  },
  15_000,
);
test.skipIf(!nvim || process.env.UNDER_NO_SOCKETS === "1")(
  "Neovim initialization can be cancelled during an interactive config prompt",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "under-nvim-cancel-"));
    const init = join(dir, "init.lua");
    await writeFile(init, "vim.fn.input('Under startup prompt: ')\n");
    const editor = await Editor.launch({ argv: [nvim!, "-u", init] }, dir);
    editor.host.attach(() => {});
    const ready = editor.ready();
    const rejection = expect(ready).rejects.toThrow();
    try {
      await Bun.sleep(100);
      editor.abortInitialization();
      await rejection;
    } finally {
      await editor.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
  10_000,
);
