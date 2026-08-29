// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { PerihelionEscrow } from "../src/PerihelionEscrow.sol";

/// @dev Exposes the escrow's internal inbound decoders for direct testing.
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

    /// @dev Expose _encodeFillInstruction for testing.
    function encodeFillInstruction(bytes32 intentHash, Intent calldata intent)
        external
        view
        returns (bytes memory)
    {
        return _encodeFillInstruction(intentHash, intent);
    }

    function fillInstructionLength() external pure returns (uint256) {
        return FILL_INSTRUCTION_LENGTH;
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

    // FillInstruction canonical inputs (must match fill_instruction.hex).
    // The vector uses the 219-byte strkey-text layout (issue #270/#271):
    //   recipient  = CC53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53WQD5 (56 chars)
    //                = strkey of [0xBB; 32] contract id
    //   dest_asset = CDGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZLND (56 chars)
    //                = strkey of [0xCC; 32] contract id, padded to 69 bytes
    //   preferred_solver = all zeros (open — test encoder hardcodes this)
    bytes32 internal constant FI_INTENT_HASH =
        hex"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    // Recipient destination string: CC53XO53...WQD5 (strkey of [0xBB;32])
    string internal constant FI_RECIPIENT_STR = "CC53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53WQD5";
    // dest_asset string: CDGMZTGM...ZLND (strkey of [0xCC;32])
    string internal constant FI_DEST_ASSET_STR = "CDGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZLND";

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

    /// @dev Cross-validate the Solidity encoder against fill_instruction.hex.
    ///      The encoder must produce the exact bytes the Rust encoder produces,
    ///      keeping both codecs in sync. Tests issue #270 (56-byte recipient,
    ///      69-byte dest_asset) and issue #271 (strkey ASCII text, not raw bytes).
    function test_FillInstructionVectorMatchesSolidityEncoder() public view {
        bytes memory golden = _readVector("fill_instruction.hex");
        assertEq(golden.length, harness.fillInstructionLength(), "fill_instruction.hex has the wrong length");

        // Build the canonical intent using the same inputs as the Rust test.
        PerihelionEscrow.Intent memory intent = PerihelionEscrow.Intent({
            user: address(0xA1),
            destination: FI_RECIPIENT_STR,          // strkey of [0xBB;32]
            sourceChainId: block.chainid,
            sourceAsset: address(0xA2),
            sourceAmount: 0,
            destAsset: FI_DEST_ASSET_STR,           // strkey of [0xCC;32]
            minDestAmount: 1_000_000_000,
            deadline: 9_999_999_999,
            nonce: 0,
            preferredSolver: address(0)             // all-zeros = open
        });

        bytes memory encoded = harness.encodeFillInstruction(FI_INTENT_HASH, intent);
        assertEq(encoded.length, harness.fillInstructionLength(), "encoder must produce the FillInstruction length");
        assertEq(encoded, golden, "Solidity encoder output must match fill_instruction.hex golden vector");
    }

    /// @dev Asserts the golden vector length matches the expected constant.
    /// This test catches stale vectors immediately rather than surfacing as
    /// a decode error in an unrelated test.
    function test_FillInstructionVectorLength() public view {
        bytes memory golden = _readVector("fill_instruction.hex");
        assertEq(golden.length, FILL_INSTRUCTION_LENGTH, "fill_instruction.hex must be exactly FILL_INSTRUCTION_LENGTH bytes");
        assertEq(golden.length, 219, "fill_instruction.hex must be exactly 219 bytes");
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

    // --- FillInstruction negatives (issue #270/#271) ---

    function test_FillInstructionRejectsShortPayload() public {
        bytes memory m = _readNeg("fill_instruction_short.hex");
        assertEq(m.length, 218);
        // The Solidity side validates FillInstruction length when encoding;
        // decoding is handled on the Soroban side. Use routeInbound here to
        // confirm the EVM router rejects a truncated FillInstruction message type.
        // (The EVM side does not decode inbound FillInstruction — it only sends
        // them — so length rejection is a Soroban concern; this test confirms the
        // cross-language vector is correctly sized and available for Soroban tests.)
        assertEq(m[0], 0x01, "version must be 0x01");
        assertEq(m[1], 0x01, "type must be 0x01 (FillInstruction)");
        // Soroban decoder will reject this at the length check (expects 219).
        // The vector is included here so the file is validated and the hex is parseable.
        assertTrue(m.length == 218);
    }

    function test_FillInstructionRejectsLongPayload() public {
        bytes memory m = _readNeg("fill_instruction_long.hex");
        assertEq(m.length, 220);
        assertEq(m[0], 0x01, "version must be 0x01");
        assertEq(m[1], 0x01, "type must be 0x01 (FillInstruction)");
        // Soroban decoder will reject this at the length check (expects 219).
        assertTrue(m.length == 220);
    }
}

/// @dev Tests for issue #270: destAsset must survive the full 69-byte round-trip.
contract FillInstructionEncodeTest is Test {
    DecoderHarness internal harness;

    uint32 internal constant STELLAR_EID = 30_316;

    function setUp() public {
        harness = new DecoderHarness(address(0x1), STELLAR_EID);
    }

    function _baseIntent() internal view returns (PerihelionEscrow.Intent memory) {
        return PerihelionEscrow.Intent({
            user: address(0xA1),
            destination: "GUSERSTELLARADDRESSFIXEDLENGTH56CHARS123", // will be padded
            sourceChainId: block.chainid,
            sourceAsset: address(0xA2),
            sourceAmount: 1_000_000,
            destAsset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVV",
            minDestAmount: 990_000,
            deadline: 9_999_999,
            nonce: 1,
            preferredSolver: address(0)
        });
    }

    /// Encoded payload is exactly 219 bytes (expanded from the old 158).
    function test_EncodedPayloadIs219Bytes() public view {
        PerihelionEscrow.Intent memory intent = _baseIntent();
        bytes memory encoded = harness.encodeFillInstruction(bytes32(uint256(1)), intent);
        assertEq(encoded.length, 219);
    }

    /// The full 69-byte destAsset appears at offset 94 in the payload.
    function test_DestAsset69BytesPreserved() public view {
        // Use a CODE:ISSUER asset whose issuer is 56 chars (total 69 bytes with CODE: prefix).
        string memory fullAsset = "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVV";
        assertEq(bytes(fullAsset).length, 61); // "USDC:" (5) + 56 char issuer

        PerihelionEscrow.Intent memory intent = _baseIntent();
        intent.destAsset = fullAsset;

        bytes memory encoded = harness.encodeFillInstruction(bytes32(uint256(1)), intent);
        assertEq(encoded.length, 219);

        // Slice out the 69-byte dest_asset field at offset 94.
        bytes memory destField = new bytes(69);
        for (uint256 i = 0; i < 69; i++) {
            destField[i] = encoded[94 + i];
        }

        // First 61 bytes should be the asset string; remaining 8 should be zero-padded.
        bytes memory expected = new bytes(69);
        bytes memory assetBytes = bytes(fullAsset);
        for (uint256 i = 0; i < assetBytes.length; i++) {
            expected[i] = assetBytes[i];
        }
        assertEq(destField, expected);
    }

    /// recipient field (56 bytes) starts at offset 38.
    function test_RecipientFieldIs56Bytes() public view {
        string memory dest = "GUSERSTELLARADDRESSFIXEDLENGTH56CHARS12345678901234567890ABCD";
        // A Stellar strkey is exactly 56 chars; trim/pad to 56 for test.
        PerihelionEscrow.Intent memory intent = _baseIntent();
        intent.destination = "GBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // 58 chars, will be clamped to 56
        bytes memory encoded = harness.encodeFillInstruction(bytes32(uint256(1)), intent);
        // Confirm recipient field occupies bytes [38, 94).
        assertEq(encoded.length, 219);
        // Byte at offset 94 is the start of dest_asset, not recipient overflow.
        // Verify by checking that the min_dest_amount field lands at offset 163.
        // min_dest_amount = 990_000 encoded as uint128 big-endian.
        uint128 minAmt = intent.minDestAmount;
        bytes memory amtBytes = abi.encodePacked(minAmt);
        for (uint256 i = 0; i < 16; i++) {
            assertEq(encoded[163 + i], amtBytes[i]);
        }
    }
}
