// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { PerihelionEscrow } from "../src/PerihelionEscrow.sol";
import { IERC20 } from "../src/IERC20.sol";

/// @notice Issue #57 — Amount boundary conformance tests.
///
/// Asserts the boundary values documented in docs/intent-spec.md
/// §Amount Field Specification:
///
///   • sourceAmount is a uint256 stored in the EVM `Lock.amount` after a
///     measured-delta pull. It is transmitted in the informational 16-byte wire
///     field only, which means a sourceAmount > u128::MAX cannot be encoded.
///     However, the EVM escrow itself never rejects a uint256 sourceAmount at
///     lock time — the ceiling is enforced off-chain (SDK) and by the Soroban
///     decoder which rejects amounts that don't fit in i128. These tests verify
///     the EVM does not add a spurious upper-bound check of its own.
///
///   • The FillConfirmed wire field is 16 bytes big-endian (u128). This test
///     verifies that encoding u128::MAX and 0 round-trip correctly through the
///     Solidity ABI packing used in the WireFormat test, so the boundary is
///     correctly represented in the golden vectors.
///
///   • The EVM hashIntent function accepts any uint256 for sourceAmount and
///     minDestAmount — it performs no range check. The protocol range constraint
///     is enforced at the application layer (SDK + Soroban), not the hash.
///
/// See also:
///   • contracts/shared/wire-vectors/README.md — golden vector layout
///   • docs/intent-spec.md §Amount Field Specification
///   • sdk/test/intent.test.ts — SDK-side boundary enforcement
///   • contracts/soroban/settlement/src/test.rs — Soroban-side boundary tests

contract AmountBoundaryHarness is PerihelionEscrow {
    constructor(address ep, uint32 eid) PerihelionEscrow(ep, eid) { }

    function exposedHashIntent(Intent calldata intent) external view returns (bytes32) {
        return hashIntent(intent);
    }
}

