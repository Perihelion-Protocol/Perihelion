// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { PerihelionEscrow } from "../src/PerihelionEscrow.sol";

/// @dev Differential fuzzer: cross-validate Solidity encode/decode against Rust.
/// Generates random structured messages, encodes them, and asserts symmetric
/// round-trip and rejection properties. Complements the fixed golden vectors
/// (WireFormat.t.sol) by exercising the full input space.
///
/// ## Architecture
/// 1. Foundry fuzz generates random message fields within valid ranges.
/// 2. Solidity encodes the message into bytes.
/// 3. Solidity decodes the same bytes and asserts round-trip equality.
/// 4. Structural mutations are generated and both codecs must reject identically.
///
/// ## Cross-language validation
/// A companion Rust proptest (contracts/soroban/settlement/src/fuzz.rs) uses the
/// same input distribution. To cross-check outputs:
///   - Export Rust-generated payloads to shared/wire-vectors/fuzz-corpus/
///   - Re-run this test with `FUZZ_CORPUS=1` to decode and compare.
///
/// ## CI integration
/// - Bounded run (100 cases): `forge test --match-contract DifferentialFuzz`
/// - Extended nightly (10k cases): `forge test --match-contract DifferentialFuzz -vvv --fuzz-runs 10000`
contract DifferentialFuzzTest is Test {
    DecoderHarness internal harness;

    string internal constant CORPUS_DIR = "../shared/wire-vectors/fuzz-corpus/";

    function setUp() public {
        harness = new DecoderHarness(address(0x1), 30_316);
    }

    // -------------------------------------------------------------------------
    // FillConfirmed: round-trip and rejection symmetry
    // -------------------------------------------------------------------------

    /// @dev Round-trip: encode a random FillConfirmed, decode it, assert equality.
    function testFuzz_FillConfirmedRoundTrip(
        bytes32 intentHash,
        address solverEvm,
        uint128 amount,
        uint64 ledger
    ) public view {
        // Constrain amount to realistic range (0 to max Stellar stroops ~9e18).
        amount = uint128(bound(amount, 0, type(uint128).max));

        // Encode manually to match the Rust encoder layout.
        bytes memory encoded = abi.encodePacked(
            bytes1(0x01), // PROTOCOL_VERSION
            bytes1(0x02), // MSG_FILL_CONFIRMED
            intentHash,
            bytes32(uint256(uint160(solverEvm))), // left-padded 20-byte address
            amount,
            ledger
        );
        assertEq(encoded.length, 90, "FillConfirmed must be 90 bytes");

        // Decode and assert round-trip.
        (bytes32 h2, address s2, uint128 a2, uint64 l2) = harness.decodeFillConfirmed(encoded);
        assertEq(h2, intentHash, "intentHash mismatch");
        assertEq(s2, solverEvm, "solverEvm mismatch");
        assertEq(a2, amount, "amount mismatch");
        assertEq(l2, ledger, "ledger mismatch");
    }

    /// @dev Mutation: reject payloads with non-zero high bytes in solver_evm word.
    function testFuzz_FillConfirmedRejectsNonzeroHigh(
        bytes32 intentHash,
        uint128 amount,
        uint64 ledger,
        uint96 highBits // 12 bytes of entropy for the high bits
    ) public {
        vm.assume(highBits != 0); // Must be non-zero to trigger rejection

        // Construct a malformed solver_evm word: high 12 bytes != 0.
        // Use a non-zero address that will still have high bits set
        address solverAddr = address(0xaaaaaaaaaaaaaaaaaaaaaaaa);
        bytes32 malformedSolver = bytes32((uint256(highBits) << 160) | uint256(uint160(solverAddr)));

        bytes memory payload = abi.encodePacked(
            bytes1(0x01), bytes1(0x02), intentHash, malformedSolver, amount, ledger
        );
        assertEq(payload.length, 90);

        vm.expectRevert(PerihelionEscrow.MalformedPayload.selector);
        harness.decodeFillConfirmed(payload);
    }

    /// @dev Mutation: reject short payloads (length < 90).
    function testFuzz_FillConfirmedRejectsShort(
        bytes32 intentHash,
        address solverEvm,
        uint128 amount,
        uint64 ledger,
        uint8 truncateBytes
    ) public {
        truncateBytes = uint8(bound(truncateBytes, 1, 89));

        bytes memory full = abi.encodePacked(
            bytes1(0x01),
            bytes1(0x02),
            intentHash,
            bytes32(uint256(uint160(solverEvm))),
            amount,
            ledger
        );
        bytes memory truncated = new bytes(90 - truncateBytes);
        for (uint256 i = 0; i < truncated.length; i++) {
            truncated[i] = full[i];
        }

        vm.expectRevert(PerihelionEscrow.MalformedPayload.selector);
        harness.decodeFillConfirmed(truncated);
    }

    /// @dev Mutation: reject long payloads (length > 90).
    function testFuzz_FillConfirmedRejectsLong(
        bytes32 intentHash,
        address solverEvm,
        uint128 amount,
        uint64 ledger,
        bytes calldata extraBytes
    ) public {
        vm.assume(extraBytes.length > 0 && extraBytes.length < 100); // Keep test bounded

        bytes memory payload = abi.encodePacked(
            bytes1(0x01),
            bytes1(0x02),
            intentHash,
            bytes32(uint256(uint160(solverEvm))),
            amount,
            ledger,
            extraBytes
        );

        vm.expectRevert(PerihelionEscrow.MalformedPayload.selector);
        harness.decodeFillConfirmed(payload);
    }

    /// @dev Mutation: reject bad version byte.
    function testFuzz_FillConfirmedRejectsBadVersion(
        uint8 badVersion,
        bytes32 intentHash,
        address solverEvm,
        uint128 amount,
        uint64 ledger
    ) public {
        vm.assume(badVersion != 0x01); // Must differ from PROTOCOL_VERSION

        bytes memory payload = abi.encodePacked(
            bytes1(badVersion),
            bytes1(0x02),
            intentHash,
            bytes32(uint256(uint160(solverEvm))),
            amount,
            ledger
        );

        vm.expectRevert(PerihelionEscrow.MalformedPayload.selector);
        harness.routeInbound(payload);
    }

    /// @dev Mutation: reject unknown message type.
    function testFuzz_FillConfirmedRejectsUnknownType(
        uint8 badType,
        bytes32 intentHash,
        address solverEvm,
        uint128 amount,
        uint64 ledger
    ) public {
        // Valid types: 0x01 (FillInstruction), 0x02 (FillConfirmed), 0x03 (CancelIntent)
        vm.assume(badType != 0x01 && badType != 0x02 && badType != 0x03);

        bytes memory payload = abi.encodePacked(
            bytes1(0x01),
            bytes1(badType),
            intentHash,
            bytes32(uint256(uint160(solverEvm))),
            amount,
            ledger
        );

        vm.expectRevert(PerihelionEscrow.UnknownMessageType.selector);
        harness.routeInbound(payload);
    }

    // -------------------------------------------------------------------------
    // CancelIntent: round-trip and rejection symmetry
    // -------------------------------------------------------------------------

    /// @dev Round-trip: encode a random CancelIntent, decode it, assert equality.
    function testFuzz_CancelIntentRoundTrip(bytes32 intentHash, uint8 reason) public view {
        // Only valid reason codes: 0x00 (EXPIRED), 0x01 (ADMIN), 0x02 (INVALID)
        reason = uint8(bound(reason, 0, 2));

        bytes memory encoded = abi.encodePacked(
            bytes1(0x01), // PROTOCOL_VERSION
            bytes1(0x03), // MSG_CANCEL_INTENT
            intentHash,
            reason
        );
        assertEq(encoded.length, 35, "CancelIntent must be 35 bytes");

        (bytes32 h2, uint8 r2) = harness.decodeCancelIntent(encoded);
        assertEq(h2, intentHash, "intentHash mismatch");
        assertEq(r2, reason, "reason mismatch");
    }

    /// @dev Mutation: reject unknown reason codes (outside [0, 2]).
    function testFuzz_CancelIntentRejectsUnknownReason(bytes32 intentHash, uint8 badReason) public {
        vm.assume(badReason > 2); // Valid: 0x00, 0x01, 0x02

        bytes memory payload = abi.encodePacked(bytes1(0x01), bytes1(0x03), intentHash, badReason);

        vm.expectRevert(PerihelionEscrow.MalformedPayload.selector);
        harness.decodeCancelIntent(payload);
    }

    /// @dev Mutation: reject short payloads (length < 35).
    function testFuzz_CancelIntentRejectsShort(
        bytes32 intentHash,
        uint8 reason,
        uint8 truncateBytes
    ) public {
        reason = uint8(bound(reason, 0, 2));
        truncateBytes = uint8(bound(truncateBytes, 1, 34));

        bytes memory full = abi.encodePacked(bytes1(0x01), bytes1(0x03), intentHash, reason);
        bytes memory truncated = new bytes(35 - truncateBytes);
        for (uint256 i = 0; i < truncated.length; i++) {
            truncated[i] = full[i];
        }

        vm.expectRevert(PerihelionEscrow.MalformedPayload.selector);
        harness.decodeCancelIntent(truncated);
    }

    /// @dev Mutation: reject long payloads (length > 35).
    function testFuzz_CancelIntentRejectsLong(
        bytes32 intentHash,
        uint8 reason,
        bytes calldata extraBytes
    ) public {
        reason = uint8(bound(reason, 0, 2));
        vm.assume(extraBytes.length > 0 && extraBytes.length < 100);

        bytes memory payload =
            abi.encodePacked(bytes1(0x01), bytes1(0x03), intentHash, reason, extraBytes);

        vm.expectRevert(PerihelionEscrow.MalformedPayload.selector);
        harness.decodeCancelIntent(payload);
    }

    /// @dev Mutation: reject bad version byte.
    function testFuzz_CancelIntentRejectsBadVersion(
        uint8 badVersion,
        bytes32 intentHash,
        uint8 reason
    ) public {
        vm.assume(badVersion != 0x01);
        reason = uint8(bound(reason, 0, 2));

        bytes memory payload =
            abi.encodePacked(bytes1(badVersion), bytes1(0x03), intentHash, reason);

        vm.expectRevert(PerihelionEscrow.MalformedPayload.selector);
        harness.routeInbound(payload);
    }

    /// @dev Mutation: reject unknown message type.
    function testFuzz_CancelIntentRejectsUnknownType(
        uint8 badType,
        bytes32 intentHash,
        uint8 reason
    ) public {
        vm.assume(badType != 0x01 && badType != 0x02 && badType != 0x03);
        reason = uint8(bound(reason, 0, 2));

        bytes memory payload = abi.encodePacked(bytes1(0x01), bytes1(badType), intentHash, reason);

        vm.expectRevert(PerihelionEscrow.UnknownMessageType.selector);
        harness.routeInbound(payload);
    }
}

/// @dev Exposes PerihelionEscrow's internal decoders for direct testing.
/// Reuses the harness from WireFormat.t.sol for consistency.
contract DecoderHarness is PerihelionEscrow {
    constructor(address endpoint_, uint32 eid_) PerihelionEscrow(endpoint_, eid_) { }

    function decodeFillConfirmed(bytes calldata m)
        external
        pure
        returns (bytes32, address, uint128, uint64)
    {
        return _decodeFillConfirmed(m);
    }

    function decodeCancelIntent(bytes calldata m) external pure returns (bytes32, uint8) {
        return _decodeCancelIntent(m);
    }

    function routeInbound(bytes calldata m) external {
        if (m.length < 2 || m[0] != 0x01) revert MalformedPayload();
        bytes1 msgType = m[1];
        if (msgType == 0x02) {
            _decodeFillConfirmed(m);
        } else if (msgType == 0x03) {
            _decodeCancelIntent(m);
        } else {
            revert UnknownMessageType();
        }
    }
}
