# Cross-chain wire-format conformance vectors

Golden test vectors for the LayerZero OApp messages in the Perihelion protocol.
These are the single source of truth for the binary layout: the Soroban encoder
(`contracts/soroban/.../messages.rs`) and the EVM encoder/decoder
(`contracts/evm/.../PerihelionEscrow.sol`) each have a conformance test that
reads these exact files, so the two implementations cannot drift apart without a
test going red.

All files hold one `0x`-prefixed hex string, no trailing newline.

## `fill_instruction.hex` (158 bytes)

`version(1) | type(1) | intent_hash(32) | src_eid(4) | recipient(32) | dest_asset(32) | min_dest_amount(16) | deadline(8) | preferred_solver(32)`

This is the **source → Stellar** payload that registers a locked intent on the
Soroban settlement contract. All integers are big-endian. Addresses are 32 bytes:
`recipient` and `dest_asset` are Stellar strkey bodies; `preferred_solver` is an
EVM address left-padded to 32 bytes (all zeros = open, no preferred solver).

| Field              | Canonical value                                              |
| ------------------ | ------------------------------------------------------------ |
| `version`          | `0x01`                                                       |
| `type`             | `0x01` (FillInstruction)                                     |
| `intent_hash`      | 32 bytes of `0xAA`                                           |
| `src_eid`          | `30316` (u32, big-endian) — canonical Stellar LayerZero eid  |
| `recipient`        | 32 bytes of `0xBB` (Stellar strkey body)                     |
| `dest_asset`       | 32 bytes of `0xCC` (Stellar SAC address)                     |
| `min_dest_amount`  | `1_000_000_000` (u128, big-endian)                           |
| `deadline`         | `9_999_999_999` (u64, big-endian)                            |
| `preferred_solver` | EVM `0xDDDD…DDDD` (20 bytes) left-padded to 32 bytes         |

## `fill_confirmed.hex` (90 bytes)

`version(1) | type(1) | intent_hash(32) | solver_evm(32) | amount(16) | ledger(8)`

This is the **Stellar → source** payload that authorises the solver payout on
the source chain.

| Field         | Canonical value                                                  |
| ------------- | ---------------------------------------------------------------- |
| `version`     | `0x01`                                                           |
| `type`        | `0x02` (FillConfirmed)                                           |
| `intent_hash` | 32 bytes of `0x11`                                               |
| `solver_evm`  | 32-byte word; low 20 bytes = EVM address `0xAA…AA`               |
| `amount`      | `1_000_000` (u128, big-endian) — informational, not used by EVM  |
| `ledger`      | `42` (u64, big-endian) — informational                           |

## `cancel_intent.hex` (35 bytes)

`version(1) | type(1) | intent_hash(32) | reason(1)`

Sent in either direction to unwind an intent.

| Field         | Canonical value                  |
| ------------- | -------------------------------- |
| `version`     | `0x01`                           |
| `type`        | `0x03` (CancelIntent)            |
| `intent_hash` | 32 bytes of `0x22`               |
| `reason`      | `0x00` (`CANCEL_REASON_EXPIRED`) |

> See the architecture spec §3.3 for the full field-by-field description and
> rationale for the fixed big-endian binary format.
