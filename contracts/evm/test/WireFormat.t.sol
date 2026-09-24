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
    // The vector uses the 227-byte strkey-text layout (issue #270/#271):
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
    ///      Issue #706: offset 34 must carry the *source* eid (this chain's own
    ///      LayerZero endpoint id), not the destination `stellarEid`.
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

        // Issue #706: the src_eid slot (offset 34, 4 bytes) must be the source
        // eid — the escrow's own LayerZero endpoint id — not the destination
        // `stellarEid`. The harness is constructed with eid 30_316.
        uint32 encodedSrcEid;
        assembly {
            encodedSrcEid := shr(224, mload(add(add(encoded, 0x20), 34)))
        }
        assertEq(encodedSrcEid, 30_316, "offset 34 must encode the source eid, not the destination eid");
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

/* … truncated 7758 chars — edit only what you need near the top … */
