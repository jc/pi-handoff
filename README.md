# pi-handoff

> [!IMPORTANT]
> This repository is a customized fork of [default-anton/pi-handoff](https://github.com/default-anton/pi-handoff).
>
> **What this fork adds**
> - **Portable handoff files** with `/handoff-save`, `/handoff-load`, and `/handoff-view` for cross-directory and worktree workflows
> - **Draft mode** via `/handoff --draft`, so you can review or tweak the generated handoff before sending it
> - **Custom file paths and cleanup options**, including `--path` and `/handoff-load --delete-after-load`
>
> The rest of this README largely follows upstream so future syncs stay simple.

Handoff command extension package for [pi](https://github.com/badlogic/pi-mono).

## Installation

From npm (after publish):

```bash
pi install npm:pi-handoff
```

From git:

```bash
pi install git:github.com/default-anton/pi-handoff
```

Or use without installing:

```bash
pi -e npm:pi-handoff
# or
pi -e git:github.com/default-anton/pi-handoff
```

## What it does

- Registers `/handoff`, `/handoff-save`, `/handoff-load`, and `/handoff-view` commands.
- Generates a concise handoff note from current session context.
- By default: `/handoff` creates a new session linked to the current session and sends handoff context plus task immediately.
- Cross-directory/worktree workflow:
  - `/handoff-save ...` generates and saves a portable handoff file (default: `~/.pi/handoff/latest.md`).
  - `/handoff-load ...` loads that file into the current session.
  - `/handoff-view ...` previews the file in editor without sending.

## Command usage

```bash
/handoff [--draft] <goal or task for new thread>
/handoff-save [--path <path>] <goal or task for new thread>
/handoff-load [--path <path>] [--view] [--delete-after-load]
/handoff-view [--path <path>]
```

Examples:

> Note: `--write` on `/handoff` has been replaced by `/handoff-save`.

```bash
# Default: create a new linked session and send the handoff there
/handoff now implement this for teams as well

# Draft-only: keep current session, place prompt in editor for manual copy/paste
/handoff --draft execute phase one of the plan

# Save a portable handoff file (default path: ~/.pi/handoff/latest.md)
/handoff-save check other places that need this fix

# Save to a custom file
/handoff-save --path ~/.pi/handoff/teams-fix.md check other places that need this fix

# In another directory/worktree session, load and send it automatically
/handoff-load

# Preview without sending
/handoff-view
# (or via handoff-load)
/handoff-load --view

# Load and remove the file afterwards
/handoff-load --delete-after-load

# Load/view from a custom path
/handoff-load --path ~/.pi/handoff/teams-fix.md
/handoff-view --path ~/.pi/handoff/teams-fix.md
```

## Requirements

- pi coding agent with extension loading enabled.

## License

Apache-2.0
