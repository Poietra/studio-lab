use std::fmt;
use std::sync::{Arc, Mutex};

use poietra_render_wgpu::{
    PreparedFrameV1, WgpuFillRendererV1, WgpuRenderTargetV1, prepare_frame_v1,
};
use poietra_scene_ir::ViewportV1;
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;
use web_sys::OffscreenCanvas;

use crate::canvas_protocol::{
    CanvasRenderErrorCodeV1, error_response, gpu_error_code_from_js_class_name, presented_response,
    sample_error_response, surface_configuration_required,
};
use crate::protocol::EngineWorkerSessionV1;

const SNAPSHOT_REJECTED_ERROR_NAME: &str = "PoietraCanvasSnapshotRejected";
const RENDERER_UNAVAILABLE_ERROR_NAME: &str = "PoietraCanvasRendererUnavailable";

#[derive(Clone, Debug)]
struct RuntimeFailureV1 {
    code: CanvasRenderErrorCodeV1,
    message: String,
}

#[derive(Clone, Copy, Debug)]
struct SurfaceSelectionV1 {
    alpha_mode: wgpu::CompositeAlphaMode,
    surface_format: wgpu::TextureFormat,
    view_format: wgpu::TextureFormat,
}

type SharedFailureV1 = Arc<Mutex<Option<RuntimeFailureV1>>>;

struct GpuErrorScopesV1 {
    raw_device: JsValue,
}

struct RawUncapturedErrorListenerV1 {
    callback: Closure<dyn FnMut(JsValue)>,
    raw_device: JsValue,
}

impl RawUncapturedErrorListenerV1 {
    fn install(
        device: &wgpu::Device,
        failures: &SharedFailureV1,
    ) -> Result<Self, RuntimeFailureV1> {
        let raw_device = raw_webgpu_device(device)?;
        let reported_failure = Arc::clone(failures);
        let callback = Closure::wrap(Box::new(move |event: JsValue| {
            let failure = match js_sys::Reflect::get(&event, &JsValue::from_str("error")) {
                Ok(error) => runtime_failure_from_js_gpu_error(&error),
                Err(error) => RuntimeFailureV1 {
                    code: CanvasRenderErrorCodeV1::GpuInternal,
                    message: format!(
                        "could not inspect WebGPU uncaptured error: {}",
                        js_error_message(&error)
                    ),
                },
            };
            retain_first_failure(&reported_failure, failure);
        }) as Box<dyn FnMut(JsValue)>);
        call_js_method_two(
            &raw_device,
            "addEventListener",
            &JsValue::from_str("uncapturederror"),
            callback.as_ref(),
        )
        .map_err(|error| RuntimeFailureV1 {
            code: CanvasRenderErrorCodeV1::GpuInternal,
            message: format!(
                "could not install WebGPU uncaptured-error listener: {}",
                js_error_message(&error)
            ),
        })?;
        Ok(Self {
            callback,
            raw_device,
        })
    }
}

impl Drop for RawUncapturedErrorListenerV1 {
    fn drop(&mut self) {
        let _ = call_js_method_two(
            &self.raw_device,
            "removeEventListener",
            &JsValue::from_str("uncapturederror"),
            self.callback.as_ref(),
        );
    }
}

impl GpuErrorScopesV1 {
    fn push(device: &wgpu::Device) -> Result<Self, RuntimeFailureV1> {
        // wgpu 30's browser `pop_error_scope` converter panics on GPUInternalError.
        // Use the same WebGPU scopes directly so every variant fails closed instead.
        let raw_device = raw_webgpu_device(device)?;
        for filter in ["internal", "out-of-memory", "validation"] {
            call_js_method_one(&raw_device, "pushErrorScope", &JsValue::from_str(filter)).map_err(
                |error| RuntimeFailureV1 {
                    code: CanvasRenderErrorCodeV1::GpuInternal,
                    message: format!(
                        "could not push {filter} WebGPU error scope: {}",
                        js_error_message(&error)
                    ),
                },
            )?;
        }
        Ok(Self { raw_device })
    }

