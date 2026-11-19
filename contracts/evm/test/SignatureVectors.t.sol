// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { PerihelionEscrow } from "../src/PerihelionEscrow.sol";

/// @title SignatureVectors conformance test
/// @notice Loads the shared signature-vectors.json and asserts that the
///         on-chain signature verifier produces identical accept/reject results
///         to the TypeScript verifyIntent.  This pins cross-implementation
///         signature behaviour and catches asymmetric acceptance bugs.
///
/// The vectors cover:
///   0  valid_canonical        : must accept
///   1  wrong_signer           : must reject (wrong private key)
///   2  high_s_malleable       : must reject (s > secp256k1 half-order, EIP-2)
///   3  truncated_64           : must reject (64 bytes, missing v)
///   4  over_length_66         : must reject (66 bytes, extra trailing zero)
///   5  bad_v_value_29         : must reject (v=29, not in {27,28})
///   6  cross_chain_domain     : must reject (signed under chainId=1, not 8453)
///   7  wrong_contract_domain  : must reject (signed under different contract address)
///
/// Run:
///   cd contracts/evm && forge test --match-contract SignatureVectors -vvv
contract SignatureVectorsTest is Test {
    // ─── Vector file ──────────────────────────────────────────────────────────

    string internal constant VECTORS_FILE = "../shared/wire-vectors/signature-vectors.json";

    // ─── Fixed domain (must match signature-vectors.json) ────────────────────

    uint256 internal constant CHAIN_ID = 8453;
    address internal constant VERIFYING_CONTRACT = 0x1234567890123456789012345678901234567890;

    // ─── Fixed intent (must match signature-vectors.json) ────────────────────

    address internal constant SIGNER = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address internal constant WRONG_SIGNER = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;

    // ─── Pre-computed hash from vector generator ──────────────────────────────

    bytes32 internal constant EXPECTED_INTENT_HASH =
        0x2a13e474fbc11b64d8df1011811e93203dd1f6fd4de909aba0fb4aa87c974e9d;

    // ─── Harness ──────────────────────────────────────────────────────────────

    SigVerifyHarness internal harness;

    function setUp() public {
        vm.chainId(CHAIN_ID);
        harness = new SigVerifyHarness();
    }

    // ─── Intent hash pinning ──────────────────────────────────────────────────

    /// @notice The intent hash must be reproducible on-chain from the fixed
    ///         intent fields to ensure the EIP-712 encoding is identical to
    ///         what the TypeScript SDK computed.
    function test_intentHashMatchesVector() public {
        string memory json = vm.readFile(VECTORS_FILE);

        // Reconstruct the intent hash using the harness's EIP-712 implementation
        // using the same domain and intent fields as the vector generator.
        bytes32 computed = harness.computeIntentHash(
            CHAIN_ID,
            VERIFYING_CONTRACT,
            SigVerifyHarness.IntentFields({
                user: SIGNER,
                destination: vm.parseJsonString(json, ".intent.destination"),
                sourceChainId: uint256(vm.parseJsonUint(json, ".intent.sourceChainId")),
                sourceAsset: vm.parseJsonAddress(json, ".intent.sourceAsset"),
                sourceAmount: uint256(vm.parseJsonUint(json, ".intent.sourceAmount")),
                destAsset: vm.parseJsonString(json, ".intent.destAsset"),
                minDestAmount: uint256(vm.parseJsonUint(json, ".intent.minDestAmount")),
                deadline: uint256(vm.parseJsonUint(json, ".intent.deadline")),
                nonce: uint256(vm.parseJsonUint(json, ".intent.nonce")),
                preferredSolver: address(0)
            })
        );
        assertEq(computed, EXPECTED_INTENT_HASH, "EIP-712 intent hash mismatch with vector file");
    }

    // ─── Valid vector ─────────────────────────────────────────────────────────

    function test_vector_valid_canonical() public {
        bytes memory sig = _vectorSig(0);
        assertTrue(
            harness.verifyEIP712(EXPECTED_INTENT_HASH, SIGNER, sig),
            "valid_canonical must be accepted"
        );
    }

    // ─── Reject vectors ───────────────────────────────────────────────────────

    function test_vector_wrong_signer() public {
        bytes memory sig = _vectorSig(1);
        // Signature verifies for WRONG_SIGNER but not for SIGNER (intent.user)
        assertFalse(
            harness.verifyEIP712(EXPECTED_INTENT_HASH, SIGNER, sig),
            "wrong_signer must be rejected when checked against intent.user"
        );
    }

    function test_vector_high_s_malleable() public {
        bytes memory sig = _vectorSig(2);
        assertFalse(
            harness.verifyEIP712(EXPECTED_INTENT_HASH, SIGNER, sig),
            "high_s_malleable must be rejected (s > half-order, EIP-2)"
        );
    }

    function test_vector_truncated_64() public {
        bytes memory sig = _vectorSig(3);
        assertFalse(
            harness.verifyEIP712(EXPECTED_INTENT_HASH, SIGNER, sig),
            "truncated_64 must be rejected (only 64 bytes)"
        );
    }

    function test_vector_over_length_66() public {
        bytes memory sig = _vectorSig(4);
        assertFalse(
            harness.verifyEIP712(EXPECTED_INTENT_HASH, SIGNER, sig),
            "over_length_66 must be rejected (66 bytes)"
        );
    }

    function test_vector_bad_v_value_29() public {
        bytes memory sig = _vectorSig(5);
        assertFalse(
            harness.verifyEIP712(EXPECTED_INTENT_HASH, SIGNER, sig),
            "bad_v_value_29 must be rejected"
        );
    }

    function test_vector_cross_chain_domain() public {
        bytes memory sig = _vectorSig(6);
        // The digest (EXPECTED_INTENT_HASH) was computed under chainId=8453.
        // The signature was produced under chainId=1. ecrecover will return
        // the wrong address, so this must be rejected.
        assertFalse(
            harness.verifyEIP712(EXPECTED_INTENT_HASH, SIGNER, sig),
            "cross_chain_domain must be rejected"
        );
    }

    function test_vector_wrong_contract_domain() public {
        bytes memory sig = _vectorSig(7);
        assertFalse(
            harness.verifyEIP712(EXPECTED_INTENT_HASH, SIGNER, sig),
            "wrong_contract_domain must be rejected"
        );
    }

    // ─── ERC-1271 vectors ─────────────────────────────────────────────────────

    function test_erc1271_magic_value_accepted() public {
        MockERC1271Wallet wallet =
            new MockERC1271Wallet(MockERC1271Wallet.Mode.ReturnMagic, bytes4(0x1626ba7e));
        bytes memory sig = hex"deadbeef";
        assertTrue(
            harness.verifyEIP712(EXPECTED_INTENT_HASH, address(wallet), sig),
            "ERC-1271 wallet returning magic value must be accepted"
        );
    }

    function test_erc1271_wrong_value_rejected() public {
        MockERC1271Wallet wallet =
            new MockERC1271Wallet(MockERC1271Wallet.Mode.ReturnMagic, bytes4(0xffffffff));
        bytes memory sig = hex"deadbeef";
        assertFalse(
            harness.verifyEIP712(EXPECTED_INTENT_HASH, address(wallet), sig),
            "ERC-1271 wallet returning wrong value must be rejected"
        );
    }

    function test_erc1271_revert_rejected() public {
        MockERC1271Wallet wallet =
            new MockERC1271Wallet(MockERC1271Wallet.Mode.Revert, bytes4(0x1626ba7e));
        bytes memory sig = hex"deadbeef";
        assertFalse(
            harness.verifyEIP712(EXPECTED_INTENT_HASH, address(wallet), sig),
            "ERC-1271 wallet that reverts must be rejected"
        );
    }

    function test_erc1271_empty_return_rejected() public {
        MockERC1271Wallet wallet =
            new MockERC1271Wallet(MockERC1271Wallet.Mode.ReturnEmpty, bytes4(0x1626ba7e));
        bytes memory sig = hex"deadbeef";
        assertFalse(
            harness.verifyEIP712(EXPECTED_INTENT_HASH, address(wallet), sig),
            "ERC-1271 wallet returning no data must be rejected"
        );
    }

    function test_erc1271_short_return_rejected() public {
        MockERC1271Wallet wallet =
            new MockERC1271Wallet(MockERC1271Wallet.Mode.ReturnShort, bytes4(0x1626ba7e));
        bytes memory sig = hex"deadbeef";
        assertFalse(
            harness.verifyEIP712(EXPECTED_INTENT_HASH, address(wallet), sig),
            "ERC-1271 wallet returning fewer than 32 bytes must be rejected"
        );
    }

    function test_erc1271_does_not_accept_ecdsa_vectors() public {
        // A contract wallet must not fall back to ECDSA: a valid ECDSA
        // signature for SIGNER must be rejected when intent.user is a contract.
        MockERC1271Wallet wallet =
            new MockERC1271Wallet(MockERC1271Wallet.Mode.ReturnMagic, bytes4(0xffffffff));
        bytes memory sig = _vectorSig(0);
        assertFalse(
            harness.verifyEIP712(EXPECTED_INTENT_HASH, address(wallet), sig),
            "contract wallet must not accept ECDSA signatures"
        );
    }

    // ─── Helper ───────────────────────────────────────────────────────────────

    function _vectorSig(uint256 index) internal view returns (bytes memory) {
        string memory json = vm.readFile(VECTORS_FILE);
        string memory key = string.concat(".vectors[", vm.toString(index), "].signature");
        return vm.parseJsonBytes(json, key);
    }
}

