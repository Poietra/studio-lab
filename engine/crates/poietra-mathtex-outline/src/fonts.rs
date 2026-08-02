use ratex_font::FontId;

macro_rules! define_embedded_fonts {
    ($( $variant:ident => $constant:ident: $filename:literal ),+ $(,)?) => {
        $(
            const $constant: &[u8] = include_bytes!(concat!(
                env!("OUT_DIR"),
                "/katex-fonts/",
                $filename
            ));
        )+

        /// Maps every `FontId` exposed by pinned `RaTeX` to the only bytes
        /// reachable by the `MathTex` compiler. This exhaustive match fails to
        /// compile if the dependency gains a variant without an attestation
        /// decision here.
        pub(crate) fn katex_font_bytes(font_id: FontId) -> Option<&'static [u8]> {
            Some(match font_id {
                $(FontId::$variant => $constant,)+
                FontId::CjkRegular | FontId::CjkFallback | FontId::EmojiFallback => return None,
            })
        }

        #[cfg(test)]
        pub(crate) const REACHABLE_KATEX_FONT_ASSETS_V1: &[(FontId, &str, &[u8])] = &[
            $((FontId::$variant, $filename, $constant),)+
        ];
    };
}

// This is the exact non-fallback `FontId` image of pinned RaTeX revision
// ae391d727ac615437c63c308f4538d971a84bede, in basename order.
define_embedded_fonts! {
    AmsRegular => AMS_REGULAR: "KaTeX_AMS-Regular.ttf",
    CaligraphicRegular => CALIGRAPHIC_REGULAR: "KaTeX_Caligraphic-Regular.ttf",
    FrakturBold => FRAKTUR_BOLD: "KaTeX_Fraktur-Bold.ttf",
    FrakturRegular => FRAKTUR_REGULAR: "KaTeX_Fraktur-Regular.ttf",
    MainBold => MAIN_BOLD: "KaTeX_Main-Bold.ttf",
    MainBoldItalic => MAIN_BOLD_ITALIC: "KaTeX_Main-BoldItalic.ttf",
    MainItalic => MAIN_ITALIC: "KaTeX_Main-Italic.ttf",
    MainRegular => MAIN_REGULAR: "KaTeX_Main-Regular.ttf",
    MathBoldItalic => MATH_BOLD_ITALIC: "KaTeX_Math-BoldItalic.ttf",
    MathItalic => MATH_ITALIC: "KaTeX_Math-Italic.ttf",
    SansSerifBold => SANS_SERIF_BOLD: "KaTeX_SansSerif-Bold.ttf",
    SansSerifItalic => SANS_SERIF_ITALIC: "KaTeX_SansSerif-Italic.ttf",
    SansSerifRegular => SANS_SERIF_REGULAR: "KaTeX_SansSerif-Regular.ttf",
    ScriptRegular => SCRIPT_REGULAR: "KaTeX_Script-Regular.ttf",
    Size1Regular => SIZE1_REGULAR: "KaTeX_Size1-Regular.ttf",
    Size2Regular => SIZE2_REGULAR: "KaTeX_Size2-Regular.ttf",
    Size3Regular => SIZE3_REGULAR: "KaTeX_Size3-Regular.ttf",
    Size4Regular => SIZE4_REGULAR: "KaTeX_Size4-Regular.ttf",
    TypewriterRegular => TYPEWRITER_REGULAR: "KaTeX_Typewriter-Regular.ttf",
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reachable_assets_are_the_exact_pinned_ratex_font_id_image() {
        let mut previous = "";
        for &(font_id, filename, expected_bytes) in REACHABLE_KATEX_FONT_ASSETS_V1 {
            assert!(
                previous < filename,
                "font attestation order must be canonical"
            );
            assert_eq!(filename, format!("KaTeX_{}.ttf", font_id.as_str()));
            assert_eq!(katex_font_bytes(font_id), Some(expected_bytes));
            previous = filename;
        }

        assert_eq!(FontId::parse("Caligraphic-Bold"), None);
        assert_eq!(katex_font_bytes(FontId::CjkRegular), None);
        assert_eq!(katex_font_bytes(FontId::CjkFallback), None);
        assert_eq!(katex_font_bytes(FontId::EmojiFallback), None);
    }
}
