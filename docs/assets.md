# Asset Decimals and Corridors

This is the canonical reference for Perihelion amount math. Integrators,
solvers, the SDK, and conformance vectors should treat this document as the
source of truth for supported asset decimals, corridor conversion, and maximum
bridgeable amounts.

All intent amounts are decimal strings in the asset's smallest unit. Never use
floating point arithmetic for conversion or pricing.

## Supported Assets

| Asset family | Chain / representation | Intent field | Decimals | Smallest unit |
| --- | --- | --- | --- | --- |
| USDC | EVM ERC-20 address, deployment-specific | `sourceAsset` | 6 | 0.000001 USDC |
| EURC | EVM ERC-20 address, deployment-specific | `sourceAsset` | 6 | 0.000001 EURC |
| ETH-like ERC-20 assets | EVM ERC-20 address, deployment-specific | `sourceAsset` | 18 | 0.000000000000000001 token |
| XLM | Stellar `native` | `destAsset` | 7 | 0.0000001 XLM, one stroop |
| USDC | Stellar `USDC:<ISSUER_G...>` | `destAsset` | 7 | 0.0000001 USDC |
| EURC | Stellar `EURC:<ISSUER_G...>` | `destAsset` | 7 | 0.0000001 EURC |

EVM token addresses are deployment-specific. A solver must configure decimals
per token address; the 6 decimal stablecoin convention only applies to listed
USDC/EURC-style source assets. Stellar classic assets and the native XLM asset
use 7 decimals in Soroban token amounts. At settlement, a Stellar destination
asset may be represented by its Stellar Asset Contract address, but its decimals
remain the decimals of the underlying Stellar asset.

## Corridor Conversion

Let:

- `sourceSmallest` be `sourceAmount` as a bigint.
- `sourceDecimals` be the decimals for `sourceAsset`.
- `destDecimals` be the decimals for `destAsset`.
- `rateNumerator / rateDenominator` be the price: destination human units per
  one source human unit.

Then the destination amount in smallest units is:

```text
destSmallest =
  floor(sourceSmallest * rateNumerator * 10^destDecimals
        / (rateDenominator * 10^sourceDecimals))
```

For a 1:1 EVM stablecoin to Stellar stablecoin corridor:

```text
sourceDecimals = 6
destDecimals   = 7
rate           = 1/1
destSmallest   = sourceSmallest * 10
```

Example: `1_000_000` source-smallest USDC on Base is `1.000000` USDC.
Converted 1:1 to Stellar USDC it is `10_000_000` destination-smallest units.

If a corridor scales down, for example 18 decimals to 7 decimals, integer
division floors fractional destination-smallest units. User-facing code should
set `minDestAmount` after applying slippage and rounding policy; solver code
must never round up a fill amount that it cannot deliver.

## Wire Limits

Perihelion wire messages encode amount fields as 16-byte big-endian integers.
The EVM side can store `uint256`, but an amount that cannot fit in the wire
field cannot be represented safely across the protocol.

| Field | Protocol limit | Decimal value |
| --- | --- | --- |
| `sourceAmount` | `u128::MAX` | `340282366920938463463374607431768211455` |
| `minDestAmount` | `i128::MAX` | `170141183460469231731687303715884105727` |
| Soroban `fill_amount` | `i128::MAX` | `170141183460469231731687303715884105727` |

Destination amounts use the stricter `i128::MAX` ceiling because Soroban stores
token amounts as signed `i128`. Values above `i128::MAX` fit in the 16-byte wire
field but decode as negative at the Soroban boundary and are rejected.

## Human-Unit Ceilings

| Decimals | `u128::MAX` human units | `i128::MAX` human units |
| --- | --- | --- |
| 6 | `340282366920938463463374607431768.211455` | `170141183460469231731687303715884.105727` |
| 7 | `34028236692093846346337460743176.8211455` | `17014118346046923173168730371588.4105727` |
| 18 | `340282366920938463463.374607431768211455` | `170141183460469231731.687303715884105727` |

See also [Intent Specification](./intent-spec.md#amount-field-specification) for
field-by-field boundary behavior and signedness at each protocol layer.
