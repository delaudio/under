# Architecture decisions

## Runtime and UI

Under uses TypeScript, Bun's PTY API, and OpenTUI Core 0.6.1. The core renderer
provides Ghostty-backed `EmbeddedTerminalRenderable`. Using Core directly avoids
adding React solely to wrap imperative terminal lifetimes. Dependencies are
pinned and a Bun lockfile is committed. OpenTUI version upgrades require
rerunning the terminal and visual checks.

The source launcher is the distribution format for the first release. A
compiled executable is deferred until native artifact loading and platform
packaging have their own verified release workflow. No speculative binary
download or package name is advertised.

## Modules

| Module | Responsibility |
| --- | --- |
| `model.ts` | Workspace/tab/pane metadata and split geometry |
| `pty.ts` | Owned process group, PTY input/output, resize and cleanup |
| `editor.ts` | Neovim startup, MessagePack-RPC and buffer operations |
| `input.ts` | Explicit terminal/application/modal input ownership |
| `app.ts` | Terminal views, command routing and UI lifecycle |
| `bridge.ts` | Private per-workspace socket for opening editor locations |
| `context.ts` / `git.ts` | Explicit live-buffer and disk-diff context |
| `config.ts` / `state.ts` | Validated settings and metadata persistence |
| `main.ts` | CLI parsing and runtime startup |

## Terminal integration

Every embedded CLI is a real interactive process. Child output feeds its
terminal emulator continuously, including while hidden. Encoded keys, paste,
mouse and terminal-query replies flow back to the PTY. Resizing the pane resizes
the PTY; a SIGWINCH is sent explicitly for detached PTYs.

Pre-attach output is buffered without truncating VT sequences. An unattached
producer that exceeds the bound is stopped instead of rendering a corrupted
stream. Scrollback is bounded. UI visibility does not own process lifetime.

## Neovim

Neovim runs its normal TUI with `--listen` and a private socket. PTY rendering is
separate from RPC. The UI mounts before waiting for `vim_did_enter`, allowing
interactive user-config startup prompts. RPC verifies an instance marker and
has bounded calls. Filenames and locations are passed as arguments rather than
interpolated into Ex or Lua commands.

Opening a file preserves other buffers, including modified ones with destructive
`bufhidden` settings. Normal shutdown refuses unsaved work. A disconnect during
quit is accepted only after the owned Neovim process actually exits.

## Agent integrations

The first integration contract is the native CLI, not a rewritten chat view.
Under starts configurable argv in the workspace directory and leaves login,
approval and conversation behavior to the provider. Process phase and semantic
agent status are separate concepts. A future hook integration may supply
authoritative working/blocked/done events; scraping terminal text is not an
authoritative status source.

Context submission uses a preview followed by paste, leaving actual submission
to the user. It is bounded and revalidates source state. No automatic broad
context collection or transcript persistence is introduced.

## Yazi and Hunk

A private editor wrapper and socket are scoped to each workspace. `$EDITOR` and
`$VISUAL` are changed only in Under's child environment. Yazi's user-configured
openers remain intact. The wrapper supports Hunk's Vim-style `+line` argument.

Hunk 0.23.0 publishes `HunkDiffView` under `hunkdiff/opentui` with an MIT license,
but that package uses a different OpenTUI version from Under. The first release
therefore embeds its supported standalone CLI and avoids coupling native runtime
versions. Native component composition remains an optional future integration.

## Persistence and deferred features

Only versioned metadata is persisted, using a private temporary file and atomic
rename. Layout restore is not live-session restore. Unsupported state versions
and bad references are rejected. No repository commands run during discovery or
restore. Persistent server/detach, SSH, automatic native-session resume and
structured agent adapters require independent lifecycle contracts.

## Primary API references

- [OpenTUI embedded terminal](https://opentui.com/docs/components/embedded-terminal/)
- [Bun subprocess and PTY API](https://bun.com/docs/runtime/child-process)
- [Neovim RPC/API](https://neovim.io/doc/user/api/)
- [Hunk](https://github.com/modem-dev/hunk)
- [Yazi opener configuration](https://yazi-rs.github.io/docs/configuration/yazi/#opener)
