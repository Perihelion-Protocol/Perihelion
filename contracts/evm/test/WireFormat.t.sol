// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { PerihelionEscrow } from "../src/PerihelionEscrow.sol";

/// @dev Exposes the escrow's internal inbound decoders for direct testing.
contract DecoderHarness is PerihelionEscrow {
    constructor(address endpoint_, uint32 eid_) PerihelionEscrow(endpoint_, eid_) { }

    function decodeFillConfirmed(bytes calldata m) external pure returns (bytes32, address) {
        return _decodeFillConfirmed(m);
    }

    function decodeCancelIntent(bytes calldata m) external pure returns (bytes32, uint8) {
        return _decodeCancelIntent(m);
    }

    /// @dev Mirrors lzReceive's message routing without endpoint/peer auth —
    ///      used by conformance tests to verify version and type rejection.
    function routeInbound(bytes calldata m) external {
        // 0x01 = PROTOCOL_VERSION, 0x02 = MSG_FILL_CONFIRMED, 0x03 = MSG_CANCEL_INTENT
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

/// @dev Cross-chain wire-format conformance. Reads the same golden vectors the
///      Soroban encoder asserts against (contracts/shared/wire-vectors), so the
///      EVM decoder and the Stellar encoder cannot drift apart silently.
contract WireFormatConformanceTest is Test {
    DecoderHarness internal harness;

    string internal constant VECTOR_DIR = "../shared/wire-vectors/";

    // Canonical inputs, mirrored from the vectors README.
    bytes32 internal constant FC_HASH =
        hex"1111111111111111111111111111111111111111111111111111111111111111";
    bytes32 internal constant FC_SOLVER_WORD =
        hex"000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    bytes32 internal constant CI_HASH =
        hex"2222222222222222222222222222222222222222222222222222222222222222";

    function setUp() public {
        harness = new DecoderHarness(address(0x1), 30_316);
    }

    function _readVector(string memory name) internal view returns (bytes memory) {
        return vm.parseBytes(vm.readFile(string.concat(VECTOR_DIR, name)));
    }

    function test_FillConfirmedVectorDecodes() public view {
        bytes memory golden = _readVector("fill_confirmed.hex");
        assertEq(golden.length, 90);

        (bytes32 h, address solver) = harness.decodeFillConfirmed(golden);
        assertEq(h, FC_HASH);
        assertEq(solver, address(uint160(uint256(FC_SOLVER_WORD))));

        // The EVM view of the layout must re-encode to the exact golden bytes.
        bytes memory rebuilt = abi.encodePacked(
            bytes1(0x01), bytes1(0x02), FC_HASH, FC_SOLVER_WORD, uint128(1_000_000), uint64(42)
        );
        assertEq(rebuilt, golden);
    }

    function test_CancelIntentVectorDecodes() public view {
        bytes memory golden = _readVector("cancel_intent.hex");
        assertEq(golden.length, 35);

        (bytes32 h, uint8 reason) = harness.decodeCancelIntent(golden);
        assertEq(h, CI_HASH);
        assertEq(reason, 0x00); // CANCEL_REASON_EXPIRED

        bytes memory rebuilt = abi.encodePacked(bytes1(0x01), bytes1(0x03), CI_HASH, uint8(0));
        assertEq(rebuilt, golden);
    }

    // -------------------------------------------------------------------------
    // Negative / adversarial conformance vectors (issue #61)
    //
    // Each vector below is a mutation of the golden payload that must be
    // rejected. The decoder under test is the one that would normally process
    // this message type; the router-level checks (version, type) are exercised
    // via `routeInbound`.
    // -------------------------------------------------------------------------

    string internal constant NEG_DIR = "../shared/wire-vectors/neg/";

    function _readNeg(string memory name) internal view returns (bytes memory) {
        return vm.parseBytes(vm.readFile(string.concat(NEG_DIR, name)));
    }

    // --- FillConfirmed negatives ---

    function test_FillConfirmedRejectsShortPayload() public {
        bytes memory m = _readNeg("fill_confirmed_short.hex");
        assertEq(m.length, 89);
        vm.expectRevert(PerihelionEscrow.MalformedPayload.selector);
        harness.decodeFillConfirmed(m);
    }

    function test_FillConfirmedRejectsLongPayload() public {
        bytes memory m = _readNeg("fill_confirmed_long.hex");
        assertEq(m.length, 91);
        vm.expectRevert(PerihelionEscrow.MalformedPayload.selector);
        harness.decodeFillConfirmed(m);
    }

    function test_FillConfirmedRejectsNonzeroHighBytesInSolverWord() public {
        bytes memory m = _readNeg("fill_confirmed_nonzero_high.hex");
        assertEq(m.length, 90);
        vm.expectRevert(PerihelionEscrow.MalformedPayload.selector);
        harness.decodeFillConfirmed(m);
    }

    function test_FillConfirmedRejectsBadVersion() public {
        bytes memory m = _readNeg("fill_confirmed_bad_version.hex");
        assertEq(m.length, 90);
        vm.expectRevert(PerihelionEscrow.MalformedPayload.selector);
        harness.routeInbound(m);
    }

    function test_FillConfirmedRejectsUnknownType() public {
        bytes memory m = _readNeg("fill_confirmed_bad_type.hex");
        assertEq(m.length, 90);
        vm.expectRevert(PerihelionEscrow.UnknownMessageType.selector);
        harness.routeInbound(m);
    }

    // --- CancelIntent negatives ---

    function test_CancelIntentRejectsShortPayload() public {
        bytes memory m = _readNeg("cancel_intent_short.hex");
        assertEq(m.length, 34);
        vm.expectRevert(PerihelionEscrow.MalformedPayload.selector);
        harness.decodeCancelIntent(m);
    }

    function test_CancelIntentRejectsLongPayload() public {
        bytes memory m = _readNeg("cancel_intent_long.hex");
        assertEq(m.length, 36);
        vm.expectRevert(PerihelionEscrow.MalformedPayload.selector);
        harness.decodeCancelIntent(m);
    }

    function test_CancelIntentRejectsUnknownReasonCode() public {
        bytes memory m = _readNeg("cancel_intent_bad_reason.hex");
        assertEq(m.length, 35);
        vm.expectRevert(PerihelionEscrow.MalformedPayload.selector);
        harness.decodeCancelIntent(m);
    }

    function test_CancelIntentRejectsBadVersion() public {
        bytes memory m = _readNeg("cancel_intent_bad_version.hex");
        assertEq(m.length, 35);
        vm.expectRevert(PerihelionEscrow.MalformedPayload.selector);
        harness.routeInbound(m);
    }

    function test_CancelIntentRejectsUnknownType() public {
        bytes memory m = _readNeg("cancel_intent_bad_type.hex");
        assertEq(m.length, 35);
        vm.expectRevert(PerihelionEscrow.UnknownMessageType.selector);
        harness.routeInbound(m);
    }
}
