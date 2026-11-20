// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { StellarStrKey } from "../src/StellarStrKey.sol";

/// @dev External wrapper so the internal library functions can be fuzzed and
///      called through a real call frame.
contract StrKeyHarness {
    function isStrKey(string memory s) external pure returns (bool) {
        return StellarStrKey.isValidStrKey(bytes(s));
    }

    function isDestAsset(string memory s) external pure returns (bool) {
        return StellarStrKey.isValidDestAsset(bytes(s));
    }
}

/// @notice Conformance tests for the on-chain strkey / asset validator (#1052).
///         The vector files under contracts/shared/wire-vectors/strkey/ are shared with
///         the Soroban decoder's tests (`strkey.rs` / `asset.rs`), and their labels were
///         checked against the SDK's `isStellarAddress` / `isStellarAsset`. A value the
///         escrow accepts must therefore decode on the settlement side.
contract StellarStrKeyTest is Test {
    string internal constant VECTOR_DIR = "../shared/wire-vectors/strkey/";
    string internal constant BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

    /// @dev Valid account strkey (all-zero key). Used as the base for mutations.
    string internal constant G_KEY = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    string internal constant C_KEY = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
    string internal constant ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

    StrKeyHarness internal h;

    function setUp() public {
        h = new StrKeyHarness();
    }

    // --- Vector files --------------------------------------------------------

    function test_DestinationVectors() public view {
        string[] memory valid = _readCases("destination-valid.txt");
        string[] memory invalid = _readCases("destination-invalid.txt");
        assertGt(valid.length, 0);
        assertGt(invalid.length, 0);
        for (uint256 i = 0; i < valid.length; i++) {
            assertTrue(h.isStrKey(valid[i]), valid[i]);
        }
        for (uint256 i = 0; i < invalid.length; i++) {
            assertFalse(h.isStrKey(invalid[i]), invalid[i]);
        }
    }

    function test_DestAssetVectors() public view {
        string[] memory valid = _readCases("dest-asset-valid.txt");
        string[] memory invalid = _readCases("dest-asset-invalid.txt");
        assertGt(valid.length, 0);
        assertGt(invalid.length, 0);
        for (uint256 i = 0; i < valid.length; i++) {
            assertTrue(h.isDestAsset(valid[i]), valid[i]);
        }
        for (uint256 i = 0; i < invalid.length; i++) {
            assertFalse(h.isDestAsset(invalid[i]), invalid[i]);
        }
    }

    // --- Targeted cases ------------------------------------------------------

    function test_AcceptsCanonicalStrKeys() public view {
        assertTrue(h.isStrKey(G_KEY));
        assertTrue(h.isStrKey(C_KEY));
        assertTrue(h.isStrKey(ISSUER));
    }

    function test_RejectsBadChecksum() public view {
        // Same length and alphabet, last character changed: CRC-16 must catch it.
        assertFalse(h.isStrKey("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHE"));
    }

    function test_RejectsWrongVersionByte() public view {
        // A valid contract payload re-prefixed with G (account version byte mismatch).
        assertFalse(h.isStrKey("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4"));
    }

    function test_RejectsWrongLength() public view {
        assertFalse(h.isStrKey(""));
        assertFalse(h.isStrKey("GUSERSTELLAR"));
        assertFalse(h.isStrKey(string.concat(G_KEY, "A")));
    }

    function test_AssetFormsAreExclusive() public view {
        assertTrue(h.isDestAsset("native"));
        assertFalse(h.isDestAsset("Native"));
        assertFalse(h.isDestAsset("XLM"));
        // A bare account strkey is an account, not an asset.
        assertFalse(h.isDestAsset(G_KEY));
        // Classic issuers must be G... accounts, never contracts.
        assertFalse(h.isDestAsset(string.concat("USDC:", C_KEY)));
    }

    function test_AssetCodeBounds() public view {
        assertTrue(h.isDestAsset(string.concat("ABCDEFGHIJKL:", G_KEY))); // 12 chars
        assertFalse(h.isDestAsset(string.concat("ABCDEFGHIJKLM:", G_KEY))); // 13 chars
        assertFalse(h.isDestAsset(string.concat(":", G_KEY))); // empty code
    }

    // --- Properties ----------------------------------------------------------

    /// @dev CRC-16 detects every single-burst error of up to 16 bits, and changing one
    ///      base32 character alters a 5-bit group. So every single-character change of a
    ///      valid strkey must be rejected, whatever the position or replacement.
    function testFuzz_SingleCharSubstitutionRejected(uint256 seed, bool useContract) public view {
        bytes memory key = bytes(useContract ? C_KEY : G_KEY);
        uint256 pos = seed % 56;
        uint256 pick = (seed / 56) % 32;
        bytes1 replacement = bytes(BASE32)[pick];
        vm.assume(replacement != key[pos]);

        bytes memory mutated = key;
        mutated[pos] = replacement;
        assertFalse(h.isStrKey(string(mutated)));
    }

    /// @dev Only 56-character strings can be strkeys.
    function testFuzz_WrongLengthRejected(uint8 len) public view {
        vm.assume(len != 56);
        bytes memory s = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            s[i] = "G";
        }
        assertFalse(h.isStrKey(string(s)));
    }

    /// @dev A classic code longer than 12 characters is never canonical.
    function testFuzz_LongAssetCodeRejected(uint8 len) public view {
        len = uint8(bound(len, 13, 40));
        bytes memory code = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            code[i] = "A";
        }
        assertFalse(h.isDestAsset(string.concat(string(code), ":", ISSUER)));
    }

    // --- Helpers -------------------------------------------------------------

    /// @dev Reads a vector file and splits it on `\n`. An empty line is a valid case, so
    ///      `vm.readLine` (which also returns "" at EOF) cannot be used here.
    function _readCases(string memory name) internal view returns (string[] memory out) {
        bytes memory data = bytes(vm.readFile(string.concat(VECTOR_DIR, name)));
        uint256 count;
        for (uint256 i = 0; i < data.length; i++) {
            if (data[i] == "\n") count++;
        }
        out = new string[](count);
        uint256 start;
        uint256 n;
        for (uint256 i = 0; i < data.length; i++) {
            if (data[i] == "\n") {
                bytes memory line = new bytes(i - start);
                for (uint256 j = 0; j < line.length; j++) {
                    line[j] = data[start + j];
                }
                out[n++] = string(line);
                start = i + 1;
            }
        }
    }
}
