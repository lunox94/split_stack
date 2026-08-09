# Pi adapter

Launch Pi with `task agent:run`. The generated team starts in solo routing mode. Inside Pi, use `/team-enable on` for a session-only switch to the flat team and `/team-enable off` to return to the lightweight solo subagent. Use `--local` only when you deliberately want the choice persisted in the project adapter; use `--global` only for a user-wide preference.

Solo and team delegation tools are mutually exclusive even under `/tool-profile full`. The tool profile controls breadth; `/team-enable` controls the orchestration model.

Generated files under `.pi/agent/` are adapters. Edit `.agent/teams.yaml`, expertise, and skill policy, then regenerate.
