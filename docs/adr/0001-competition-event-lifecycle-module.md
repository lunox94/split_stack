---
status: accepted
---

# Concentrate the Competition Event Lifecycle

Competition Event identity, durable delivery, canonical materialization, retry recovery, and chat feedback currently require callers to coordinate several shallow modules. We will place that complete lifecycle behind one deep Competition Event Lifecycle module: callers express Competition Intents and observe Competition views and lifecycle status, while the Competition ledger, outbox, feedback journal, and Webxdc coordination remain inside the implementation. Canonical Competition state takes priority over feedback delivery, so feedback failure never rolls back an accepted Competition Event; UI projection and realtime match behavior remain outside the seam.

The module's external interface has three operations: express one domain-shaped Competition Intent, read the current immutable lifecycle snapshot, and observe snapshot revisions. Intent inputs retain explicit target domain IDs but omit Competition Event IDs and facts derivable from canonical Competition state. Admission returns an opaque Competition Intent Reference; stable Competition Event identity remains inside the implementation.

## Considered options

- A planning and selector language was rejected because its preconditions, dependencies, milestones, and delivery policies would form a shallow interface without demonstrated callers.
- One method per Competition Intent was rejected because it would widen the interface whenever Competition behavior grows and would encourage ambient “current match” operations that can target stale presentation state.
