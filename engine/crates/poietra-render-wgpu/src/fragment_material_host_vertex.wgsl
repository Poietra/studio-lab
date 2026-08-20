struct FragmentHostUniform {
    viewport_and_time: vec4<f32>,
    parameters_0: vec4<f32>,
    parameters_1: vec4<f32>,
    object_uv_from_screen_0: vec4<f32>,
    object_uv_from_screen_1: vec4<f32>,
};

@group(0) @binding(0)
var<uniform> host: FragmentHostUniform;

struct VertexInput {
    @location(0) position: vec2<f32>,
    @location(1) base_color: vec4<f32>,
};

struct FragmentOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) base_color: vec4<f32>,
    // Normalized screen coordinates with a top-left origin.
    @location(1) screen_position: vec2<f32>,
    // Normalized local control-hull coordinates, also with a top-left origin.
    @location(2) object_uv: vec2<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> FragmentOutput {
    var output: FragmentOutput;
    output.position = vec4<f32>(input.position, 0.0, 1.0);
    output.base_color = input.base_color;
    let screen_position = vec2<f32>(
        input.position.x * 0.5 + 0.5,
        0.5 - input.position.y * 0.5,
    );
    output.screen_position = screen_position;
    let screen_homogeneous = vec3<f32>(screen_position, 1.0);
    output.object_uv = vec2<f32>(
        dot(host.object_uv_from_screen_0.xyz, screen_homogeneous),
        dot(host.object_uv_from_screen_1.xyz, screen_homogeneous),
    );
    return output;
}
