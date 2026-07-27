#![cfg(not(target_arch = "wasm32"))]

mod support;

use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use poietra_render_wgpu::{WgpuPaintRendererV1, WgpuRenderTargetV1, prepare_frame_v1};
use poietra_scene_ir::{RenderPacketV1, StrokeCapV1};
use serde::Serialize;
use support::{
    PixelReferenceSet, generic_fill_fixture, generic_stroke_fixture, sampled_packet,
    straight_stroke_packet,
};

const BYTES_PER_PIXEL: u32 = 4;
const GPU_TIMEOUT: Duration = Duration::from_secs(10);
const TARGET_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8UnormSrgb;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdapterEvidence {
    backend: String,
    device: u32,
    device_type: String,
    driver: String,
    driver_info: String,
    fallback_requested: bool,
    name: String,
    vendor: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PixelEvidence {
    background: [u8; 4],
    blue_center: [u8; 4],
    green_cap_exterior: [u8; 4],
    green_round_cap: [u8; 4],
    green_stroke_center: [u8; 4],
    red_center: [u8; 4],
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SmokeEvidence {
    adapter: AdapterEvidence,
    format: String,
    padded_bytes_per_row: u32,
    pixels: PixelEvidence,
    status: &'static str,
    viewport: [u32; 2],
}

fn padded_bytes_per_row(width_px: u32) -> (u32, u32) {
    let unpadded = width_px
        .checked_mul(BYTES_PER_PIXEL)
        .expect("viewport row size must fit u32");
    let alignment = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let aligned_rows = unpadded
        .checked_add(alignment - 1)
        .expect("aligned row size must fit u32")
        / alignment;
    let padded = aligned_rows
        .checked_mul(alignment)
        .expect("padded row size must fit u32");
    (unpadded, padded)
}

fn pixel(rgba: &[u8], width_px: u32, x: u32, y: u32) -> [u8; 4] {
    assert!(x < width_px, "pixel x must be inside the viewport");
    let pixel_offset = y
        .checked_mul(width_px)
        .and_then(|offset| offset.checked_add(x))
        .and_then(|offset| offset.checked_mul(BYTES_PER_PIXEL))
        .and_then(|offset| usize::try_from(offset).ok())
        .expect("pixel offset must fit usize");
    let pixel_end = pixel_offset
        .checked_add(4)
        .expect("pixel end must fit usize");
    rgba.get(pixel_offset..pixel_end)
        .expect("pixel y must be inside the viewport")
        .try_into()
        .expect("RGBA8 pixel must contain four channels")
}

fn assert_pixel_close(actual: [u8; 4], expected: [u8; 4], tolerance: [u8; 4]) {
    for ((actual, expected), tolerance) in actual.into_iter().zip(expected).zip(tolerance) {
        assert!(
            actual.abs_diff(expected) <= tolerance,
            "expected channel {expected} +/- {tolerance}, received {actual}"
        );
    }
}

fn assert_no_gpu_error(kind: &str, error: Option<wgpu::Error>) {
    let Some(error) = error else {
        return;
    };
    panic!("{kind} GPU error: {error:?}");
}

fn request_fallback_adapter(instance: &wgpu::Instance) -> wgpu::Adapter {
    pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        apply_limit_buckets: false,
        compatible_surface: None,
        force_fallback_adapter: true,
        power_preference: wgpu::PowerPreference::None,
    }))
    .expect("a native fallback WGPU adapter is required for this proof")
}

fn assert_target_format_support(adapter: &wgpu::Adapter) {
    let required_texture_usages =
        wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::RENDER_ATTACHMENT;
    let format_features = adapter.get_texture_format_features(TARGET_FORMAT);
    assert!(
        format_features
            .allowed_usages
            .contains(required_texture_usages),
        "fallback adapter must support {TARGET_FORMAT:?} as a copyable render attachment"
    );
}

