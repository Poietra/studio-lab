use naga::{
    AddressSpace, Binding, BuiltIn, Handle, ImageClass, ImageDimension, Module, Scalar, ScalarKind,
    ShaderStage, Type, TypeInner, VectorSize,
    back::wgsl,
    front::glsl,
    valid::{Capabilities, ValidationFlags, Validator},
};

use crate::{
    MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1, scene_post_effect_wgsl::validate_scene_post_effect_wgsl,
};

const CANONICAL_FRAGMENT_ENTRY_POINT: &str = "fs_main";

/// A Vulkan GLSL fragment source cannot be admitted to the fixed Scene
/// post-effect ABI.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("{diagnostic}")]
pub struct ScenePostEffectGlslError {
    diagnostic: String,
}

impl ScenePostEffectGlslError {
    fn at(source: &str, offset: usize, message: impl AsRef<str>) -> Self {
        let offset = offset.min(source.len());
        let prefix = &source[..offset];
        let line = prefix.bytes().filter(|byte| *byte == b'\n').count() + 1;
        let line_start = prefix.rfind('\n').map_or(0, |position| position + 1);
        let column = source[line_start..offset].chars().count() + 1;
        Self {
            diagnostic: format!("line {line}, column {column}: {}", message.as_ref()),
        }
    }

    fn first(source: &str, message: impl AsRef<str>) -> Self {
        Self::at(source, 0, message)
    }

    fn named(source: &str, name: Option<&str>, message: impl AsRef<str>) -> Self {
        let offset = name.and_then(|needle| source.find(needle)).unwrap_or(0);
        Self::at(source, offset, message)
    }
}

fn f32_vec4(module: &Module, ty: Handle<Type>) -> bool {
    matches!(
        module.types[ty].inner,
        TypeInner::Vector {
            size: VectorSize::Quad,
            scalar: Scalar {
                kind: ScalarKind::Float,
                width: 4,
            },
        }
    )
}

fn interface_members<'a>(
    module: &'a Module,
    ty: Handle<Type>,
    binding: Option<&'a Binding>,
) -> Vec<(Option<&'a Binding>, Handle<Type>)> {
    if let Some(binding) = binding {
        return vec![(Some(binding), ty)];
    }
    match &module.types[ty].inner {
        TypeInner::Struct { members, .. } => members
            .iter()
            .map(|member| (member.binding.as_ref(), member.ty))
            .collect(),
        _ => vec![(None, ty)],
    }
}

fn location_zero(binding: Option<&Binding>) -> bool {
    matches!(
        binding,
        Some(Binding::Location {
            blend_src: None,
            location: 0,
            per_primitive: false,
            ..
        })
    )
}

fn validate_fragment_interface(
    source: &str,
    module: &Module,
) -> Result<(), ScenePostEffectGlslError> {
    let Some(entry) = module.entry_points.first() else {
        return Err(ScenePostEffectGlslError::first(
            source,
            "the declared fragment entry point was not found",
        ));
    };
    if module.entry_points.len() != 1 || entry.stage != ShaderStage::Fragment {
        return Err(ScenePostEffectGlslError::named(
            source,
            Some(&entry.name),
            "exactly one fragment entry point is required",
        ));
    }

    let inputs = entry
        .function
        .arguments
        .iter()
        .flat_map(|argument| interface_members(module, argument.ty, argument.binding.as_ref()))
        .collect::<Vec<_>>();
    if inputs.len() > 1
        || !inputs.iter().all(|(binding, ty)| {
            matches!(binding, Some(Binding::BuiltIn(BuiltIn::Position { .. })))
                && f32_vec4(module, *ty)
        })
    {
        return Err(ScenePostEffectGlslError::first(
            source,
            "gl_FragCoord is the only supported fragment input",
        ));
    }

    let Some(result) = &entry.function.result else {
        return Err(ScenePostEffectGlslError::first(
            source,
            "the fragment entry point must write one vec4 color at location 0",
        ));
    };
    let outputs = interface_members(module, result.ty, result.binding.as_ref());
    if outputs.len() != 1 || !location_zero(outputs[0].0) || !f32_vec4(module, outputs[0].1) {
        return Err(ScenePostEffectGlslError::first(
            source,
            "the fragment entry point must write exactly one vec4 color at layout(location=0)",
        ));
    }
    Ok(())
}

