// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { PerihelionEscrow } from "../src/PerihelionEscrow.sol";

/// @dev Exposes the escrow's internal inbound decoders for direct testing.
contract DecoderHarness is PerihelionEscrow {
    constructor(address endpoint_, uint32 eid_) PerihelionEscrow(endpoint_, eid_) { }

    function decodeFillConfirmed(bytes calldata m) external pure returns (bytes32, address, uint128, uint64) {
        return _decodeFillConfirmed(m);
    }

    function decodeCancelIntent(bytes calldata m) external pure returns (bytes32, uint8) {
        return _decodeCancelIntent(m);
    }

    function encodeFillInstruction(
        bytes32 intentHash,
        Intent calldata intent,
        uint256 received
    ) external view returns (bytes memory) {
        return _encodeFillInstruction(intentHash, intent, received);
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

    // FillInstruction canonical inputs (must match fill_instruction.hex).
    bytes32 internal constant FI_INTENT_HASH =
        hex"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    // recipient: 32 bytes of 0xBB (Stellar strkey body)
    bytes32 internal constant FI_RECIPIENT =
        hex"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    // dest_asset: 32 bytes of 0xCC (Stellar SAC address)
    bytes32 internal constant FI_DEST_ASSET =
        hex"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    // preferred_solver: EVM address 0xDDDD...DDDD (20 bytes), left-padded to 32
    bytes32 internal constant FI_SOLVER_WORD =
        hex"000000000000000000000000dddddddddddddddddddddddddddddddddddddddd";

    function setUp() public {
        harness = new DecoderHarness(address(0x1), 30_316);
    }

    function _readVector(string memory name) internal view returns (bytes memory) {
        return vm.parseBytes(vm.readFile(string.concat(VECTOR_DIR, name)));
    }

    function test_FillConfirmedVectorDecodes() public view {
        bytes memory golden = _readVector("fill_confirmed.hex");
        assertEq(golden.length, 90);

        (bytes32 h, address solver, uint128 fillAmount, uint64 fillLedger) =
            harness.decodeFillConfirmed(golden);
        assertEq(h, FC_HASH);
        assertEq(solver, address(uint160(uint256(FC_SOLVER_WORD))));
        // Audit fields are decoded and emitted in Released but do not control the release.
        assertEq(fillAmount, 1_000_000);
        assertEq(fillLedger, 42);

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

    /// @dev Assert that the EVM encoder produces the canonical FillInstruction bytes.
    ///      Canonical inputs: intent_hash=0xAA*32, src_eid=30316, recipient=0xBB*32,
    ///      dest_asset=0xCC*32, min_dest_amount=1_000_000_000, deadline=9999999999,
    ///      preferred_solver=0xDDDD...DDDD (EVM address).
    function test_FillInstructionVectorEncodes() public view {
        bytes memory golden = _readVector("fill_instruction.hex");
        assertEq(golden.length, 158);

        // Build the Intent calldata with canonical values.
        // destination / destAsset are passed as strings whose first 32 bytes are the
        // Stellar strkey bodies encoded in the vector.
        PerihelionEscrow.Intent memory intent = PerihelionEscrow.Intent({
            user:              address(0),
            destination:       _bytes32ToString(FI_RECIPIENT),
            sourceChainId:     block.chainid,
            sourceAsset:       address(0),
            sourceAmount:      0,
            destAsset:         _bytes32ToString(FI_DEST_ASSET),
            minDestAmount:     1_000_000_000,
            deadline:          9_999_999_999,
            nonce:             0,
            preferredSolver:   address(uint160(uint256(FI_SOLVER_WORD)))
        });

        bytes memory encoded = harness.encodeFillInstruction(FI_INTENT_HASH, intent, 0);
        assertEq(encoded.length, 158);
        assertEq(encoded, golden);
    }

    /// @dev Convert the first 32 bytes of a bytes32 into a string (for Intent string fields).
    function _bytes32ToString(bytes32 b) internal pure returns (string memory) {
        bytes memory raw = new bytes(32);
        assembly { mstore(add(raw, 32), b) }
        return string(raw);
    }
}
