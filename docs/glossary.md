# Glossary

Definitions of the terms used throughout Perihelion's code and documentation.

## Core Protocol Concepts

### Intent

A structured, off-chain message a user signs to declare a desired outcome —
"receive ≥ X of asset Y on Stellar, spending asset Z on chain C, before a
deadline." It contains no execution details. See
[intent-spec.md](./intent-spec.md).

**Status:** User-facing  
**Synonyms:** None

### Intent hash

The EIP-712 hash of an intent. It is the protocol's universal identifier: the
commitment the EVM escrow locks against, the id carried in every LayerZero
message, and the replay key in the Soroban settlement contract. Computed
identically by the SDK and the EVM escrow.

**Status:** Internal  
**Synonyms:** `intent_hash` (code), commitment hash

## Settlement Lifecycle Verbs

The following terms describe the intent's journey from signing through settlement or cancellation.
Their usage varies across layers; this glossary defines them precisely and maps cross-layer synonyms
per the [Intent Lifecycle State Diagram](./TECHNICAL-ARCHITECTURE.md#intent-lifecycle-state-diagram).

### Lock (EVM) / Register (Soroban event)

The act of the **solver** securing the user's source-chain funds by calling `lock()` on the EVM escrow.
Once locked, the funds are held against the intent hash until one of: release (on successful fill),
refund (on cancellation), or expiry (if no fill is claimed in time).

**Status:** Internal  
**EVM side:** `lock()` call → `Lock` struct stored with `released=false, refunded=false`  
**Soroban side:** `FillInstruction` received via LayerZero → intent state set to `Locked`  
**SDK side:** Intent status becomes `claimed` after `lock()` succeeds on EVM  

### Fill (Soroban) / Claim (SDK)

The act of a **solver** delivering the destination asset to the user on Stellar by calling `fill_intent()`.
The solver fronts liquidity from its own inventory; it is repaid only if settlement completes.

**Status:** Internal  
**Soroban side:** `fill_intent()` call → intent state becomes `Filled`, assets transferred to user  
**SDK side:** Intent status becomes `settling` after `fill_intent()` succeeds on Soroban  
**Relayer/LayerZero side:** `FillConfirmed` message dispatched back to EVM  

### Release (EVM) / Settled (SDK)

The act of the **EVM escrow** releasing the locked source funds to the solver after
receiving confirmation that the destination assets were delivered on Stellar.
This is the "happy path" terminal state where both legs succeed.

**Status:** User-facing outcome (positive)  
**EVM side:** Funds released to solver after `FillConfirmed` received via LayerZero  
**SDK side:** Intent status becomes `settled`  
**Soroban side:** Intent state remains `ConfirmationSent` (local completion; EVM release is the user-visible confirmation)  
**User perspective:** "My assets arrived; transaction complete."

### Refund / Cancel

The act of returning the user's source-chain funds in full when:
- The deadline passes without a successful fill (expiry), or
- A fill is rejected or raced by cancellation (explicit cancellation path)

The two paths differ in actor and timing:
- **Refund via deadline + local timeout (EVM):** Anyone can call `cancelExpired()` after `deadline + confirmationGrace` passes without a `FillConfirmed`.
- **Refund via Soroban deadline (Soroban → EVM):** Anyone can call `cancel_expired_intent()` after the deadline passes on Soroban; this emits a `CancelIntent` message that causes `lzReceive` to refund on EVM.

**Status:** User-facing outcome (recovery); permissionless liveness path  
**EVM side:** `refunded=true` on the `Lock` struct  
**SDK side:** Intent status becomes `refunded`  
**Soroban side:** Intent state becomes `Cancelled`  
**User perspective:** "Deadline passed or fill was rejected; funds returned to source chain."

### Cancel / Expire

The explicit act of marking an intent as cancelled (either by Soroban deadline expiry or EVM local timeout),
blocking any future settlement attempts.

**Status:** Internal state marker  
**Soroban side:** `cancel_expired_intent()` marks intent as `Cancelled`, emits `CancelIntent` message  
**EVM side:** `cancelExpired()` marks lock as `refunded=true`; prevents any future `lock()` calls  
**Idempotent:** Both operations are safe to call repeatedly; cancellation is a no-op if already cancelled  

## Actors & Infrastructure

### Solver

An independent operator that monitors the intent mempool, fronts its own
liquidity to fill profitable intents on Stellar, and is repaid from the locked
source funds. Solvers compete; the winner earns the spread.

**Status:** User-facing (indirectly)  
**Synonyms:** Liquidity provider

### Relayer

A permissionless node that transports LayerZero messages along the Stellar ↔ EVM
path and constructs the destination transactions (including state restoration
when needed). It cannot forge messages — it only transports verified ones.

**Status:** Infrastructure  
**Synonyms:** Message carrier, LayerZero relayer

### Keeper

A permissionless bot that performs liveness maintenance: bumping the TTL of
state nearing archival and cancelling expired intents. Never a safety dependency
— anyone, including the user, can perform the same actions.

**Status:** Infrastructure; permissionless  
**Synonyms:** Liveness bot, maintenance bot

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

## Contracts

### Escrow (EVM)

The source-chain contract that locks a user's funds against the intent hash and
releases them to the solver on confirmed settlement, or refunds the user after
the deadline.

**Status:** Core contract  
**Synonyms:** Lock contract, source-chain contract  
**Permissioned roles:** `owner` (timelock multisig), `guardian` (pause only)

### Settlement contract (Soroban)

The Stellar-side contract that registers locked intents, records fills, enforces
single-settlement, and dispatches confirmation/cancellation messages back to the
source chain.

**Status:** Core contract  
**Synonyms:** Intent registry, Soroban settlement contract  
**Permissioned roles:** `admin` (Stellar multisig)

## Cross-Chain Infrastructure

### LayerZero / OApp

The cross-chain messaging protocol Perihelion uses. An **OApp** (Omnichain
Application) is a contract that sends and receives LayerZero messages. Both the
EVM escrow and the Soroban settlement contract are OApps.

**Status:** Infrastructure (third-party)  
**Synonyms:** Omnichain application, cross-chain messaging layer  
**Trusted components:** Endpoint (on each chain), DVN set

### DVN (Decentralized Verifier Network)

An independent party that attests to the validity of a cross-chain message.
Perihelion requires multiple independent DVNs to attest before a message can be
executed, removing single-verifier trust.

**Status:** Trust model component  
**Synonyms:** Verifier, message verifier  
**Protocol assumption:** At least 2 independent DVNs (configurable)

## Storage & State Management

### Soroban storage tiers

Soroban offers three storage lifetimes:
- **Instance** (shares the contract's life, used for config)
- **Persistent** (long-lived, archivable-and-restorable, used for intent records and replay markers)
- **Temporary** (ephemeral, hard-deleted at expiry, used only for state whose loss is safe)

**Status:** Soroban platform concept  
**Rationale:** Persistent state is expensive to maintain forever; Temporary is auto-cleaned by the ledger  

### TTL / archival

Every Soroban ledger entry has a time-to-live in ledgers. At expiry, Temporary
entries are deleted and Persistent/Instance entries are **archived** (removed
from live state but restorable by paying rent). See
[the architecture spec, §1.7](./TECHNICAL-ARCHITECTURE.md#17-state-archival-in-practice).

**Status:** Soroban platform mechanism  
**Synonyms:** Time-to-live, ledger expiry, rent  
**Implication:** Keepers must periodically restore archived state for liveness

## Assets & Economics

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

**Status:** Soroban platform feature  
**Synonyms:** Wrapped asset, token contract  

### SEP-40

The Stellar oracle interface standard, used to sanity-check settlement pricing.

**Status:** Soroban ecosystem standard  
**Use case:** Price feeds for slippage validation

### Min dest amount / slippage floor

The minimum amount of the destination asset the user is willing to accept. A
solver must deliver at least this much, or the fill is rejected on-chain.

**Status:** User-facing parameter  
**Enforced by:** Soroban settlement contract on `fill_intent()`  
**Synonym:** Minimum receive amount, price protection

### Spread

The difference between what the user offers on the source chain and what the
solver must deliver on Stellar — the solver's gross margin before costs.

**Status:** Internal (solver economics)  
**Formula:** `sourceAmount - destAmountRequired`  
**Synonyms:** Margin, solver profit opportunity

### Max intent amount / Per-intent cap

The maximum amount a single intent can lock on the source chain or settle on Stellar.
On EVM it is configured per allowlisted asset (`setMaxIntentAmountPerAsset`); there is no
protocol-wide EVM maximum. An asset with a zero maximum cannot be locked. Breaching the
cap causes the lock or fill to be rejected, protecting against catastrophic loss from
undiscovered bugs.

**Status:** Security control (under development; see #145)  
**Enforced by:** EVM escrow on `lock()`, Soroban settlement on `fill_intent()`  
**Governance:** Timelock-controlled; starts conservative, raises with confidence

### Rolling-window throughput cap

The maximum total value that can be locked (EVM) or settled (Soroban) within a
sliding time window. When exceeded, new locks/fills are paused until the window
advances. Existing in-flight settlements are not blocked.

**Status:** Security control (under development; see #145)  
**Enforced by:** EVM escrow and Soroban settlement contracts  
**Governance:** Timelock-controlled; increases as the protocol matures  
**Design constraint:** Must not strand in-flight transactions

## Cross-Chain & Encoding

### Cross-chain address encoding

Addresses cross the bridge as 32-byte LayerZero words.

**EVM address ↔ `bytes32`**: An EVM address is 20 bytes (160 bits). When packed
into a 32-byte word it is **left-padded with 12 zero bytes**
(`bytes32 = bytes12(0) ++ address`). Decoders **must reject** any word whose
high 12 bytes are non-zero rather than silently truncating — a non-zero high
word would send funds to a different address than intended. The check is:
`uint256(word) >> 160 == 0`.

**Stellar strkey ↔ `BytesN<32>`**: A Stellar account or contract address is a
strkey string (`G…` / `C…`, 56 base32 characters using the alphabet A–Z and
2–7). At the LayerZero boundary the underlying 32-byte public key (stripped of
the 1-byte type prefix and 2-byte checksum) is transported as a `BytesN<32>`.
The Soroban SDK's `Address` type encapsulates this encoding; callers do not
manipulate the raw bytes directly.

**Status:** Encoding standard  
**Synonyms:** Cross-chain address marshalling, address serialization  
**Security property:** Address padding mismatch detection prevents fund misdirection
