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

The Soroban contract interface that represents a Stellar asset as a token,
allowing contracts to hold and transfer it.

### SEP-40

The Stellar oracle interface standard, used to sanity-check settlement pricing.

### Min dest amount / slippage floor

The minimum amount of the destination asset the user is willing to accept. A
solver must deliver at least this much, or the fill is rejected on-chain.

### Spread

The difference between what the user offers on the source chain and what the
solver must deliver on Stellar — the solver's gross margin before costs.

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
