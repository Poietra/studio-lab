struct VertexInput {
    @location(0) position: vec2<f32>,
    @location(1) base_color: vec4<f32>,
};

struct FragmentOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) base_color: vec4<f32>,
    // Normalized screen coordinates with a top-left origin.
    @location(1) screen_position: vec2<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> FragmentOutput {
    var output: FragmentOutput;
    output.position = vec4<f32>(input.position, 0.0, 1.0);
    output.base_color = input.base_color;
    output.screen_position = vec2<f32>(
        input.position.x * 0.5 + 0.5,
        0.5 - input.position.y * 0.5,
    );
    return output;
}
