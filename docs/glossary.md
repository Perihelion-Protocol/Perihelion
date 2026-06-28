# Glossary

Definitions of the terms used throughout Perihelion's code and documentation.

### Intent

A structured, off-chain message a user signs to declare a desired outcome —
"receive ≥ X of asset Y on Stellar, spending asset Z on chain C, before a
deadline." It contains no execution details. See
[intent-spec.md](./intent-spec.md).

### Intent hash

The EIP-712 hash of an intent. It is the protocol's universal identifier: the
commitment the EVM escrow locks against, the id carried in every LayerZero
message, and the replay key in the Soroban settlement contract. Computed
identically by the SDK and the EVM escrow.

### Solver

An independent operator that monitors the intent mempool, fronts its own
liquidity to fill profitable intents on Stellar, and is repaid from the locked
source funds. Solvers compete; the winner earns the spread.

### Relayer

A permissionless node that transports LayerZero messages along the Stellar ↔ EVM
path and constructs the destination transactions (including state restoration
when needed). It cannot forge messages — it only transports verified ones.

### Keeper

A permissionless bot that performs liveness maintenance: bumping the TTL of
state nearing archival and cancelling expired intents. Never a safety dependency
— anyone, including the user, can perform the same actions.

### Escrow (EVM)

The source-chain contract that locks a user's funds against the intent hash and
releases them to the solver on confirmed settlement, or refunds the user after
the deadline.

### Settlement contract (Soroban)

The Stellar-side contract that registers locked intents, records fills, enforces
single-settlement, and dispatches confirmation/cancellation messages back to the
source chain.

### LayerZero / OApp

The cross-chain messaging protocol Perihelion uses. An **OApp** (Omnichain
Application) is a contract that sends and receives LayerZero messages. Both the
EVM escrow and the Soroban settlement contract are OApps.

### DVN (Decentralized Verifier Network)

An independent party that attests to the validity of a cross-chain message.
Perihelion requires multiple independent DVNs to attest before a message can be
executed, removing single-verifier trust.

### Soroban storage tiers

Soroban offers three storage lifetimes: **Instance** (shares the contract's
life, used for config), **Persistent** (long-lived, archivable-and-restorable,
used for intent records and replay markers), and **Temporary** (ephemeral,
hard-deleted at expiry, used only for state whose loss is safe).

### TTL / archival

Every Soroban ledger entry has a time-to-live in ledgers. At expiry, Temporary
entries are deleted and Persistent/Instance entries are **archived** (removed
from live state but restorable by paying rent). See
[the architecture spec, §1.7](./TECHNICAL-ARCHITECTURE.md#17-state-archival-in-practice).

### SAC (Stellar Asset Contract)

The Soroban contract interface that wraps a Stellar asset as a Soroban token,
allowing smart contracts to hold and transfer it via the `token::Interface`.

Every classic Stellar asset and native XLM has exactly one SAC whose contract
address is derived deterministically from the asset and the network passphrase:

```
contract_id = SHA-256(
    HashIDPreimage::CONTRACT_ID {
        network_id:            SHA-256(network_passphrase),
        contract_id_preimage:  ContractIDPreimage::ASSET(asset),
    }
)
```

Where `asset` is the Stellar XDR `Asset` type:

| `StellarAsset` string  | XDR `Asset`                                         |
| ---------------------- | --------------------------------------------------- |
| `"native"`             | `Asset::NATIVE`                                     |
| `"CODE:ISSUER_G..."`   | `Asset::CREDIT_ALPHANUM4(code, issuer_public_key)`  |
|                        | or `Asset::CREDIT_ALPHANUM12(...)` for codes >4 chars |

The resulting 32-byte hash is the SAC's **contract ID**, which in Soroban is
represented as an `Address` value with the `Contract` discriminant.

**Resolving a SAC address back to its asset:** The Stellar SDK's
`StellarBase.Contract.fromAsset(asset, networkPassphrase)` computes the address
in the forward direction. To reverse, query the SAC's `asset()` or `name()`
contract function via RPC — or maintain a pre-image index keyed on
`(network_id, asset_code, asset_issuer)`.

Well-known SAC addresses on Stellar mainnet (network passphrase
`"Public Global Stellar Network ; September 2015"`):

| Asset                            | SAC contract ID (C-address)                            |
| -------------------------------- | ------------------------------------------------------ |
| XLM (native)                     | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |
| USDC (Centre, GABC…)             | varies by issuer — derive from the issuer G-address    |

See also [§ Asset representation](./intent-spec.md#asset-representation) in the
intent spec for how `StellarAsset` strings map to SAC addresses at settlement.

### SEP-40

The Stellar oracle interface standard, used to sanity-check settlement pricing.

### Min dest amount / slippage floor

The minimum amount of the destination asset the user is willing to accept. A
solver must deliver at least this much, or the fill is rejected on-chain.

### Spread

The difference between what the user offers on the source chain and what the
solver must deliver on Stellar — the solver's gross margin before costs.
