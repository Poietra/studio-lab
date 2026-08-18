use poietra_render_wgpu::{
    FragmentMaterialSourceV1, MAX_FRAGMENT_MATERIAL_SOURCE_BYTES_V1,
    MAX_PROJECT_FRAGMENT_MATERIALS_V1,
};
use serde::Deserialize;

pub(crate) const MAX_FRAGMENT_MATERIAL_REGISTRY_JSON_BYTES_V1: usize =
    MAX_PROJECT_FRAGMENT_MATERIALS_V1 * MAX_FRAGMENT_MATERIAL_SOURCE_BYTES_V1 + 16 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FragmentMaterialSourceJsonV1 {
    revision: u32,
    shader_id: String,
    source: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FragmentMaterialRegistryJsonV1 {
    materials: Vec<FragmentMaterialSourceJsonV1>,
    schema: String,
    version: u32,
}

pub(crate) fn parse_fragment_material_registry_v1(
    registry_json: &[u8],
) -> Result<Vec<FragmentMaterialSourceV1>, String> {
    if registry_json.is_empty()
        || registry_json.len() > MAX_FRAGMENT_MATERIAL_REGISTRY_JSON_BYTES_V1
    {
        return Err(format!(
            "fragment material registry JSON must contain 1 to {MAX_FRAGMENT_MATERIAL_REGISTRY_JSON_BYTES_V1} bytes"
        ));
    }
    let registry: FragmentMaterialRegistryJsonV1 = serde_json::from_slice(registry_json)
        .map_err(|error| format!("fragment material registry JSON is invalid: {error}"))?;
    if registry.schema != "poietra.fragment-material-registry" || registry.version != 1 {
        return Err("fragment material registry schema/version is unsupported".to_owned());
    }
    if registry.materials.len() > MAX_PROJECT_FRAGMENT_MATERIALS_V1 {
        return Err(format!(
            "fragment material registry accepts at most {MAX_PROJECT_FRAGMENT_MATERIALS_V1} materials"
        ));
    }
    Ok(registry
        .materials
        .into_iter()
        .map(|material| FragmentMaterialSourceV1 {
            revision: material.revision,
            shader_id: material.shader_id,
            source: material.source,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_json_is_strict_and_bounded() {
        let parsed = parse_fragment_material_registry_v1(
            br#"{"materials":[{"revision":1,"shaderId":"project-wave","source":"@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }"}],"schema":"poietra.fragment-material-registry","version":1}"#,
        )
        .unwrap();
        assert_eq!(parsed.len(), 1);
        assert!(
            parse_fragment_material_registry_v1(
                br#"{"materials":[],"schema":"poietra.fragment-material-registry","version":1,"extra":true}"#
            )
            .is_err()
        );
    }
}
