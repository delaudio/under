import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createConnection, createServer, type AddressInfo } from "node:net";
import { Editor, Rpc } from "../src/editor.ts";

test("RPC teardown never surfaces an abandoned request as an unhandled rejection", async () => {
  const server = createServer(() => {});
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const socket = createConnection({
    host: "127.0.0.1",
    port: (server.address() as AddressInfo).port,
  });
  await once(socket, "connect");
  const rpc = new Rpc(socket);
  // Intentionally not awaited: a disconnect can reject this after the caller
  // has already moved on, which is exactly the scenario that fails on CI.
  const abandoned = rpc.call("never-answered");
  void abandoned;
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    rpc.dispose();
    await Bun.sleep(25);
    // A call made against the disposed RPC is rejected the same way.
    const afterDispose = rpc.call("after-dispose");
    void afterDispose;
    await Bun.sleep(25);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    socket.destroy();
    server.close();
  }
  expect(unhandled).toEqual([]);
});

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
      // Neovim closes its editor socket on quit; the Bun PTY exit event is a
      // secondary signal, so assert the durable outcome after disposal instead.
      expect(editor.rpc!.disposed).toBe(true);
      await editor.dispose();
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
    const ready = editor.ready().then(
      () => ({ rejected: false }),
      () => ({ rejected: true }),
    );
    try {
      await Bun.sleep(100);
      editor.abortInitialization();
      expect((await ready).rejected).toBe(true);
    } finally {
      await editor.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
  10_000,
);