fn host_uniform_matches(module: &Module, variable: &naga::GlobalVariable) -> bool {
    if variable.space != AddressSpace::Uniform {
        return false;
    }
    let TypeInner::Struct { members, span } = &module.types[variable.ty].inner else {
        return false;
    };
    *span == 48
        && members.len() == 3
        && members
            .iter()
            .zip([0_u32, 16, 32])
            .all(|(member, offset)| member.offset == offset && f32_vec4(module, member.ty))
}

fn scene_texture_matches(module: &Module, variable: &naga::GlobalVariable) -> bool {
    variable.space == AddressSpace::Handle
        && matches!(
            module.types[variable.ty].inner,
            TypeInner::Image {
                arrayed: false,
                class: ImageClass::Sampled {
                    kind: ScalarKind::Float,
                    multi: false,
                },
                dim: ImageDimension::D2,
            }
        )
}

fn scene_sampler_matches(module: &Module, variable: &naga::GlobalVariable) -> bool {
    variable.space == AddressSpace::Handle
        && matches!(
            module.types[variable.ty].inner,
            TypeInner::Sampler { comparison: false }
        )
}

fn validate_fragment_resources(
    source: &str,
    module: &Module,
) -> Result<(), ScenePostEffectGlslError> {
    let mut host_uniforms = 0_usize;
    let mut scene_samplers = 0_usize;
    let mut scene_textures = 0_usize;
    for (_, variable) in module.global_variables.iter() {
        match variable.binding {
            Some(binding)
                if binding.group == 0
                    && binding.binding == 0
                    && host_uniform_matches(module, variable) =>
            {
                host_uniforms += 1;
            }
            Some(binding)
                if binding.group == 0
                    && binding.binding == 1
                    && scene_texture_matches(module, variable) =>
            {
                scene_textures += 1;
            }
            Some(binding)
                if binding.group == 0
                    && binding.binding == 2
                    && scene_sampler_matches(module, variable) =>
            {
                scene_samplers += 1;
            }
            None if variable.space == AddressSpace::Private => {}
            Some(binding) if binding.group == 0 && binding.binding == 0 => {
                return Err(ScenePostEffectGlslError::named(
                    source,
                    variable.name.as_deref(),
                    "set 0 binding 0 must contain exactly three vec4 fields: viewport/time and two parameter vectors",
                ));
            }
            Some(binding) if binding.group == 0 && binding.binding == 1 => {
                return Err(ScenePostEffectGlslError::named(
                    source,
                    variable.name.as_deref(),
                    "set 0 binding 1 must be one sampled float texture2D Scene texture",
                ));
            }
            Some(binding) if binding.group == 0 && binding.binding == 2 => {
                return Err(ScenePostEffectGlslError::named(
                    source,
                    variable.name.as_deref(),
                    "set 0 binding 2 must be one non-comparison sampler",
                ));
            }
            _ => {
                return Err(ScenePostEffectGlslError::named(
                    source,
                    variable.name.as_deref(),
                    "Scene post effects cannot declare additional resources",
                ));
            }
        }
    }
    if host_uniforms != 1 || scene_textures != 1 || scene_samplers > 1 {
        return Err(ScenePostEffectGlslError::first(
            source,
            "Scene post effects require exactly set 0 binding 0 host uniform and binding 1 texture2D Scene texture, with at most one set 0 binding 2 sampler",
        ));
    }
    Ok(())
}