    async fn finish(self) -> Option<RuntimeFailureV1> {
        let validation = pop_raw_error_scope(&self.raw_device).await;
        let out_of_memory = pop_raw_error_scope(&self.raw_device).await;
        let internal = pop_raw_error_scope(&self.raw_device).await;
        out_of_memory.or(validation).or(internal)
    }
}

/// Retained Scene evaluator and WebGPU surface owned by one browser worker.
#[wasm_bindgen]
pub struct PoietraCanvasEngineV1 {
    canvas: OffscreenCanvas,
    configured_viewport: Option<ViewportV1>,
    // Kept before `device` so Drop unregisters the JS callback first.
    _uncaptured_error_listener: RawUncapturedErrorListenerV1,
    device: wgpu::Device,
    device_lost: SharedFailureV1,
    queue: wgpu::Queue,
    renderer: WgpuFillRendererV1,
    session: EngineWorkerSessionV1,
    surface: wgpu::Surface<'static>,
    surface_config: wgpu::SurfaceConfiguration,
    terminal_surface_failure: Option<RuntimeFailureV1>,
    uncaptured_gpu_failure: SharedFailureV1,
    view_format: wgpu::TextureFormat,
}

impl fmt::Debug for PoietraCanvasEngineV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PoietraCanvasEngineV1")
            .field(
                "canvas_extent",
                &[self.canvas.width(), self.canvas.height()],
            )
            .field("configured_viewport", &self.configured_viewport)
            .field("surface_format", &self.surface_config.format)
            .field("view_format", &self.view_format)
            .field(
                "has_terminal_surface_failure",
                &self.terminal_surface_failure.is_some(),
            )
            .finish_non_exhaustive()
    }
}

