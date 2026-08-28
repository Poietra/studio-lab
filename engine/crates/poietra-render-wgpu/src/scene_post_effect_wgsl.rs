use naga::{
    AddressSpace, Binding, BuiltIn, ImageClass, ImageDimension, Scalar, ScalarKind, ShaderStage,
    Type, TypeInner, VectorSize,
    front::wgsl,
    valid::{Capabilities, ValidationFlags, Validator},
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

fn scene_texture_matches(module: &naga::Module, variable: &naga::GlobalVariable) -> bool {
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

pub(crate) fn validate_scene_post_effect_wgsl(source: &str) -> Result<(), String> {
    let module = wgsl::parse_str(source).map_err(|error| error.emit_to_string(source))?;
    Validator::new(ValidationFlags::all(), Capabilities::empty())
        .validate(&module)
        .map_err(|error| format!("WGSL validation failed: {error}"))?;
    let mut host_uniforms = 0_usize;
    let mut scene_textures = 0_usize;
    for (_, variable) in module.global_variables.iter() {
        let Some(binding) = variable.binding else {
            continue;
        };
        match (binding.group, binding.binding) {
            (0, 0) if host_uniform_matches(&module, variable) => host_uniforms += 1,
            (0, 1) if scene_texture_matches(&module, variable) => scene_textures += 1,
            (0, 0) => {
                return Err(
                    "group 0 binding 0 must be the fixed three-vec4 Poietra host uniform"
                        .to_owned(),
                );
            }
            (0, 1) => {
                return Err("group 0 binding 1 must be one sampled float texture_2d".to_owned());
            }
            _ => {
                return Err(
                    "Scene post effects cannot declare additional resource bindings".to_owned(),
                );
            }
        }
    }
    if host_uniforms != 1 || scene_textures != 1 {
        return Err(
            "Scene post effects require exactly group 0 binding 0 host uniform and binding 1 texture_2d<f32>"
                .to_owned(),
        );
    }

    let mut fragment_entry_points = 0_usize;
    for entry_point in &module.entry_points {
        match (entry_point.stage, entry_point.name.as_str()) {
            (ShaderStage::Fragment, "fs_main") => {
                let valid_inputs = entry_point.function.arguments.len() <= 1
                    && entry_point.function.arguments.iter().all(|argument| {
                        matches!(
                            argument.binding,
                            Some(Binding::BuiltIn(BuiltIn::Position { .. }))
                        ) && f32_vec4(&module, argument.ty)
                    });
                let valid_output = entry_point.function.result.as_ref().is_some_and(|result| {
                    matches!(result.binding, Some(Binding::Location { location: 0, .. }))
                        && f32_vec4(&module, result.ty)
                });
                if !valid_inputs || !valid_output {
                    return Err(
                        "fs_main may take only one vec4<f32> position builtin and must return location 0 vec4<f32>"
                            .to_owned(),
                    );
                }
                fragment_entry_points += 1;
            }
            (ShaderStage::Fragment, _) => {
                return Err("the only fragment entry point must be named fs_main".to_owned());
            }
            _ => {
                return Err(
                    "Scene post effects cannot declare non-fragment entry points".to_owned(),
                );
            }
        }
    }
    if fragment_entry_points != 1 {
        return Err(
            "Scene post effects require exactly one fs_main fragment entry point".to_owned(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID: &str = r"
struct Host { viewport_and_time: vec4<f32>, parameters_0: vec4<f32>, parameters_1: vec4<f32> };
@group(0) @binding(0) var<uniform> host: Host;
@group(0) @binding(1) var scene_texture: texture_2d<f32>;
@fragment fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    return textureLoad(scene_texture, vec2<i32>(position.xy), 0) + host.parameters_0;
}
";

    #[test]
    fn admits_only_the_fixed_scene_post_effect_abi() {
        assert!(validate_scene_post_effect_wgsl(VALID).is_ok());
        assert!(
            validate_scene_post_effect_wgsl(&format!(
                "{VALID}\n@group(1) @binding(0) var extra: texture_2d<f32>;"
            ))
            .is_err()
        );
        assert!(
            validate_scene_post_effect_wgsl(&VALID.replace("texture_2d<f32>", "sampler")).is_err()
        );
        assert!(
            validate_scene_post_effect_wgsl(&VALID.replace("fs_main", "another_fragment")).is_err()
        );
        assert!(
            validate_scene_post_effect_wgsl(
                &VALID.replace("@location(0) vec4<f32>", "@location(1) vec4<f32>"),
            )
            .is_err()
        );
        assert!(
            validate_scene_post_effect_wgsl(&format!(
                "{VALID}\n@compute @workgroup_size(1) fn cs_main() {{}}"
            ))
            .is_err()
        );
    }
}
