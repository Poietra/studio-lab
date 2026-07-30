/** Linux Chromium needs an explicit Vulkan lane on the software fallback host. */
const LINUX_WEBGPU_CHROMIUM_LAUNCH_ARGS = [
  "--disable-vulkan-surface",
  "--enable-features=Vulkan",
  "--enable-unsafe-webgpu",
  "--use-angle=vulkan",
] as const;

export type WebgpuBrowserLaunch = Readonly<{
  args: readonly string[];
  channel: "chromium" | "msedge";
}>;

/**
 * Shared, platform-owned WebGPU launch configuration.
 *
 * Windows uses installed Edge with its production-default D3D12 path. Adding
 * the Linux Vulkan/ANGLE flags there would create a different, non-canonical
 * renderer. Linux keeps the existing explicit Vulkan lane for exploratory
 * SwiftShader/Lavapipe runs. The project browser and all cold processes call
 * this same selector.
 */
export function webgpuBrowserLaunch(platform: NodeJS.Platform = process.platform): WebgpuBrowserLaunch {
  return platform === "win32"
    ? { args: [], channel: "msedge" }
    : { args: [...LINUX_WEBGPU_CHROMIUM_LAUNCH_ARGS], channel: "chromium" };
}

const launch = webgpuBrowserLaunch();

export const WEBGPU_CHROMIUM_CHANNEL = launch.channel;
export const WEBGPU_CHROMIUM_LAUNCH_ARGS = launch.args;
