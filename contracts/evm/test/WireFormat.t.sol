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
}
