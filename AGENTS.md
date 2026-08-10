# Project agent guide

Start with `README.md` for architecture, development, validation, release, offline, and privacy constraints. Use `CONTEXT.md` for the domain language, `IMPLEMENTATION_DECISIONS.md` for deterministic rules and Webxdc decisions, and `docs/adr/` for durable architecture decisions. Agent runtime and team policy live under `.agent/`; GitHub tracking policy is in `docs/agents/issue-tracker.md`.

Use `npm ci` for application dependencies and `npm run check` as the integrated application gate. Run focused typecheck, Vitest, or Playwright checks while iterating. After implementation and specialist review stabilize, run broad gates once; rerun only gates affected by later file changes, with the final verifier owning full application/browser validation. Packaging changes also require `npm run build` and `npm run verify:xdc`. Agent-policy or runtime changes require `task agent:team:generate`, `task agent:validate`, and `task agent:fixed-layout:test` before commit. Agent-only changes do not require application/browser reruns unless application files also changed.

Preserve deterministic simulation order, rules hashing/version compatibility, convergent Webxdc state, bounded and validated messages, offline runtime assets, and privacy-safe telemetry. When game semantics change, update the relevant tests, `src/config/rules-hash.ts`, and `IMPLEMENTATION_DECISIONS.md` together. Never add server, account, analytics, advertising, or external runtime dependencies without an explicit product decision.

Default to solo execution. Use the flat team only for genuinely separable investigation, implementation, or risk-based validation; assign exact file scopes where `src/app` or tests overlap. External GitHub writes always require explicit user approval.
