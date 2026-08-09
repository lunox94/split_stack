# Orchestrator contract

The visible orchestrator owns user communication, Hermes memory, skill selection, planning transitions, delegation, and final synthesis. Workers never query Hermes and never recursively delegate.

## Solo versus team

Use solo mode for direct answers and tightly bounded changes where delegation costs more than it saves. Use team mode for independent investigations, cross-stack implementation, or risk-based validation. Select the smallest role set and run at most three independent workers concurrently. Writable workers receive distinct worktrees. Retry a failed worker once, then report the evidence and choose a different approach.

## Planning transition

Enter planning with `/plan`. When exploration or plan writing is ready, the assistant calls `ask_user_question` with the reference workflow's fixed choices. Only the returned user choice transitions into writing or execution. A user may also explicitly invoke `/plan execute` from write-plan mode. Ordinary assistant prose never triggers execution.

Use `to-spec` after intent is settled when a durable specification is useful. Add `to-tickets` only when the work is larger than one agent session or needs tracker-visible dependency edges. These are explicit workflows, not automatic effects of planning.

## Skills and briefs

Upstream skills are pinned and unchanged. Apply the local registry in `.agent/skill-policy.yaml`. The orchestrator chooses skills; a worker receives only the relevant constraints in its self-contained brief. Every team brief names `profileName`, `title`, `goal`, `contextHints`, `pathScopeRoots`, and `expectedOutput`. Require the exact `<final_answer>` completion contract from the worker bundle.

## Split Stack routing

- Default to solo work. Enable the flat team for independent investigation, changes spanning at least two architecture seams, or an implementation that benefits from independent verification.
- Route deterministic simulation, scoring, powers, and rules-hash work to `gameplay-rules`; Webxdc protocol, match lifecycle, recovery, and convergence to `realtime-webxdc`; Three.js, UI, input, audio, and accessibility to `experience`; and build, manifest, offline asset closure, or archive integrity to `platform-release`.
- Treat `src/app` and `tests` as shared boundaries. Before parallel writable work, assign disjoint files and dedicated worktrees. QA edits only explicitly delegated tests and reports product defects rather than repairing implementation code.
- Every team-mode implementation receives an independent `verifier`. Add QA for behavior changes; security/privacy for identity, message validation, storage, telemetry, secrets, or external-boundary changes; and performance for simulation cadence, networking queues, rendering, allocations, audio streaming, or archive-size risks.
- Require focused evidence while iterating and `npm run check` for integrated product changes. Packaging changes additionally require `npm run build` and `npm run verify:xdc`; agent-runtime changes require the checks in `AGENTS.md`.
- Preserve the sensitive invariants indexed by `AGENTS.md`; detailed project truth remains in `README.md`, `CONTEXT.md`, `IMPLEMENTATION_DECISIONS.md`, and the role expertise files.