#[wasm_bindgen]
impl PoietraCanvasEngineV1 {
    /// Validates a snapshot and asynchronously acquires an `OffscreenCanvas` WebGPU device.
    ///
    /// # Errors
    ///
    /// Rejects with a named JavaScript `Error`: `PoietraCanvasSnapshotRejected`
    /// for invalid snapshots or `PoietraCanvasRendererUnavailable` for WebGPU setup failures.
    #[wasm_bindgen(js_name = create)]
    pub async fn create(
        snapshot_json: &[u8],
        canvas: OffscreenCanvas,
    ) -> Result<PoietraCanvasEngineV1, JsValue> {
        let session = EngineWorkerSessionV1::from_snapshot_json(snapshot_json)
            .map_err(|error| named_js_error(SNAPSHOT_REJECTED_ERROR_NAME, &error.to_string()))?;

        let mut instance_descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
        instance_descriptor.backends = wgpu::Backends::BROWSER_WEBGPU;
        let instance = wgpu::Instance::new(instance_descriptor);
        let surface = instance
            .create_surface(wgpu::SurfaceTarget::OffscreenCanvas(canvas.clone()))
            .map_err(|error| renderer_unavailable(&format!("could not create surface: {error}")))?;
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                compatible_surface: Some(&surface),
                ..wgpu::RequestAdapterOptions::default()
            })
            .await
            .map_err(|error| {
                renderer_unavailable(&format!("no compatible WebGPU adapter: {error}"))
            })?;
        let selection = select_surface_capabilities(&surface.get_capabilities(&adapter))?;
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("poietra canvas device v1"),
                ..wgpu::DeviceDescriptor::default()
            })
            .await
            .map_err(|error| {
                renderer_unavailable(&format!("could not create WebGPU device: {error}"))
            })?;

        let device_lost = install_device_lost_handler(&device);
        let uncaptured_gpu_failure = shared_failure();
        let uncaptured_error_listener =
            RawUncapturedErrorListenerV1::install(&device, &uncaptured_gpu_failure)
                .map_err(|failure| renderer_unavailable(&failure.message))?;

        let scopes = GpuErrorScopesV1::push(&device)
            .map_err(|failure| renderer_unavailable(&failure.message))?;
        let renderer = WgpuFillRendererV1::new(&device, selection.view_format).map_err(|error| {
            renderer_unavailable(&format!("could not create fill renderer: {error}"))
        });
        let scoped_failure = scopes.finish().await;
        if let Some(failure) = scoped_failure {
            return Err(renderer_unavailable(&failure.message));
        }
        if let Some(failure) = read_shared_failure(&device_lost)
            .or_else(|| read_shared_failure(&uncaptured_gpu_failure))
        {
            return Err(renderer_unavailable(&failure.message));
        }
        let renderer = renderer?;

        Ok(Self {
            canvas,
            configured_viewport: None,
            _uncaptured_error_listener: uncaptured_error_listener,
            device,
            device_lost,
            queue,
            renderer,
            session,
            surface,
            surface_config: wgpu::SurfaceConfiguration {
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                format: selection.surface_format,
                color_space: wgpu::SurfaceColorSpace::Auto,
                width: 1,
                height: 1,
                desired_maximum_frame_latency: 2,
                present_mode: wgpu::PresentMode::Fifo,
                alpha_mode: selection.alpha_mode,
                view_formats: vec![selection.view_format],
            },
            terminal_surface_failure: None,
            uncaptured_gpu_failure,
            view_format: selection.view_format,
        })
    }

    /// Atomically validates and installs a complete replacement snapshot.
    ///
    /// # Errors
    ///
    /// Returns a JavaScript error and preserves the current snapshot on failure.
    #[wasm_bindgen(js_name = replaceSnapshot)]
    pub fn replace_snapshot(&mut self, snapshot_json: &[u8]) -> Result<(), JsValue> {
        self.session
            .replace_snapshot_json(snapshot_json)
            .map_err(|error| named_js_error(SNAPSHOT_REJECTED_ERROR_NAME, &error.to_string()))
    }

    /// Evaluates and presents one bounded sample request.
    ///
    /// The returned JSON contains only presentation correlation or a structured
    /// error. A `RenderPacket` never crosses this ABI.
    #[must_use]
    pub async fn render(&mut self, request_json: &[u8]) -> Vec<u8> {
        let sampled = match self.session.sample_packet_json(request_json) {
            Ok(sampled) => sampled,
            Err(error) => return sample_error_response(&error),
        };
        let correlation = &sampled.correlation;
        if let Some(failure) = self.current_terminal_failure() {
            return error_response(failure.code, &failure.message, Some(correlation));
        }
        let frame = match prepare_frame_v1(&sampled.packet) {
            Ok(frame) => frame,
            Err(error) => {
                return error_response(
                    CanvasRenderErrorCodeV1::UnsupportedFrame,
                    &error.to_string(),
                    Some(correlation),
                );
            }
        };

        match self.render_prepared_frame(&frame).await {
            Ok(suboptimal) => presented_response(correlation, suboptimal),
            Err(failure) => error_response(failure.code, &failure.message, Some(correlation)),
        }
    }
}

impl PoietraCanvasEngineV1 {
    async fn render_prepared_frame(
        &mut self,
        frame: &PreparedFrameV1,
    ) -> Result<bool, RuntimeFailureV1> {
        if let Some(failure) = self.current_terminal_failure() {
            return Err(failure);
        }

        let scopes = GpuErrorScopesV1::push(&self.device)?;
        let operation = self.render_with_active_scopes(frame);
        let scoped_failure = scopes.finish().await;

        if let Some(failure) = self.current_terminal_failure() {
            return Err(failure);
        }
        if let Some(failure) = scoped_failure {
            return Err(failure);
        }
        operation
    }

