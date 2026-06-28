# Cross-chain wire-format conformance vectors

Golden test vectors for the two **Stellar → source-chain** LayerZero messages —
the fund-moving payloads. These are the single source of truth for the binary
layout: the Soroban encoder (`contracts/soroban/.../messages.rs`) and the EVM
decoder (`contracts/evm/.../PerihelionEscrow.sol`) each have a conformance test
that reads these exact files, so the two implementations cannot drift apart
without a test going red.

Both files hold one `0x`-prefixed hex string, no trailing newline.

## `fill_confirmed.hex` (90 bytes)

`version(1) | type(1) | intent_hash(32) | solver_evm(32) | amount(16) | ledger(8)`

| Field         | Canonical value                                  |
| ------------- | ------------------------------------------------ |
| `version`     | `0x01`                                           |
| `type`        | `0x02` (FillConfirmed)                            |
| `intent_hash` | 32 bytes of `0x11`                               |
| `solver_evm`  | 32-byte word; low 20 bytes = the EVM address `0xAA…AA` |
| `amount`      | `1_000_000` (u128, big-endian)                   |
| `ledger`      | `42` (u64, big-endian)                           |

## `cancel_intent.hex` (35 bytes)

`version(1) | type(1) | intent_hash(32) | reason(1)`

| Field         | Canonical value             |
| ------------- | --------------------------- |
| `version`     | `0x01`                      |
| `type`        | `0x03` (CancelIntent)       |
| `intent_hash` | 32 bytes of `0x22`          |
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
