#[allow(dead_code)]
mod support;

use std::sync::Arc;

use poietra_render_wgpu::{
    PrepareFrameErrorV1, PreparedRenderCommandV1, UnsupportedDrawReasonV1, prepare_frame_v1,
    prepare_frame_with_assets_v1,
};
use poietra_scene_ir::{
    AffineTransformV1, ImageLocalRectV1, ImageSamplerV1, RenderCameraKindV1, RenderCameraV1,
    RenderCapabilityV1, RgbaColorV1, ViewportV1,
};
use support::{empty_render_packet, image_draw, solid_rectangle_draw, verified_rgba_png};

fn camera() -> RenderCameraV1 {
    RenderCameraV1 {
        bottom: -2.0,
        clear_color: RgbaColorV1 {
            alpha: 1.0,
            blue: 0.0,
            green: 0.0,
            red: 0.0,
        },
        kind: RenderCameraKindV1::Orthographic2d,
        left: -4.0,
        right: 4.0,
        top: 2.0,
    }
}

fn local_rect() -> ImageLocalRectV1 {
    ImageLocalRectV1 {
        bottom: -1.0,
        left: -1.0,
        right: 1.0,
        top: 1.0,
    }
}

#[test]
fn prepares_verified_image_quad_with_camera_affine_and_top_first_uvs() {
    let (metadata, decoded) = verified_rgba_png("asset:image", 1, 1, &[255, 0, 0, 255]);
    let mut packet = empty_render_packet(
        ViewportV1 {
            height_px: 4,
            width_px: 8,
        },
        camera(),
    );
    packet.draws.push(image_draw(
        &metadata,
        "draw:image",
        "entity:image",
        local_rect(),
        0.5,
        0,
        ImageSamplerV1::Nearest,
        AffineTransformV1 {
            m11: 2.0,
            m12: 0.0,
            m21: 0.0,
            m22: 1.0,
            tx: 1.0,
            ty: 0.5,
        },
    ));
    packet.required_capabilities = vec![RenderCapabilityV1::PngImage];
    let resolve = |digest: &str| (digest == metadata.sha256.as_str()).then(|| Arc::clone(&decoded));

    let frame = prepare_frame_with_assets_v1(&packet, &resolve).unwrap();
    assert!(frame.draws().is_empty());
    assert_eq!(
        frame.render_commands(),
        &[PreparedRenderCommandV1::Image { image_index: 0 }]
    );
    let image = &frame.image_draws()[0];
    assert_eq!(image.draw_id(), "draw:image");
    assert_eq!(image.entity_id(), "entity:image");
    assert!((image.opacity() - 0.5).abs() <= f32::EPSILON);
    assert_eq!(image.sampler(), ImageSamplerV1::Nearest);
    assert_eq!(
        image.vertices().map(|vertex| vertex.position()),
        [[-0.25, 0.75], [0.75, 0.75], [-0.25, -0.25], [0.75, -0.25]]
    );
    assert_eq!(
        image.vertices().map(|vertex| vertex.uv()),
        [[0.0, 0.0], [1.0, 0.0], [0.0, 1.0], [1.0, 1.0]]
    );
    assert_eq!(
        frame.clip_bounds_for_entity("entity:image"),
        Some([-0.25, -0.25, 0.75, 0.75])
    );
}

#[test]
fn rejects_unresolved_or_wrong_digest_without_returning_a_partial_frame() {
    let (metadata, decoded) = verified_rgba_png("asset:image", 1, 1, &[255, 0, 0, 255]);
    let (_, wrong) = verified_rgba_png("asset:wrong", 1, 1, &[0, 255, 0, 255]);
    let mut packet = empty_render_packet(
        ViewportV1 {
            height_px: 4,
            width_px: 8,
        },
        camera(),
    );
    packet.draws.push(image_draw(
        &metadata,
        "draw:image",
        "entity:image",
        local_rect(),
        1.0,
        0,
        ImageSamplerV1::Linear,
        AffineTransformV1::identity(),
    ));
    packet.required_capabilities = vec![RenderCapabilityV1::PngImage];

    assert!(matches!(
        prepare_frame_v1(&packet),
        Err(PrepareFrameErrorV1::Unsupported {
            reason: UnsupportedDrawReasonV1::Image,
            ..
        })
    ));
    let missing = |_digest: &str| None;
    assert!(matches!(
        prepare_frame_with_assets_v1(&packet, &missing),
        Err(PrepareFrameErrorV1::MissingImageAsset { .. })
    ));
    let wrong_resolver = |_digest: &str| Some(Arc::clone(&wrong));
    assert!(matches!(
        prepare_frame_with_assets_v1(&packet, &wrong_resolver),
        Err(PrepareFrameErrorV1::ResolvedImageDigestMismatch { .. })
    ));

    let correct = |_digest: &str| Some(Arc::clone(&decoded));
    assert!(prepare_frame_with_assets_v1(&packet, &correct).is_ok());

    let mut overflowing = packet;
    let poietra_scene_ir::RenderDrawV1::Image { transform, .. } = &mut overflowing.draws[0] else {
        panic!("fixture draw must remain an image");
    };
    transform.m11 = f64::MAX / 2.0;
    assert!(matches!(
        prepare_frame_with_assets_v1(&overflowing, &correct),
        Err(PrepareFrameErrorV1::NumericRange { .. })
    ));
}

#[test]
fn preserves_path_image_path_command_order_without_splitting_path_geometry_storage() {
    let (metadata, decoded) = verified_rgba_png("asset:image", 1, 1, &[255, 255, 255, 128]);
    let mut packet = empty_render_packet(
        ViewportV1 {
            height_px: 4,
            width_px: 8,
        },
        camera(),
    );
    packet.draws = vec![
        solid_rectangle_draw(
            "draw:back",
            "entity:back",
            &ImageLocalRectV1 {
                bottom: -2.0,
                left: -4.0,
                right: 4.0,
                top: 2.0,
            },
            RgbaColorV1 {
                alpha: 1.0,
                blue: 0.0,
                green: 0.0,
                red: 1.0,
            },
            1.0,
            0,
        ),
        image_draw(
            &metadata,
            "draw:image",
            "entity:image",
            local_rect(),
            1.0,
            1,
            ImageSamplerV1::Linear,
            AffineTransformV1::identity(),
        ),
        solid_rectangle_draw(
            "draw:front",
            "entity:front",
            &local_rect(),
            RgbaColorV1 {
                alpha: 1.0,
                blue: 1.0,
                green: 0.0,
                red: 0.0,
            },
            0.5,
            2,
        ),
    ];
    packet.required_capabilities = vec![
        RenderCapabilityV1::CubicPathFill,
        RenderCapabilityV1::PngImage,
    ];
    let resolve = |_digest: &str| Some(Arc::clone(&decoded));

    let frame = prepare_frame_with_assets_v1(&packet, &resolve).unwrap();
    assert_eq!(frame.draws().len(), 2);
    assert_eq!(frame.image_draws().len(), 1);
    assert_eq!(frame.tessellation_calls(), 2);
    assert_eq!(
        frame.render_commands(),
        &[
            PreparedRenderCommandV1::Paint { draw_index: 0 },
            PreparedRenderCommandV1::Image { image_index: 0 },
            PreparedRenderCommandV1::Paint { draw_index: 1 },
        ]
    );
    assert_eq!(
        frame.draws()[0].index_range().end,
        frame.draws()[1].index_range().start
    );
}
