use std::fmt::Write as _;

use sha2::{Digest as _, Sha256};

pub(crate) fn lowercase_hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut output, "{byte:02x}").expect("writing to a String cannot fail");
    }
    output
}

pub(crate) fn sha256_hex(input: impl AsRef<[u8]>) -> String {
    lowercase_hex(&Sha256::digest(input.as_ref()))
}

#[cfg(test)]
mod tests {
    use super::{lowercase_hex, sha256_hex};

    #[test]
    fn lowercase_hex_preserves_leading_zeroes() {
        assert_eq!(lowercase_hex(&[0x00, 0x01, 0xab, 0xff]), "0001abff");
    }

    #[test]
    fn sha256_hex_matches_the_standard_abc_vector() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
