# Intent Specification

An **intent** is a structured, off-chain message a user signs to declare what
they want from the bridge. It carries no execution details — only the desired
outcome and the constraints under which a solver may fill it.

## Fields

| Field             | Type      | Description                                                        |
| ----------------- | --------- | ----------------------------------------------------------------- |
| `user`            | `address` | EVM address funding the source leg; the EIP-712 signer            |
| `destination`     | `string`  | Stellar address that receives settled assets (`G...` / `C...`)    |
| `sourceChainId`   | `uint256` | EVM chain id spent from (1 = Ethereum, 8453 = Base, …)            |
| `sourceAsset`     | `address` | ERC-20 token spent on the source chain                            |
| `sourceAmount`    | `uint256` | Amount of `sourceAsset` locked, in smallest units                |
| `destAsset`       | `string`  | Stellar asset wanted: `native` or `<CODE>:<ISSUER>`              |
| `minDestAmount`   | `uint256` | Minimum acceptable amount on Stellar (slippage floor)            |
| `deadline`        | `uint256` | Unix seconds after which the intent is void and refundable       |
| `nonce`           | `uint256` | Unique value preventing replay/collision of identical intents    |
| `preferredSolver` | `address` | Optional exclusive solver; `address(0)` = open to all            |

All amounts are decimal strings in the asset's smallest unit. The canonical
per-asset decimals, corridor conversion rule, and human-unit ceilings are in
[Asset Decimals and Corridors](./assets.md).

### preferredSolver Limitation

**`preferredSolver` controls solver reservation on the EVM source chain only.**
When an intent bridges to Stellar, the solver reservation does not carry over —
the Soroban settlement contract cannot represent an EVM address as a Stellar
address, so any `preferredSolver` value is silently dropped on Stellar. Users who
set `preferredSolver` on the EVM side get no reservation protection if the intent
settles through cross-chain settlement. Cross-chain solver identity and
reservation is tracked as a follow-up to issue #271.

## Amount Field Specification

Each amount field has a distinct width, signedness, valid range, and set of
conversion rules at the boundaries between layers. Mishandling any conversion is
where cross-chain amount bugs live.

### Field-by-field table

| Field | SDK type | EVM type | Wire type | Soroban type | Valid range | Max bridgeable |
|---|---|---|---|---|---|---|
| `sourceAmount` | `string` (decimal) | `uint256` | 16-byte big-endian u128 (informational) | n/a — not stored | [1, u128::MAX] | u128::MAX = 2¹²⁸ − 1 |
| `minDestAmount` | `string` (decimal) | `uint256` | 16-byte big-endian u128 | `i128` | [1, i128::MAX] | i128::MAX = 2¹²⁷ − 1 |
| `fill_amount` (Soroban) | n/a | n/a | 16-byte big-endian u128 | `i128` | [1, i128::MAX] | i128::MAX |

