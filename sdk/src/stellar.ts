/**
 * Validators for Stellar addresses and asset identifiers.
 *
 * Stellar uses a custom Base32 encoding (RFC 4648 alphabet with CRC-16/XMODEM
 * checksum) for public keys and contract addresses — "strkeys". This module
 * validates the structure and checksum of those values so integrators catch
 * malformed inputs before a cross-chain hop, not after.
 *
 * Supported strkey version bytes:
 *   G...  → 0x06 << 3 = 0x30  (ED25519 public key / account address)
 *   C...  → 0x02 << 3 = 0x10  (contract address)
 */

// Stellar's Base32 alphabet (same as RFC 4648 but uppercase only).
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** CRC-16/XMODEM over a byte array, as used by Stellar strkey. */
function crc16(data: Uint8Array): number {
  let crc = 0x0000;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
    }
  }
  return crc & 0xffff;
}

/** Decode a Stellar Base32 string to raw bytes, or null on invalid input. */
function base32Decode(input: string): Uint8Array | null {
  // Stellar strkeys have no padding; length must produce a whole number of bytes.
  const bits = input.length * 5;
  if (bits % 8 !== 0) return null;
  const out = new Uint8Array(bits / 8);
  let buf = 0;
  let bitsLeft = 0;
  let idx = 0;
  for (const ch of input) {
    const val = BASE32_ALPHABET.indexOf(ch);
    if (val === -1) return null;
    buf = (buf << 5) | val;
    bitsLeft += 5;
    if (bitsLeft >= 8) {
      bitsLeft -= 8;
      out[idx++] = (buf >> bitsLeft) & 0xff;
    }
  }
  return out;
}

/**
 * Validate a Stellar strkey.
 * @param value  The strkey string to validate.
 * @param expectedVersion  Expected version byte (0x30 for G-keys, 0x10 for C-keys).
 */
function isValidStrkey(value: string, expectedVersion: number): boolean {
  const decoded = base32Decode(value);
  if (!decoded || decoded.length < 3) return false;
  if (decoded[0] !== expectedVersion) return false;
  // Last 2 bytes are the CRC-16 checksum over the preceding bytes.
  const payload = decoded.slice(0, -2);
  const checksum = (decoded[decoded.length - 2]! | (decoded[decoded.length - 1]! << 8));
  return crc16(payload) === checksum;
}

/**
 * Returns true if `value` is a valid Stellar account address (`G...` strkey,
 * 56 chars) or contract address (`C...` strkey, 56 chars).
 *
 * These are the only valid forms for {@link Intent.destination}.
 */
export function isStellarAddress(value: string): boolean {
  if (typeof value !== "string") return false;
  if (value.length !== 56) return false;
  if (value[0] === "G") return isValidStrkey(value, 0x30);
  if (value[0] === "C") return isValidStrkey(value, 0x10);
  return false;
}

/**
 * Returns true if `value` is a valid Stellar asset identifier:
 * - `"native"` for XLM
 * - `"<CODE>:<ISSUER>"` where CODE is 1–12 alphanumeric chars and ISSUER
 *   is a valid `G...` account strkey.
 *
 * This is the valid form for {@link Intent.destAsset}.
 */
export function isStellarAsset(value: string): boolean {
  if (typeof value !== "string") return false;
  if (value === "native") return true;
  const colon = value.indexOf(":");
  if (colon === -1) return false;
  const code = value.slice(0, colon);
  const issuer = value.slice(colon + 1);
  // Asset codes: 1–12 alphanumeric characters (Stellar spec).
  if (!/^[A-Za-z0-9]{1,12}$/.test(code)) return false;
  // Issuer must be a valid G... account strkey.
  return issuer.length === 56 && issuer[0] === "G" && isValidStrkey(issuer, 0x30);
}
