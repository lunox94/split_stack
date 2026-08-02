# Split Stack implementation decisions

The approved specification identifies itself as the source of truth and asks
implementers to surface ambiguity. This file records the narrow interpretations
needed to make version 1 deterministic. They are part of rules version 1 and
must change together with the peer rules hash.

## Simulation ordering

- Recognized input actions apply in their observed ordinal against the current
  simulation tick. The fixed 60 Hz step then advances gravity/grounding plus
  status and mode timers. A lock is one atomic transaction using specification
  section 17.
- Input DAS/ARR values remain monotonic UI-input timings. They emit logical
  actions into the tick loop; they are not rounded into gameplay timers.
- Level-nine gravity begins with four ticks, then alternates 4/5 per successful
  gravity step. The phase pauses with the simulation.
- The spawn selection in resolution step 13 includes the spawn-collision
  top-out check. This is the operational form of the top-out check mentioned in
  step 12.
- O rotation is a no-op and is not a successful action, so it cannot reset lock
  delay or qualify a T-Spin. A hard drop is the final successful action and,
  per the literal T-Spin rule, disqualifies a prior rotation.

## Effects and queues

- Pending Monomino Rush and Acid Rain activations form a bounded FIFO. An active
  mode remains uninterrupted; already queued forced pieces precede a newly
  pending mode.
- Acid drops spawn at `(4, 0)`, use current-level gravity, resolve immediately
  on stack/floor contact without lock delay, and award no drop score.
- Collapse clears of more than four lines score deterministic groups of four
  plus the remaining one-to-three lines. They increment the lines statistic,
  but preserve combo/B2B and create no attack, charge, achievement, or special
  trigger.
- Normal line clears made by a Cross or Glitch use the normal scoring/attack/
  meter rules; a four-line clear therefore creates a Cross regardless of the
  controlled piece source.
- Garbage Core rows are emitted as event-derived one-row packets so each can
  retain the explicitly required seeded hole. The ordinary attack rows from the
  same lock remain combined into one packet after cancellation.
- A lock examines at most four ready garbage rows total. Barrier-blocked rows
  count toward that attempt boundary because they were rows that would have
  risen; later queued rows wait for the next lock.

## Webxdc constraints

- Webxdc durable `update.serial` is a replica-local replay cursor, not a
  portable global order. Competing claims therefore use the convergent
  application tuple `(logicalClock, actorId, eventId)`. Once occupied, a seat
  cannot be overridden until its holder emits a release with a new vacancy ID.
- Realtime identities are application assertions because the host listener
  supplies only bytes. Validation binds a claimed player/session to the current
  lobby handshake, consistent with the specification's casual trust model.
- Critical ACKs name `(senderId, sessionId)` explicitly; bare sequence numbers
  are never treated as globally unique.
- Realtime `MATCH_CONFIG` is the live acknowledged authority. A compact durable
  mirror carries the round, seed, rules hash, and config hash for recovery and
  late observers.
- A critical gap is requested immediately. Buffers, ACK lists, and gap ranges
  are bounded by the central network limit so a remote peer cannot amplify an
  unbounded control frame.
- Network pause stops each authoritative local simulation immediately. Resume
  reconciles owner states and ledgers, requires equal pause ticks, then
  performs a new three-second countdown. A tick mismatch ends neutrally as a
  desynchronization rather than guessing which owner state to rewrite.
- Each replica displays recent history in its durable replay order, using
  `matchId` only as the stable tie-breaker. Durable serials are not used for
  distributed seat arbitration.
