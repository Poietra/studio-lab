use sha2::{Digest, Sha256};

const CONTENT_DOMAIN_V1: &[u8] = b"poietra.mathtex-outline.content.v1\0";
const TOOLCHAIN_DOMAIN_V1: &[u8] = b"poietra.mathtex-outline.toolchain.v1\0";

const TOOLCHAIN_MANIFEST_V1: &str = concat!(
    "algorithm=poietra-mathtex-outline-v1\n",
    "mitex=0.2.7@51f7210e026ab05d037125247e92d4d023d8a80d\n",
    "typst=0.15.1\n",
    "ttf-parser=0.25.1\n",
    "font-family=New Computer Modern Math\n",
    "normalization-height=1\n",
    "coordinate-quantum=0.000001\n",
    "fill-rule=nonzero\n",
);

fn digest(domain: &[u8], content: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update(
        u64::try_from(content.len())
            .unwrap_or(u64::MAX)
            .to_be_bytes(),
    );
    hasher.update(content);
    format!("{:x}", hasher.finalize())
}

pub(crate) fn content_digest_v1(normalized_tex_parts: &[String]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(CONTENT_DOMAIN_V1);
    hasher.update(
        u64::try_from(normalized_tex_parts.len())
            .unwrap_or(u64::MAX)
            .to_be_bytes(),
    );
    for part in normalized_tex_parts {
        hasher.update(u64::try_from(part.len()).unwrap_or(u64::MAX).to_be_bytes());
        hasher.update(part.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

pub(crate) fn toolchain_digest_v1() -> String {
    digest(TOOLCHAIN_DOMAIN_V1, TOOLCHAIN_MANIFEST_V1.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domains_and_content_are_part_of_the_digest() {
        assert_ne!(
            content_digest_v1(&["E = mc^2".to_owned()]),
            content_digest_v1(&["E = mc^3".to_owned()])
        );
        assert_ne!(
            content_digest_v1(&[TOOLCHAIN_MANIFEST_V1.to_owned()]),
            toolchain_digest_v1()
        );
        assert_ne!(
            content_digest_v1(&["E".to_owned(), "=".to_owned()]),
            content_digest_v1(&["E =".to_owned()]),
            "length framing preserves Studio texParts boundaries"
        );
    }
}
