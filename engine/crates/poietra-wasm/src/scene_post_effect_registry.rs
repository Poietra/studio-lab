use poietra_render_wgpu::{
    MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1, ScenePostEffectSourceV1,
    validate_scene_post_effect_source_v1,
};
use serde::{Deserialize, Deserializer};
use wasm_bindgen::prelude::*;

pub(crate) const MAX_SCENE_POST_EFFECT_REGISTRY_JSON_BYTES_V1: usize =
    MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1 * 6 + 1024;

fn deserialize_required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScenePostEffectSourceJsonV1 {
    revision: u32,
    shader_id: String,
    source: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScenePostEffectRegistryJsonV1 {
    #[serde(deserialize_with = "deserialize_required_nullable")]
    effect: Option<ScenePostEffectSourceJsonV1>,
    schema: String,
    version: u32,
}

pub(crate) fn parse_scene_post_effect_registry_v1(
    registry_json: &[u8],
) -> Result<Option<ScenePostEffectSourceV1>, String> {
    if registry_json.is_empty()
        || registry_json.len() > MAX_SCENE_POST_EFFECT_REGISTRY_JSON_BYTES_V1
    {
        return Err(format!(
            "Scene post-effect registry JSON must contain 1 to {MAX_SCENE_POST_EFFECT_REGISTRY_JSON_BYTES_V1} bytes"
        ));
    }
    let registry: ScenePostEffectRegistryJsonV1 = serde_json::from_slice(registry_json)
        .map_err(|error| format!("Scene post-effect registry JSON is invalid: {error}"))?;
    if registry.schema != "poietra.scene-post-effect-registry" || registry.version != 1 {
        return Err("Scene post-effect registry schema/version is unsupported".to_owned());
    }
    let effect = registry.effect.map(|effect| ScenePostEffectSourceV1 {
        revision: effect.revision,
        shader_id: effect.shader_id,
        source: effect.source,
    });
    if effect
        .as_ref()
        .is_some_and(|effect| effect.source.len() > MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1)
    {
        return Err(format!(
            "Scene post-effect WGSL accepts at most {MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1} UTF-8 bytes"
        ));
    }
    Ok(effect)
}

/// Performs the same source and fixed-ABI validation used before renderer
/// installation, without allocating a GPU device.
///
/// # Errors
///
/// Throws a diagnostic when the registry or WGSL source is invalid.
#[wasm_bindgen(js_name = validateScenePostEffectSourceV1)]
pub fn validate_scene_post_effect_source_registry_v1(registry_json: &[u8]) -> Result<(), JsValue> {
    let source = parse_scene_post_effect_registry_v1(registry_json)
        .map_err(|error| JsValue::from_str(&error))?;
    source
        .as_ref()
        .map(validate_scene_post_effect_source_v1)
        .transpose()
        .map(|_| ())
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID_SOURCE: &str = r"
struct Host { viewport_and_time: vec4<f32>, parameters_0: vec4<f32>, parameters_1: vec4<f32> };
@group(0) @binding(0) var<uniform> host: Host;
@group(0) @binding(1) var scene_texture: texture_2d<f32>;
@fragment fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    return textureLoad(scene_texture, vec2<i32>(position.xy), 0) + host.parameters_0;
}
";

    #[test]
    fn registry_is_strict_bounded_and_exactly_zero_or_one_effect() {
        let empty = parse_scene_post_effect_registry_v1(
            br#"{"effect":null,"schema":"poietra.scene-post-effect-registry","version":1}"#,
        )
        .unwrap();
        assert!(empty.is_none());

        let encoded_source = serde_json::to_string(VALID_SOURCE).unwrap();
        let json = format!(
            "{{\"effect\":{{\"revision\":3,\"shaderId\":\"project-scene-post-effect\",\"source\":{encoded_source}}},\"schema\":\"poietra.scene-post-effect-registry\",\"version\":1}}"
        );
        let parsed = parse_scene_post_effect_registry_v1(json.as_bytes())
            .unwrap()
            .unwrap();
        assert_eq!(parsed.revision, 3);
        assert_eq!(parsed.source, VALID_SOURCE);

        assert!(
            parse_scene_post_effect_registry_v1(
                br#"{"schema":"poietra.scene-post-effect-registry","version":1}"#
            )
            .is_err()
        );
        assert!(
            parse_scene_post_effect_registry_v1(
                br#"{"effect":null,"schema":"poietra.scene-post-effect-registry","version":1,"extra":true}"#
            )
            .is_err()
        );

        let escaped_source = "\n".repeat(MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1);
        let escaped_source = serde_json::to_string(&escaped_source).unwrap();
        let escaped_registry = format!(
            "{{\"effect\":{{\"revision\":1,\"shaderId\":\"project-scene-post-effect\",\"source\":{escaped_source}}},\"schema\":\"poietra.scene-post-effect-registry\",\"version\":1}}"
        );
        assert!(escaped_registry.len() <= MAX_SCENE_POST_EFFECT_REGISTRY_JSON_BYTES_V1);
        assert!(parse_scene_post_effect_registry_v1(escaped_registry.as_bytes()).is_ok());
    }
}
