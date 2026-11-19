// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Stellar strkey and asset-identifier validation
/// @notice On-chain mirror of the Soroban decoder, so the escrow rejects a bad
///         `destination` or `destAsset` before the LayerZero fee is paid (#1052).
///         A FillInstruction the escrow accepts must also decode on the settlement
///         side. The rules are ported from `contracts/soroban/settlement/src/strkey.rs`
///         (`decode_strkey`) and `src/asset.rs` (`parse`) and from the SDK's
///         `isStellarAddress` / `isStellarAsset`; keep all of them in step.
///
///         Strkey layout (SEP-0023): `version(1) | payload(32) | crc16_xmodem(2, LE)`,
///         base32 (RFC 4648 alphabet, no padding). 35 bytes encode to exactly 56
///         characters (280 bits), so no padding bits exist and every character
///         participates in the checksum.
library StellarStrKey {
    /// @dev Version byte of a `G...` account strkey: 6 << 3.
    uint8 private constant VERSION_ACCOUNT = 0x30;
    /// @dev Version byte of a `C...` contract strkey: 2 << 3.
    uint8 private constant VERSION_CONTRACT = 0x10;
    /// @dev Length in characters of every strkey (G/C) this protocol accepts.
    uint256 private constant STRKEY_LEN = 56;
    /// @dev Longest asset code in a `CODE:ISSUER` identifier.
    uint256 private constant MAX_CODE_LEN = 12;
    /// @dev Sentinel for "not a base32 character".
    uint8 private constant INVALID = 0xff;

    /// @notice True iff `s` is a 56-character `G...` or `C...` strkey with a valid
    ///         version byte and CRC-16 checksum.
    function isValidStrKey(bytes memory s) internal pure returns (bool) {
        if (s.length != STRKEY_LEN) return false;
        uint8 expected;
        if (s[0] == "G") {
            expected = VERSION_ACCOUNT;
        } else if (s[0] == "C") {
            expected = VERSION_CONTRACT;
        } else {
            return false;
        }

        bytes memory raw = new bytes(35);
        uint256 buf;
        uint256 bits;
        uint256 idx;
        for (uint256 i = 0; i < STRKEY_LEN; i++) {
            uint8 v = _base32Value(uint8(s[i]));
            if (v == INVALID) return false;
            buf = (buf << 5) | v;
            bits += 5;
            if (bits >= 8) {
                bits -= 8;
                raw[idx++] = bytes1(uint8(buf >> bits));
            }
        }

        if (uint8(raw[0]) != expected) return false;
        uint16 crc = _crc16(raw, 33);
        return uint8(raw[33]) == uint8(crc) && uint8(raw[34]) == uint8(crc >> 8);
    }

    /// @notice True iff `a` is one of the three canonical `destAsset` forms:
    ///         `native`, `CODE:ISSUER` (1-12 ASCII alphanumerics, then a valid `G...`
    ///         issuer), or a bare `C...` contract strkey. Byte-for-byte the Soroban
    ///         `asset::parse` rules, including its first-colon split.
    function isValidDestAsset(bytes memory a) internal pure returns (bool) {
        if (a.length == 0) return false;
        if (keccak256(a) == keccak256("native")) return true;

        uint256 colon = a.length;
        for (uint256 i = 0; i < a.length; i++) {
            if (a[i] == ":") {
                colon = i;
                break;
            }
        }

        if (colon == a.length) {
            // No colon: only a contract strkey is canonical.
            return a[0] == "C" && isValidStrKey(a);
        }

        if (colon == 0 || colon > MAX_CODE_LEN) return false;
        for (uint256 i = 0; i < colon; i++) {
            if (!_isAsciiAlnum(uint8(a[i]))) return false;
        }

        // Issuer is everything after the first colon. It must be a `G...` strkey.
        uint256 issuerLen = a.length - colon - 1;
        if (issuerLen != STRKEY_LEN || a[colon + 1] != "G") return false;
        bytes memory issuer = new bytes(issuerLen);
        for (uint256 i = 0; i < issuerLen; i++) {
            issuer[i] = a[colon + 1 + i];
        }
        return isValidStrKey(issuer);
    }

    // --- Internal helpers ----------------------------------------------------

    /// @dev Base32 (RFC 4648, uppercase) digit value, or `INVALID`.
    function _base32Value(uint8 c) private pure returns (uint8) {
        if (c >= 0x41 && c <= 0x5a) return c - 0x41; // 'A'..'Z' -> 0..25
        if (c >= 0x32 && c <= 0x37) return c - 0x32 + 26; // '2'..'7' -> 26..31
        return INVALID;
    }

    function _isAsciiAlnum(uint8 c) private pure returns (bool) {
        return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
    }

    /// @dev CRC-16/XMODEM (poly 0x1021, init 0, no reflection, no xorout) over the
    ///      first `len` bytes of `data`. Matches Stellar's `crc16`.
    function _crc16(bytes memory data, uint256 len) private pure returns (uint16 crc) {
        for (uint256 i = 0; i < len; i++) {
            crc ^= uint16(uint8(data[i])) << 8;
            for (uint256 j = 0; j < 8; j++) {
                crc = (crc & 0x8000) != 0 ? (crc << 1) ^ 0x1021 : crc << 1;
            }
        }
    }
}
