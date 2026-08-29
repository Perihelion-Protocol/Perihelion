# Event Shape Reference (issue #102)

Corrected mapping between the documented topic names in the event-shape
specification table (`contracts/soroban/settlement/src/lib.rs`, immediately
below `mod events`) and the actual `symbol_short!` constants the contract
publishes. `symbol_short!` caps names at 9 characters, so several of the
table's long-form names were never the value actually placed on the wire —
an indexer subscribing to the documented name would never match.

Ground truth here is the code (`mod events` in `lib.rs`), not the table,
since that's what an indexer, relayer, or monitor actually receives.

| Documented topic (table)   | Constant                  | Declared symbol (code) |
|-----------------------------|----------------------------|-------------------------|
| `admin_transfer_started`    | `ADMIN_TRANSFER_STARTED`   | `adm_start`             |
| `admin_transfer_completed`  | `ADMIN_TRANSFER_COMPLETED` | `adm_complete`          |
| `native_token_set`          | `NATIVE_TOKEN_SET`         | `native_tok`            |
| `keeper_reward_set`         | `KEEPER_REWARD_SET`        | `reward_set`            |
| `keeper_reward_paid`        | `KEEPER_REWARD_PAID`       | `reward_pd`             |
| `confirmation_sent`         | `CONFIRMATION_SENT`        | `confirmed`             |
| `cancelled_inbound`         | `CANCELLED_INBOUND`        | `canl_in`               |
| `cancel_ignored`            | `CANCEL_IGNORED`           | `canl_ign`              |
| *(undocumented)*            | `PEER_CHANGE_PROPOSED`     | `peer_prop`             |
| *(undocumented)*            | `PEER_CHANGE_CANCELLED`    | `peer_cancel`           |

Rows not listed above (`initialized`, `endpoint_set`, `peer_set`,
`paused_set`, `registered`, `filled`, `cancelled`) already match between the
table and the code and are unaffected.

## Indexer guidance

Subscribe to the **Declared symbol (code)** column, not the table's topic
name. `peer_prop` / `peer_cancel` mark the start and revocation of the
one-day delayed peer-rotation window (`propose_peer` / `cancel_pending_peer`
in `lib.rs`); a monitor built only from the table's original rows misses
that window entirely — the one-day period in which a peer rotation can be
observed and contested.

## Test coverage

`contracts/soroban/settlement/src/event_shape_spec.rs` asserts the actual
emitted topic tuple (symbol + topic count) for each row above against its
declared short symbol, so a future rename of the underlying constant, or
further drift between the table and the code, fails a test instead of only
being caught by someone reading the source.

## What this doesn't resolve

The table's own text calls each event shape a "VERSIONED INTERFACE", which
implies the *documented* long names — not the compressed ones — were the
intended wire format. The short constants exist only because
`symbol_short!` caps names at 9 characters; that's the design tension the
original issue calls out. Resolving it (renaming the constants to
`Symbol::new` so the wire format matches the documented long names, vs.
keeping the short constants and rewriting the table to match them) changes
the contract's existing event constants or documentation and is left as a
follow-up. This document and the tests it describes only make the
*current* on-chain behavior observable and pinned; they don't choose a side
in that naming question.
