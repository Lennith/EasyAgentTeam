# Platform Support

## Current Status

- Windows: fully supported and regression-protected
- Linux: main product runtime is supported for deployment and agent execution
- macOS: design-compatible, but not fully validated yet

## What Changes By Platform

- Agent prompt baseline changes with the host platform
- MiniMax shell tool registers only shells that exist for the host platform
- Default CLI commands for `codex` and `trae` change with the host platform
- Workspace `AGENTS.md` runtime guide changes with the host platform

## Not Included Yet

- `TeamTools/*.ps1` remains Windows-only
- `E2ETest/*.ps1` and `gate:standard` still route through PowerShell wrappers and are Windows-only for now

## What Users Should Expect

- On Windows, Agent instructions and shell tools use PowerShell/CMD
- On Linux, Agent instructions and shell tools use bash/sh
- On macOS, Agent instructions follow POSIX shell rules, but manual validation may still be needed
