# Customizing the agent scaffold

This directory is the tool-neutral source of truth. Generated Pi team JSON and bundles are adapters; regenerate them instead of hand-maintaining them. Project-local Pi runtime and extension files remain committed mechanics.

## Resolution loop

1. Search for `<!-- SCAFFOLD:BEGIN`.
2. Inspect the repository evidence named by that block.
3. Replace the entire marked block with concise project truth. Remove both markers; do not change them to a resolved status.
4. Run `task agent:team:generate`.
5. Review `task agent:corpus:report`, then record the intentional result with `task agent:corpus:baseline`.
6. Run `task agent:validate` and `task agent:fixed-layout:test`.

Required unresolved blocks intentionally keep team mode disabled. Solo Pi remains usable while the scaffold is being customized. Launch it through `task agent:run` so Ponytail stays in full mode and Pi loads only the project-selected skills. The launcher disables ambient global skill discovery, then explicitly adds the local scaffold, selected Matt skills, and pinned package skills.

## Team model

The visible orchestrator owns memory, skill selection, planning transitions, and final synthesis. The runtime team is flat: workers cannot spawn workers. Leads coordinate by returning recommendations to the orchestrator; writable implementation workers use distinct worktrees. The default concurrency ceiling is three, with one retry.

Workers receive self-contained bundles and do not query Hermes. That keeps specialist context predictable while the orchestrator retains cross-session memory.
