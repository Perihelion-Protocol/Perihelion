// SPDX-License-Identifier: MIT

//! Canonical `destAsset` identifiers.
//!
//! The user signs `destAsset` as a string, and the EVM escrow forwards those
//! exact bytes in the 69-byte `dest_asset` field of a `FillInstruction`. Three
//! forms are canonical, and each resolves to the token contract that
//! `fill_intent` calls `transfer` on:
//!
//! | Form          | Example                 | Resolves to                                   |
//! |---------------|-------------------------|-----------------------------------------------|
//! | `native`      | `native`                | the configured `NativeToken` (XLM SAC)        |
//! | `CODE:ISSUER` | `USDC:GA5Z...`          | that asset's Stellar Asset Contract, derived  |
//! | `C...` strkey | `CDLZ...` (56 chars)    | the contract itself, if admin-allowlisted     |
//!
//! `CODE:ISSUER` needs no configuration: its Stellar Asset Contract address is
//! a deterministic function of the asset, so the contract derives it on-chain
//! rather than trusting a registry entry. A contract-only (SEP-41) token has no
//! classic asset to derive from, and an arbitrary contract could misbehave on
//! `transfer`, so a `C...` identifier settles only once the admin has added it
//! to the destination-token allowlist.
//!
//! The longest form is `CODE:ISSUER` at 12 + 1 + 56 = 69 bytes, which is why
//! `MAX_DEST_ASSET_LEN` (here, in the EVM escrow and in the SDK) is 69; a
//! `C...` strkey is 56 bytes and `native` is 6.

use soroban_sdk::{Bytes, Env};

use crate::strkey;

pub use crate::constants::MAX_DEST_ASSET_LEN;

/// A parsed canonical `destAsset` identifier.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DestAsset<'a> {
    /// `native` — XLM.
    Native,
    /// `CODE:ISSUER` — a classic asset with a 1–12 character alphanumeric code
    /// and the 32-byte ed25519 key of its `G...` issuer.
    Classic { code: &'a [u8], issuer: [u8; 32] },
    /// A `C...` contract strkey — a contract-native token used directly.
    Contract,
}

/// Parse a canonical `destAsset` identifier, or `None` if it is none of the
/// three forms. Matches the SDK's `isStellarAsset` exactly.
pub fn parse(id: &[u8]) -> Option<DestAsset<'_>> {
    if id == b"native" {
        return Some(DestAsset::Native);
    }
    if let Some(colon) = id.iter().position(|&b| b == b':') {
        let (code, issuer) = (&id[..colon], &id[colon + 1..]);
        if code.is_empty() || code.len() > 12 || !code.iter().all(u8::is_ascii_alphanumeric) {
            return None;
        }
        if issuer.first() != Some(&b'G') {
            return None;
        }
        let (_, key) = strkey::decode_strkey(issuer)?;
        return Some(DestAsset::Classic { code, issuer: key });
    }
    if id.first() == Some(&b'C') && strkey::is_valid_strkey(id) {
        return Some(DestAsset::Contract);
    }
    None
}

/// XDR-serialize a classic `Asset` (`CreditAlphanum4` for 1–4 character codes,
/// `CreditAlphanum12` for 5–12), the input `Deployer::with_stellar_asset`
/// derives the Stellar Asset Contract address from.
pub fn classic_asset_xdr(env: &Env, code: &[u8], issuer: &[u8; 32]) -> Bytes {
    let (asset_type, code_width): (u32, usize) = if code.len() <= 4 { (1, 4) } else { (2, 12) };
    let mut b = Bytes::new(env);
    b.append(&Bytes::from_array(env, &asset_type.to_be_bytes()));
    let mut padded = [0u8; 12];
    padded[..code.len()].copy_from_slice(code);
    b.append(&Bytes::from_slice(env, &padded[..code_width]));
    // AccountId: PublicKey union, discriminant PUBLIC_KEY_TYPE_ED25519 = 0.
    b.append(&Bytes::from_array(env, &0u32.to_be_bytes()));
    b.append(&Bytes::from_array(env, issuer));
    b
}

#[cfg(test)]
mod test {
    extern crate std;

    use super::*;
    use soroban_sdk::testutils::Address as _;

