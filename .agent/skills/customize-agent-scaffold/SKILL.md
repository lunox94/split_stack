---
name: customize-agent-scaffold
description: Resolve this project's generated agent scaffold from repository evidence.
---

# Customize the agent scaffold

1. Read the root README integration and conflict rules.
2. Enumerate exact `<!-- SCAFFOLD:BEGIN` markers.
3. Resolve one concern at a time from current code, tests, docs, Taskfiles, and CI.
4. Replace the whole marked block with concise project truth and remove both markers. Never retain placeholder metadata.
5. Edit `.agent/` sources, not generated Pi team JSON or bundles.
6. Generate the team, validate fingerprints, run fixed-layout tests, and inspect the complete diff.
7. Keep team mode disabled until validation succeeds.
