use naga::{
    AddressSpace, ImageClass, ImageDimension, Scalar, ScalarKind, Type, TypeInner, VectorSize,
    front::wgsl,
};

fn f32_vec4(module: &naga::Module, ty: naga::Handle<Type>) -> bool {
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

fn host_uniform_matches(module: &naga::Module, variable: &naga::GlobalVariable) -> bool {
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

fn texture_2d_matches(module: &naga::Module, variable: &naga::GlobalVariable) -> bool {
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

fn filtering_sampler_matches(module: &naga::Module, variable: &naga::GlobalVariable) -> bool {
    variable.space == AddressSpace::Handle
        && matches!(
            module.types[variable.ty].inner,
            TypeInner::Sampler { comparison: false }
        )
}

pub(crate) fn validate_fragment_material_wgsl_resources(
    source: &str,
    texture_slot: bool,
) -> Result<(), String> {
    let module = wgsl::parse_str(source).map_err(|error| error.emit_to_string(source))?;
    let mut host_uniforms = 0_usize;
    let mut textures = 0_usize;
    let mut samplers = 0_usize;
    for (_, variable) in module.global_variables.iter() {
        let Some(binding) = variable.binding else {
            continue;
        };
        match (binding.group, binding.binding) {
            (0, 0) if host_uniform_matches(&module, variable) => host_uniforms += 1,
            (0, 1) if texture_slot && texture_2d_matches(&module, variable) => textures += 1,
            (0, 2) if texture_slot && filtering_sampler_matches(&module, variable) => samplers += 1,
            (0, 0) => {
                return Err(
                    "group 0 binding 0 must be the fixed three-vec4 Poietra host uniform"
                        .to_owned(),
                );
            }
            (0, 1 | 2) if !texture_slot => {
                return Err(
                    "the material source uses a texture binding without declaring textureSlot"
                        .to_owned(),
                );
            }
            (0, 1) => {
                return Err("group 0 binding 1 must be one sampled float texture_2d".to_owned());
            }
            (0, 2) => {
                return Err("group 0 binding 2 must be one non-comparison sampler".to_owned());
            }
            _ => {
                return Err(
                    "fragment materials cannot declare additional resource bindings".to_owned(),
                );
            }
        }
    }
    if host_uniforms > 1 {
        return Err("group 0 binding 0 may be declared only once".to_owned());
    }
    if texture_slot && (textures != 1 || samplers != 1) {
        return Err(
            "textureSlot requires exactly group 0 binding 1 texture_2d<f32> and binding 2 sampler"
                .to_owned(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOST: &str = r"
struct Host { viewport_and_time: vec4<f32>, parameters_0: vec4<f32>, parameters_1: vec4<f32> };
@group(0) @binding(0) var<uniform> host: Host;
";

    #[test]
    fn enforces_the_declared_fixed_texture_slot() {
        let textured = format!(
            "{HOST}\n@group(0) @binding(1) var tex: texture_2d<f32>;\n@group(0) @binding(2) var samp: sampler;"
        );
        assert!(validate_fragment_material_wgsl_resources(&textured, true).is_ok());
        assert!(validate_fragment_material_wgsl_resources(&textured, false).is_err());
        assert!(validate_fragment_material_wgsl_resources(HOST, false).is_ok());
        assert!(validate_fragment_material_wgsl_resources(HOST, true).is_err());
        assert!(
            validate_fragment_material_wgsl_resources(
                &format!("{textured}\n@group(1) @binding(0) var extra: texture_2d<f32>;"),
                true,
            )
            .is_err()
        );
        assert!(
            validate_fragment_material_wgsl_resources(
                &format!(
                    "{HOST}\n@group(0) @binding(1) var tex: texture_storage_2d<rgba8unorm, read>;\n@group(0) @binding(2) var samp: sampler;"
                ),
                true,
            )
            .is_err()
        );
    }
}
