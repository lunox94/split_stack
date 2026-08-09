# Split Stack

Split Stack is a chat-wide competitive falling-block game in which challenges, matches, rematches, results, and Practice records converge across participants.

## Language

**Competition Event**:
A player-originated fact that may change the shared Competition, such as opening or joining a challenge, starting or finishing a match, requesting a rematch, or completing Practice.
_Avoid_: Lobby event, durable update

**Competition Event Lifecycle**:
The progression of a Competition Event from local intent until it is accepted into canonical Competition state and its player-visible chat feedback is confirmed. Chat feedback is part of this lifecycle.
_Avoid_: Write lifecycle, publication pipeline

**Competition Intent**:
A player's request to create a Competition Event. It has not yet been accepted into canonical Competition state.
_Avoid_: Raw event, durable update

**Competition Intent Reference**:
An opaque reference assigned after a Competition Intent is admitted. It identifies that intent's lifecycle without exposing the Competition Event's identity.
_Avoid_: Event ID, durable ID

**Canonical Competition State**:
The convergent interpretation of challenges, pairings, matches, rematches, results, and Practice records shared by participants.
_Avoid_: Ledger state, durable log

**Deferred Competition Event**:
A canonical Competition Event that cannot affect Competition state until another required Competition Event is accepted. It is pending a domain prerequisite, not failed.
_Avoid_: Failed event, delayed update

**Settled Competition Event**:
A Competition Event whose effect on canonical Competition state is known and whose required chat feedback has been confirmed or determined unnecessary.
_Avoid_: Completed write, acknowledged update
