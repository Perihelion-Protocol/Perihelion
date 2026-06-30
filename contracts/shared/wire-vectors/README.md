# Cross-chain wire-format conformance vectors

Golden test vectors for the LayerZero OApp messages in the Perihelion protocol.
These are the single source of truth for the binary layout: the Soroban encoder
(`contracts/soroban/.../messages.rs`) and the EVM encoder/decoder
(`contracts/evm/.../PerihelionEscrow.sol`) each have a conformance test that
reads these exact files, so the two implementations cannot drift apart without a
test going red.

All files hold one `0x`-prefixed hex string, no trailing newline.

Amount fields in these vectors use the same smallest-unit and maximum-amount
rules as the rest of the protocol. See
[`docs/assets.md`](../../../docs/assets.md) for the canonical per-asset decimals
and corridor conversion rule, and
[`docs/intent-spec.md`](../../../docs/intent-spec.md#amount-field-specification)
for the 16-byte wire-field bounds.

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

> The **inbound** FillInstruction (source → Stellar) is not pinned here: it
> carries variable-length Stellar addresses and its raw codec is finalized at
> the adapter boundary once the Soroban LayerZero ABI is GA (architecture spec
> §3.3). Only the fully-specified, fixed-length outbound payloads are locked.

## `neg/` — adversarial / negative conformance vectors

Each file in `neg/` is a mutation of a golden payload that **both decoders
must reject**. The EVM decoder tests (`WireFormat.t.sol`) and the Soroban
inbound decoder tests (`test.rs`) each load these vectors and assert rejection.
A new decoder implementation is conformant only if it rejects every vector here
and accepts every golden vector above.

### `solver_evm` address encoding (issue #60)

An EVM address occupies the **low 20 bytes** (160 bits) of the 32-byte
`solver_evm` word. The high 12 bytes must be zero. A decoder that silently
truncates a word with non-zero high bytes would redirect funds to a different
address; decoders must therefore reject such words with a `MalformedPayload`
error rather than truncating.

`neg/fill_confirmed_nonzero_high.hex` contains a valid-length FillConfirmed
with the first byte of `solver_evm` set to `0xFF`. Both decoders must reject it.

### FillConfirmed negative vectors

| File | Length | Mutation | Expected error |
| ---- | ------ | -------- | -------------- |
| `fill_confirmed_short.hex` | 89 | Last byte removed | `MalformedPayload` (length) |
| `fill_confirmed_long.hex` | 91 | Extra `0x00` appended | `MalformedPayload` (length) |
| `fill_confirmed_bad_version.hex` | 90 | `version` byte = `0x02` | `MalformedPayload` (version) |
| `fill_confirmed_bad_type.hex` | 90 | `type` byte = `0x04` (unknown) | `UnknownMessageType` / `MalformedPayload` |
| `fill_confirmed_nonzero_high.hex` | 90 | `solver_evm[0]` = `0xFF` | `MalformedPayload` (address) |

### CancelIntent negative vectors

| File | Length | Mutation | Expected error |
| ---- | ------ | -------- | -------------- |
| `cancel_intent_short.hex` | 34 | `reason` byte removed | `MalformedPayload` (length) |
| `cancel_intent_long.hex` | 36 | Extra `0x00` appended | `MalformedPayload` (length) |
| `cancel_intent_bad_version.hex` | 35 | `version` byte = `0x02` | `MalformedPayload` (version) |
| `cancel_intent_bad_type.hex` | 35 | `type` byte = `0x04` (unknown) | `UnknownMessageType` / `MalformedPayload` |
| `cancel_intent_bad_reason.hex` | 35 | `reason` byte = `0xFF` (unknown) | `MalformedPayload` (reason) |
