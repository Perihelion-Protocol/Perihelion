//! Minimal, `no_std`-safe Stellar strkey (SEP-0023) encoder for contract IDs.
//!
//! `Address::from_contract_id` (used to construct an `Address` from a raw
//! 32-byte contract-id payload) was removed as a public `soroban-sdk` API —
//! guest (wasm) code must instead build the strkey string and call
//! `Address::from_str`. The obvious fix is the `stellar-strkey` crate, but it
//! pulls in `std` (`String`, `Vec`, `data-encoding`, `thiserror`), which
//! conflicts with the contract's own `no_std` panic handler at wasm link time
//! (`error[E0152]: duplicate lang item... panic_impl`, first defined in
//! `soroban_sdk`, second in `std`). Contracts must never depend on `std`.
//!
//! This module hand-ports just the one operation the contract needs —
//! encoding a 32-byte contract ID as a strkey — using only `core`, into a
//! fixed-size stack buffer (no heap allocation). Decoding is not needed: the
//! host resolves the string via `Address::from_str`.
//!
//! Base32 (RFC4648, no padding) and the CRC16/XMODEM checksum are ported from
//! `stellar-strkey` v0.0.9 (Apache-2.0), whose CRC16 implementation itself
//! carries a BSD-style notice from `stellar/go`; both are reproduced below
//! per their license terms.
//!
//! `contract_strkey`'s only caller, `messages::address_from_contract_id`, is
//! itself only reachable from tests today (see that function's doc-comment)
//! — hence the module-wide `dead_code` allow, not a claim that this code is
//! unused in spirit.
#![allow(dead_code)]

/// version byte for a `Contract` strkey: `2 << 3`. See SEP-0023.
const VERSION_CONTRACT: u8 = 2 << 3;

const BASE32_ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// Ported from stellar-strkey's `crc.rs` (Apache-2.0), which itself carries:
//
// Copyright 2001-2010 Georges Menie (www.menie.org)
// Copyright 2010-2012 Salvatore Sanfilippo (adapted to Redis coding style)
// Copyright 2015 Stellar Development Foundation (ported to go)
// Copyright 2022 Stellar Development Foundation (ported to rust)
// All rights reserved. Redistributed under a BSD-style license; see
// https://github.com/stellar/rs-stellar-strkey/blob/main/LICENSE.
//
// CRC-16/XMODEM: width 16, poly 0x1021, init 0x0000, no reflection, no xorout.
const CRC16_TABLE: [u16; 256] = [
    0x0000, 0x1021, 0x2042, 0x3063, 0x4084, 0x50a5, 0x60c6, 0x70e7, 0x8108, 0x9129, 0xa14a, 0xb16b,
    0xc18c, 0xd1ad, 0xe1ce, 0xf1ef, 0x1231, 0x0210, 0x3273, 0x2252, 0x52b5, 0x4294, 0x72f7, 0x62d6,
    0x9339, 0x8318, 0xb37b, 0xa35a, 0xd3bd, 0xc39c, 0xf3ff, 0xe3de, 0x2462, 0x3443, 0x0420, 0x1401,
    0x64e6, 0x74c7, 0x44a4, 0x5485, 0xa56a, 0xb54b, 0x8528, 0x9509, 0xe5ee, 0xf5cf, 0xc5ac, 0xd58d,
    0x3653, 0x2672, 0x1611, 0x0630, 0x76d7, 0x66f6, 0x5695, 0x46b4, 0xb75b, 0xa77a, 0x9719, 0x8738,
    0xf7df, 0xe7fe, 0xd79d, 0xc7bc, 0x48c4, 0x58e5, 0x6886, 0x78a7, 0x0840, 0x1861, 0x2802, 0x3823,
    0xc9cc, 0xd9ed, 0xe98e, 0xf9af, 0x8948, 0x9969, 0xa90a, 0xb92b, 0x5af5, 0x4ad4, 0x7ab7, 0x6a96,
    0x1a71, 0x0a50, 0x3a33, 0x2a12, 0xdbfd, 0xcbdc, 0xfbbf, 0xeb9e, 0x9b79, 0x8b58, 0xbb3b, 0xab1a,
    0x6ca6, 0x7c87, 0x4ce4, 0x5cc5, 0x2c22, 0x3c03, 0x0c60, 0x1c41, 0xedae, 0xfd8f, 0xcdec, 0xddcd,
    0xad2a, 0xbd0b, 0x8d68, 0x9d49, 0x7e97, 0x6eb6, 0x5ed5, 0x4ef4, 0x3e13, 0x2e32, 0x1e51, 0x0e70,
    0xff9f, 0xefbe, 0xdfdd, 0xcffc, 0xbf1b, 0xaf3a, 0x9f59, 0x8f78, 0x9188, 0x81a9, 0xb1ca, 0xa1eb,
    0xd10c, 0xc12d, 0xf14e, 0xe16f, 0x1080, 0x00a1, 0x30c2, 0x20e3, 0x5004, 0x4025, 0x7046, 0x6067,
    0x83b9, 0x9398, 0xa3fb, 0xb3da, 0xc33d, 0xd31c, 0xe37f, 0xf35e, 0x02b1, 0x1290, 0x22f3, 0x32d2,
    0x4235, 0x5214, 0x6277, 0x7256, 0xb5ea, 0xa5cb, 0x95a8, 0x8589, 0xf56e, 0xe54f, 0xd52c, 0xc50d,
    0x34e2, 0x24c3, 0x14a0, 0x0481, 0x7466, 0x6447, 0x5424, 0x4405, 0xa7db, 0xb7fa, 0x8799, 0x97b8,
    0xe75f, 0xf77e, 0xc71d, 0xd73c, 0x26d3, 0x36f2, 0x0691, 0x16b0, 0x6657, 0x7676, 0x4615, 0x5634,
    0xd94c, 0xc96d, 0xf90e, 0xe92f, 0x99c8, 0x89e9, 0xb98a, 0xa9ab, 0x5844, 0x4865, 0x7806, 0x6827,
    0x18c0, 0x08e1, 0x3882, 0x28a3, 0xcb7d, 0xdb5c, 0xeb3f, 0xfb1e, 0x8bf9, 0x9bd8, 0xabbb, 0xbb9a,
    0x4a75, 0x5a54, 0x6a37, 0x7a16, 0x0af1, 0x1ad0, 0x2ab3, 0x3a92, 0xfd2e, 0xed0f, 0xdd6c, 0xcd4d,
    0xbdaa, 0xad8b, 0x9de8, 0x8dc9, 0x7c26, 0x6c07, 0x5c64, 0x4c45, 0x3ca2, 0x2c83, 0x1ce0, 0x0cc1,
    0xef1f, 0xff3e, 0xcf5d, 0xdf7c, 0xaf9b, 0xbfba, 0x8fd9, 0x9ff8, 0x6e17, 0x7e36, 0x4e55, 0x5e74,
    0x2e93, 0x3eb2, 0x0ed1, 0x1ef0,
];

