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

### Hover previews

The overlay's `init.lua` is a small hook followed by the user's own file
(prepended, so a trailing top-level `return` stays valid). When
`UNDER_HOVER_FILE` is set, the hook subscribes to Yazi's `hover` event and rewrites that
file with the hovered path whenever it changes. Under sets the variable only for
its Yazi panes and watches the overlay directory. The hook only subscribes to an
event, so Yazi's stdout — and the programs Yazi starts, which inherit it — stay
untouched (an earlier `--local-events` stdout redirection would have captured
their output). Hovers are acted on only while that Yazi pane has focus in
terminal mode; repeats of the pending or last path are dropped before the 90 ms
debounce, so only the stop position loads. An explicit open cancels a pending
preview and, through a generation counter, one already in flight. Preview loads
suppress the swap-file prompt (`shortmess+=A`), which would otherwise block
Neovim while focus is elsewhere, and never replace a floating, special-buftype or
`winfixbuf` window nor leave it: the file loads into another normal window of the
tab page through `nvim_win_call`, or the preview is skipped. Buffers already
loaded by LSP or plugins count as the user's and are never deleted. Previews never move Under's focus.

`Editor.openFile(..., preview)` marks a buffer it had to create with
`b:under_preview` and remembers it in `g:under_preview_buf`; the next preview
deletes it only if it is still flagged, unmodified and not shown in another
window. `BufModifiedSet`/`InsertEnter` and any normal open clear the flag. Opened
buffers are listed, as with `:edit`.

### Editor tabs and following the active file

After start-up `Editor.watchBuffers` installs `UnderBuffers` autocommands
(`BufEnter`, `BufAdd`, `BufDelete`, `BufWipeout`, `BufModifiedSet`,
`BufFilePost`) that coalesce through `vim.schedule` and `rpcnotify` the listed
file buffers, the current one and their preview flags; `Rpc` now dispatches
notifications. `src/tabs.ts` lays them out in the pane's title row with
`StyledText`, returning column hit ranges for tab bodies and close glyphs.
Closing switches every window showing the buffer to the alternate (or another
listed, or a new empty) buffer before `nvim_buf_delete`, and refuses modified
buffers. It uses `:bdelete`, so marks and undo survive a reopen. Selecting a tab
clears its preview flag.

The same notification drives following: when the current file changes and lies
inside the workspace, Under reveals it in each Yazi pane of the tab that does not
have focus (the existing reveal key) and in the fallback list unless it has
focus. Hover previews therefore never move the Yazi cursor under the user.

Hidden files use two reserved Yazi keys bound to `hidden show` / `hidden hide`
(explicit states, so Under and Yazi cannot drift as with `hidden toggle`). The
overlay records which keys it bound in `under-bindings.json`; a key the user
already owns is never sent. The
fallback list filters dotfiles and asks `git check-ignore --stdin` for ignored
names, treating any Git failure as "nothing ignored".

## Themes

`src/theme.ts` resolves a palette (`flat` or `classic`) plus explicit colour
overrides; the App reads it through a getter so configuration reloads apply on
the next frame. `runtime/nvim` is appended to Neovim's `runtimepath` after
start-up, providing `colors/under-flat.lua`; it is applied only with
`editorTheme`, after the user's configuration.

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

Quick Open and the destination switcher are two more list modals on the same
machinery: `modalItems()` returns the rows for whichever modal is open, so
filtering, arrows, paging, mouse clicks and paste behave identically everywhere.
The context preview uses the same machinery for its destination picker: running
agents are listed across every tab of the workspace, and the payload waits in
`pendingPreview` until a row is chosen. Dismissing the picker drops it, while
selecting a row closes the picker first and still needs it, so the payload is
only discarded when the picker was not the modal being closed. The chosen
destination is remembered per workspace, and confirmation re-checks that the pane
is still the same running agent before pasting.
`src/search.ts` owns the file side: `listFiles()` prefers
`git ls-files --cached --others --exclude-standard` so a repository's ignore
rules decide the candidates, falls back to a bounded walk with a fixed skip list,
and `fuzzyScore()`/`rank()` order the results with a stable index tiebreak.
Enumeration happens once when the modal opens and filtering is then in memory, so
typing stays responsive; a generation counter drops results from a modal the user
already closed. Candidates for the active workspace are cached per workspace, and
the recent files that fill an empty query are remembered per workspace too.
The overlay's row count is derived from the height it is about to have rather
than read back from the renderable, whose computed size lags a layout pass.

Worktree discovery lives in `src/git.ts`: `listWorktrees()` runs only
`git worktree list --porcelain -z`, bounded in time and output, and parses the
records with `parseWorktrees()`. `worktreeLabel()` names each entry by branch and
its last two path segments, so sibling checkouts that share a basename stay
distinguishable, and `worktreeBlocker()` explains why an entry cannot be opened.
The list is re-read on every request, so worktrees created or removed outside
Under appear immediately, and opening one creates a workspace without starting a
tool. Nothing about a worktree is persisted: it is derived state, so a workspace
pointing at a worktree restores like any other folder.

Layout templates are a catalogue in `src/model.ts`: each names the panes it shows
and the layout over them, in the order the tab already holds. `applyTemplate()`
reuses a pane of the required kind, preferring one that is currently visible, and
only falls back to creating a stopped placeholder. It never starts, stops or
reloads a pane, so a chat thread and unsaved editor buffers survive switching
templates. Because a template arranges a subset, a tab's layout may reference
fewer panes than it holds; the panes left out are hidden and keep running, and
state validation accepts that while still requiring every leaf to be a pane and
the focused pane to be visible. Keyboard cycling walks the visible layout order,
so hidden panes stay out of the way. `config.preset` still selects the workspace's
initial template.

The Storybook generator injects synthetic configuration/files and read-only
PTY/editor adapters into the production App. OpenTUI captures cell colors,
attributes and widths. Browser Storybook only imports those generated frames,
never Bun terminal code. Playwright checks the catalog, frame/story mapping,
reviewed baseline inventory and exact terminal element screenshots. Real tool
startup and editing are established by the separate PTY tests.

A review is a pane like any other, so it can be scoped. `Pane` carries an optional
absolute `cwd` and optional `args`; `startPane()` runs the pane there and
`withArgs()` inserts the arguments before a trailing `--watch`, which is how a
revision reaches `hunk diff <target> --watch`. `openReview()` keys tab reuse on
the profile, directory and revision together, so two worktrees or two revisions
get their own tab. The directory may sit outside the workspace: it is chosen
explicitly, and the file browser's containment rule is unaffected.

Tools can ask Under for a review over the existing per-workspace socket. The
bridge message grew a `kind` discriminator, so `review-here` carries the
directory the tool is running in rather than a file location. Yazi needs no
guessing: the temporary configuration also writes a merged `keymap.toml` whose
`prepend_keymap` entries run Under's helper with the `shell` action, which Yazi
executes in its current directory. Bindings are only added on keys the user's own
`keymap.toml` has not taken.