/// @dev Minimal ERC-1271 wallet used to exercise the contract-wallet branch of
///      the signature verifier.  Behaviour is selected by `mode`.
contract MockERC1271Wallet {
    enum Mode {
        ReturnMagic, // return the configured 4-byte value (left-padded to 32 bytes)
        Revert, // revert on isValidSignature
        ReturnEmpty, // return zero-length data
        ReturnShort // return fewer than 32 bytes

    }

    Mode internal immutable mode;
    bytes4 internal immutable magic;

    constructor(Mode _mode, bytes4 _magic) {
        mode = _mode;
        magic = _magic;
    }

    function isValidSignature(bytes32, bytes calldata) external view returns (bytes4) {
        if (mode == Mode.Revert) revert("MockERC1271: invalid signature");
        if (mode == Mode.ReturnEmpty) {
            assembly {
                return(0, 0)
            }
        }
        if (mode == Mode.ReturnShort) {
            assembly {
                mstore(0, 0)
                return(0, 4)
            }
        }
        return magic;
    }
}

/// @dev Standalone harness that replicates PerihelionEscrow's _verify logic
///      (byte-for-byte identical) so the signature vectors can be tested
///      without needing access to a private function.
///
///      Also exposes a computeIntentHash helper that reconstructs the EIP-712
///      hash from raw intent fields + domain parameters, used to pin the hash
///      against the vector file.
contract SigVerifyHarness {
    // secp256k1 half-order — identical to PerihelionEscrow.SECP256K1_HALF_ORDER
    uint256 private constant HALF_ORDER =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    bytes32 private constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    bytes32 private constant INTENT_TYPEHASH = keccak256(
        "Intent(address user,string destination,uint256 sourceChainId,address sourceAsset,uint256 sourceAmount,string destAsset,uint256 minDestAmount,uint256 deadline,uint256 nonce,address preferredSolver)"
    );

    struct IntentFields {
        address user;
        string destination;
        uint256 sourceChainId;
        address sourceAsset;
        uint256 sourceAmount;
        string destAsset;
        uint256 minDestAmount;
        uint256 deadline;
        uint256 nonce;
        address preferredSolver;
    }

    // ERC-1271 magic value: bytes4(keccak256("isValidSignature(bytes32,bytes)"))
    bytes4 private constant ERC1271_MAGIC_VALUE = 0x1626ba7e;

    // Bounded gas stipend for the ERC-1271 staticcall, mirroring the escrow.
    uint256 private constant ERC1271_GAS_STIPEND = 30_000;

    /// @notice Replicate PerihelionEscrow._verify exactly, including the
    ///         ERC-1271 branch for contract wallets.
    function verifyEIP712(bytes32 digest, address signer, bytes calldata signature)
        external
        view
        returns (bool)
    {
        if (signer.code.length > 0) {
            return _verifyERC1271(digest, signer, signature);
        }
        return _verifyECDSA(digest, signer, signature);
    }

    /// @dev ERC-1271 path: staticcall isValidSignature with a bounded gas
    ///      stipend and accept only the magic value with >= 32 bytes returned.
    function _verifyERC1271(bytes32 digest, address signer, bytes calldata signature)
        private
        view
        returns (bool)
    {
        (bool ok, bytes memory ret) = signer.staticcall{ gas: ERC1271_GAS_STIPEND }(
            abi.encodeWithSelector(
                bytes4(keccak256("isValidSignature(bytes32,bytes)")), digest, signature
            )
        );
        if (!ok || ret.length < 32) return false;
        return bytes4(ret) == ERC1271_MAGIC_VALUE;
    }

    /// @dev ECDSA path: 65-byte signature, EIP-2 low-s, v in {27,28}.
    function _verifyECDSA(bytes32 digest, address signer, bytes calldata signature)
        private
        pure
        returns (bool)
    {
        if (signature.length != 65) return false;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return false;
        if (uint256(s) > HALF_ORDER) return false;
        address recovered = ecrecover(digest, v, r, s);
        return recovered != address(0) && recovered == signer;
    }

    /// @notice Compute the EIP-712 intent hash from raw intent fields + domain params.
    function computeIntentHash(uint256 chainId, address verifyingContract, IntentFields calldata f)
        external
        pure
        returns (bytes32)
    {
        bytes32 domainSep = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256(bytes("Perihelion")),
                keccak256(bytes("1")),
                chainId,
                verifyingContract
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                INTENT_TYPEHASH,
                f.user,
                keccak256(bytes(f.destination)),
                f.sourceChainId,
                f.sourceAsset,
                f.sourceAmount,
                keccak256(bytes(f.destAsset)),
                f.minDestAmount,
                f.deadline,
                f.nonce,
                f.preferredSolver
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
    }
}
