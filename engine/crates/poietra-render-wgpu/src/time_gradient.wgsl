struct FragmentHostUniform {
    // xy = logical viewport pixels, z = sampled Scene time, w = reserved.
    viewport_and_time: vec4<f32>,
    parameters_0: vec4<f32>,
    parameters_1: vec4<f32>,
};

@group(0) @binding(0)
var<uniform> host: FragmentHostUniform;

struct VertexInput {
    @location(0) position: vec2<f32>,
    @location(1) base_color: vec4<f32>,
};

struct FragmentInput {
    @builtin(position) position: vec4<f32>,
    @location(0) base_color: vec4<f32>,
    // Normalized screen coordinates with a top-left origin.
    @location(1) screen_position: vec2<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> FragmentInput {
    var output: FragmentInput;
    output.position = vec4<f32>(input.position, 0.0, 1.0);
    output.base_color = input.base_color;
    output.screen_position = vec2<f32>(
        input.position.x * 0.5 + 0.5,
        0.5 - input.position.y * 0.5,
    );
    return output;
}

@fragment
fn fs_main(input: FragmentInput) -> @location(0) vec4<f32> {
    let viewport = max(host.viewport_and_time.xy, vec2<f32>(1.0));
    let pixel_position = input.screen_position * viewport;
    let diagonal = (pixel_position.x + pixel_position.y) / (viewport.x + viewport.y);
    let phase = 6.28318530718 * (
        diagonal * host.parameters_0.x
        + host.viewport_and_time.z * host.parameters_0.y
        + host.parameters_0.z
    );
    let wave = 0.5 + 0.5 * sin(phase);
    let minimum_brightness = clamp(host.parameters_0.w, 0.0, 1.0);
    let brightness = mix(minimum_brightness, 1.0, wave);
    return vec4<f32>(input.base_color.rgb * brightness, input.base_color.a);
}