    fn render_with_active_scopes(
        &mut self,
        frame: &PreparedFrameV1,
    ) -> Result<bool, RuntimeFailureV1> {
        let [width_px, height_px] = frame.viewport();
        let viewport = ViewportV1 {
            height_px,
            width_px,
        };
        self.ensure_configured_for_viewport(&viewport);

        let (surface_texture, suboptimal) = self.acquire_surface_texture(&viewport)?;
        let view = surface_texture
            .texture
            .create_view(&wgpu::TextureViewDescriptor {
                label: Some("poietra canvas sRGB view v1"),
                format: Some(self.view_format),
                ..wgpu::TextureViewDescriptor::default()
            });
        self.renderer
            .render(
                &self.device,
                &self.queue,
                WgpuRenderTargetV1 {
                    format: self.view_format,
                    height_px,
                    view: &view,
                    width_px,
                },
                frame,
            )
            .map_err(|error| RuntimeFailureV1 {
                code: CanvasRenderErrorCodeV1::GpuValidation,
                message: error.to_string(),
            })?;
        self.queue.present(surface_texture);
        if suboptimal {
            self.force_configure_for_viewport(&viewport);
        }
        Ok(suboptimal)
    }

    fn acquire_surface_texture(
        &mut self,
        viewport: &ViewportV1,
    ) -> Result<(wgpu::SurfaceTexture, bool), RuntimeFailureV1> {
        match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(texture) => Ok((texture, false)),
            wgpu::CurrentSurfaceTexture::Suboptimal(texture) => Ok((texture, true)),
            wgpu::CurrentSurfaceTexture::Outdated => {
                self.force_configure_for_viewport(viewport);
                match self.surface.get_current_texture() {
                    wgpu::CurrentSurfaceTexture::Success(texture) => Ok((texture, false)),
                    wgpu::CurrentSurfaceTexture::Suboptimal(texture) => Ok((texture, true)),
                    wgpu::CurrentSurfaceTexture::Outdated => Err(RuntimeFailureV1 {
                        code: CanvasRenderErrorCodeV1::SurfaceOutdated,
                        message: "surface remained outdated after one reconfiguration".to_owned(),
                    }),
                    wgpu::CurrentSurfaceTexture::Lost => Err(self.record_terminal_surface_failure(
                        CanvasRenderErrorCodeV1::SurfaceLost,
                        "surface was lost while retrying an outdated frame",
                    )),
                    wgpu::CurrentSurfaceTexture::Validation => Err(self
                        .record_terminal_surface_failure(
                            CanvasRenderErrorCodeV1::SurfaceValidation,
                            "surface acquisition raised a validation error after reconfiguration",
                        )),
                    wgpu::CurrentSurfaceTexture::Timeout => Err(RuntimeFailureV1 {
                        code: CanvasRenderErrorCodeV1::SurfaceTimeout,
                        message: "surface acquisition timed out after reconfiguration".to_owned(),
                    }),
                    wgpu::CurrentSurfaceTexture::Occluded => Err(RuntimeFailureV1 {
                        code: CanvasRenderErrorCodeV1::SurfaceOccluded,
                        message: "surface was occluded after reconfiguration".to_owned(),
                    }),
                }
            }
            wgpu::CurrentSurfaceTexture::Lost => Err(self.record_terminal_surface_failure(
                CanvasRenderErrorCodeV1::SurfaceLost,
                "surface was lost and must be recreated",
            )),
            wgpu::CurrentSurfaceTexture::Validation => Err(self.record_terminal_surface_failure(
                CanvasRenderErrorCodeV1::SurfaceValidation,
                "surface acquisition raised a validation error",
            )),
            wgpu::CurrentSurfaceTexture::Timeout => Err(RuntimeFailureV1 {
                code: CanvasRenderErrorCodeV1::SurfaceTimeout,
                message: "surface acquisition timed out".to_owned(),
            }),
            wgpu::CurrentSurfaceTexture::Occluded => Err(RuntimeFailureV1 {
                code: CanvasRenderErrorCodeV1::SurfaceOccluded,
                message: "surface is occluded".to_owned(),
            }),
        }
    }

    fn ensure_configured_for_viewport(&mut self, viewport: &ViewportV1) {
        if !surface_configuration_required(self.configured_viewport.as_ref(), viewport, false) {
            return;
        }
        self.force_configure_for_viewport(viewport);
    }

    fn force_configure_for_viewport(&mut self, viewport: &ViewportV1) {
        self.surface_config.width = viewport.width_px;
        self.surface_config.height = viewport.height_px;
        // The wgpu WebGPU backend applies these configuration dimensions to
        // the OffscreenCanvas backing store before configuring GPUCanvasContext.
        self.surface.configure(&self.device, &self.surface_config);
        self.configured_viewport = Some(viewport.clone());
    }

    fn current_terminal_failure(&self) -> Option<RuntimeFailureV1> {
        read_shared_failure(&self.device_lost)
            .or_else(|| read_shared_failure(&self.uncaptured_gpu_failure))
            .or_else(|| self.terminal_surface_failure.clone())
    }

    fn record_terminal_surface_failure(
        &mut self,
        code: CanvasRenderErrorCodeV1,
        message: &str,
    ) -> RuntimeFailureV1 {
        let failure = RuntimeFailureV1 {
            code,
            message: message.to_owned(),
        };
        self.terminal_surface_failure = Some(failure.clone());
        failure
    }
}

