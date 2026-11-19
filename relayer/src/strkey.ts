// SPDX-License-Identifier: MIT

/**
 * Checksum validation for Stellar strkey-encoded Ed25519 secret seeds.
 *
 * The layout matches Stellar's strkey format: base32 (RFC 4648 alphabet, no
 * padding) over `version byte || 32-byte payload || CRC16-XModem checksum`,
 * where the checksum is stored little-endian. A 56-character `S…` string
 * decodes to exactly 35 bytes. Implemented locally so that loading config does
 * not pull in the full Stellar SDK.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** Version byte for Ed25519 secret seeds (encodes to a leading "S"). */
const SECRET_SEED_VERSION_BYTE = 18 << 3;
const SECRET_SEED_LENGTH = 56;
const DECODED_LENGTH = 35;
const PAYLOAD_LENGTH = 33;

/** CRC16-XModem (polynomial 0x1021, initial value 0). */
function crc16Xmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/** Decode unpadded base32; returns undefined on a character outside the alphabet. */
function base32Decode(input: string): Uint8Array | undefined {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of input) {
    const index = BASE32_ALPHABET.indexOf(ch);
    if (index < 0) return undefined;
    buffer = ((buffer << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >>> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/**
 * Return true when `value` is a well-formed Stellar secret seed: correct
 * alphabet and length, correct version byte, and a valid CRC16 checksum.
 */
export function isValidEd25519SecretSeed(value: string): boolean {
  if (value.length !== SECRET_SEED_LENGTH || !value.startsWith("S")) return false;
  const bytes = base32Decode(value);
  if (!bytes || bytes.length !== DECODED_LENGTH) return false;
  if (bytes[0] !== SECRET_SEED_VERSION_BYTE) return false;
  const checksum = crc16Xmodem(bytes.subarray(0, PAYLOAD_LENGTH));
  return bytes[33] === (checksum & 0xff) && bytes[34] === checksum >> 8;
}