fn request_device(adapter: &wgpu::Adapter) -> (wgpu::Device, wgpu::Queue) {
    pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("poietra headless proof device"),
        memory_hints: wgpu::MemoryHints::MemoryUsage,
        required_features: wgpu::Features::empty(),
        required_limits: wgpu::Limits::downlevel_defaults(),
        ..Default::default()
    }))
    .expect("fallback adapter must create the proof device")
}

fn track_device_loss(
    device: &wgpu::Device,
) -> Arc<Mutex<Option<(wgpu::DeviceLostReason, String)>>> {
    let device_loss = Arc::new(Mutex::new(None));
    let reported_device_loss = Arc::clone(&device_loss);
    device.set_device_lost_callback(move |reason, message| {
        *reported_device_loss
            .lock()
            .expect("device-loss evidence mutex must not be poisoned") = Some((reason, message));
    });
    device_loss
}

fn render_packet(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    packet: &RenderPacketV1,
) -> (wgpu::Texture, wgpu::Extent3d) {
    let prepared = prepare_frame_v1(packet).expect("packet must prepare");
    let [width_px, height_px] = prepared.viewport();
    let extent = wgpu::Extent3d {
        depth_or_array_layers: 1,
        height: height_px,
        width: width_px,
    };
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("poietra headless proof target"),
        size: extent,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: TARGET_FORMAT,
        usage: wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    let renderer = WgpuPaintRendererV1::new(device, TARGET_FORMAT)
        .expect("proof target format must be supported by the renderer");
    renderer
        .render(
            device,
            queue,
            WgpuRenderTargetV1 {
                format: TARGET_FORMAT,
                height_px,
                view: &view,
                width_px,
            },
            &prepared,
        )
        .expect("prepared fixture must submit to the proof target");
    (texture, extent)
}

fn readback_texture(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    texture: &wgpu::Texture,
    extent: wgpu::Extent3d,
) -> (u32, Vec<u8>) {
    let (unpadded_bytes_per_row, padded_bytes_per_row) = padded_bytes_per_row(extent.width);
    let readback_size = u64::from(padded_bytes_per_row)
        .checked_mul(u64::from(extent.height))
        .expect("readback buffer size must fit u64");
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("poietra headless proof readback"),
        size: readback_size,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut copy_encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("poietra headless proof copy encoder"),
    });
    copy_encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &readback,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(padded_bytes_per_row),
                rows_per_image: Some(extent.height),
            },
        },
        extent,
    );
    let copy_submission = queue.submit([copy_encoder.finish()]);

    let (map_sender, map_receiver) = mpsc::sync_channel(1);
    readback
        .slice(..)
        .map_async(wgpu::MapMode::Read, move |result| {
            map_sender
                .send(result)
                .expect("map receiver must remain alive through device polling");
        });
    let poll_status = device
        .poll(wgpu::PollType::Wait {
            submission_index: Some(copy_submission),
            timeout: Some(GPU_TIMEOUT),
        })
        .expect("GPU proof submission must finish before the timeout");
    assert!(poll_status.wait_finished(), "GPU proof wait must finish");
    map_receiver
        .recv_timeout(GPU_TIMEOUT)
        .expect("map callback must run during device polling")
        .expect("readback buffer must map successfully");

    let mapped = readback
        .slice(..)
        .get_mapped_range()
        .expect("mapped readback range must be available");
    let padded_row_size =
        usize::try_from(padded_bytes_per_row).expect("padded row size must fit usize");
    let unpadded_row_size =
        usize::try_from(unpadded_bytes_per_row).expect("unpadded row size must fit usize");
    let height = usize::try_from(extent.height).expect("viewport height must fit usize");
    let rgba_size = unpadded_row_size
        .checked_mul(height)
        .expect("unpadded image size must fit usize");
    assert_eq!(
        mapped.len(),
        padded_row_size
            .checked_mul(height)
            .expect("mapped image size must fit usize")
    );
    let mut rgba = Vec::with_capacity(rgba_size);
    for row in mapped.chunks_exact(padded_row_size) {
        rgba.extend_from_slice(&row[..unpadded_row_size]);
    }
    assert_eq!(rgba.len(), rgba_size);
    drop(mapped);
    readback.unmap();
    (padded_bytes_per_row, rgba)
}

