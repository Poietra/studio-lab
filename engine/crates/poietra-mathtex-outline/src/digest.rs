use sha2::{Digest, Sha256};

use crate::compile::{
    MANIM_DEFAULT_SOURCE_PROFILE_REVISION_V1, manim_default_source_profile_digest_v1,
};

const CONTENT_DOMAIN_V1: &[u8] = b"poietra.mathtex-outline.content.v1\0";
const TOOLCHAIN_DOMAIN_V1: &[u8] = b"poietra.mathtex-outline.toolchain.v1\0";

const TOOLCHAIN_MANIFEST_PREFIX_V1: &str = concat!(
    "algorithm=poietra-mathtex-outline-v1\n",
    "ratex=0.1.14@ae391d727ac615437c63c308f4538d971a84bede\n",
    "kurbo=0.13.1\n",
    "ttf-parser=0.25.1\n",
    "font-set=KaTeX-19-TTF\n",
    "font-digest=6a8369948029b4811a906fdd028542d5e34b11044937544a9870a88d4b9cd93a\n",
    "open-path-stroke-width-em=0.0375\n",
    "normalization-height=1\n",
    "coordinate-quantum=0.000001\n",
    "fill-rule=nonzero\n",
);
const TOOLCHAIN_MANIFEST_SUFFIX_V1: &str = "user-defined-macros=fail-closed\n";

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
    toolchain_digest_with_source_profile_v1(&manim_default_source_profile_digest_v1())
}

fn toolchain_digest_with_source_profile_v1(source_profile_digest: &str) -> String {
    digest(
        TOOLCHAIN_DOMAIN_V1,
        toolchain_manifest_v1(source_profile_digest).as_bytes(),
    )
}

fn toolchain_manifest_v1(source_profile_digest: &str) -> String {
    let mut manifest = String::with_capacity(
        TOOLCHAIN_MANIFEST_PREFIX_V1.len()
            + TOOLCHAIN_MANIFEST_SUFFIX_V1.len()
            + MANIM_DEFAULT_SOURCE_PROFILE_REVISION_V1.len()
            + source_profile_digest.len()
            + 64,
    );
    manifest.push_str(TOOLCHAIN_MANIFEST_PREFIX_V1);
    manifest.push_str("source-profile-revision=");
    manifest.push_str(MANIM_DEFAULT_SOURCE_PROFILE_REVISION_V1);
    manifest.push('\n');
    manifest.push_str("source-profile-digest=");
    manifest.push_str(source_profile_digest);
    manifest.push('\n');
    manifest.push_str(TOOLCHAIN_MANIFEST_SUFFIX_V1);
    manifest
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
            content_digest_v1(&[toolchain_manifest_v1(
                &manim_default_source_profile_digest_v1()
            )]),
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
        let source_profile_digest = manim_default_source_profile_digest_v1();
        let manifest = toolchain_manifest_v1(&source_profile_digest);
        assert!(
            manifest.contains(MATHTEX_FONT_DIGEST_V1),
            "font provenance must invalidate the toolchain digest"
        );
        assert!(
            manifest.contains(&format!(
                "source-profile-revision={MANIM_DEFAULT_SOURCE_PROFILE_REVISION_V1}\n"
            )),
            "source policy revision must invalidate the toolchain digest"
        );
        assert!(
            manifest.contains(&format!("source-profile-digest={source_profile_digest}\n")),
            "executable source profile must invalidate the toolchain digest"
        );
    }

    #[test]
    fn toolchain_digest_tracks_the_canonical_source_profile_digest() {
        assert_ne!(
            toolchain_digest_with_source_profile_v1(&"a".repeat(64)),
            toolchain_digest_with_source_profile_v1(&"b".repeat(64))
        );
    }
}
