@group(0) @binding(0)
var supersample_texture: texture_2d<f32>;

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
    let source = vec2<i32>(position.xy) * 2;
    return (
        textureLoad(supersample_texture, source, 0)
        + textureLoad(supersample_texture, source + vec2<i32>(1, 0), 0)
        + textureLoad(supersample_texture, source + vec2<i32>(0, 1), 0)
        + textureLoad(supersample_texture, source + vec2<i32>(1, 1), 0)
    ) * 0.25;
}