fn call_js_method_zero(target: &JsValue, name: &str) -> Result<JsValue, JsValue> {
    let function =
        js_sys::Reflect::get(target, &JsValue::from_str(name))?.dyn_into::<js_sys::Function>()?;
    function.call0(target)
}

fn call_js_method_one(
    target: &JsValue,
    name: &str,
    argument: &JsValue,
) -> Result<JsValue, JsValue> {
    let function =
        js_sys::Reflect::get(target, &JsValue::from_str(name))?.dyn_into::<js_sys::Function>()?;
    function.call1(target, argument)
}

fn call_js_method_two(
    target: &JsValue,
    name: &str,
    first: &JsValue,
    second: &JsValue,
) -> Result<JsValue, JsValue> {
    let function =
        js_sys::Reflect::get(target, &JsValue::from_str(name))?.dyn_into::<js_sys::Function>()?;
    function.call2(target, first, second)
}

fn raw_webgpu_device(device: &wgpu::Device) -> Result<JsValue, RuntimeFailureV1> {
    device
        .as_webgpu()
        .ok_or_else(|| RuntimeFailureV1 {
            code: CanvasRenderErrorCodeV1::GpuInternal,
            message: "WebGPU device handle is unavailable".to_owned(),
        })
        .map(|device| device.clone().into())
}

async fn pop_raw_error_scope(raw_device: &JsValue) -> Option<RuntimeFailureV1> {
    let promise = match call_js_method_zero(raw_device, "popErrorScope")
        .and_then(wasm_bindgen::JsCast::dyn_into::<js_sys::Promise>)
    {
        Ok(promise) => promise,
        Err(error) => {
            return Some(RuntimeFailureV1 {
                code: CanvasRenderErrorCodeV1::GpuInternal,
                message: format!(
                    "could not pop WebGPU error scope: {}",
                    js_error_message(&error)
                ),
            });
        }
    };
    match JsFuture::from(promise).await {
        Ok(value) if value.is_null() || value.is_undefined() => None,
        Ok(error) => Some(runtime_failure_from_js_gpu_error(&error)),
        Err(error) => Some(RuntimeFailureV1 {
            code: CanvasRenderErrorCodeV1::GpuInternal,
            message: format!(
                "WebGPU error scope promise rejected: {}",
                js_error_message(&error)
            ),
        }),
    }
}

fn runtime_failure_from_js_gpu_error(error: &JsValue) -> RuntimeFailureV1 {
    let class_name = js_error_class_name(error).unwrap_or_default();
    RuntimeFailureV1 {
        code: gpu_error_code_from_js_class_name(&class_name),
        message: js_error_message(error),
    }
}

