import type { Subprocess, Terminal } from "bun";
import type { Profile } from "./config.ts";
export type Phase = "running" | "stopping" | "exited" | "error";
export class PtyHost {
  terminal: Terminal;
  process: Subprocess;
  phase: Phase = "running";
  private sink?: (bytes: Uint8Array) => void;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private closing?: Promise<void>;
  exitCode: number | null = null;
  constructor(profile: Profile, cwd: string, cols = 80, rows = 24) {
    if (!profile.argv.length) throw new Error("Missing command");
    this.terminal = new Bun.Terminal({
      cols,
      rows,
      data: (_, bytes) => {
        if (this.sink) this.sink(bytes);
        else {
          this.pending.push(bytes.slice());
          this.pendingBytes += bytes.length;
          // Never truncate escape sequences. Abort a pathological unattached producer.
          if (this.pendingBytes > 1024 * 1024) {
            this.phase = "error";
            void this.close().catch(() => {});
          }
        }
      },
    });
    try {
      this.process = Bun.spawn({
        cmd: profile.argv,
        cwd,
        detached: true,
        terminal: this.terminal,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          ...profile.env,
          PWD: cwd,
        },
      });
    } catch (e) {
      this.terminal.close();
      throw e;
    }
    void this.process.exited.then((code) => {
      this.exitCode = code;
      if (this.phase !== "error") this.phase = "exited";
    });
  }
  attach(sink: (bytes: Uint8Array) => void) {
    if (this.sink) throw new Error("PTY already has an output consumer");
    this.sink = sink;
    for (const bytes of this.pending) sink(bytes);
    this.pending = [];
    this.pendingBytes = 0;
  }
  write(bytes: Uint8Array) {
    if (this.phase === "running") this.terminal.write(bytes);
  }
  resize(cols: number, rows: number) {
    if (this.phase !== "running") return;
    this.terminal.resize(
      Math.max(1, Math.floor(cols)),
      Math.max(1, Math.floor(rows)),
    );
    try {
      this.process.kill("SIGWINCH");
    } catch {
      /* exited */
    }
  }
  close(): Promise<void> {
    return (this.closing ??= this.cleanup());
  }
  private async cleanup() {
    this.phase = "stopping";
    const alive = () => {
      try {
        process.kill(-this.process.pid, 0);
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw e;
      }
    };
    const signal = (s: NodeJS.Signals) => {
      try {
        process.kill(-this.process.pid, s);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
      }
    };
    const wait = async () => {
      const end = Date.now() + 1500;
      while (alive() && Date.now() < end) await Bun.sleep(25);
      return !alive();
    };
    try {
      signal("SIGTERM");
      if (!(await wait())) {
        signal("SIGKILL");
        if (!(await wait()))
          throw new Error(`Process group ${this.process.pid} survived cleanup`);
      }
      await this.process.exited;
      this.phase = "exited";
    } catch (e) {
      this.phase = "error";
      throw e;
    } finally {
      this.terminal.close();
    }
  }
}
