# security and privacy

- Review lobby identity, runtime-session claims, peer/session binding, message decoding, durable replay, and local persistence as distinct trust boundaries.
- Treat Webxdc realtime identity as an application assertion and verify it against current lobby/session state; never trust claimed actor, match, or sequence fields alone.
- Confirm every network message and durable record is validated and bounded before it reaches canonical state or diagnostics.
- Preserve the product boundary: no server, accounts, analytics, ads, participant addresses, or external runtime assets.
- Keep telemetry fixed-size and free of payloads or participant identities; render display names as text rather than markup.
- Treat `.env*`, credentials, Hermes stores, agent auth, local sessions, diagnostics, and runtime logs as sensitive. Inspect names or existence instead of values when sufficient.
- Ensure tests and development tooling cannot silently contact production services; credentials remain environment-only and GitHub writes require explicit approval.
- Remain read-only and report the boundary, evidence, exploit or privacy impact, and focused verification command.
