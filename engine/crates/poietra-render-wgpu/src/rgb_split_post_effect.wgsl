struct ScenePostEffectHost {
    // xy = logical viewport pixels, z = sampled Scene time, w = reserved.
    viewport_and_time: vec4<f32>,
    // x = base offset px, y = oscillation amplitude px,
    // z = cycles per second, w = phase in radians.
    parameters_0: vec4<f32>,
    parameters_1: vec4<f32>,
};

@group(0) @binding(0)
var<uniform> host: ScenePostEffectHost;

@group(0) @binding(1)
var scene_texture: texture_2d<f32>;

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4<f32> {
    let positions = array(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0),
    );
    return vec4<f32>(positions[vertex_index], 0.0, 1.0);
}

@fragment
fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let viewport = max(vec2<i32>(host.viewport_and_time.xy), vec2<i32>(1));
    let maximum = viewport - vec2<i32>(1);
    let center_coordinate = clamp(vec2<i32>(position.xy), vec2<i32>(0), maximum);
    let phase = 6.28318530718 * host.viewport_and_time.z * host.parameters_0.z
        + host.parameters_0.w;
    let distance = clamp(
        host.parameters_0.x + host.parameters_0.y * sin(phase),
        0.0,
        f32(maximum.x),
    );
    let offset = i32(round(distance));
    let red_coordinate = clamp(
        center_coordinate - vec2<i32>(offset, 0),
        vec2<i32>(0),
        maximum,
    );
    let blue_coordinate = clamp(
        center_coordinate + vec2<i32>(offset, 0),
        vec2<i32>(0),
        maximum,
    );
    let red = textureLoad(scene_texture, red_coordinate, 0);
    let center = textureLoad(scene_texture, center_coordinate, 0);
    let blue = textureLoad(scene_texture, blue_coordinate, 0);
    let alpha = max(red.a, max(center.a, blue.a));
    let rgb = min(vec3<f32>(red.r, center.g, blue.b), vec3<f32>(alpha));
    return vec4<f32>(rgb, alpha);
}
