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
| `CANCELLED_BEFORE_REGISTRATION`| `cancelled_before_registration`¹ | `cancelled_before_registration` |
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

## Added topics (issues #1063, #1064, #1065)

| Topic                          | Emitted when                                                       |
|--------------------------------|--------------------------------------------------------------------|
| `fill_instruction_rejected`    | A FillInstruction is terminally rejected by policy (deterministic rejection, e.g. `DeadlineTooFar`, `DeadlinePassed`, `InvalidAmount`, `UnsupportedDestAsset`, `ExceedsMaxIntentAmount`, missing peer). Data carries the instruction hash and a rejection code. The nonce is consumed and a terminal `Cancelled` marker is written so a CancelIntent can be dispatched; transport/authentication errors (`UntrustedPeer`, `StaleNonce`, `MalformedPayload`) still revert. |
| `enforced_options_set`         | Admin sets the per-destination-eid LayerZero executor options (`set_enforced_options(eid, bytes)`). Data carries the eid and the encoded Type-3 options blob. |

Both names exceed 9 characters and are built with `Symbol::new` via `mod
events`.

## Payload changes (issues #1116, #1117)

`initialized` now carries all three constructor arguments: `admin`,
`endpoint` and `native_token`. Deployment tooling can confirm the native SAC
address from the event instead of trusting the deploy transaction's calldata.

The `native` destination asset no longer resolves through an admin-settable
`NativeToken` storage entry; it is derived on-chain from the network's native
Stellar Asset Contract, so `set_native_token` and the `native_token_set` event
have been removed. Indexers that subscribed to `native_token_set` should drop
that subscription; the `native_token` value is now observable only via
`initialized`.

## Payload changes (issue #1066)

`confirmation_sent` and `cancelled` now include the **actual** LayerZero fee
paid (the quoted `required` amount forwarded to the endpoint), not the
caller-supplied `lz_fee` maximum, so off-chain reconciliation can account for
the exact cost. Consumers decoding these payloads must read the trailing fee
field.

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

## EVM ignore events (issue #1041)

`PerihelionEscrow` consumes benign late inbound deliveries as no-ops instead of
reverting, so the LayerZero packet does not stay as a permanently failing payload.
Each no-op emits an event whose `reason` byte is one of:

| Event               | Reason | Constant                   | Meaning                                                            |
|---------------------|--------|----------------------------|--------------------------------------------------------------------|
| `FillConfirmedIgnored` | `0x01` | `IGNORE_UNKNOWN_LOCK`      | No lock exists for `intentHash`.                                   |
| `FillConfirmedIgnored` | `0x02` | `IGNORE_ALREADY_FINALIZED` | The lock was already released or refunded (e.g. after `cancelExpired`). |
| `CancelIgnored`     | `0x01` | `IGNORE_UNKNOWN_LOCK`      | No lock exists for `intentHash`.                                   |
| `CancelIgnored`     | `0x02` | `IGNORE_ALREADY_FINALIZED` | The lock was already released or refunded.                         |

In every case the nonce is consumed by `lzReceive` and no funds move.

Not ignored: a `FillConfirmed` from a non-reserved solver before the deadline
(`ReservedForSolver`) and a `FillConfirmed` below `minDestAmount` (`UnderDelivered`).
These are delivery violations, not races, so they still revert and stay visible in the
failed-message queue. Transport-level problems (endpoint, peer, nonce, malformed payload)
also still revert.