fn reflected_string(value: &JsValue, property: &str) -> Option<String> {
    js_sys::Reflect::get(value, &JsValue::from_str(property))
        .ok()
        .and_then(|value| value.as_string())
}

fn reflected_constructor_name(value: &JsValue) -> Option<String> {
    js_sys::Reflect::get(value, &JsValue::from_str("constructor"))
        .ok()
        .and_then(|constructor| reflected_string(&constructor, "name"))
}

fn js_error_class_name(error: &JsValue) -> Option<String> {
    reflected_string(error, "name")
        .filter(|name| !name.is_empty())
        .or_else(|| reflected_constructor_name(error).filter(|name| !name.is_empty()))
}

fn js_error_message(error: &JsValue) -> String {
    let name = js_error_class_name(error).unwrap_or_else(|| "WebGPUError".to_owned());
    let message = reflected_string(error, "message")
        .or_else(|| error.as_string())
        .unwrap_or_else(|| "WebGPU operation failed".to_owned());
    format!("{name}: {message}")
}

fn shared_failure() -> SharedFailureV1 {
    Arc::new(Mutex::new(None))
}

fn install_device_lost_handler(device: &wgpu::Device) -> SharedFailureV1 {
    let device_lost = shared_failure();
    let device_lost_callback = Arc::clone(&device_lost);
    device.set_device_lost_callback(move |reason, message| {
        retain_first_failure(
            &device_lost_callback,
            RuntimeFailureV1 {
                code: CanvasRenderErrorCodeV1::DeviceLost,
                message: format!("WebGPU device lost ({reason:?}): {message}"),
            },
        );
    });

    device_lost
}

fn select_surface_capabilities(
    capabilities: &wgpu::SurfaceCapabilities,
) -> Result<SurfaceSelectionV1, JsValue> {
    let surface_format = capabilities
        .formats
        .iter()
        .copied()
        .find(|format| {
            matches!(
                format,
                wgpu::TextureFormat::Bgra8Unorm | wgpu::TextureFormat::Rgba8Unorm
            )
        })
        .ok_or_else(|| {
            renderer_unavailable("surface does not expose a base BGRA8Unorm or RGBA8Unorm format")
        })?;
    if !capabilities
        .usages
        .contains(wgpu::TextureUsages::RENDER_ATTACHMENT)
    {
        return Err(renderer_unavailable(
            "surface does not support render attachments",
        ));
    }
    if !capabilities
        .present_modes
        .contains(&wgpu::PresentMode::Fifo)
    {
        return Err(renderer_unavailable(
            "surface does not support FIFO presentation",
        ));
    }
    let alpha_mode = capabilities
        .alpha_modes
        .iter()
        .copied()
        .find(|mode| {
            matches!(
                mode,
                wgpu::CompositeAlphaMode::Auto
                    | wgpu::CompositeAlphaMode::Opaque
                    | wgpu::CompositeAlphaMode::PreMultiplied
            )
        })
        .ok_or_else(|| renderer_unavailable("surface does not expose an alpha mode"))?;
    Ok(SurfaceSelectionV1 {
        alpha_mode,
        surface_format,
        view_format: surface_format.add_srgb_suffix(),
    })
}

fn retain_first_failure(shared: &SharedFailureV1, failure: RuntimeFailureV1) {
    let mut current = shared
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if current.is_none() {
        *current = Some(failure);
    }
}

fn read_shared_failure(shared: &SharedFailureV1) -> Option<RuntimeFailureV1> {
    shared
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

fn named_js_error(name: &str, message: &str) -> JsValue {
    let error = js_sys::Error::new(message);
    error.set_name(name);
    error.into()
}

fn renderer_unavailable(message: &str) -> JsValue {
    named_js_error(RENDERER_UNAVAILABLE_ERROR_NAME, message)
}
