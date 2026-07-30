use sha2::{Digest, Sha256};

const CONTENT_DOMAIN_V1: &[u8] = b"poietra.mathtex-outline.content.v1\0";
const TOOLCHAIN_DOMAIN_V1: &[u8] = b"poietra.mathtex-outline.toolchain.v1\0";

const TOOLCHAIN_MANIFEST_V1: &str = concat!(
    "algorithm=poietra-mathtex-outline-v1\n",
    "ratex=0.1.14@ae391d727ac615437c63c308f4538d971a84bede\n",
    "kurbo=0.13.1\n",
    "ttf-parser=0.25.1\n",
    "font-set=KaTeX-20-TTF\n",
    "font-digest=e52df76208d1e41c8222496e9fb30cc2a1fe8a275b14995f3f6c3a9205db21fa\n",
    "open-path-stroke-width-em=0.0375\n",
    "normalization-height=1\n",
    "coordinate-quantum=0.000001\n",
    "fill-rule=nonzero\n",
    "source-profile=manim-default-corpus-v1-ascii\n",
    "user-defined-macros=fail-closed\n",
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
    use crate::MATHTEX_FONT_DIGEST_V1;

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

    #[test]
    fn toolchain_manifest_tracks_the_public_font_and_source_profile() {
        assert!(
            TOOLCHAIN_MANIFEST_V1.contains(MATHTEX_FONT_DIGEST_V1),
            "font provenance must invalidate the toolchain digest"
        );
        assert!(
            TOOLCHAIN_MANIFEST_V1.contains("source-profile=manim-default-corpus-v1-ascii"),
            "source compatibility policy must invalidate the toolchain digest"
        );
    }
}
