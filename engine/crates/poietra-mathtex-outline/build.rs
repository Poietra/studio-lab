use std::{env, fs, path::PathBuf};

// This is the exact filename image of the non-fallback `FontId` variants in
// pinned RaTeX ae391d727ac615437c63c308f4538d971a84bede. The build dependency
// owns the upstream bytes; copying only this closed set keeps its dynamic
// 20-face lookup out of the shipped native/WASM artifacts.
const REACHABLE_KATEX_FONT_FILENAMES_V1: [&str; 19] = [
    "KaTeX_AMS-Regular.ttf",
    "KaTeX_Caligraphic-Regular.ttf",
    "KaTeX_Fraktur-Bold.ttf",
    "KaTeX_Fraktur-Regular.ttf",
    "KaTeX_Main-Bold.ttf",
    "KaTeX_Main-BoldItalic.ttf",
    "KaTeX_Main-Italic.ttf",
    "KaTeX_Main-Regular.ttf",
    "KaTeX_Math-BoldItalic.ttf",
    "KaTeX_Math-Italic.ttf",
    "KaTeX_SansSerif-Bold.ttf",
    "KaTeX_SansSerif-Italic.ttf",
    "KaTeX_SansSerif-Regular.ttf",
    "KaTeX_Script-Regular.ttf",
    "KaTeX_Size1-Regular.ttf",
    "KaTeX_Size2-Regular.ttf",
    "KaTeX_Size3-Regular.ttf",
    "KaTeX_Size4-Regular.ttf",
    "KaTeX_Typewriter-Regular.ttf",
];

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=Cargo.toml");

    let output =
        PathBuf::from(env::var_os("OUT_DIR").expect("Cargo must set OUT_DIR")).join("katex-fonts");
    fs::create_dir_all(&output).expect("the generated KaTeX font directory must be writable");

    for filename in REACHABLE_KATEX_FONT_FILENAMES_V1 {
        let bytes = ratex_katex_fonts::ttf_bytes(filename)
            .unwrap_or_else(|| panic!("pinned RaTeX must embed {filename}"));
        fs::write(output.join(filename), bytes.as_ref())
            .unwrap_or_else(|error| panic!("failed to stage {filename}: {error}"));
    }
}
