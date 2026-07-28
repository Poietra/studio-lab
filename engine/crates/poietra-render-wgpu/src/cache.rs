use std::collections::HashMap;
use std::mem::size_of;

use poietra_scene_ir::{
    AffineTransformV1, CubicPathV1, CubicSubpathV1, FillRuleV1, RenderCameraKindV1, RenderCameraV1,
    StrokeCapV1, StrokeJoinV1, StrokeStyleV1, ViewportV1,
};

use crate::prepare::{FLATTEN_TOLERANCE_PIXELS_V1, PreparedGeometryVertexV1};

/// Maximum logical bytes retained by one browser renderer for prepared geometry.
pub const MAX_PREPARED_GEOMETRY_CACHE_BYTES_V1: usize = 64 * 1024 * 1024;
/// Maximum fill/stroke phase entries retained by one browser renderer.
pub const MAX_PREPARED_GEOMETRY_CACHE_ENTRIES_V1: usize = 4_096;

const HASH_MAP_BUCKET_OVERHEAD_BYTES: usize = 16;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct PreparedGeometryCacheFrameStatsV1 {
    hits: u64,
    misses: u64,
}

impl PreparedGeometryCacheFrameStatsV1 {
    #[must_use]
    pub const fn hits(self) -> u64 {
        self.hits
    }