/// Compiles one bounded Vulkan GLSL 450 Scene post effect to canonical WGSL.
///
/// The profile accepts one fragment `main`, optional `gl_FragCoord`, one
/// location-zero color output, and exactly the existing Poietra Scene
/// post-effect host uniform and Scene texture, plus an optional separate
/// sampler at set 0 binding 2. Omitting the sampler keeps stored binding 0/1
/// sources compatible; when declared, the renderer owns its linear-clamp
/// configuration.
///
/// # Errors
///
/// Returns a line/column diagnostic for source, interface, resource,
/// validation, generation, or canonical WGSL admission failures.
pub fn compile_scene_post_effect_glsl(
    source: &str,
    entry_point: &str,
) -> Result<String, ScenePostEffectGlslError> {
    if source.is_empty() || source.len() > MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1 {
        return Err(ScenePostEffectGlslError::first(
            source,
            format!(
                "GLSL source must contain 1 to {MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1} UTF-8 bytes"
            ),
        ));
    }
    if entry_point != "main" {
        return Err(ScenePostEffectGlslError::named(
            source,
            Some(entry_point),
            "the Vulkan GLSL Scene post-effect profile requires the explicit entry point `main`",
        ));
    }

    let mut frontend = glsl::Frontend::default();
    let mut module = frontend
        .parse(&glsl::Options::from(ShaderStage::Fragment), source)
        .map_err(|errors| ScenePostEffectGlslError {
            diagnostic: errors.emit_to_string_with_path(source, "scene-post-effect.glsl"),
        })?;
    let metadata = frontend.metadata();
    if metadata.version != 450 {
        return Err(ScenePostEffectGlslError::at(
            source,
            source.find("#version").unwrap_or(0),
            "the Scene post-effect profile requires `#version 450`",
        ));
    }
    if !metadata.extensions.is_empty() {
        return Err(ScenePostEffectGlslError::at(
            source,
            source.find("#extension").unwrap_or(0),
            "GLSL extensions are not supported by the Scene post-effect profile",
        ));
    }
    if module.entry_points.first().map(|entry| entry.name.as_str()) != Some(entry_point) {
        return Err(ScenePostEffectGlslError::named(
            source,
            Some(entry_point),
            "the declared fragment entry point was not found",
        ));
    }

    validate_fragment_interface(source, &module)?;
    validate_fragment_resources(source, &module)?;
    let info = Validator::new(ValidationFlags::all(), Capabilities::empty())
        .validate(&module)
        .map_err(|error| {
            error.location(source).map_or_else(
                || {
                    ScenePostEffectGlslError::first(
                        source,
                        format!("GLSL validation failed: {error}"),
                    )
                },
                |location| {
                    ScenePostEffectGlslError::at(
                        source,
                        location.offset as usize,
                        format!("GLSL validation failed: {error}"),
                    )
                },
            )
        })?;
    CANONICAL_FRAGMENT_ENTRY_POINT.clone_into(&mut module.entry_points[0].name);
    let generated =
        wgsl::write_string(&module, &info, wgsl::WriterFlags::EXPLICIT_TYPES).map_err(|error| {
            ScenePostEffectGlslError::first(source, format!("WGSL generation failed: {error}"))
        })?;
    if generated.len() > MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1 {
        return Err(ScenePostEffectGlslError::first(
            source,
            format!(
                "generated WGSL exceeds the {MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1}-byte Scene post-effect limit"
            ),
        ));
    }
    validate_scene_post_effect_wgsl(&generated).map_err(|message| {
        ScenePostEffectGlslError::first(
            source,
            format!("generated WGSL failed Scene post-effect admission: {message}"),
        )
    })?;
    Ok(generated)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SUPPORTED: &str = r"#version 450
layout(location = 0) out vec4 output_color;
layout(set = 0, binding = 0, std140) uniform PoietraHost {
    vec4 viewport_and_time;
    vec4 parameters_0;
    vec4 parameters_1;
} host;
layout(set = 0, binding = 1) uniform texture2D scene_texture;
layout(set = 0, binding = 2) uniform sampler scene_sampler;

void main() {
    vec2 coordinate = gl_FragCoord.xy / max(host.viewport_and_time.xy, vec2(1.0));
    vec4 scene_color = texture(sampler2D(scene_texture, scene_sampler), coordinate);
    float pulse = 0.5 + 0.5 * sin(host.viewport_and_time.z + host.parameters_0.x);
    output_color = vec4(scene_color.rgb * pulse, scene_color.a);
}
";

    #[test]
    fn compiles_the_fixed_scene_texture_profile_to_canonical_wgsl() {
        let compiled = compile_scene_post_effect_glsl(SUPPORTED, "main").unwrap();
        assert!(compiled.contains("@fragment"));
        assert!(compiled.contains("fn fs_main"));
        assert!(compiled.contains("@group(0) @binding(0)"));
        assert!(compiled.contains("@group(0) @binding(1)"));
        assert!(compiled.contains("@group(0) @binding(2)"));
        assert!(compiled.contains("textureSample"));
        assert!(!compiled.contains("#version"));
        assert!(validate_scene_post_effect_wgsl(&compiled).is_ok());
    }

    #[test]
    fn retains_the_samplerless_binding_zero_one_profile() {
        let legacy = SUPPORTED
            .replace(
                "layout(set = 0, binding = 2) uniform sampler scene_sampler;\n",
                "",
            )
            .replace(
                "vec2 coordinate = gl_FragCoord.xy / max(host.viewport_and_time.xy, vec2(1.0));\n    vec4 scene_color = texture(sampler2D(scene_texture, scene_sampler), coordinate);",
                "ivec2 coordinate = ivec2(gl_FragCoord.xy);\n    vec4 scene_color = texelFetch(scene_texture, coordinate, 0);",
            );
        let compiled = compile_scene_post_effect_glsl(&legacy, "main").unwrap();
        assert!(compiled.contains("textureLoad"));
        assert!(!compiled.contains("@group(0) @binding(2)"));
    }

    #[test]
    fn reports_parse_locations_and_rejects_wrong_profile_or_resources() {
        let syntax = SUPPORTED.replace("float pulse", "float = pulse");
        let diagnostic = compile_scene_post_effect_glsl(&syntax, "main")
            .unwrap_err()
            .to_string();
        assert!(
            diagnostic.contains("scene-post-effect.glsl:"),
            "{diagnostic}"
        );

        let extra_sampler = SUPPORTED.replace(
            "void main()",
            "layout(set = 0, binding = 3) uniform sampler extra_sampler;\nvoid main()",
        );
        assert!(compile_scene_post_effect_glsl(&extra_sampler, "main").is_err());
        let combined_sampler =
            SUPPORTED.replace("texture2D scene_texture", "sampler2D scene_texture");
        assert!(compile_scene_post_effect_glsl(&combined_sampler, "main").is_err());
        let extra_texture = SUPPORTED.replace(
            "void main()",
            "layout(set = 1, binding = 0) uniform texture2D extra_texture;\nvoid main()",
        );
        assert!(compile_scene_post_effect_glsl(&extra_texture, "main").is_err());
    }

    #[test]
    fn rejects_extensions_entry_points_and_non_host_fragment_interface() {
        let extension = SUPPORTED.replacen(
            "#version 450",
            "#version 450\n#extension GL_EXT_samplerless_texture_functions : require",
            1,
        );
        assert!(compile_scene_post_effect_glsl(&extension, "main").is_err());
        assert!(compile_scene_post_effect_glsl(SUPPORTED, "shade").is_err());

        let extra_input = SUPPORTED.replace(
            "layout(location = 0) out vec4 output_color;",
            "layout(location = 0) in vec2 uv;\nlayout(location = 0) out vec4 output_color;",
        );
        let diagnostic = compile_scene_post_effect_glsl(&extra_input, "main")
            .unwrap_err()
            .to_string();
        assert!(diagnostic.contains("gl_FragCoord"), "{diagnostic}");

        let wrong_output = SUPPORTED.replace(
            "layout(location = 0) out vec4 output_color;",
            "layout(location = 1) out vec4 output_color;",
        );
        assert!(compile_scene_post_effect_glsl(&wrong_output, "main").is_err());
    }
}