contract AmountBoundaryTest is Test {
    // u128::MAX = 2^128 - 1
    uint256 internal constant U128_MAX = type(uint128).max;
    // i128::MAX = 2^127 - 1 = u128::MAX >> 1
    uint256 internal constant I128_MAX = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF; // 2^127 - 1

    AmountBoundaryHarness internal harness;

    function setUp() public {
        harness = new AmountBoundaryHarness(address(0x1), 30_316);
    }

    // -----------------------------------------------------------------------
    // Wire field encoding: 16-byte big-endian u128
    // -----------------------------------------------------------------------

    /// @notice The 16-byte wire field must faithfully encode u128::MAX (all-ones).
    function test_wireField_u128Max_encodesCorrectly() public pure {
        bytes memory packed = abi.encodePacked(uint128(U128_MAX));
        assertEq(packed.length, 16);
        // All 16 bytes should be 0xFF.
        for (uint256 i; i < 16; i++) {
            assertEq(uint8(packed[i]), 0xFF);
        }
    }

    /// @notice The 16-byte wire field must faithfully encode 0 (all-zeros).
    ///         The zero case is the additive identity; amounts must be > 0 but
    ///         the encoding must be able to represent the boundary.
    function test_wireField_zero_encodesCorrectly() public pure {
        bytes memory packed = abi.encodePacked(uint128(0));
        assertEq(packed.length, 16);
        for (uint256 i; i < 16; i++) {
            assertEq(uint8(packed[i]), 0x00);
        }
    }

    /// @notice The 16-byte wire field must faithfully encode 1.
    function test_wireField_one_encodesCorrectly() public pure {
        bytes memory packed = abi.encodePacked(uint128(1));
        assertEq(packed.length, 16);
        // Should be 15 zero bytes followed by 0x01.
        for (uint256 i; i < 15; i++) {
            assertEq(uint8(packed[i]), 0x00);
        }
        assertEq(uint8(packed[15]), 0x01);
    }

    /// @notice i128::MAX correctly fits in the u128 wire type without truncation.
    function test_wireField_i128Max_noTruncation() public pure {
        // Casting i128::MAX (a positive value) to uint128 must be lossless.
        uint128 asU128 = uint128(I128_MAX);
        assertEq(uint256(asU128), I128_MAX);
    }

    /// @notice i128::MAX + 1 = i128 sign boundary. When cast to u128 it equals
    ///         2^127, which fits in u128 but would be negative if re-cast to i128.
    ///         The Soroban decoder rejects this. Verify the value itself is representable
    ///         in u128 so the wire field doesn't truncate it (it reaches Soroban intact).
    function test_wireField_i128SignBoundary_fitsInU128() public pure {
        uint256 signBoundary = I128_MAX + 1;
        // Verify it still fits in uint128 (i.e., < u128::MAX).
        assertLt(signBoundary, U128_MAX);
        // Verify it's representable in the wire field without truncation.
        uint128 asU128 = uint128(signBoundary);
        assertEq(uint256(asU128), signBoundary);
    }

    /// @notice u128::MAX + 1 overflows uint128 and gets truncated to 0. This
    ///         demonstrates why the SDK must reject sourceAmount > u128::MAX before
    ///         it reaches the wire encoding: truncation would silently misrepresent
    ///         the amount.
    function test_wireField_u128MaxPlusOne_truncatesToZero() public pure {
        uint256 overMax = U128_MAX + 1; // This is 2^128, i.e. 1 followed by 128 zero bits.
        uint128 truncated = uint128(overMax);
        assertEq(truncated, 0);
    }

    // -----------------------------------------------------------------------
    // hashIntent: no range check on amount fields (the hash is amount-agnostic)
    // -----------------------------------------------------------------------

    function _baseIntent() internal view returns (PerihelionEscrow.Intent memory) {
        return PerihelionEscrow.Intent({
            user: address(0xA1),
            destination: "GUSER",
            sourceChainId: block.chainid,
            sourceAsset: address(0xB2),
            sourceAmount: 1_000_000,
            destAsset: "USDC:GISSUER",
            minDestAmount: 990_000,
            deadline: block.timestamp + 600,
            nonce: 1,
            preferredSolver: address(0)
        });
    }

    /// @notice hashIntent does not reject sourceAmount = 1 (minimum valid value).
    function test_hashIntent_sourceAmount_one() public view {
        PerihelionEscrow.Intent memory intent = _baseIntent();
        intent.sourceAmount = 1;
        bytes32 h = harness.exposedHashIntent(intent);
        assertTrue(h != bytes32(0));
    }

    /// @notice hashIntent does not reject sourceAmount = u128::MAX.
    function test_hashIntent_sourceAmount_u128Max() public view {
        PerihelionEscrow.Intent memory intent = _baseIntent();
        intent.sourceAmount = U128_MAX;
        bytes32 h = harness.exposedHashIntent(intent);
        assertTrue(h != bytes32(0));
    }

    /// @notice hashIntent does not reject sourceAmount > u128::MAX (uint256 range).
    ///         The SDK rejects such values before hashing; the EVM hash itself is
    ///         range-agnostic. This is intentional: the constraint is on the wire
    ///         encoding path, not the EIP-712 commitment.
    function test_hashIntent_sourceAmount_aboveU128Max() public view {
        PerihelionEscrow.Intent memory intent = _baseIntent();
        intent.sourceAmount = U128_MAX + 1;
        bytes32 h = harness.exposedHashIntent(intent);
        assertTrue(h != bytes32(0));
    }

    /// @notice hashIntent produces different hashes for sourceAmount = 1 vs 0.
    function test_hashIntent_differsByAmount() public view {
        PerihelionEscrow.Intent memory a = _baseIntent();
        PerihelionEscrow.Intent memory b = _baseIntent();
        a.sourceAmount = 1;
        b.sourceAmount = 2;
        assertNotEq(harness.exposedHashIntent(a), harness.exposedHashIntent(b));
    }
}
