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

All amounts are decimal strings in the asset's smallest unit, preserving
precision across the EVM (typically 6–18 decimals) and Stellar (7 decimals).

## Asset representation

Perihelion uses two distinct representations for the destination asset depending
on the layer of the stack:

### Off-chain canonical form (`StellarAsset`)

The SDK (`sdk/src/types.ts`), relayer, and solver all use a human-readable
string called `StellarAsset`:

| Value            | Meaning                                                        |
| ---------------- | -------------------------------------------------------------- |
| `"native"`       | XLM (the native Stellar asset)                                 |
| `"CODE:ISSUER"`  | A Stellar classic asset, e.g. `"USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"` |

This string appears in:
- The user-signed `Intent.destAsset` field
- The EIP-712 struct hash (as `keccak256(bytes(intent.destAsset))`)
- The `FillInstruction` wire body encoded by the EVM escrow (`_encodeFillInstruction`)
- All off-chain config, quotes, and API surfaces

### On-chain form (Soroban `Address`)

Inside the Soroban settlement contract, `dest_asset` is stored and emitted as a
Soroban `Address` — the 32-byte contract ID of the asset's
[Stellar Asset Contract (SAC)](./glossary.md#sac-stellar-asset-contract). This
is what the solver passes to `token::TokenClient::new(&env, &dest_asset)` to
transfer funds to the recipient.

### Mapping between the two

The conversion happens at the **LayerZero adapter boundary**: the adapter
receives the `FillInstruction` message (which carries the `destAsset` string
from the EVM side), derives the corresponding SAC contract address, and encodes
the resulting 32 bytes into the 158-byte on-chain payload that the Soroban
settlement contract decodes.

The derivation is deterministic and defined by the Stellar protocol:

```
contract_id = SHA-256(
    HashIDPreimage::CONTRACT_ID {
        network_id:           SHA-256("<network passphrase>"),
        contract_id_preimage: ContractIDPreimage::ASSET(<stellar XDR Asset>),
    }
)
```

| `StellarAsset` string  | Stellar XDR `Asset`                                             | Notes                    |
| ---------------------- | --------------------------------------------------------------- | ------------------------ |
| `"native"`             | `Asset::NATIVE`                                                 | XLM                      |
| `"CODE:ISSUER"`        | `Asset::CREDIT_ALPHANUM4` or `CREDIT_ALPHANUM12` (code + issuer key) | code ≤4 chars → ALPHANUM4 |

The `StellarBase.Contract.fromAsset(asset, networkPassphrase)` helper in the
Stellar JS SDK computes the SAC address from an asset string.

### `filled` event: indexer guidance

The Soroban settlement contract emits this event when a solver completes a fill
([`lib.rs:335–338`](../contracts/soroban/settlement/src/lib.rs)):

```
topic:  ("filled", intent_hash: BytesN<32>)
value:  (solver: Address, dest_asset: Address, fill_amount: i128, src_eid: u32)
```

`dest_asset` in the event is the SAC `Address` (32-byte contract ID), **not**
the `StellarAsset` string. An indexer consuming this event must resolve the
contract address back to the canonical asset identifier. Two approaches:

1. **Call the SAC `asset()` function** via Soroban RPC on the emitted contract
   address. It returns the Stellar XDR `Asset`, from which you reconstruct
   `"native"` or `"CODE:ISSUER"`.
2. **Maintain a pre-image index**: for each asset your application cares about,
   derive its SAC address at startup using `StellarBase.Contract.fromAsset` and
   store the `(contract_id → StellarAsset)` mapping locally.

**Decision rationale:** The event carries only the SAC `Address` and does not
additionally emit the canonical string. The SAC address is the authoritative
on-chain identifier — it is what the contract transfers against, and it uniquely
identifies the asset without ambiguity. Adding a redundant string field would
increase event size and introduce a surface for mismatch. The reverse mapping is
deterministic and well-supported by Stellar tooling; it is the standard pattern
for Stellar indexers and is not unique to Perihelion.

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
