use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use poietra_eval::{CompileEngineFrameOptionsV1, compile_engine_frame_v1};
use poietra_render_wgpu::{DecodedPngAssetV1, decode_verified_png_v1};
use poietra_scene_ir::{
    AffineTransformV1, AnimationChannelV1, AssetAlphaModeV1, AssetColorSpaceV1, AssetManifestV1,
    AssetReferenceV1, CubicPathV1, CubicSegmentV1, CubicSubpathV1, FillRuleV1, FillStyleV1,
    FragmentMaterialV1, ImageLocalRectV1, ImageSamplerV1, PngAssetKindV1, PngAssetV1,
    PngMediaTypeV1, PointV1, RenderCameraV1, RenderCapabilityV1, RenderDrawV1, RenderPacketV1,
    RgbaColorV1, SceneIrV1, StrokeCapV1, StrokeJoinV1, StrokeStyleV1, ViewportV1,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SharedFixture {
    assets: AssetManifestV1,
    #[allow(dead_code)]
    #[serde(default)]
    reference: Option<PixelReferenceSet>,
    sample: EvaluationRequest,
    scene: SceneIrV1,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
pub struct PixelReferenceSet {
    #[serde(default)]
    pub clear_only: bool,
    pub reason: String,
    pub samples: BTreeMap<String, PixelReference>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
pub struct PixelReference {
    pub at: [u32; 2],
    pub rgba: [u8; 4],
    pub tolerance: u8,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EvaluationRequest {
    evidence: Vec<String>,
    #[allow(dead_code)]
    expected: Option<EvaluationExpectation>,
    #[allow(dead_code)]
    id: Option<String>,
    packet_id: String,
    sample_time: f64,
    viewport: ViewportV1,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
struct EvaluationExpectation {
    semantic_digest: String,
}

fn fixture_path(file_name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures/engine-v1")
        .join(file_name)
}

fn read_fixture(file_name: &str) -> SharedFixture {
    let fixture: SharedFixture = serde_json::from_slice(
        &fs::read(fixture_path(file_name)).expect("shared fixture must be readable"),
    )
    .expect("shared fixture must match its envelope");
    fixture
}

fn compile_fixture(fixture: &SharedFixture) -> poietra_scene_ir::RenderPacketV1 {
    compile_engine_frame_v1(CompileEngineFrameOptionsV1 {
        assets: &fixture.assets,
        evidence: &fixture.sample.evidence,
        packet_id: &fixture.sample.packet_id,
        sample_time: fixture.sample.sample_time,
        scene: &fixture.scene,
        viewport: fixture.sample.viewport.clone(),
    })
    .expect("shared fixture must evaluate")
    .packet
}

pub fn sampled_packet() -> poietra_scene_ir::RenderPacketV1 {
    compile_fixture(&read_fixture("shared-circle-opacity.json"))
}

#[allow(dead_code)]
pub fn verified_rgba_png(
    id: &str,
    width: u32,
    height: u32,
    pixels: &[u8],
) -> (PngAssetV1, Arc<DecodedPngAssetV1>) {
    let mut bytes = Vec::new();
    let mut encoder = png::Encoder::new(&mut bytes, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().expect("test PNG header must encode");
    writer
        .write_image_data(pixels)
        .expect("test PNG pixels must encode");
    writer.finish().expect("test PNG must finish");
    let metadata = PngAssetV1 {
        alpha_mode: AssetAlphaModeV1::Straight,
        byte_length: u64::try_from(bytes.len()).expect("test PNG length must fit u64"),
        color_space: AssetColorSpaceV1::Srgb,
        id: id.to_owned(),
        kind: PngAssetKindV1::PngImage,
        media_type: PngMediaTypeV1::ImagePng,
        pixel_height: height,
        pixel_width: width,
        sha256: format!("{:x}", Sha256::digest(&bytes)),
    };
    let decoded = Arc::new(
        decode_verified_png_v1(&metadata, &bytes).expect("test PNG must verify and decode"),
    );
    (metadata, decoded)
}

#[allow(dead_code)]
pub fn empty_render_packet(viewport: ViewportV1, camera: RenderCameraV1) -> RenderPacketV1 {
    let mut packet = sampled_packet();
    packet.camera = camera;
    packet.draws.clear();
    packet.required_capabilities.clear();
    packet.viewport = viewport;
    packet
}

#[allow(dead_code)]
#[allow(clippy::too_many_arguments)] // Test fixture mirrors the Image draw contract fields.
pub fn image_draw(
    metadata: &PngAssetV1,
    draw_id: &str,
    entity_id: &str,
    local_rect: ImageLocalRectV1,
    opacity: f64,
    paint_order: u32,
    sampler: ImageSamplerV1,
    transform: AffineTransformV1,
) -> RenderDrawV1 {
    RenderDrawV1::Image {
        asset: AssetReferenceV1 {
            asset_id: metadata.id.clone(),
            sha256: metadata.sha256.clone(),
        },
        draw_id: draw_id.to_owned(),
        entity_id: entity_id.to_owned(),
        local_rect,
        opacity,
        paint_order,
        sampler,
        source_z_index: f64::from(paint_order),
        transform,
    }
}

fn rectangle_path(rectangle: &ImageLocalRectV1) -> CubicPathV1 {
    let points = [
        PointV1 {
            x: rectangle.left,
            y: rectangle.top,
        },
        PointV1 {
            x: rectangle.left,
            y: rectangle.bottom,
        },
        PointV1 {
            x: rectangle.right,
            y: rectangle.bottom,
        },
        PointV1 {
            x: rectangle.right,
            y: rectangle.top,
        },
        PointV1 {
            x: rectangle.left,
            y: rectangle.top,
        },
    ];
    let mut segments = Vec::new();
    for pair in points.windows(2) {
        segments.push(CubicSegmentV1 {
            control1: line_control(&pair[0], &pair[1], 1.0 / 3.0),
            control2: line_control(&pair[0], &pair[1], 2.0 / 3.0),
            end: pair[1].clone(),
        });
    }
    CubicPathV1 {
        subpaths: vec![CubicSubpathV1 {
            closed: true,
            segments,
            start: points[0].clone(),
        }],
    }
}

#[allow(dead_code)]
pub fn solid_rectangle_draw(
    draw_id: &str,
    entity_id: &str,
    rectangle: &ImageLocalRectV1,
    color: RgbaColorV1,
    opacity: f64,
    paint_order: u32,
) -> RenderDrawV1 {
    RenderDrawV1::Path {
        draw_id: draw_id.to_owned(),
        entity_id: entity_id.to_owned(),
        fill: Some(FillStyleV1 {
            color,
            fragment_material: None,
            rule: FillRuleV1::NonZero,
        }),
        opacity,
        paint_order,
        path: rectangle_path(rectangle),
        source_z_index: f64::from(paint_order),
        stroke: None,
        transform: AffineTransformV1::identity(),
    }
}

#[allow(dead_code)]
pub fn time_gradient_paint_order_packet(sample_time: f64) -> RenderPacketV1 {
    let mut packet = empty_render_packet(
        ViewportV1 {
            height_px: 16,
            width_px: 32,
        },
        RenderCameraV1 {
            bottom: -1.0,
            clear_color: RgbaColorV1 {
                alpha: 1.0,
                blue: 0.0,
                green: 0.0,
                red: 0.0,
            },
            kind: poietra_scene_ir::RenderCameraKindV1::Orthographic2d,
            left: -2.0,
            right: 2.0,
            top: 1.0,
        },
    );
    let background_rect = ImageLocalRectV1 {
        bottom: -1.0,
        left: -2.0,
        right: 2.0,
        top: 1.0,
    };
    let middle = ImageLocalRectV1 {
        bottom: -0.75,
        left: -1.5,
        right: 1.5,
        top: 0.75,
    };
    let foreground = ImageLocalRectV1 {
        bottom: -0.35,
        left: -0.5,
        right: 0.5,
        top: 0.35,
    };
    let mut fragment_draw = solid_rectangle_draw(
        "draw:time-gradient",
        "entity:time-gradient",
        &middle,
        RgbaColorV1 {
            alpha: 1.0,
            blue: 1.0,
            green: 1.0,
            red: 1.0,
        },
        1.0,
        1,
    );
    let RenderDrawV1::Path {
        fill: Some(fill_style),
        ..
    } = &mut fragment_draw
    else {
        unreachable!()
    };
    fill_style.fragment_material = Some(FragmentMaterialV1 {
        parameters: vec![1.0, 1.0, 0.0, 0.2],
        revision: 1,
        shader_id: "time-gradient".to_owned(),
        texture: None,
    });
    packet.draws = vec![
        solid_rectangle_draw(
            "draw:background",
            "entity:background",
            &background_rect,
            RgbaColorV1 {
                alpha: 1.0,
                blue: 0.0,
                green: 0.0,
                red: 1.0,
            },
            1.0,
            0,
        ),
        fragment_draw,
        solid_rectangle_draw(
            "draw:foreground",
            "entity:foreground",
            &foreground,
            RgbaColorV1 {
                alpha: 1.0,
                blue: 1.0,
                green: 0.0,
                red: 0.0,
            },
            1.0,
            2,
        ),
    ];
    packet.required_capabilities = vec![
        RenderCapabilityV1::CubicPathFill,
        RenderCapabilityV1::FragmentMaterial,
    ];
    packet.sample_time = sample_time;
    packet
}

#[allow(dead_code)]
pub fn generic_fill_fixture() -> (poietra_scene_ir::RenderPacketV1, PixelReferenceSet) {
    let mut fixture = read_fixture("generic-fill-topology.json");
    let reference = fixture
        .reference
        .take()
        .expect("generic fill fixture must carry its pixel reference");
    (compile_fixture(&fixture), reference)
}

#[allow(dead_code)]
pub fn generic_stroke_fixture() -> (poietra_scene_ir::RenderPacketV1, PixelReferenceSet) {
    let mut fixture = read_fixture("generic-stroke-topology.json");
    let reference = fixture
        .reference
        .take()
        .expect("generic stroke fixture must carry its pixel reference");
    (compile_fixture(&fixture), reference)
}

#[allow(dead_code)]
pub fn generic_stroke_packet_with_initial_trim(
    initial_trim: f64,
) -> poietra_scene_ir::RenderPacketV1 {
    let mut fixture = read_fixture("generic-stroke-topology.json");
    fixture.sample.sample_time = 0.0;
    let trim = fixture
        .scene
        .animation_channels
        .iter_mut()
        .find_map(|channel| match channel {
            AnimationChannelV1::PathTrim {
                entity_id,
                keyframes,
                ..
            } if entity_id == "curve" => Some(keyframes),
            _ => None,
        })
        .expect("generic stroke fixture must contain the curve trim channel");
    trim[0].value = initial_trim;
    compile_fixture(&fixture)
}

fn line_control(start: &PointV1, end: &PointV1, factor: f64) -> PointV1 {
    PointV1 {
        x: start.x + (end.x - start.x) * factor,
        y: start.y + (end.y - start.y) * factor,
    }
}

pub fn straight_stroke_packet(cap: StrokeCapV1) -> poietra_scene_ir::RenderPacketV1 {
    let mut packet = sampled_packet();
    packet.draws.truncate(1);
    let start = PointV1 { x: -2.0, y: 0.0 };
    let end = PointV1 { x: 2.0, y: 0.0 };
    let RenderDrawV1::Path {
        fill,
        opacity,
        path,
        stroke,
        ..
    } = &mut packet.draws[0]
    else {
        panic!("fixture draw must be a path");
    };
    *fill = None;
    *opacity = 0.5;
    *path = CubicPathV1 {
        subpaths: vec![CubicSubpathV1 {
            closed: false,
            segments: vec![CubicSegmentV1 {
                control1: line_control(&start, &end, 1.0 / 3.0),
                control2: line_control(&start, &end, 2.0 / 3.0),
                end,
            }],
            start,
        }],
    };
    *stroke = Some(StrokeStyleV1 {
        cap,
        color: RgbaColorV1 {
            alpha: 1.0,
            blue: 0.0,
            green: 1.0,
            red: 0.0,
        },
        dash_length_world: None,
        fragment_material: None,
        gap_length_world: None,
        join: StrokeJoinV1::Miter,
        miter_limit: 4.0,
        width_world: 1.0,
    });
    packet.required_capabilities = vec![RenderCapabilityV1::CubicPathStroke];
    packet
}
