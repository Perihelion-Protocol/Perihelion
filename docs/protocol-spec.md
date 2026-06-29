## Fill Amount Semantics

### Current Behavior (All-or-Nothing)

- The source chain **always releases the full locked amount** (`l.amount`) when a fill is accepted.
- The solver chooses a `fill_amount` ≥ `min_dest_amount` on the destination chain.
- There is **no partial fill support** — an intent is either fully filled or not filled at all.

### Key Semantics

- `fill_amount` is the amount **delivered to the user** on the destination chain.
- Any `fill_amount > min_dest_amount` is a **voluntary surplus** given to the user.
- The solver receives the full locked amount on the source chain regardless of the `fill_amount` chosen.

### Solver-Optimal Behavior

A rational solver will **always deliver exactly `min_dest_amount`** (the floor), because delivering more reduces their profit without any additional benefit.

### Over-Delivery

Delivering `fill_amount > min_dest_amount` is **harmless** but economically irrational for the solver. The protocol accepts it without error.

### Future Partial Fills

Partial fills are currently **out of scope**. Supporting them would require:
- Partial release of locked funds on source chain
- More complex intent state management
- Updated FillInstruction and FillConfirmed structures

This is noted as a possible future enhancement.

---

