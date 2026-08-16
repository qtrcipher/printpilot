# House Rules — PrintPilot (working name)

Open source desktop tool for Windows and Linux: control a network printer's menu
remotely (born from a Canon MF750 with a dead touchscreen). NOT an iOS project —
any iOS-specific skill guidance applies only in adapted form.

## Session routine
- **Start:** read `PROGRESS.md` first. Work top to bottom. If a task is already
  checked, confirm with the user before redoing it.
- **End:** check off what's done, add a session-log line to `PROGRESS.md`, commit.
- **Phase 0 is a gate:** no implementation code until every Phase 0 item is checked.

## Engineering rules
- No manual testing as a verification strategy — automated tests travel with each feature.
- Minimal diffs; match surrounding conventions; no speculative abstractions.
- Tests must not require a physical printer — record fixtures from real devices.
- Docker may be used locally for reproducible builds.

## Git
- Commit at session end (user standing instruction). No force-push, no history rewrites.
- Tags are for releases only.
