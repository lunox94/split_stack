# realtime Webxdc

- Own delegated code under `src/network`, `src/match`, persistence and competition lifecycle/recovery areas of `src/app`, plus corresponding tests.
- Preserve the distinction between ephemeral realtime frames and bounded durable competition events; `update.serial` is replica-local, never a global order.
- Validate and bound every decoded message, bind realtime identity to the active lobby/session, and keep duplicate runtimes read-only once a match is controlled.
- Maintain convergent competition state, deterministic snapshots, compatibility handshakes, reliable critical delivery, bounded retries, and recovery from visibility or channel replacement.
- Keep telemetry fixed-size and free of payloads, participant identities, addresses, or unbounded event history.
- Use manual clocks and `ShapedRealtimeBus` for deterministic latency, loss, duplication, bandwidth, queue, and asymmetric-network tests.
- Do not infer production throughput from the Webxdc simulator dashboard alone; follow the diagnostic procedure in `README.md`.
- Run focused network/app tests while iterating and `npm run check` after integration; request security/privacy review for trust-boundary changes.
