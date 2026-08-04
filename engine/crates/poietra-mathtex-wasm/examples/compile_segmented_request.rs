use std::io::{self, BufRead, Write};

use poietra_mathtex_outline::{
    SEGMENTED_TEX_OUTLINE_RESPONSE_SCHEMA_V1, SEGMENTED_TEX_OUTLINE_VERSION_V1,
    SegmentedTexOutlineRequestV1, SegmentedTexOutlineResultV1,
    SegmentedTexOutlineUnsupportedCodeV1, compile_segmented_tex_outline_v1,
};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResponseV1 {
    result: SegmentedTexOutlineResultV1,
    schema: &'static str,
    version: u32,
}

fn response(result: SegmentedTexOutlineResultV1) -> ResponseV1 {
    ResponseV1 {
        result,
        schema: SEGMENTED_TEX_OUTLINE_RESPONSE_SCHEMA_V1,
        version: SEGMENTED_TEX_OUTLINE_VERSION_V1,
    }
}

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().lines() {
        let line = line?;
        let result = serde_json::from_str::<SegmentedTexOutlineRequestV1>(&line).map_or_else(
            |_| {
                SegmentedTexOutlineResultV1::unsupported(
                    SegmentedTexOutlineUnsupportedCodeV1::InvalidRequest,
                    "Segmented Tex outline request does not match the v1 contract",
                )
            },
            |request| compile_segmented_tex_outline_v1(&request),
        );
        serde_json::to_writer(&mut stdout, &response(result))?;
        stdout.write_all(b"\n")?;
    }
    Ok(())
}