    const ZERO_ACCOUNT: &[u8] = b"GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    const ZERO_CONTRACT: &[u8] = b"CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

    #[test]
    fn parses_the_three_canonical_forms() {
        assert_eq!(parse(b"native"), Some(DestAsset::Native));
        let mut classic = std::vec::Vec::from(&b"USDC:"[..]);
        classic.extend_from_slice(ZERO_ACCOUNT);
        assert_eq!(
            parse(&classic),
            Some(DestAsset::Classic {
                code: b"USDC",
                issuer: [0u8; 32]
            })
        );
        assert_eq!(parse(ZERO_CONTRACT), Some(DestAsset::Contract));
    }

    #[test]
    fn longest_classic_form_is_max_dest_asset_len() {
        let mut id = std::vec::Vec::from(&b"ABCDEFGHIJKL:"[..]);
        id.extend_from_slice(ZERO_ACCOUNT);
        assert_eq!(id.len(), MAX_DEST_ASSET_LEN);
        assert!(parse(&id).is_some());
    }

    /// The shared strkey vectors (`contracts/shared/wire-vectors/strkey`) are also run
    /// by the EVM escrow's `StellarStrKey.t.sol`. Both sides must agree on every case,
    /// so a value the escrow accepts always decodes here (#1052).
    #[test]
    fn shared_vectors_agree_with_the_evm_validator() {
        const DEST_VALID: &str =
            include_str!("../../../shared/wire-vectors/strkey/destination-valid.txt");
        const DEST_INVALID: &str =
            include_str!("../../../shared/wire-vectors/strkey/destination-invalid.txt");
        const ASSET_VALID: &str =
            include_str!("../../../shared/wire-vectors/strkey/dest-asset-valid.txt");
        const ASSET_INVALID: &str =
            include_str!("../../../shared/wire-vectors/strkey/dest-asset-invalid.txt");

        for line in DEST_VALID.lines() {
            assert!(
                strkey::is_valid_strkey(line.as_bytes()),
                "destination {line:?}"
            );
        }
        for line in DEST_INVALID.lines() {
            assert!(
                !strkey::is_valid_strkey(line.as_bytes()),
                "destination {line:?}"
            );
        }
        for line in ASSET_VALID.lines() {
            assert!(parse(line.as_bytes()).is_some(), "dest_asset {line:?}");
        }
        for line in ASSET_INVALID.lines() {
            assert!(parse(line.as_bytes()).is_none(), "dest_asset {line:?}");
        }
    }

    #[test]
    fn rejects_malformed_identifiers() {
        let with = |prefix: &[u8], key: &[u8]| {
            let mut v = std::vec::Vec::from(prefix);
            v.extend_from_slice(key);
            v
        };
        // Account strkey alone is not an asset.
        assert_eq!(parse(ZERO_ACCOUNT), None);
        // Issuer must be a G... account, not a contract.
        assert_eq!(parse(&with(b"USDC:", ZERO_CONTRACT)), None);
        // Code length and alphabet.
        assert_eq!(parse(&with(b":", ZERO_ACCOUNT)), None);
        assert_eq!(parse(&with(b"ABCDEFGHIJKLM:", ZERO_ACCOUNT)), None);
        assert_eq!(parse(&with(b"US-C:", ZERO_ACCOUNT)), None);
        // Bad checksum on a contract strkey.
        let mut bad = std::vec::Vec::from(ZERO_CONTRACT);
        bad[55] = b'A';
        assert_eq!(parse(&bad), None);
        assert_eq!(parse(b""), None);
        assert_eq!(parse(b"Native"), None);
    }

    #[test]
    fn classic_xdr_matches_the_host_sac_derivation() {
        // The test SAC helper wraps `aaa:<issuer>`; deriving its address from our
        // XDR must land on the contract the host actually deployed.
        let env = Env::default();
        let issuer = soroban_sdk::Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(issuer);
        let issuer_strkey = sac.issuer().address().to_string();
        let mut buf = [0u8; 56];
        issuer_strkey.copy_into_slice(&mut buf);
        let (_, key) = strkey::decode_strkey(&buf).unwrap();
        let derived = env
            .deployer()
            .with_stellar_asset(classic_asset_xdr(&env, b"aaa", &key))
            .deployed_address();
        assert_eq!(derived, sac.address());
    }
}
