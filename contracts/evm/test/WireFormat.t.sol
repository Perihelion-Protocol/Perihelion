// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { PerihelionEscrow } from "../src/PerihelionEscrow.sol";
import { MockEndpoint } from "./PerihelionEscrow.t.sol";

/// @dev Endpoint stub: the escrow constructor calls `setDelegate` and needs code.
contract WireFormatNoopEndpoint {
    function setDelegate(address) external { }
}

/// @dev Exposes the escrow's internal inbound decoders for direct testing.
/// @dev The escrow constructor registers itself as the endpoint delegate; the
///      conformance tests only need that call to succeed.
contract StubEndpointV2 {
    function setDelegate(address) external { }
}

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
    function encodeFillInstruction(
        bytes32 intentHash,
        Intent calldata intent,
        address lockingSolver
    ) external view returns (bytes memory) {
        return _encodeFillInstruction(intentHash, intent, lockingSolver);
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
    // The vector uses the 227-byte strkey-text layout (issue #270/#271):
    //   recipient  = CC53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53WQD5 (56 chars)
    //                = strkey of [0xBB; 32] contract id
    //   dest_asset = CDGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZLND (56 chars)
    //                = strkey of [0xCC; 32] contract id, padded to 69 bytes
    //   preferred_solver = all zeros (open — test encoder hardcodes this)
    bytes32 internal constant FI_INTENT_HASH =
        hex"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    // Recipient destination string: CC53XO53...WQD5 (strkey of [0xBB;32])
    string internal constant FI_RECIPIENT_STR =
        "CC53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53XO53WQD5";
    // dest_asset string: CDGMZTGM...ZLND (strkey of [0xCC;32])
    string internal constant FI_DEST_ASSET_STR =
        "CDGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZLND";

    function setUp() public {
        harness = new DecoderHarness(address(new StubEndpointV2()), 30_316);
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

    /// @dev Issue #946: the solver SDK's `evmAddressToBytes32` must left-pad the
    ///      address (bytes 12-31) so the EVM decoder accepts it. This pins the
    ///      SDK helper to `_decodeFillConfirmed` and to the golden vector's
    ///      `solver_evm` word (bytes 34-65 of fill_confirmed.hex), preventing a
    ///      regression to the left-justified encoding the escrow rejects.
    function test_SolverEvmEncodingDecodesOnEvm() public {
        // Known solver address used by the SDK helper's test vector.
        address solverAddr = 0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa;

        // Mirror of @perihelion/sdk evmAddressToBytes32: left-pad into bytes 12-31.
        bytes32 solverWord = bytes32(uint256(uint160(solverAddr)));

        // The golden vector's solver_evm word must equal the SDK encoding.
        bytes memory golden = _readVector("fill_confirmed.hex");
        bytes32 goldenSolverWord;
        assembly {
            goldenSolverWord := mload(add(add(golden, 0x20), 34))
        }
        assertEq(
            solverWord,
            goldenSolverWord,
            "SDK solver_evm word must match fill_confirmed.hex bytes 34-65"
        );
        assertEq(solverWord, FC_SOLVER_WORD);

        // Feed the SDK-encoded word through the EVM decoder.
        bytes memory payload = abi.encodePacked(
            bytes1(0x01), bytes1(0x02), FC_HASH, solverWord, uint128(1_000_000), uint64(42)
        );
        (bytes32 h, address decodedSolver,,) = harness.decodeFillConfirmed(payload);
        assertEq(h, FC_HASH);
        assertEq(decodedSolver, solverAddr, "solver_evm must decode back to the solver address");

        // A left-justified (buggy) encoding must be rejected by the decoder.
        bytes32 leftJustified = bytes32(uint256(uint160(solverAddr)) << 96);
        bytes memory bad = abi.encodePacked(
            bytes1(0x01), bytes1(0x02), FC_HASH, leftJustified, uint128(1_000_000), uint64(42)
        );
        vm.expectRevert();
        harness.decodeFillConfirmed(bad);
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
    ///      Issue #706: offset 34 must carry the *source* eid (this chain's own
    ///      LayerZero endpoint id), not the destination `stellarEid`.
    function test_FillInstructionVectorMatchesSolidityEncoder() public view {
        bytes memory golden = _readVector("fill_instruction.hex");
        assertEq(
            golden.length,
            harness.fillInstructionLength(),
            "fill_instruction.hex has the wrong length"
        );

        // Build the canonical intent using the same inputs as the Rust test.
        PerihelionEscrow.Intent memory intent = PerihelionEscrow.Intent({
            user: address(0xA1),
            destination: FI_RECIPIENT_STR, // strkey of [0xBB;32]
            sourceChainId: block.chainid,
            sourceAsset: address(0xA2),
            sourceAmount: 0,
            destAsset: FI_DEST_ASSET_STR, // strkey of [0xCC;32]
            minDestAmount: 1_000_000_000,
            deadline: 9_999_999_999,
            nonce: 0,
            preferredSolver: address(0) // all-zeros = open
         });

        bytes memory encoded = harness.encodeFillInstruction(FI_INTENT_HASH, intent, address(0));
        assertEq(
            encoded.length,
            harness.fillInstructionLength(),
            "encoder must produce the FillInstruction length"
        );
        assertEq(
            encoded, golden, "Solidity encoder output must match fill_instruction.hex golden vector"
        );

        // Offset 34 is `reserved` (4 bytes). The escrow always writes zero there:
        // the origin eid is authenticated by the LayerZero transport, so the body
        // carries no eid that a router or the decoder could mistake for a route.
        uint32 encodedReserved;
        assembly {
            encodedReserved := shr(224, mload(add(add(encoded, 0x20), 34)))
        }
        assertEq(encodedReserved, 0, "offset 34 (reserved) must be zero");
    }

    /// @dev The other two canonical destAsset forms (`native`, `CODE:ISSUER`)
    ///      encode to their golden vectors too; `fill_instruction.hex` above
    ///      covers the contract-native `C...` form.
    function test_FillInstructionDestAssetFormVectorsMatchSolidityEncoder() public view {
        _assertFillInstructionVector("fill_instruction_native_asset.hex", "native");
        _assertFillInstructionVector(
            "fill_instruction_classic_asset.hex",
            "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
        );
    }

    function _assertFillInstructionVector(string memory name, string memory destAsset)
        internal
        view
    {
        PerihelionEscrow.Intent memory intent = PerihelionEscrow.Intent({
            user: address(0xA1),
            destination: FI_RECIPIENT_STR,
            sourceChainId: block.chainid,
            sourceAsset: address(0xA2),
            sourceAmount: 0,
            destAsset: destAsset,
            minDestAmount: 1_000_000_000,
            deadline: 9_999_999_999,
            nonce: 0,
            preferredSolver: address(0)
        });
        bytes memory encoded = harness.encodeFillInstruction(FI_INTENT_HASH, intent, address(0));
        assertEq(encoded, _readVector(name), name);
    }

    /// @dev Asserts the golden vector length matches the expected constant.
    /// This test catches stale vectors immediately rather than surfacing as
    /// a decode error in an unrelated test.
    function test_FillInstructionVectorLength() public view {
        bytes memory golden = _readVector("fill_instruction.hex");
        assertEq(
            golden.length,
            harness.fillInstructionLength(),
            "fill_instruction.hex must be exactly FILL_INSTRUCTION_LENGTH bytes"
        );
        assertEq(golden.length, 227, "fill_instruction.hex must be exactly 227 bytes");
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
        bytes memory bad = _readNeg("fill_confirmed_short.hex");
        vm.expectRevert();
        harness.decodeFillConfirmed(bad);
    }

    function test_FillConfirmedRejectsLongPayload() public {
        bytes memory bad = _readNeg("fill_confirmed_long.hex");
        vm.expectRevert();
        harness.decodeFillConfirmed(bad);
    }

    function test_FillConfirmedRejectsBadType() public {
        bytes memory bad = _readNeg("fill_confirmed_bad_type.hex");
        vm.expectRevert();
        harness.routeInbound(bad);
    }

    function test_FillConfirmedRejectsBadVersion() public {
        bytes memory bad = _readNeg("fill_confirmed_bad_version.hex");
        vm.expectRevert();
        harness.routeInbound(bad);
    }

    function test_FillConfirmedRejectsNonzeroHigh() public {
        bytes memory bad = _readNeg("fill_confirmed_nonzero_high.hex");
        vm.expectRevert();
        harness.decodeFillConfirmed(bad);
    }

    // --- CancelIntent negatives ---

    function test_CancelIntentRejectsShortPayload() public {
        bytes memory bad = _readNeg("cancel_intent_short.hex");
        vm.expectRevert();
        harness.decodeCancelIntent(bad);
    }

    function test_CancelIntentRejectsLongPayload() public {
        bytes memory bad = _readNeg("cancel_intent_long.hex");
        vm.expectRevert();
        harness.decodeCancelIntent(bad);
    }

    function test_CancelIntentRejectsBadType() public {
        bytes memory bad = _readNeg("cancel_intent_bad_type.hex");
        vm.expectRevert();
        harness.routeInbound(bad);
    }

    function test_CancelIntentRejectsBadVersion() public {
        bytes memory bad = _readNeg("cancel_intent_bad_version.hex");
        vm.expectRevert();
        harness.routeInbound(bad);
    }

    function test_CancelIntentRejectsBadReason() public {
        bytes memory bad = _readNeg("cancel_intent_bad_reason.hex");
        vm.expectRevert();
        harness.decodeCancelIntent(bad);
    }
}

/// @dev Tests for issue #270: destAsset must survive the full 69-byte round-trip.
contract FillInstructionEncodeTest is Test {
    DecoderHarness internal harness;

    uint32 internal constant STELLAR_EID = 30_316;

    function setUp() public {
        harness = new DecoderHarness(address(new StubEndpointV2()), STELLAR_EID);
    }

    function _baseIntent() internal view returns (PerihelionEscrow.Intent memory) {
        return PerihelionEscrow.Intent({
            user: address(0xA1),
            destination: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", // exactly 56 chars
            sourceChainId: block.chainid,
            sourceAsset: address(0xA2),
            sourceAmount: 1_000_000,
            destAsset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
            minDestAmount: 990_000,
            deadline: 9_999_999,
            nonce: 1,
            preferredSolver: address(0)
        });
    }

    /// Encoded payload is exactly 227 bytes (expanded from the old 158 and including reservation_window).
    function test_EncodedPayloadIs227Bytes() public view {
        PerihelionEscrow.Intent memory intent = _baseIntent();
        bytes memory encoded =
            harness.encodeFillInstruction(bytes32(uint256(1)), intent, address(0));
        assertEq(encoded.length, 227);
    }

    /// The full 69-byte destAsset appears at offset 94 in the payload.
    function test_DestAsset69BytesPreserved() public view {
        // Use a CODE:ISSUER asset whose issuer is 56 chars (total 69 bytes with CODE: prefix).
        string memory fullAsset = "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
        assertEq(bytes(fullAsset).length, 61); // "USDC:" (5) + 56 char issuer

        PerihelionEscrow.Intent memory intent = _baseIntent();
        intent.destAsset = fullAsset;

        bytes memory encoded =
            harness.encodeFillInstruction(bytes32(uint256(1)), intent, address(0));
        assertEq(encoded.length, 227);

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
        // A Stellar strkey is exactly 56 chars; trim/pad to 56 for test.
        PerihelionEscrow.Intent memory intent = _baseIntent();
        intent.destination = "GBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // 58 chars, will be clamped to 56
        bytes memory encoded =
            harness.encodeFillInstruction(bytes32(uint256(1)), intent, address(0));
        // Confirm recipient field occupies bytes [38, 94).
        assertEq(encoded.length, 227);
        // Byte at offset 94 is the start of dest_asset, not recipient overflow.
        // Verify by checking that the min_dest_amount field lands at offset 163.
        // min_dest_amount = 990_000 encoded as uint128 big-endian.
        uint128 minAmt = uint128(intent.minDestAmount);
        bytes memory amtBytes = abi.encodePacked(minAmt);
        for (uint256 i = 0; i < 16; i++) {
            assertEq(encoded[163 + i], amtBytes[i]);
        }
    }
}