fn record_and_assert_evidence(
    adapter_info: wgpu::AdapterInfo,
    padded_bytes_per_row: u32,
    rgba: &[u8],
    viewport: [u32; 2],
) {
    let [width_px, _] = viewport;
    let pixels = PixelEvidence {
        background: pixel(rgba, width_px, 0, 0),
        blue_center: pixel(rgba, width_px, 90, 45),
        green_cap_exterior: pixel(rgba, width_px, 34, 25),
        green_round_cap: pixel(rgba, width_px, 36, 25),
        green_stroke_center: pixel(rgba, width_px, 50, 25),
        red_center: pixel(rgba, width_px, 70, 45),
    };
    let evidence = SmokeEvidence {
        adapter: AdapterEvidence {
            backend: format!("{:?}", adapter_info.backend),
            device: adapter_info.device,
            device_type: format!("{:?}", adapter_info.device_type),
            driver: adapter_info.driver,
            driver_info: adapter_info.driver_info,
            fallback_requested: true,
            name: adapter_info.name,
            vendor: adapter_info.vendor,
        },
        format: format!("{TARGET_FORMAT:?}"),
        padded_bytes_per_row,
        pixels,
        status: "rendered",
        viewport,
    };
    println!(
        "poietra-wgpu-evidence={}",
        serde_json::to_string(&evidence).expect("adapter evidence must serialize")
    );

    assert_eq!(evidence.pixels.background, [0, 0, 0, 255]);
    assert_pixel_close(evidence.pixels.red_center, [188, 0, 0, 255], [1, 0, 0, 0]);
    assert_eq!(evidence.pixels.blue_center, [0, 0, 255, 255]);
    assert_eq!(evidence.pixels.green_cap_exterior, [0, 0, 0, 255]);
    assert_pixel_close(
        evidence.pixels.green_round_cap,
        [0, 188, 0, 255],
        [0, 1, 0, 0],
    );
    assert_pixel_close(
        evidence.pixels.green_stroke_center,
        [0, 188, 0, 255],
        [0, 1, 0, 0],
    );
}

#[test]
#[ignore = "requires a native software WGPU adapter; the dedicated CI step runs this proof"]
fn renders_shared_fixture_with_fallback_adapter() {
    let instance =
        wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let adapter = request_fallback_adapter(&instance);
    let adapter_info = adapter.get_info();
    assert_eq!(
        adapter_info.device_type,
        wgpu::DeviceType::Cpu,
        "force_fallback_adapter must resolve to a CPU adapter"
    );
    assert_target_format_support(&adapter);

    let (device, queue) = request_device(&adapter);
    let device_loss = track_device_loss(&device);
    let out_of_memory_scope = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let internal_scope = device.push_error_scope(wgpu::ErrorFilter::Internal);
    let validation_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);

    let (texture, extent) = render_packet(&device, &queue, &sampled_packet());
    let (padded_bytes_per_row, rgba) = readback_texture(&device, &queue, &texture, extent);

    assert_no_gpu_error("validation", pollster::block_on(validation_scope.pop()));
    assert_no_gpu_error("internal", pollster::block_on(internal_scope.pop()));
    assert_no_gpu_error(
        "out-of-memory",
        pollster::block_on(out_of_memory_scope.pop()),
    );
    assert!(
        device_loss
            .lock()
            .expect("device-loss evidence mutex must not be poisoned")
            .is_none(),
        "device must remain available through readback"
    );
    record_and_assert_evidence(
        adapter_info,
        padded_bytes_per_row,
        &rgba,
        [extent.width, extent.height],
    );
}

