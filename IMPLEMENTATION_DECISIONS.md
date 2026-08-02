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

- Pending Monomino Rush and Acid Rain activations form a two-item FIFO. Further
  activations are ignored while that queue is full. An active mode remains
  uninterrupted; already queued forced pieces precede a newly pending mode.
- Acid drops spawn at `(4, 0)`, use current-level gravity, resolve immediately
  on stack/floor contact without lock delay, and award no drop score.
- Collapse clears of more than four lines score deterministic groups of four
  plus the remaining one-to-three lines. They increment the lines statistic,
  but preserve combo/B2B and create no attack, charge, achievement, or special
  trigger.
- Normal line clears made by a Cross or Glitch use the normal scoring/attack/
  meter rules; a four-line clear therefore creates a Cross regardless of the
  controlled piece source.
- Every resolution emits at most one garbage packet after cancellation,
  including all surviving Garbage Core contributions. Its hole is seeded from
  the lock's combined attack event so every row in the packet shares one hole.
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
- Each occupied seat also publishes a bounded durable runtime-session claim.
  The newest convergent claim must echo through the durable listener before it
  controls the seat; an older duplicate remains a read-only spectator. A
  visibility or WebGL recovery acquires a replacement realtime channel before
  retiring the previous one.
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
- Incoming realtime ticks are bounded to three seconds of catch-up work. A
  rolling checkpoint window accepts earlier terminal events without replaying
  from match start; events outside either bound finish neutrally as a desync.
- Initial clock samples, config acknowledgements, and critical frames retry on
  bounded timers. Results require identical peer hashes, with a 20-second
  consensus deadline and a canonical neutral result on failure.
- An explicit forfeit carries a canonical self-loss result. The receiver queues
  that exact hash-validated result before acknowledging; Leave pumps retries for
  the three-second presence window and queues the same durable fallback once if
  no acknowledgement arrives.
- Each replica displays recent history in its durable replay order, using
  `matchId` only as the stable tie-breaker. Durable serials are not used for
  distributed seat arbitration.
- A result enters history only after a coordinator announcement that matches
  the materialized challenge roster, rules/config hashes, seed, round, and both
  seats. Results that arrive first wait in a bounded queue. The materializer
  retains the latest 20 for presentation while bounded aggregate state keeps
  all accepted matches available for tallies and reload restoration.

## Presentation event routing

- Input-resolution effects are consumed immediately, while effects produced by
  automatic competitive ticks cross a read-only session callback. Snapshot
  transitions supply level, countdown, and upcoming-power warning cues. Remote
  attacks and Blackout cues pan right; authoritative local effects pan left.
