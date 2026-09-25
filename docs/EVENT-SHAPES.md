# Event Shape Reference (issues #102, #679)

Soroban event topics emitted by `contracts/soroban/settlement`. The
authoritative table (topics and data tuples) lives in `lib.rs`, immediately
below `mod events`; this document records the naming rule and the one-time
rename that established it.

## Naming rule

Every event topic is the event's **full snake_case name**, exactly as listed in
the event-shape specification table. No topic is abbreviated.

- Names of 9 characters or fewer (`peer_set`, `filled`, `cancelled`) are
  compile-time constants built with `symbol_short!`.
- Longer names cannot use `symbol_short!` (it rejects anything over 9
  characters at compile time) and are built at emission time with
  `Symbol::new`, via the helper functions generated in `mod events`.

Subscribe to the topic name in the table verbatim.

## Rename (issue #679)

Earlier revisions declared eight topics with `symbol_short!` even though they
were 10–12 characters long, which failed to compile, and abbreviated several
more to squeeze under the limit. The documented long names were always the
intended wire format ("VERSIONED INTERFACE"), so every topic now uses its
documented name:

| Constant (old)                 | Old symbol     | Topic now emitted              |
|--------------------------------|----------------|--------------------------------|
| `INITIALIZED`                  | `initialized`¹ | `initialized`                  |
| `ENDPOINT_SET`                 | `endpoint_set`¹| `endpoint_set`                 |
| `PAUSED_SET`                   | `paused_set`¹  | `paused_set`                   |
| `REGISTERED`                   | `registered`¹  | `registered`                   |
| `ADMIN_TRANSFER_COMPLETED`     | `adm_complete`¹| `admin_transfer_completed`     |
| `NATIVE_TOKEN_SET`             | `native_tok`¹  | `native_token_set`             |
| `KEEPER_REWARD_SET`            | `reward_set`¹  | `keeper_reward_set`            |
| `PEER_CHANGE_CANCELLED`        | `peer_cancel`¹ | `peer_change_cancelled`        |
| `ADMIN_TRANSFER_STARTED`       | `adm_start`    | `admin_transfer_started`       |
| `KEEPER_REWARD_PAID`           | `reward_pd`    | `keeper_reward_paid`           |
| `KEEPER_REWARD_SKIPPED`        | `reward_sk`    | `keeper_reward_skipped`        |
| `CONFIRMATION_SENT`            | `confirmed`    | `confirmation_sent`            |
| `CANCELLED_INBOUND`            | `canl_in`      | `cancelled_inbound`            |
| `CANCEL_IGNORED`               | `canl_ign`     | `cancel_ignored`               |
| `PEER_CHANGE_PROPOSED`         | `peer_prop`    | `peer_change_proposed`         |
| `ENDPOINT_CHANGE_PROPOSED`     | `endp_prop`    | `endpoint_change_proposed`     |
| `ENDPOINT_CHANGE_CANCELLED`    | `endp_canl`    | `endpoint_change_cancelled`    |
| `ROLLING_WINDOW_CAP_TRIGGERED` | `roll_cap`     | `rolling_window_cap_triggered` |

¹ Over 9 characters in `symbol_short!` — a compile error, so no deployed build
ever emitted these symbols.

`peer_set`, `filled` and `cancelled` are unchanged. `peer_change_expired`,
`paused_eid_set`, `max_intent_amount_set`, `rolling_window_cap_set` and
`rolling_window_cap_reset` already used `Symbol::new` with their full names;
they moved into `mod events` but their topics are unchanged.

## Indexer guidance

`peer_change_proposed` / `peer_change_cancelled` (and the endpoint
equivalents) mark the start and revocation of the one-day delayed rotation
window (`propose_peer` / `cancel_pending_peer` in `lib.rs`). A monitor that
subscribes only to `peer_set` / `endpoint_set` misses that window entirely —
the period in which a rotation can be observed and contested.

## Test coverage

`contracts/soroban/settlement/src/event_shape_spec.rs` asserts the emitted
topic (symbol + topic count) for each renamed event, including all eight
events from issue #679, so a future rename or drift between the table and the
code fails a test.
