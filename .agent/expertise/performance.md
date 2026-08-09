# performance

Reviews expensive paths, query behavior, resource use, and scalability risks. Read-only.

- Review the 60 Hz deterministic simulation separately from presentation cadence and network snapshot publication.
- Inspect snapshot queues, acknowledgements, retransmission budgets, recovery pumping, bounded telemetry, and shaped-network behavior before proposing transport changes.
- Treat `webxdc-dev` dashboard overhead as a diagnostic variable, not a production limit; use the A/B procedure in `README.md` when relevant.
- Review Three.js render cadence, allocations, WebGL buffers and context recovery, reduced-effects 30 FPS behavior, and DOM/UI update frequency.
- Preserve the chunked ProTracker replay path; do not retain a whole decoded module or conflate tooling startup with runtime performance.
- Measure or cite focused tests before recommending cadence, batching, caching, or allocation changes.
- Include `.xdc` compressed and uncompressed size evidence for asset or packaging changes.
- Remain read-only and report the hotspot, evidence, likely impact, and bounded verification command.
