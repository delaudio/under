# TUI visual coverage

49 stories capture the production OpenTUI App through its native test renderer.
The browser preview preserves text, foreground/background, bold, italic,
underline and cell widths; it uses bundled JetBrains Mono at 15px, 9×20px cells.

| Group | Coverage |
| --- | --- |
| Workspace | 120×30, 80×24, 50×15, 24×10; hidden files; empty directory; stopped-process restore; a resize captured mid-drag; navigation mode with its footer hint |
| Layouts | every layout template (chat, code, files-editor, review, files-review, editor-chat, editor, run, editor-chat-stack) plus a user-declared template |
| Files | Native Yazi pane with synthetic folder output; fallback selection at wide and narrow widths; real directory/opening behavior is checked by native tests |
| Worktrees | The repository picker at wide and narrow widths, with a linked, a detached and an unavailable entry |
| Menu | File, View, Review, Tools, Agent, Help; wrapped and scrolled menus; unavailable providers; checked toggles |
| Overlay | Command palette, help wide/tiny, open-file form, editor error and context preview |
| Search | Quick Open results at wide and narrow widths; the workspace/tab switcher |
| Review | A review scoped to a revision, shown by the pane title and the tab name |
| Agent | Idle chooser; synthetic Codex/Claude/OpenCode sessions; exited, stopping and error; choosing which running agent receives a context preview |
| Terminal | ANSI truecolor, Unicode/wide cells, bold, italic and underline in the real terminal renderable |

## Reproduce

Use Bun >=1.4.3 and Node >=22, then from the checkout root:

```sh
bun install --frozen-lockfile
bunx playwright install chromium
bun run storybook
bun run typecheck:storybook
bun run test:storybook:visual
bun run build-storybook
```

Each visual test checks the corresponding production-frame element. A catalog
check rejects missing/extra stories, frames or PNG baselines. Ordinary checks
use `updateSnapshots: none`; missing images and changed pixels fail.

To intentionally change the visual baseline:

```sh
bun run test:storybook:visual:update
# Inspect every changed PNG under visual/baselines/darwin/.
bun run test:storybook:visual
```

The reviewed baseline platform is Chromium from Playwright 1.57.0 on macOS.
CI runs the screenshot gate on `macos-latest`. Other platforms require their
own explicitly generated and reviewed `visual/baselines/<platform>/` directory;
the native tool integration suite runs on Linux and macOS independently.
The browser gate uploads actual/expected/diff results, its HTML report and the
static Storybook build. Generated frame JSON, build output and reports remain
ignored; reviewed PNG baselines are repository artifacts.

## Fixture limits

Generation uses synthetic `/fixtures/project` paths, fixed output and isolated
configuration. It never reads user HOME, starts an authenticated provider,
opens a real project or connects to a service. The terminal adapters reject
input. Context comes from a fixed unsaved-buffer snapshot, exercised through
the real palette/preview handler.

Frames are static. Agent stories show the host pane's lifecycle and sample
output; they do not certify provider branding, authentication or conversations.
Highlighted terminal text certifies rendering, not syntax parsing or a user's
theme. Use `bun run check` for actual PTY/Neovim behavior and the authenticated
provider checklist in `docs/validation.md` for native conversations.
