# Agent integrations

Pi Lens/LSP, web access, markdown preview, Hermes, context-mode, Ponytail, MCP, and the fixed-layout package are declared in `.pi/settings.json`. Git packages and npm packages are pinned. Remote MCP services stay disabled until explicitly configured; credentials belong in the environment, never in committed files.

`task agent:run` fixes Ponytail to `full` mode. It launches Pi with ambient skill discovery disabled and explicitly loads only the project scaffold, the selected Matt corpus, and skills shipped by the pinned context-mode, Pi Lens, Ponytail, and MCP adapter packages. This prevents `~/.agents/skills` and `~/.pi/agent/skills` from shadowing or colliding with project skills.

`context-mode` is the only MCP service and runs locally from the locked `.pi` dependency graph. No project-specific remote MCP server is configured. Ordinary web access is development tooling only and must never introduce external runtime assets or network dependencies into the `.xdc` application.

Pi Lens provides TypeScript navigation, diagnostics, structural analysis, and linters to every engineering and validation role. It uses the repository's TypeScript version and may offer to install `typescript-language-server` into its user-managed tool directory on first use. Keep that installation explicit; do not add the server to application dependencies or enable broad automatic tool installation. The committed `.pi-lens.json` disables formatter and autofix mutations because this repository has not adopted Biome or Prettier.

Project-local npm Pi extensions are locked under `.pi/npm`; `task agent:bootstrap` restores them with `npm ci` before Pi reconciles Git packages. This runtime-only graph is separate from both the application's root npm graph and the core `.pi` Bun graph.

Credentials belong in the environment and are never committed. The current integration requires no project-specific credential variables.
