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

## `fill_instruction.hex` (227 bytes)

`version(1) | type(1) | intent_hash(32) | reserved(4) | recipient(56) | dest_asset(69) | min_dest_amount(16) | deadline(8) | preferred_solver(32)`

This is the **source → Stellar** payload that registers a locked intent on the
Soroban settlement contract. All integers are big-endian.

Address fields carry the ASCII bytes of their Stellar strkeys, right-zero-padded
to fixed widths:

- `recipient` is a Stellar account (`G...`) or contract (`C...`) strkey — 56
  ASCII characters exactly — stored as 56 bytes, no zero-padding needed.
- `dest_asset` is the user-signed canonical asset identifier: `native`,
  `CODE:ISSUER`, or a `C...` token contract strkey (see
  [`docs/intent-spec.md`](../../../docs/intent-spec.md#destasset-field--canonical-asset-identifier)),
  up to 69 bytes, right-zero-padded to 69 bytes. The full 69-byte field
  prevents truncation of `CODE:ISSUER` assets whose issuer strkey extends past
  byte 32 (issue #270).
- `preferred_solver` is an EVM address left-padded to 32 bytes; all zeros
  signals "open" (no preferred solver) on the Soroban side.

The Soroban decoder strips trailing zeros from both fields. It converts
`recipient` to a native `Address` via `Address::from_string_bytes` (issue #271).
It checks that `dest_asset` is one of the three canonical forms, keeps it
verbatim, and resolves it to a token contract (native token, derived Stellar
Asset Contract, or allowlisted contract) before registering the intent. Any
other value, including a bare `G...` account strkey, is `MalformedPayload`.

### Byte layout

| Field              | Byte offset | Width (bytes) | Encoding                                         | Consumer     |
| ------------------ | ----------- | ------------- | ------------------------------------------------ | ------------ |
| `version`          | 0           | 1             | Unsigned integer; must equal `0x01`              | Both sides   |
| `type`             | 1           | 1             | Unsigned integer; `0x01` = FillInstruction       | Both sides   |
| `intent_hash`      | 2           | 32            | Raw bytes (EIP-712 keccak256 hash)               | Soroban      |
| `reserved`         | 34          | 4             | Always zero (`0x00000000`); ignored by the decoder | Soroban (dropped) |
| `recipient`        | 38          | 56            | ASCII strkey (`G...` or `C...`), right-zero-padded | Soroban    |
| `dest_asset`       | 94          | 69            | ASCII `native`, `CODE:ISSUER` or `C...` strkey, right-zero-padded | Soroban |
| `min_dest_amount`  | 163         | 16            | Big-endian `u128`                                | Soroban      |
| `deadline`         | 179         | 8             | Big-endian `u64` (Unix timestamp, seconds)       | Soroban      |
| `preferred_solver` | 187         | 32            | EVM address left-padded to 32 bytes; all zeros = "open" | Soroban (dropped) |

**Total: 227 bytes.** All integer fields are big-endian. The `recipient` and
`dest_asset` fields contain ASCII characters, not raw key material, and are
decoded by stripping trailing zero bytes (see above).

The canonical inputs below produce the strkeys by encoding the raw byte arrays
via the Stellar SEP-0023 base32 algorithm. Specifically, `[0xBB; 32]` encodes
to `CC53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53WQD5` and `[0xCC; 32]`
encodes to `CDGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZLND`.

| Field              | Canonical value                                                        |
| ------------------ | ---------------------------------------------------------------------- |
| `version`          | `0x01`                                                                 |
| `type`             | `0x01` (FillInstruction)                                               |
| `intent_hash`      | 32 bytes of `0xAA`                                                     |
| `reserved`         | `0` (u32, big-endian). The locking chain's eid is the authenticated transport origin, not a body field (#1051) |
| `recipient`        | `CC53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53WQD5` (56 ASCII bytes) — strkey of `[0xBB; 32]` contract id |
| `dest_asset`       | `CDGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZLND` (56 ASCII bytes) followed by 13 zero-padding bytes — strkey of `[0xCC; 32]` contract id |
| `min_dest_amount`  | `1_000_000_000` (u128, big-endian)                                     |
| `deadline`         | `9_999_999_999` (u64, big-endian)                                      |
| `preferred_solver` | All zeros (32 bytes) — open, no preferred solver (test encoder hardcodes this) |

### `dest_asset` form variants

`fill_instruction.hex` covers the contract-native `C...` form. Two more golden
vectors are identical to it except for the `dest_asset` field, which covers the
other canonical forms:

| File                                  | `dest_asset` (right-zero-padded to 69 bytes) |
| ------------------------------------- | -------------------------------------------- |
| `fill_instruction_native_asset.hex`   | `native`                                     |
| `fill_instruction_classic_asset.hex`  | `USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` (61 bytes + 8 zero bytes) |

`neg/fill_instruction_account_dest_asset.hex` carries the all-zero `G...`
account strkey in `dest_asset`. It is a valid strkey but not an asset, and the
Soroban decoder must reject it.

## `fill_confirmed.hex` (90 bytes)

`version(1) | type(1) | intent_hash(32) | solver_evm(32) | amount(16) | ledger(8)`

This is the **Stellar → source** payload that authorises the solver payout on
the source chain.

| Field         | Canonical value                                                  |
| ------------- | ---------------------------------------------------------------- |
| `version`     | `0x01`                                                           |
| `type`        | `0x02` (FillConfirmed)                                           |
| `intent_hash` | 32 bytes of `0x11`                                               |
| `solver_evm`  | 32-byte word; low 20 bytes (offsets 12–31) = EVM address `0xAA…AA`; high 12 bytes zero |
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

> The **inbound** FillInstruction (source → Stellar) is pinned above. The
> `recipient` and `dest_asset` fields carry ASCII strkey text right-zero-padded
> to fixed widths (56 and 69 bytes respectively — issue #270), so the payload
> is fully determined. The Soroban decoder uses `Address::from_string_bytes`
> rather than raw contract-id reinterpretation (issue #271).

## `neg/` — adversarial / negative conformance vectors

Each file in `neg/` is a mutation of a golden payload that **both decoders
must reject**. The EVM decoder tests (`WireFormat.t.sol`) and the Soroban
inbound decoder tests (`test.rs`) each load these vectors and assert rejection.
A new decoder implementation is conformant only if it rejects every vector here
and accepts every golden vector above.

### `solver_evm` address encoding (issues #60, #946)

An EVM address occupies the **low 20 bytes** (160 bits) of the 32-byte
`solver_evm` word — i.e. it is written at byte offsets 12–31 and the word is
equivalent to `bytes32(uint256(uint160(addr)))`. The high 12 bytes (offsets
0–11) must be zero. A decoder that silently truncates a word with non-zero high
bytes would redirect funds to a different address; decoders must therefore
reject such words with a `MalformedPayload` error rather than truncating.

The canonical encoder for this field is the SDK helper
`evmAddressToBytes32` from `@perihelion/sdk` (left-pads the 20 address bytes
into offsets 12–31). Both the solver executor and the relayer must use it
instead of hand-rolling the conversion; a left-justified encoding (address in
offsets 0–19) is rejected by the EVM decoder and would leave the solver
unrepaid (issue #946). The SDK helper is cross-checked in tests against
`fill_confirmed.hex` above and against the EVM `_decodeFillConfirmed` decoder,
so the encoder and decoder cannot drift apart.

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

### FillInstruction negative vectors

These are consumed by the Soroban decoder tests (the EVM side only encodes
FillInstruction, never decodes it, so rejection is a Soroban-side concern).

| File | Length | Mutation | Expected error |
| ---- | ------ | -------- | -------------- |
| `fill_instruction_short.hex` | 226 | Last byte removed | `MalformedPayload` (length) |
| `fill_instruction_long.hex` | 228 | Extra `0x00` appended | `MalformedPayload` (length) |
| `fill_instruction_legacy_219.hex` | 219 | Trailing 8-byte `reservation_window` removed (the pre-#722 layout, same `version` `0x01`) | `MalformedPayload` (length) |
| `fill_instruction_bad_version.hex` | 227 | `version` changed from `0x01` to `0x02` | `MalformedPayload` (version) |
| `fill_instruction_bad_type.hex` | 227 | `type` changed from `0x01` to `0x04` | `UnknownMessageType` / `MalformedPayload` |
