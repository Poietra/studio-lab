/**
 * Shared Chromium WebGPU launch configuration.
 *
 * The playwright config and the cold-start benchmark (which launches one
 * independent browser process per sample) must use the same flags so cold
 * samples exercise the same WebGPU path as the paced project browser.
 */
export const WEBGPU_CHROMIUM_CHANNEL = "chromium" as const;

export const WEBGPU_CHROMIUM_LAUNCH_ARGS = [
  "--disable-vulkan-surface",
  "--enable-features=Vulkan",
  "--enable-unsafe-webgpu",
  "--use-angle=vulkan",
] as const;