> **Maximum bridgeable amount.** The 16-byte wire field constrains the maximum
> amount that can round-trip end-to-end to **u128::MAX = 340,282,366,920,938,463,463,374,607,431,768,211,455**
> for source amounts and **i128::MAX = 170,141,183,460,469,231,731,687,303,715,884,105,727**
> for destination amounts. The stricter ceiling for destinations comes from
> Soroban's `i128` type: amounts in the range (i128::MAX, u128::MAX] decode
> correctly from the wire but would appear negative to the settlement contract,
> which then rejects them (see Conversion rules below). Human-unit ceilings for
> 6, 7, and 18 decimal assets are listed in
> [Asset Decimals and Corridors](./assets.md#human-unit-ceilings).

### Conversion rules at each boundary

**1. SDK string → EVM `uint256`** (off-chain → on-chain, `lock`)

- The SDK encodes amounts as decimal strings and passes them to viem's typed-data
  encoder, which converts them to `bigint` / ABI `uint256`.
- The SDK's `buildIntent` validates `sourceAmount ∈ [1, u128::MAX]` and
  `minDestAmount ∈ [1, i128::MAX]` before constructing an intent; values outside
  these ranges throw a `RangeError`.
- A decimal string representing a value > 2²⁵⁶ − 1 would overflow `uint256` and
  is also rejected by the SDK.

**2. EVM `uint256` → 16-byte big-endian wire field** (`_encodeFillInstruction`)

- The EVM escrow transmits `received` (the measured-delta `uint256`) in a 16-byte
  big-endian field. If `received > u128::MAX`, the implicit `uint128` truncation
  silently loses the high bits — the field would be misread on the Soroban side.
  The SDK ceiling on `sourceAmount ≤ u128::MAX` prevents this.
- `minDestAmount` is transmitted identically as a 16-byte field. The same ceiling
  applies: values > u128::MAX truncate.

**3. 16-byte wire → Soroban `i128`** (`decode_fill_instruction`)

- The decoder reads 16 bytes as `i128::from_be_bytes`. This is a **reinterpret**,
  not a range-narrowing cast.
- If the wire value is in [0, i128::MAX], `from_be_bytes` gives a non-negative
  `i128`. The settlement contract then accepts it.
- If the wire value is in (i128::MAX, u128::MAX] (high bit = 1), `from_be_bytes`
  gives a **negative** `i128`. The settlement contract's `on_fill_instruction`
  check (`min_dest_amount <= 0`) rejects the intent registration. The transaction
  fails safely — no funds are moved — but the intent is unserviceable. The SDK's
  `minDestAmount ≤ i128::MAX` ceiling prevents this from ever being reached.

**4. Soroban `i128` fill_amount → 16-byte wire** (`encode_fill_confirmed`)

- Before encoding, the contract validates `fill_amount > 0`. A non-negative
  `i128` is safe to widen to `u128` via `fill_amount as u128` (the Rust `as`
  cast is defined: non-negative i128 → u128 is lossless, the high bit is 0).
- The encoded bytes are then written big-endian. The EVM side reads this field
  for observability only — it does not use the Stellar-declared amount to size
  the release. `PerihelionEscrow._onFillConfirmed` releases `l.amount` (the
  measured-delta locked amount), so no trust is placed in the Soroban-declared
  fill amount.

**5. EVM `uint256` release**

- The EVM escrow releases `l.amount`, not any amount from the wire payload. This
  is intentional: the escrow already holds the authoritative value. See the
  `_decodeFillConfirmed` doc-comment in `PerihelionEscrow.sol`.

### Sign boundary

The boundary between valid and invalid at the Soroban layer is at **i128::MAX**
(= 0x7FFF…FFFF in 16 bytes). The next value, i128::MAX + 1 (= 0x8000…0000),
has the high bit set; `i128::from_be_bytes` yields `i128::MIN` (−2¹²⁷), which
is negative and rejected. The SDK enforces `minDestAmount ≤ i128::MAX` so this
boundary is never reached in normal operation.

## EIP-712 encoding

The intent is hashed and signed per [EIP-712](https://eips.ethereum.org/EIPS/eip-712).

**Domain** — intentionally minimal so the same signature is valid across every
supported source chain:

```
EIP712Domain(string name,string version)
name    = "Perihelion"
version = "1"
```

**Type:**

```
Intent(
  address user,
  string destination,
  uint256 sourceChainId,
  address sourceAsset,
  uint256 sourceAmount,
  string destAsset,
  uint256 minDestAmount,
  uint256 deadline,
  uint256 nonce,
  address preferredSolver
)
```

The struct hash encodes dynamic fields (`destination`, `destAsset`) as the
keccak256 of their UTF-8 bytes. The final digest is:

```
keccak256(0x1901 ‖ domainSeparator ‖ structHash)
```

This digest is the **intent hash** — the protocol-wide identifier used by the
escrow lock key, the relayer message, and the settlement replay guard.

> The reference implementation lives in `sdk/src/intent.ts` (`hashIntent`) and is
> mirrored exactly in `contracts/evm/src/PerihelionEscrow.sol` (`hashIntent`).
> Any change to the domain or type must be made in both places.

## Lifecycle

```
pending ──claimed──► claimed ──settling──► settled       (success)
   │                                          
   └──deadline──► expired                      (never claimed)
                                              
claimed ──deadline w/o settlement──► refunded  (claimed but not settled)
```

| Status     | Meaning                                            |
| ---------- | -------------------------------------------------- |
| `pending`  | Signed, in the mempool, unclaimed                  |
| `claimed`  | A solver locked the source funds                   |
| `settling` | Cross-chain message in flight                      |
| `settled`  | Assets released on Stellar                         |
| `refunded` | Deadline passed after claim; source funds returned |
| `expired`  | Deadline passed before any claim                   |