fn render_and_assert_shared_reference(
    packet: &RenderPacketV1,
    reference: PixelReferenceSet,
    evidence_name: &str,
) {
    let instance =
        wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let adapter = request_fallback_adapter(&instance);
    assert_target_format_support(&adapter);
    let (device, queue) = request_device(&adapter);
    let device_loss = track_device_loss(&device);
    let out_of_memory_scope = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let internal_scope = device.push_error_scope(wgpu::ErrorFilter::Internal);
    let validation_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);

    let (texture, extent) = render_packet(&device, &queue, packet);
    let (_, rgba) = readback_texture(&device, &queue, &texture, extent);

    assert_no_gpu_error("validation", pollster::block_on(validation_scope.pop()));
    assert_no_gpu_error("internal", pollster::block_on(internal_scope.pop()));
    assert_no_gpu_error(
        "out-of-memory",
        pollster::block_on(out_of_memory_scope.pop()),
    );
    assert!(
        device_loss
            .lock()
            .expect("device-loss evidence mutex must not be poisoned")
            .is_none(),
        "device must remain available through {evidence_name} readback"
    );

    println!("poietra-{evidence_name}-reference={}", reference.reason);
    for (name, sample) in &reference.samples {
        let actual = pixel(&rgba, extent.width, sample.at[0], sample.at[1]);
        println!("poietra-{evidence_name}-pixel={name}:{actual:?}");
    }
    for (name, sample) in reference.samples {
        let actual = pixel(&rgba, extent.width, sample.at[0], sample.at[1]);
        assert_pixel_close(actual, sample.rgba, [sample.tolerance; 4]);
        println!("poietra-{evidence_name}-asserted={name}");
    }
}

#[test]
#[ignore = "requires a native software WGPU adapter; the dedicated CI step runs this proof"]
fn renders_shared_generic_fill_fixture_with_fallback_adapter() {
    let (packet, reference) = generic_fill_fixture();
    render_and_assert_shared_reference(&packet, reference, "generic-fill");
}

#[test]
#[ignore = "requires a native software WGPU adapter; the dedicated CI step runs this proof"]
fn renders_shared_generic_stroke_fixture_with_fallback_adapter() {
    let (packet, reference) = generic_stroke_fixture();
    render_and_assert_shared_reference(&packet, reference, "generic-stroke");
}

#[test]
#[ignore = "requires a native software WGPU adapter; the dedicated CI step runs this proof"]
fn renders_round_capped_stroke_with_fallback_adapter() {
    let instance =
        wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let adapter = request_fallback_adapter(&instance);
    assert_target_format_support(&adapter);
    let (device, queue) = request_device(&adapter);
    let device_loss = track_device_loss(&device);
    let out_of_memory_scope = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let internal_scope = device.push_error_scope(wgpu::ErrorFilter::Internal);
    let validation_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);

    let packet = straight_stroke_packet(StrokeCapV1::Round);
    let (texture, extent) = render_packet(&device, &queue, &packet);
    let (_, rgba) = readback_texture(&device, &queue, &texture, extent);

    assert_no_gpu_error("validation", pollster::block_on(validation_scope.pop()));
    assert_no_gpu_error("internal", pollster::block_on(internal_scope.pop()));
    assert_no_gpu_error(
        "out-of-memory",
        pollster::block_on(out_of_memory_scope.pop()),
    );
    assert!(
        device_loss
            .lock()
            .expect("device-loss evidence mutex must not be poisoned")
            .is_none(),
        "device must remain available through stroke readback"
    );

    assert_eq!(pixel(&rgba, extent.width, 54, 45), [0, 0, 0, 255]);
    assert_pixel_close(
        pixel(&rgba, extent.width, 56, 45),
        [0, 188, 0, 255],
        [0, 1, 0, 0],
    );
    assert_eq!(pixel(&rgba, extent.width, 56, 40), [0, 0, 0, 255]);
    assert_pixel_close(
        pixel(&rgba, extent.width, 80, 45),
        [0, 188, 0, 255],
        [0, 1, 0, 0],
    );
}