fn checksum(data: &[u8]) -> [u8; 2] {
    let mut crc: u16 = 0;
    for &b in data.iter() {
        crc = (crc << 8) ^ CRC16_TABLE[((crc >> 8) as u8 ^ b) as usize];
    }
    [(crc & 0xff) as u8, (crc >> 8) as u8]
}

/// Encode a raw 32-byte contract ID as a 56-character `C...` strkey.
///
/// Layout: `[version(1) | payload(32) | checksum(2)]` (35 bytes), base32
/// (RFC4648, no padding) encoded. 35 bytes is exactly 56 base32 groups
/// (280 bits / 5), so no padding character is ever produced.
pub fn contract_strkey(id: &[u8; 32]) -> [u8; 56] {
    let mut payload = [0u8; 35];
    payload[0] = VERSION_CONTRACT;
    payload[1..33].copy_from_slice(id);
    let crc = checksum(&payload[..33]);
    payload[33..35].copy_from_slice(&crc);

    let mut out = [0u8; 56];
    let mut bit_buffer: u64 = 0;
    let mut bits_in_buffer: u32 = 0;
    let mut out_idx = 0usize;
    for &byte in payload.iter() {
        bit_buffer = (bit_buffer << 8) | (byte as u64);
        bits_in_buffer += 8;
        while bits_in_buffer >= 5 {
            bits_in_buffer -= 5;
            let index = ((bit_buffer >> bits_in_buffer) & 0x1F) as usize;
            out[out_idx] = BASE32_ALPHABET[index];
            out_idx += 1;
        }
    }
    debug_assert_eq!(
        bits_in_buffer, 0,
        "35 bytes must encode to exactly 56 base32 chars with no leftover bits"
    );
    debug_assert_eq!(out_idx, 56);
    out
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn checksum_matches_known_vector() {
        // Reference vector from stellar-strkey's own crc.rs tests.
        assert_eq!(checksum(b"123456789"), [0xc3, 0x31]);
        assert_eq!(checksum(&[0x12, 0x34, 0x56, 0x78, 0x90]), [0xe6, 0x48]);
    }

    #[test]
    fn contract_strkey_starts_with_c_and_is_56_chars() {
        let strkey = contract_strkey(&[0u8; 32]);
        assert_eq!(strkey.len(), 56);
        assert_eq!(strkey[0], b'C');
        assert!(strkey.iter().all(|b| b.is_ascii_alphanumeric()));
    }

    #[test]
    fn contract_strkey_is_accepted_by_the_host_address_parser() {
        // Integration check against the real (host-side) strkey parser,
        // rather than trusting a hand-copied external vector: round-trip
        // through soroban_sdk::Address::from_str and back via to_string.
        extern crate std;
        let env = soroban_sdk::Env::default();
        let id = [0x7Bu8; 32];
        let strkey = contract_strkey(&id);
        let strkey_str = core::str::from_utf8(&strkey).unwrap();
        let addr = soroban_sdk::Address::from_str(&env, strkey_str);
        let round_tripped = addr.to_string();
        let mut buf = [0u8; 56];
        round_tripped.copy_into_slice(&mut buf);
        assert_eq!(buf, strkey, "host parser disagrees with our encoding");
    }
}
