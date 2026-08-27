# Mutation Testing

Perihelion runs mutation testing on a nightly schedule to verify that the test
suites don't just _execute_ the dangerous code but would actually _fail_ if that
code were subtly wrong.

> **Why it matters for a bridge:** line coverage tells you which lines ran. Mutation
> testing tells you whether a corrupted comparison (`>=` flipped to `>`, an off-by-one
> on a nonce guard, a deleted terminal-flag check) would be caught by the assertions.
> High line-coverage + low mutation score is a common and dangerous illusion.

---

## What is mutation testing?

A mutation tool:
1. Makes a small, automated fault injection (a _mutant_) — e.g. flips `>=` to `>`,
   removes an `if` guard, changes `+1` to `-1`.
2. Runs the full test suite against the mutant.
3. Reports the mutant as **killed** (a test failed ✓) or **survived** (all tests
   passed ✗).

A surviving mutant means the test suite cannot distinguish the correct code from a
subtly wrong version of it. That is a test quality gap, not a production bug — but
it is a gap that could hide a real bug in the future.

---

## Tools

| Stack | Tool | Config |
|-------|------|--------|
| Soroban (Rust) | [cargo-mutants](https://mutants.rs/) | `contracts/soroban/settlement/.cargo-mutants.toml` |
| TypeScript (sdk, relayer, solver) | [Stryker](https://stryker-mutator.io/) | `stryker.config.mjs` |
| EVM (Solidity) | [vertigo-rs](https://github.com/JoranHonig/vertigo) | Foundry project at `contracts/evm/` |

---

## Running locally

### Soroban / Rust

```bash
# Install once
cargo install cargo-mutants --locked

# Run (from repo root)
cd contracts/soroban/settlement
cargo mutants --timeout 120
# Results in contracts/soroban/settlement/mutants.out/
```

### TypeScript

```bash
# Install Stryker
npm install --save-dev @stryker-mutator/core@8 @stryker-mutator/typescript-checker@8

# Run all configured modules
npx stryker run

# Run a single file quickly
npx stryker run --mutate "sdk/src/intent.ts"
# Results in reports/mutation/
```

### EVM / Solidity

```bash
# Install vertigo-rs
cargo install vertigo-rs --locked

# Run from the evm directory
cd contracts/evm
vertigo run --match-contract PerihelionEscrow
```

---

## CI schedule

The mutation-testing workflow runs **nightly at 03:00 UTC** (`.github/workflows/mutation-testing.yml`).
It is separate from the CI workflow (which runs on every push) because mutation testing
is expensive — it multiplies the test suite runtime by the number of mutants generated.

You can also trigger it manually via **Actions → Mutation Testing → Run workflow**
and select which stack to test (`soroban | ts | evm | all`).

Artefacts (full reports, surviving-mutant lists) are uploaded for 30 days after each run.

---

## Interpreting results

### Mutation score

```
Mutation score = (killed mutants / total mutants) × 100 %
```

| Score | Interpretation |
|-------|---------------|
| ≥ 80 % | Strong assertion coverage — good |
| 60–80 % | Acceptable, but triage survivers |
| < 60 % | Warning — consider adding targeted tests |
| < 50 % | Hard-fail gate (Stryker `break` threshold) |

### Triaging surviving mutants

A surviving mutant is not automatically a bug — it may be:

1. **Equivalent mutant** — the mutation produces semantically identical code (e.g.
   swapping `a + b` to `b + a`). Document it in the triage table below.
2. **Test gap** — the test suite does not assert on the mutated path. Add a targeted
   test.
3. **Dead code** — the mutated line is unreachable in practice. Consider removing it.

Keep a record of accepted-equivalents in `docs/mutation-testing.md` so they are not
re-triaged on every run.

---

## Accepted-equivalent mutants

This table records surviving mutants that have been triaged and accepted as equivalent
(i.e. the mutation does not change observable behaviour).

| Date | Stack | File | Line | Mutation | Reason |
|------|-------|------|------|----------|--------|
| — | — | — | — | — | No accepted equivalents yet |

---

## Highest-priority modules

Focus mutation-testing budget on modules that are:

1. **Codec boundaries** — any serialisation/deserialisation that crosses the EVM ↔
   Stellar boundary (`messages.rs`, `sdk/src/intent.ts`). A silent encode/decode bug
   is catastrophic.
2. **Nonce and replay guards** — `inboundNonce`, `Lock.released`, `Lock.refunded`,
   `accept_nonce` in Soroban. A bypassed guard allows double-settlement or double-refund.
3. **Terminal-flag logic** — anything that checks or sets `released`/`refunded`/`Settled`/
   `Cancelled`. These are the heart of the atomicity guarantee.
4. **Signature verification** — `_verify` in Solidity, `verifyIntent` in TypeScript.
   A weakened check enables unauthorised fills.
5. **Amount arithmetic** — `validateAmount`, measured-delta accounting in `lock`. Off-by-one
   here can result in underpayment or fund lock-up.

---

## References

- [cargo-mutants documentation](https://mutants.rs/)
- [Stryker Mutator documentation](https://stryker-mutator.io/docs/stryker-js/introduction/)
- [vertigo-rs (Solidity mutation)](https://github.com/JoranHonig/vertigo)
