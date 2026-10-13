# Validation

## Recorded evidence

On 2026-10-12, revision `006c71413df29f5ac804c25edb614145b4f82fd7`
passed strict TypeScript checking and **all 22 tests with no skips** on both
Linux x86_64 and macOS arm64. The run also passed executable launcher help and
version checks. [CI evidence](https://github.com/delaudio/under/actions/runs/38259665664).

The suite includes full-app SIGTERM cleanup, cancellation during a real Neovim
startup prompt and end-to-end child-to-editor opening of a filename with spaces,
quotes and Unicode at a specified line. Cell-frame previews live in the Storybook
catalog; see [coverage and limitations](../storybook/COVERAGE.md).

## Current working-tree validation

The first-use changes add a launcher-level PTY test using an isolated normal
Neovim `init.lua`, file opening from the browser, Unicode insertion/saving,
menu input ownership and return to editing after dismissal. The test does not
use `--clean` or disable automatic initial editor launch. Directory containment,
wrapped-menu mouse positions and unavailable agent actions have native tests.

On 2026-10-12, local macOS arm64 verification with Bun 1.4.3 and Neovim
0.12.5 passed strict checking, all 65 native tests with no skips, Storybook
checking/build, and all 44 browser checks (43 screenshot comparisons and one
catalog/inventory check). Baselines were inspected before comparison. A separate
local probe confirmed startup and input with the owner's ordinary Neovim
configuration without saving file changes. The in-band resize-report adapter has
a captured regression: bypassing it leaves Neovim at its previous dimensions
after a pane resize (expected 55×26, observed 70×34). This is local evidence; the
new CI workflow has not yet run for these uncommitted changes.

The browser visual gate renders the production App and terminal panes into
43 native frames and compares Chromium element screenshots. See
[coverage and limitations](../storybook/COVERAGE.md). The visual CI job uses
macOS baselines; the native CI job retains Linux and macOS tool checks.

Cleanup also handles a denied group probe only after a reaped leader and a
process-table check prove the PTY group is absent; live-group permission errors
remain failures, with explicit regression tests.

The installed Bun 1.3.8 crashed during the original socket/PTY test run. The
launcher now enforces Bun >=1.4.3 before importing the TUI. Passing tests with
an isolated Neovim configuration establish the default workflow, not every
personal plugin/theme configuration or authenticated provider session.

## Automated gates

`bun run check` runs strict TypeScript checking and Bun tests. GitHub Actions
executes the same gate on Linux x86_64 and macOS arm64, installs real Neovim,
Yazi, Hunk and all three agent CLIs, and checks launcher help/version.

Coverage includes:

- split geometry, focus ownership, invalid configuration and corrupt state;
- private editor bridge isolation, arbitrary filename handling and error replies;
- VT alternate screen, truecolor, Unicode, query responses, paste and resize;
- hidden terminal output and idempotent process cleanup;
- actual Neovim RPC, unsaved-buffer refusal and opening another file;
- real application rendering and keyboard interaction at 120×30, 80×24 and 50×15;
- real Yazi/Hunk interactive screens, resize and Hunk watch refresh;
- themed Yazi configuration isolation and opening through the existing editor bridge;
- working/staged Review tab reuse, retained modified buffers, missing-tool/non-Git feedback;
- cursor-only updates, background output, menu ownership, clipping and resize with live panes;
- dragging a split boundary with the mouse resizes it, clamps at the minimum and maximum, keeps focus and sends no terminal input;
- every layout template, applied with its shortcut, hides and re-shows panes without stopping them, recreating them or quitting the editor;
- user-declared templates are validated field by field, merged over the built-ins, listed in the menu and reachable by their configured key;
- a review targets another directory or a revision, is reused per target, and Yazi's review bindings reach Under without shadowing the user's keys;
- entering navigation mode is visible in the footer and the shortcut help opens from both `h` and `?`;
- RPC teardown races reject in-flight requests without an unhandled rejection;
- quit confirms editor exit from the editor socket and the process table, not only the PTY exit event;
- the lockfile resolves packages from the public registry only, so a mirror or private registry cannot be published with it;
- actual Neovim geometry after startup/resize/zoom and arrow-key scrolling with relative numbers, cursorline and Unicode;
- native Codex/Claude/OpenCode CLI execution in embedded PTYs.

The agent smoke tests use `--help`; authenticated model conversations and approval
prompts are a manual validation, not something these tests claim to verify.

The original authoring container permitted PTYs but denied Unix socket listeners.
Checks in that environment used `UNDER_NO_SOCKETS=1` and report socket-dependent tests as skipped.
That flag is never used by the CI gate. Missing tools also produce explicit
test skips locally; CI installs them before running tests.

## Versions

Application dependencies: Bun 1.4.3, OpenTUI Core 0.6.1, TypeScript 5.9.3,
MessagePack 3.1.3. CI fixes Hunk 0.23.0, Codex 0.162.1, Claude Code 2.1.296,
OpenCode 1.19.0 and Linux Neovim 0.11.5/Yazi 25.5.31. macOS Homebrew versions are
reported in the CI log rather than assumed. A tested version is not a promise
that every prior/future version works.

## Manual authenticated-provider checklist

For each provider on your actual setup:

1. Authenticate using the provider's normal CLI.
2. Start it through Under's palette; confirm its normal UI and login state.
3. Resize/zoom/hide the pane; confirm its conversation remains active.
4. Preview a small file or Visual selection; paste it, review and submit.
5. Confirm a native permission prompt remains usable without bypassing it.
6. Stop/restart explicitly; verify ordinary child tools terminate and external
   shared daemons remain untouched.
7. With an unsaved Neovim buffer, attempt Quit; confirm all sessions remain usable.

These checks require the owner's authenticated installations and are not
reported as performed by an unauthenticated runner.

## First-use checklist

Open a clean checkout using the README instructions. Verify your Neovim theme
and plugins, open a file from Yazi and a changed line from Hunk, run your task,
then save layout and restart with `--restore`. Restored panes should remain
stopped until explicitly started.
