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

| Module                   | Responsibility                                            |
| ------------------------ | --------------------------------------------------------- |
| `model.ts`               | Workspace/tab/pane metadata and split geometry            |
| `pty.ts`                 | Owned process group, PTY input/output, resize and cleanup |
| `editor.ts`              | Neovim startup, MessagePack-RPC and buffer operations     |
| `input.ts`               | Explicit terminal/application/modal input ownership       |
| `app.ts`                 | Terminal views, command routing and UI lifecycle          |
| `bridge.ts`              | Private per-workspace socket for opening editor locations |
| `context.ts` / `git.ts`  | Explicit live-buffer and disk-diff context                |
| `config.ts` / `state.ts` | Validated settings and metadata persistence               |
| `main.ts`                | CLI parsing and runtime startup                           |

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
`$VISUAL` are changed only in Under's child environment. Yazi receives a temporary `YAZI_CONFIG_HOME`: theme, plugins, flavors, keymap
and init are linked from the original config; parsed TOML sets the manager ratio
to `[0, 1, 0]` (one current-directory column) and changes `opener.edit`.
Its command uses `%s` or `"$@"` to match the installed Yazi's opener placeholder
syntax. Other opener definitions and file rules are preserved. Temporary
directories are removed during shutdown. The wrapper supports Hunk's Vim-style
`+line` argument.

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

## Visible workspace and preview boundary

The default code tab contains native Yazi on the left, Neovim in the centre and
an agent chooser on the right. Yazi uses native input and the workspace editor
bridge. A per-workspace FileBrowser provides a basic fallback when Yazi is not
running. Hidden/collapsed panels keep their processes; narrow terminals can reveal
files or cycle tool panes. Review actions start/reuse separate working-tree and
staged Hunk tabs after checking for a Git working tree.

OpenTUI 0.6.1's embedded VT reports support for in-band resize events (mode 2048)
but does not emit those events when it resizes. Neovim then ignores SIGWINCH and
keeps its previous dimensions, causing wrapping and scrolling to corrupt the
visible pane. The response adapter in `src/terminal.ts` reports mode 2048 as
unsupported so tools use normal PTY resize signals. It changes only generated
terminal responses; user input and child output pass through unchanged. See
[Neovim's resize-mode and SIGWINCH handling](https://github.com/neovim/neovim/blob/master/src/nvim/tui/tui.c).

Ctrl-G l still offers an explicit full repaint through the pinned renderer's
compatibility shim. Ordinary frames use incremental rendering. Cursor mapping
remains owned by the focused visible terminal. The real Neovim regression test
checks its actual rows/columns, arrow-key scrolling, visible line order, cursor
position, background output and resize/zoom transitions.

Pane resizing works from the mouse and the keyboard. `splitHandles()` derives the
draggable boundaries from the same rectangle geometry the panes are laid out
with, and `setSplitRatio()` adjusts one split by path inside the range the state
validator accepts. A transparent overlay renderable sits on each boundary, above
the panes and below modals; it highlights on hover, captures the drag and never
lets a grab reach a tool's own mouse handling. Pointer capture can land on a pane
mid-drag, so pane frames continue the same drag. Pane borders keep their glyphs
because the handle is inset from the outline.

Top menus and the palette share the same commands and availability checks.
Menu cell positions are recalculated after resize and wrapping. Dropdowns and
forms own input until dismissed. Project-defined commands and agent launches
continue to require an explicit action; restore launches no processes.

The Storybook generator injects synthetic configuration/files and read-only
PTY/editor adapters into the production App. OpenTUI captures cell colors,
attributes and widths. Browser Storybook only imports those generated frames,
never Bun terminal code. Playwright checks the catalog, frame/story mapping,
reviewed baseline inventory and exact terminal element screenshots. Real tool
startup and editing are established by the separate PTY tests.
