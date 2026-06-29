## Cross-Chain Intent Verification

### FillInstruction Trust Model

The Stellar settlement contract receives an `intentHash` from the EVM side. It does **not** recompute the full intent hash because the `FillInstruction` does not carry source asset/amount details.

**Trust Assumption**:
- The Stellar side trusts that the `intentHash` was correctly derived on EVM and authenticated via the peer check (e.g. via the bridge or oracle).
- The solver is incentivized to only fill valid intents.

**Mitigation**:
- Solver must lock funds on EVM before filling on Stellar.
- User protection is enforced via `minDestAmount`.
- Indexers can still reconstruct full corridors by cross-referencing EVM events.

This is acceptable for the current trust model. Future versions may add full verification if needed.