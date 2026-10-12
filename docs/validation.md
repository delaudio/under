# Validation

## Recorded evidence

On 2026-10-12, revision `006c71413df29f5ac804c25edb614145b4f82fd7`
passed strict TypeScript checking and **all 22 tests with no skips** on both
Linux x86_64 and macOS arm64. The run also passed executable launcher help and
version checks. [CI evidence](https://github.com/delaudio/under/actions/runs/38259665664).

The suite includes full-app SIGTERM cleanup, cancellation during a real Neovim
startup prompt and end-to-end child-to-editor opening of a filename with spaces,
quotes and Unicode at a specified line. Three cell-frame layout fixtures are
stored under `docs/previews`; regenerate them with `bun run visual`.

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
- native Codex/Claude/OpenCode CLI execution in embedded PTYs.

The agent smoke tests use `--help`; authenticated model conversations and approval
prompts are a manual validation, not something these tests claim to verify.

The authoring container permits PTYs but denies Unix socket listeners. Local
checks use `UNDER_NO_SOCKETS=1` and report socket-dependent tests as skipped.
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