    #[must_use]
    pub const fn misses(self) -> u64 {
        self.misses
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PreparedGeometryPhaseV1 {
    Fill,
    Stroke,
}

#[derive(Clone, Copy)]
pub(crate) struct PreparedGeometryCacheInputV1<'a> {
    pub(crate) camera: &'a RenderCameraV1,
    pub(crate) draw_id: &'a str,
    pub(crate) path: &'a CubicPathV1,
    pub(crate) transform: &'a AffineTransformV1,
    pub(crate) viewport: &'a ViewportV1,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct PreparedCameraSignatureV1 {
    bottom: f64,
    kind: RenderCameraKindV1,
    left: f64,
    right: f64,
    top: f64,
}

impl From<&RenderCameraV1> for PreparedCameraSignatureV1 {
    fn from(camera: &RenderCameraV1) -> Self {
        Self {
            bottom: camera.bottom,
            kind: camera.kind,
            left: camera.left,
            right: camera.right,
            top: camera.top,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
enum PreparedGeometrySignatureV1 {
    Fill {
        camera: PreparedCameraSignatureV1,
        flatten_tolerance_bits: u64,
        path: CubicPathV1,
        rule: FillRuleV1,
        transform: AffineTransformV1,
        viewport: ViewportV1,
    },
    Stroke {
        camera: PreparedCameraSignatureV1,
        cap: StrokeCapV1,
        flatten_tolerance_bits: u64,
        join: StrokeJoinV1,
        miter_limit: f64,
        path: CubicPathV1,
        transform: AffineTransformV1,
        viewport: ViewportV1,
        width_world: f64,
    },
}

#[derive(Debug)]
pub(crate) struct CachedPhaseGeometryV1 {
    indices: Vec<u32>,
    vertices: Vec<PreparedGeometryVertexV1>,
}

impl CachedPhaseGeometryV1 {
    pub(crate) fn new(indices: Vec<u32>, vertices: Vec<PreparedGeometryVertexV1>) -> Self {
        Self { indices, vertices }
    }

    pub(crate) fn indices(&self) -> &[u32] {
        &self.indices
    }

    pub(crate) fn vertices(&self) -> &[PreparedGeometryVertexV1] {
        &self.vertices
    }

    fn owned_bytes(&self) -> usize {
        self.indices
            .capacity()
            .saturating_mul(size_of::<u32>())
            .saturating_add(
                self.vertices
                    .capacity()
                    .saturating_mul(size_of::<PreparedGeometryVertexV1>()),
            )
    }
}

#[derive(Debug)]
struct PreparedGeometryCacheEntryV1 {
    accounted_bytes: usize,
    geometry: CachedPhaseGeometryV1,
    last_used: u64,
    signature: PreparedGeometrySignatureV1,
}

#[derive(Debug, Default)]
struct PreparedDrawGeometryV1 {
    fill: Option<PreparedGeometryCacheEntryV1>,
    stroke: Option<PreparedGeometryCacheEntryV1>,
}

/// Bounded per-renderer LRU of exact, screen-space fill and stroke meshes.
///
/// Entries are addressed by stable draw ID and compared against the complete
/// geometry signature before reuse. Hash collisions therefore cannot produce
/// stale pixels; path, transform, camera, viewport, and geometry-affecting
/// paint changes all become misses.
///
/// The byte budget accounts for retained inline values, owned vector
/// capacities, draw IDs, and a fixed hash-bucket allowance. It is a portable
/// logical bound, not a claim about allocator or browser-process RSS.
#[derive(Debug)]
pub struct PreparedGeometryCacheV1 {
    accounted_bytes: usize,
    draws: HashMap<String, PreparedDrawGeometryV1>,
    entry_count: usize,
    evictions: u64,
    frame_stats: PreparedGeometryCacheFrameStatsV1,
    maximum_bytes: usize,
    maximum_entries: usize,
    stale_rejections: u64,
    use_clock: u64,
}

impl Default for PreparedGeometryCacheV1 {
    fn default() -> Self {
        Self::with_limits(
            MAX_PREPARED_GEOMETRY_CACHE_BYTES_V1,
            MAX_PREPARED_GEOMETRY_CACHE_ENTRIES_V1,
        )
    }
}

impl PreparedGeometryCacheV1 {
    #[must_use]
    pub fn with_limits(maximum_bytes: usize, maximum_entries: usize) -> Self {
        Self {
            accounted_bytes: 0,
            draws: HashMap::new(),
            entry_count: 0,
            evictions: 0,
            frame_stats: PreparedGeometryCacheFrameStatsV1::default(),
            maximum_bytes,
            maximum_entries,
            stale_rejections: 0,
            use_clock: 0,
        }
    }

    #[must_use]
    pub const fn accounted_bytes(&self) -> usize {
        self.accounted_bytes
    }

    pub fn clear(&mut self) {
        self.draws = HashMap::new();
        self.accounted_bytes = 0;
        self.entry_count = 0;
        self.frame_stats = PreparedGeometryCacheFrameStatsV1::default();
        self.use_clock = 0;
    }

    #[must_use]
    pub const fn entry_count(&self) -> usize {
        self.entry_count
    }

    #[must_use]
    pub const fn evictions(&self) -> u64 {
        self.evictions
    }

    #[must_use]
    pub const fn frame_stats(&self) -> PreparedGeometryCacheFrameStatsV1 {
        self.frame_stats
    }

    #[must_use]
    pub const fn stale_rejections(&self) -> u64 {
        self.stale_rejections
    }

    pub(crate) fn begin_frame(&mut self) {
        self.frame_stats = PreparedGeometryCacheFrameStatsV1::default();
    }

    pub(crate) fn lookup_fill(
        &mut self,
        input: PreparedGeometryCacheInputV1<'_>,
        rule: FillRuleV1,
    ) -> Option<&CachedPhaseGeometryV1> {
        let used = self.next_use();
        let entry = self
            .draws
            .get_mut(input.draw_id)
            .and_then(|draw| draw.fill.as_mut());
        let Some(entry) = entry else {
            self.frame_stats.misses = self.frame_stats.misses.saturating_add(1);
            return None;
        };
        let matches = matches!(
            &entry.signature,
            PreparedGeometrySignatureV1::Fill {
                camera: cached_camera,
                flatten_tolerance_bits,
                path: cached_path,
                rule: cached_rule,
                transform: cached_transform,
                viewport: cached_viewport,
            } if *cached_camera == PreparedCameraSignatureV1::from(input.camera)
                && *flatten_tolerance_bits == FLATTEN_TOLERANCE_PIXELS_V1.to_bits()
                && cached_path == input.path
                && *cached_rule == rule
                && cached_transform == input.transform
                && cached_viewport == input.viewport
        );
        if matches {
            entry.last_used = used;
            self.frame_stats.hits = self.frame_stats.hits.saturating_add(1);
            return Some(&entry.geometry);
        }
        self.frame_stats.misses = self.frame_stats.misses.saturating_add(1);
        self.stale_rejections = self.stale_rejections.saturating_add(1);
        None
    }

    pub(crate) fn lookup_stroke(
        &mut self,
        input: PreparedGeometryCacheInputV1<'_>,
        stroke: &StrokeStyleV1,
    ) -> Option<&CachedPhaseGeometryV1> {
        let used = self.next_use();
        let entry = self
            .draws
            .get_mut(input.draw_id)
            .and_then(|draw| draw.stroke.as_mut());
        let Some(entry) = entry else {
            self.frame_stats.misses = self.frame_stats.misses.saturating_add(1);
            return None;
        };
        let matches = matches!(
            &entry.signature,
            PreparedGeometrySignatureV1::Stroke {
                camera: cached_camera,
                cap,
                flatten_tolerance_bits,
                join,
                miter_limit,
                path: cached_path,
                transform: cached_transform,
                viewport: cached_viewport,
                width_world,
            } if *cached_camera == PreparedCameraSignatureV1::from(input.camera)
                && *cap == stroke.cap
                && *flatten_tolerance_bits == FLATTEN_TOLERANCE_PIXELS_V1.to_bits()
                && *join == stroke.join
                && miter_limit.to_bits() == stroke.miter_limit.to_bits()
                && cached_path == input.path
                && cached_transform == input.transform
                && cached_viewport == input.viewport
                && width_world.to_bits() == stroke.width_world.to_bits()
        );
        if matches {
            entry.last_used = used;
            self.frame_stats.hits = self.frame_stats.hits.saturating_add(1);
            return Some(&entry.geometry);
        }
        self.frame_stats.misses = self.frame_stats.misses.saturating_add(1);
        self.stale_rejections = self.stale_rejections.saturating_add(1);
        None
    }

    pub(crate) fn insert_fill(
        &mut self,
        input: PreparedGeometryCacheInputV1<'_>,
        rule: FillRuleV1,
        geometry: CachedPhaseGeometryV1,
    ) {
        self.insert(
            input.draw_id,
            PreparedGeometryPhaseV1::Fill,
            PreparedGeometrySignatureV1::Fill {
                camera: PreparedCameraSignatureV1::from(input.camera),
                flatten_tolerance_bits: FLATTEN_TOLERANCE_PIXELS_V1.to_bits(),
                path: input.path.clone(),
                rule,
                transform: input.transform.clone(),
                viewport: input.viewport.clone(),
            },
            geometry,
        );
    }

    pub(crate) fn insert_stroke(
        &mut self,
        input: PreparedGeometryCacheInputV1<'_>,
        stroke: &StrokeStyleV1,
        geometry: CachedPhaseGeometryV1,
    ) {
        self.insert(
            input.draw_id,
            PreparedGeometryPhaseV1::Stroke,
            PreparedGeometrySignatureV1::Stroke {
                camera: PreparedCameraSignatureV1::from(input.camera),
                cap: stroke.cap,
                flatten_tolerance_bits: FLATTEN_TOLERANCE_PIXELS_V1.to_bits(),
                join: stroke.join,
                miter_limit: stroke.miter_limit,
                path: input.path.clone(),
                transform: input.transform.clone(),
                viewport: input.viewport.clone(),
                width_world: stroke.width_world,
            },
            geometry,
        );
    }

    fn insert(
        &mut self,
        draw_id: &str,
        phase: PreparedGeometryPhaseV1,
        signature: PreparedGeometrySignatureV1,
        geometry: CachedPhaseGeometryV1,
    ) {
        let entry_bytes = signature_owned_bytes(&signature).saturating_add(geometry.owned_bytes());
        if entry_bytes > self.maximum_bytes || self.maximum_entries == 0 {
            self.remove_phase(draw_id, phase);
            return;
        }
        self.remove_phase(draw_id, phase);
        while self.entry_count >= self.maximum_entries
            || self.required_bytes(draw_id, entry_bytes) > self.maximum_bytes
        {
            if !self.evict_lru() {
                return;
            }
        }
        let last_used = self.next_use();
        let is_new_draw = !self.draws.contains_key(draw_id);
        let draw = self.draws.entry(draw_id.to_owned()).or_default();
        let slot = match phase {
            PreparedGeometryPhaseV1::Fill => &mut draw.fill,
            PreparedGeometryPhaseV1::Stroke => &mut draw.stroke,
        };
        *slot = Some(PreparedGeometryCacheEntryV1 {
            accounted_bytes: entry_bytes,
            geometry,
            last_used,
            signature,
        });
        self.entry_count += 1;
        self.accounted_bytes = self.accounted_bytes.saturating_add(entry_bytes);
        if is_new_draw {
            self.accounted_bytes = self
                .accounted_bytes
                .saturating_add(draw_accounted_bytes(draw_id));
        }
    }

    fn evict_lru(&mut self) -> bool {
        let candidate = self
            .draws
            .iter()
            .flat_map(|(draw_id, draw)| {
                [
                    draw.fill
                        .as_ref()
                        .map(|entry| (entry.last_used, draw_id, PreparedGeometryPhaseV1::Fill)),
                    draw.stroke
                        .as_ref()
                        .map(|entry| (entry.last_used, draw_id, PreparedGeometryPhaseV1::Stroke)),
                ]
                .into_iter()
                .flatten()
            })
            .min_by_key(|(last_used, _, _)| *last_used)
            .map(|(_, draw_id, phase)| (draw_id.clone(), phase));
        let Some((draw_id, phase)) = candidate else {
            return false;
        };
        self.remove_phase(&draw_id, phase);
        self.evictions = self.evictions.saturating_add(1);
        true
    }

    fn next_use(&mut self) -> u64 {
        self.use_clock = self.use_clock.saturating_add(1);
        self.use_clock
    }

    fn remove_phase(&mut self, draw_id: &str, phase: PreparedGeometryPhaseV1) {
        let mut remove_draw = false;
        if let Some(draw) = self.draws.get_mut(draw_id) {
            let slot = match phase {
                PreparedGeometryPhaseV1::Fill => &mut draw.fill,
                PreparedGeometryPhaseV1::Stroke => &mut draw.stroke,
            };
            if let Some(entry) = slot.take() {
                self.accounted_bytes = self.accounted_bytes.saturating_sub(entry.accounted_bytes);
                self.entry_count = self.entry_count.saturating_sub(1);
            }
            remove_draw = draw.fill.is_none() && draw.stroke.is_none();
        }
        if remove_draw && let Some((key, _)) = self.draws.remove_entry(draw_id) {
            self.accounted_bytes = self
                .accounted_bytes
                .saturating_sub(draw_accounted_bytes(&key));
        }
    }

    fn required_bytes(&self, draw_id: &str, entry_bytes: usize) -> usize {
        self.accounted_bytes
            .saturating_add(entry_bytes)
            .saturating_add(if self.draws.contains_key(draw_id) {
                0
            } else {
                draw_accounted_bytes(draw_id)
            })
    }
}

fn draw_accounted_bytes(draw_id: &str) -> usize {
    size_of::<(String, PreparedDrawGeometryV1)>()
        .saturating_add(HASH_MAP_BUCKET_OVERHEAD_BYTES)
        .saturating_add(draw_id.len())
}

fn signature_owned_bytes(signature: &PreparedGeometrySignatureV1) -> usize {
    let path = match signature {
        PreparedGeometrySignatureV1::Fill { path, .. }
        | PreparedGeometrySignatureV1::Stroke { path, .. } => path,
    };
    path.subpaths
        .capacity()
        .saturating_mul(size_of::<CubicSubpathV1>())
        .saturating_add(
            path.subpaths
                .iter()
                .map(|subpath| {
                    subpath
                        .segments
                        .capacity()
                        .saturating_mul(size_of::<poietra_scene_ir::CubicSegmentV1>())
                })
                .fold(0usize, usize::saturating_add),
        )
}
