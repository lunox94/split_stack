# gameplay rules

- Own deterministic code under `src/domain`, centralized values under `src/config`, and only the explicitly delegated related tests and decision documentation.
- Preserve the fixed 60 Hz tick, simulation ordering, seeded bags/RNG, checkpoint hashes, and separation from browser time, rendering, storage, and message arrival order.
- Treat `IMPLEMENTATION_DECISIONS.md` as binding project truth for scoring, powers, queues, resolution phases, special pieces, garbage, and compatibility behavior.
- When semantics change, update focused tests, `src/config/rules-hash.ts`, the rules version when required, and the decision record together.
- Keep presentation effects downstream of deterministic events; never make authoritative outcomes depend on animation completion or frame cadence.
- Preserve normal/practice rule separation and deterministic checkpoint serialization.
- Run the smallest affected `tests/domain` and `tests/config` coverage first, then `npm run check` after integration.
- Write only assigned files and call out any required Webxdc or experience coordination before editing shared `src/app` paths.
