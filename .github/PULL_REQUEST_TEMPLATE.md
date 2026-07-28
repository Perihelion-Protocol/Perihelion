<!-- Thanks for contributing to Perihelion! Please fill out the sections below. -->

## Summary

<!-- What does this PR do and why? Link the issue it closes. -->

Closes #

## Type of change

- [ ] 🐛 Bug fix
- [ ] ✨ Feature
- [ ] 📝 Documentation
- [ ] ♻️ Refactor / chore
- [ ] 🧪 Tests

## Affected components

- [ ] `contracts/soroban` (Rust)
- [ ] `contracts/evm` (Solidity)
- [ ] `sdk`
- [ ] `solver`
- [ ] `relayer`
- [ ] `docs`

## Checklist

- [ ] Tests added/updated and passing (`npm test` / `cargo test` / `forge test`)
- [ ] Docs updated if interfaces or on-chain formats changed
- [ ] CI is green
- [ ] Reviewed against the [design invariants](../docs/TECHNICAL-ARCHITECTURE.md#0-design-invariants-read-first) (I1–I5) — this change cannot violate any of them

## Resource / security impact

<!-- For contract changes: note any change to ledger reads/writes, gas, or
     trust assumptions. State whether an audit gate applies before mainnet. -->

**Does this change fund movement, authorisation, the wire format, or a CI
gate?** <!-- yes/no -->

<!-- If yes: which invariant in docs/formal-specification.md does it touch,
     and which test asserts it? A PR that touches one of these without a
     clear answer here should request a security-sensitive-path reviewer
     (see CONTRIBUTING.md § Security review policy) even if CODEOWNERS
     didn't already require one. -->

## Notes for reviewers

<!-- Anything that needs special attention, known limitations, follow-ups. -->
