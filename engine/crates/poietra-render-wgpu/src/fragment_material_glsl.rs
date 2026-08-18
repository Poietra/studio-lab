use naga::{
    AddressSpace, Binding, BuiltIn, Handle, Module, Scalar, ScalarKind, ShaderStage, Type,
    TypeInner, VectorSize,
    back::wgsl,
    front::glsl,
    valid::{Capabilities, ValidationFlags, Validator},
};

use crate::MAX_FRAGMENT_MATERIAL_SOURCE_BYTES_V1;

const CANONICAL_FRAGMENT_ENTRY_POINT: &str = "fs_main";

/// A Vulkan GLSL fragment source cannot be admitted to the fixed Poietra material ABI.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("{diagnostic}")]
pub struct FragmentMaterialGlslError {
    diagnostic: String,
}

impl FragmentMaterialGlslError {
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

fn f32_vector(module: &Module, ty: Handle<Type>, size: VectorSize) -> bool {
    matches!(
        module.types[ty].inner,
        TypeInner::Vector {
            size: actual_size,
            scalar: Scalar {
                kind: ScalarKind::Float,
                width: 4,
            },
        } if actual_size == size
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

fn validate_fragment_interface(
    source: &str,
    module: &Module,
) -> Result<(), FragmentMaterialGlslError> {
    let Some(entry) = module.entry_points.first() else {
        return Err(FragmentMaterialGlslError::first(
            source,
            "the declared fragment entry point was not found",
        ));
    };
    if module.entry_points.len() != 1 || entry.stage != ShaderStage::Fragment {
        return Err(FragmentMaterialGlslError::named(
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
    let location_zero = inputs
        .iter()
        .filter(|(binding, ty)| {
            matches!(binding, Some(Binding::Location { location: 0, .. }))
                && f32_vector(module, *ty, VectorSize::Quad)
        })
        .count();
    let location_one = inputs
        .iter()
        .filter(|(binding, ty)| {
            matches!(binding, Some(Binding::Location { location: 1, .. }))
                && f32_vector(module, *ty, VectorSize::Bi)
        })
        .count();
    let inputs_supported = inputs.iter().all(|(binding, ty)| match binding {
        Some(Binding::Location { location: 0, .. }) => f32_vector(module, *ty, VectorSize::Quad),
        Some(Binding::Location { location: 1, .. }) => f32_vector(module, *ty, VectorSize::Bi),
        Some(Binding::BuiltIn(BuiltIn::Position { .. })) => {
            f32_vector(module, *ty, VectorSize::Quad)
        }
        _ => false,
    });
    if location_zero != 1 || location_one != 1 || !inputs_supported {
        return Err(FragmentMaterialGlslError::first(
            source,
            "fragment inputs must be layout(location=0) vec4 base color and layout(location=1) vec2 normalized screen position; only gl_FragCoord is additionally supported",
        ));
    }

    let Some(result) = &entry.function.result else {
        return Err(FragmentMaterialGlslError::first(
            source,
            "the fragment entry point must write one vec4 color at location 0",
        ));
    };
    let outputs = interface_members(module, result.ty, result.binding.as_ref());
    if outputs.len() != 1
        || !matches!(outputs[0].0, Some(Binding::Location { location: 0, .. }))
        || !f32_vector(module, outputs[0].1, VectorSize::Quad)
    {
        return Err(FragmentMaterialGlslError::first(
            source,
            "the fragment entry point must write exactly one vec4 color at layout(location=0)",
        ));
    }
    Ok(())
}

fn uniform_type_matches_host_abi(module: &Module, ty: Handle<Type>) -> bool {
    let TypeInner::Struct { members, span } = &module.types[ty].inner else {
        return false;
    };
    *span == 48
        && members.len() == 3
        && members.iter().zip([0_u32, 16, 32]).all(|(member, offset)| {
            member.offset == offset && f32_vector(module, member.ty, VectorSize::Quad)
        })
}

fn validate_fragment_resources(
    source: &str,
    module: &Module,
) -> Result<(), FragmentMaterialGlslError> {
    for (_, ty) in module.types.iter() {
        if matches!(
            ty.inner,
            TypeInner::Image { .. } | TypeInner::Sampler { .. }
        ) {
            return Err(FragmentMaterialGlslError::named(
                source,
                ty.name.as_deref(),
                "textures and samplers are not supported by the first GLSL material profile",
            ));
        }
    }

    let mut host_uniforms = 0_usize;
    for (_, variable) in module.global_variables.iter() {
        match (variable.space, variable.binding) {
            (AddressSpace::Uniform, Some(binding))
                if binding.group == 0 && binding.binding == 0 =>
            {
                host_uniforms += 1;
                if !uniform_type_matches_host_abi(module, variable.ty) {
                    return Err(FragmentMaterialGlslError::named(
                        source,
                        variable.name.as_deref(),
                        "set 0 binding 0 must contain exactly three vec4 fields: viewport/time and two parameter vectors",
                    ));
                }
            }
            (AddressSpace::Private, None) => {}
            _ => {
                return Err(FragmentMaterialGlslError::named(
                    source,
                    variable.name.as_deref(),
                    "only the optional Poietra host uniform at set 0 binding 0 is supported",
                ));
            }
        }
    }
    if host_uniforms > 1 {
        return Err(FragmentMaterialGlslError::first(
            source,
            "set 0 binding 0 may be declared only once",
        ));
    }
    Ok(())
}

/// Compiles one bounded Vulkan GLSL 450 fragment shader to canonical WGSL.
///
/// The first profile accepts the GLSL `main` entry point, the two host-owned
/// fragment inputs, one location-zero color output, and the optional fixed
/// Poietra uniform at set zero/binding zero. The renderer receives only WGSL.
///
/// # Errors
///
/// Returns a line/column diagnostic for source, interface, validation, or emit failures.
pub fn compile_fragment_material_glsl(
    source: &str,
    entry_point: &str,
) -> Result<String, FragmentMaterialGlslError> {
    if source.is_empty() || source.len() > MAX_FRAGMENT_MATERIAL_SOURCE_BYTES_V1 {
        return Err(FragmentMaterialGlslError::first(
            source,
            format!(
                "GLSL source must contain 1 to {MAX_FRAGMENT_MATERIAL_SOURCE_BYTES_V1} UTF-8 bytes"
            ),
        ));
    }
    if entry_point != "main" {
        return Err(FragmentMaterialGlslError::named(
            source,
            Some(entry_point),
            "the first Vulkan GLSL material profile requires the explicit entry point `main`",
        ));
    }

    let mut frontend = glsl::Frontend::default();
    let mut module = frontend
        .parse(&glsl::Options::from(ShaderStage::Fragment), source)
        .map_err(|errors| FragmentMaterialGlslError {
            diagnostic: errors.emit_to_string_with_path(source, "material.glsl"),
        })?;
    let metadata = frontend.metadata();
    if metadata.version != 450 {
        let offset = source.find("#version").unwrap_or(0);
        return Err(FragmentMaterialGlslError::at(
            source,
            offset,
            "the first material profile requires `#version 450`",
        ));
    }
    if !metadata.extensions.is_empty() {
        let offset = source.find("#extension").unwrap_or(0);
        return Err(FragmentMaterialGlslError::at(
            source,
            offset,
            "GLSL extensions are not supported by the first material profile",
        ));
    }
    if module.entry_points.first().map(|entry| entry.name.as_str()) != Some(entry_point) {
        return Err(FragmentMaterialGlslError::named(
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
            let location = error.location(source);
            location.map_or_else(
                || {
                    FragmentMaterialGlslError::first(
                        source,
                        format!("GLSL validation failed: {error}"),
                    )
                },
                |location| {
                    FragmentMaterialGlslError::at(
                        source,
                        location.offset as usize,
                        format!("GLSL validation failed: {error}"),
                    )
                },
            )
        })?;
    CANONICAL_FRAGMENT_ENTRY_POINT.clone_into(&mut module.entry_points[0].name);
    let wgsl =
        wgsl::write_string(&module, &info, wgsl::WriterFlags::EXPLICIT_TYPES).map_err(|error| {
            FragmentMaterialGlslError::first(source, format!("WGSL generation failed: {error}"))
        })?;
    if wgsl.len() > MAX_FRAGMENT_MATERIAL_SOURCE_BYTES_V1 {
        return Err(FragmentMaterialGlslError::first(
            source,
            format!(
                "generated WGSL exceeds the {MAX_FRAGMENT_MATERIAL_SOURCE_BYTES_V1}-byte material limit"
            ),
        ));
    }
    Ok(wgsl)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SUPPORTED: &str = r"#version 450
layout(location = 0) in vec4 base_color;
layout(location = 1) in vec2 screen_position;
layout(location = 0) out vec4 output_color;
layout(set = 0, binding = 0, std140) uniform PoietraHost {
    vec4 viewport_and_time;
    vec4 parameters_0;
    vec4 parameters_1;
} host;

void main() {
    float pulse = 0.5 + 0.5 * sin(screen_position.x * host.parameters_0.y + host.viewport_and_time.z);
    output_color = vec4(base_color.rgb * pulse, base_color.a);
}
";

    #[test]
    fn compiles_supported_vulkan_glsl_to_the_renderer_entry_point() {
        let compiled = compile_fragment_material_glsl(SUPPORTED, "main").unwrap();
        assert!(compiled.contains("@fragment"));
        assert!(compiled.contains("fn fs_main"));
        assert!(compiled.contains("@group(0) @binding(0)"));
        assert!(!compiled.contains("#version"));
    }

    #[test]
    fn reports_parse_locations_and_rejects_unsupported_bindings() {
        let syntax = SUPPORTED.replace("float pulse", "float = pulse");
        let diagnostic = compile_fragment_material_glsl(&syntax, "main")
            .unwrap_err()
            .to_string();
        assert!(diagnostic.contains("material.glsl:"), "{diagnostic}");

        let unsupported_binding = SUPPORTED.replace(
            "void main()",
            "layout(set = 0, binding = 1, std140) uniform Extra { vec4 value; } extra;\nvoid main()",
        );
        let diagnostic = compile_fragment_material_glsl(&unsupported_binding, "main")
            .unwrap_err()
            .to_string();
        assert!(diagnostic.contains("line 11, column"), "{diagnostic}");
        assert!(diagnostic.contains("set 0 binding 0"), "{diagnostic}");
    }

    #[test]
    fn rejects_wrong_profile_entry_point_and_interface_with_locations() {
        let wrong_version = SUPPORTED.replacen("#version 450", "#version 460", 1);
        assert!(
            compile_fragment_material_glsl(&wrong_version, "main")
                .unwrap_err()
                .to_string()
                .starts_with("line 1, column 1:")
        );
        assert!(
            compile_fragment_material_glsl(SUPPORTED, "shade")
                .unwrap_err()
                .to_string()
                .starts_with("line 1, column 1:")
        );

        let wrong_input = SUPPORTED.replace("location = 1", "location = 2");
        let diagnostic = compile_fragment_material_glsl(&wrong_input, "main")
            .unwrap_err()
            .to_string();
        assert!(diagnostic.starts_with("line 1, column 1:"), "{diagnostic}");
        assert!(diagnostic.contains("fragment inputs"), "{diagnostic}");
    }
}
