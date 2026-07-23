const FRAME_RATE = 30;
const IR_EVENT_COUNT = 60_000;
const OVERLAY_DURATION_MS = 5_000;
const SEEK_TARGETS_SECONDS = [2.5, 7.5, 1.2, 10, 4, 8.5, 0.5, 6, 11, 0];

const button = document.querySelector("#run");
const canvas = document.querySelector("#overlay");
const resultNode = document.querySelector("#result");
const statusNode = document.querySelector("#status");
const video = document.querySelector("#video");
const context = canvas.getContext("2d", { alpha: true });

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function rounded(value) {
  return value === null ? null : Math.round(value * 100) / 100;
}

function waitForEvent(target, name, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      target.removeEventListener(name, complete);
      reject(new Error(`Timed out waiting for ${name}.`));
    }, timeoutMs);
    function complete(event) {
      clearTimeout(timeout);
      resolve(event);
    }
    target.addEventListener(name, complete, { once: true });
  });
}

async function ensureVideoMetadata() {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) return;
  await waitForEvent(video, "loadedmetadata");
}

function nextPresentedFrame() {
  if (!("requestVideoFrameCallback" in video)) return null;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 2_000);
    video.requestVideoFrameCallback((_now, metadata) => {
      clearTimeout(timeout);
      resolve(metadata.mediaTime);
    });
  });
}

async function measureSeeking() {
  await ensureVideoMetadata();
  video.pause();
  const observations = [];
  for (const targetSeconds of SEEK_TARGETS_SECONDS) {
    const presentedFrame = nextPresentedFrame();
    const seeked = waitForEvent(video, "seeked");
    const startedAt = performance.now();
    video.currentTime = targetSeconds;
    await seeked;
    const mediaTime = presentedFrame ? await presentedFrame : null;
    const displayedSeconds = mediaTime ?? video.currentTime;
    observations.push({
      displayedSeconds: rounded(displayedSeconds),
      errorMs: rounded(Math.abs(displayedSeconds - targetSeconds) * 1_000),
      latencyMs: rounded(performance.now() - startedAt),
      requestedSeconds: targetSeconds,
    });
  }
  const latencies = observations.map((observation) => observation.latencyMs);
  const errors = observations.map((observation) => observation.errorMs);
  return {
    displayedFrameMethod: "requestVideoFrameCallback" in video
      ? "requestVideoFrameCallback.mediaTime"
      : "seeked.currentTime-fallback",
    maxDisplayedTimeErrorMs: rounded(Math.max(...errors)),
    observations,
    p50LatencyMs: rounded(percentile(latencies, 0.5)),
    p95LatencyMs: rounded(percentile(latencies, 0.95)),
  };
}

function runtimeIrLine(index) {
  return JSON.stringify({
    entityId: `entity-${index % 400}`,
    frame: index % (FRAME_RATE * 12),
    kind: index % 3 === 0 ? "transform" : "sample",
    position: { x: (index * 17) % 1280, y: (index * 31) % 720 },
    sequence: index,
    visible: index % 11 !== 0,
  });
}

function prepareRuntimeIr() {
  return Array.from({ length: IR_EVENT_COUNT }, (_unused, index) => runtimeIrLine(index));
}

async function parseRuntimeIr(lines) {
  const startedAt = performance.now();
  let checksum = 0;
  for (let offset = 0; offset < lines.length; offset += 500) {
    for (const line of lines.slice(offset, offset + 500)) {
      const event = JSON.parse(line);
      checksum = (checksum + event.sequence + event.position.x + event.position.y) % 1_000_000_007;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const durationMs = performance.now() - startedAt;
  return {
    checksum,
    durationMs: rounded(durationMs),
    eventCount: lines.length,
    eventsPerSecond: Math.round(lines.length / (durationMs / 1_000)),
  };
}

function drawOverlay(elapsedMs) {
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.lineWidth = 2;
  for (let index = 0; index < 400; index += 1) {
    const phase = elapsedMs / 800 + index * 0.13;
    const x = (index * 47 + Math.sin(phase) * 28 + 1280) % 1280;
    const y = (index * 29 + Math.cos(phase) * 20 + 720) % 720;
    context.strokeStyle = index % 7 === 0 ? "#38bdf8" : "rgba(161, 161, 170, .42)";
    context.strokeRect(x, y, 44 + index % 30, 26 + index % 20);
  }
  for (let trajectory = 0; trajectory < 3; trajectory += 1) {
    context.beginPath();
    context.moveTo(120 + trajectory * 280, 560 - trajectory * 80);
    context.quadraticCurveTo(360 + trajectory * 220, 80, 820 + trajectory * 100, 440);
    context.strokeStyle = ["#38bdf8", "#a78bfa", "#34d399"][trajectory];
    context.stroke();
  }
}

async function measureOverlayAndIr(lines) {
  video.currentTime = 0;
  video.loop = true;
  await video.play();
  const frameIntervals = [];
  const startedAt = performance.now();
  let previousFrameAt = startedAt;
  const parsing = parseRuntimeIr(lines);
  await new Promise((resolve) => {
    function frame(now) {
      frameIntervals.push(now - previousFrameAt);
      previousFrameAt = now;
      drawOverlay(now - startedAt);
      if (now - startedAt < OVERLAY_DURATION_MS) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });
  video.pause();
  const runtimeIr = await parsing;
  const playback = typeof video.getVideoPlaybackQuality === "function"
    ? video.getVideoPlaybackQuality()
    : null;
  const durationMs = performance.now() - startedAt;
  return {
    overlay: {
      boxCount: 400,
      droppedAnimationFramesOver25ms: frameIntervals.filter((interval) => interval > 25).length,
      effectiveFramesPerSecond: rounded(frameIntervals.length / (durationMs / 1_000)),
      frameCount: frameIntervals.length,
      p50FrameIntervalMs: rounded(percentile(frameIntervals, 0.5)),
      p95FrameIntervalMs: rounded(percentile(frameIntervals, 0.95)),
      trajectoryCount: 3,
    },
    playback: playback ? {
      droppedVideoFrames: playback.droppedVideoFrames,
      totalVideoFrames: playback.totalVideoFrames,
    } : null,
    runtimeIr,
  };
}

function detectedShell() {
  const requested = new URLSearchParams(location.search).get("shell");
  if (requested) return requested;
  if ("__TAURI_INTERNALS__" in window) return "tauri";
  if (navigator.userAgent.includes("Electron")) return "electron";
  return "browser";
}

function jsHeap() {
  const memory = performance.memory;
  return memory ? { totalBytes: memory.totalJSHeapSize, usedBytes: memory.usedJSHeapSize } : null;
}

async function run() {
  button.disabled = true;
  statusNode.textContent = "Preparing deterministic Runtime IR…";
  try {
    const heapBefore = jsHeap();
    const lines = prepareRuntimeIr();
    statusNode.textContent = "Measuring video seeking…";
    const seeking = await measureSeeking();
    statusNode.textContent = "Measuring video, overlays, and Runtime IR ingestion together…";
    const concurrentWorkload = await measureOverlayAndIr(lines);
    const result = {
      completedAt: new Date().toISOString(),
      fixture: {
        durationSeconds: rounded(video.duration),
        frameRate: FRAME_RATE,
        height: video.videoHeight,
        runtimeIrEventCount: IR_EVENT_COUNT,
        width: video.videoWidth,
      },
      heap: { after: jsHeap(), before: heapBefore },
      schemaVersion: 1,
      seeking,
      shell: detectedShell(),
      userAgent: navigator.userAgent,
      ...concurrentWorkload,
    };
    window.__POIETRA_SHELL_EVALUATION__ = result;
    resultNode.textContent = JSON.stringify(result, null, 2);
    statusNode.textContent = "Complete. Save the JSON below with the environment metadata.";
  } catch (error) {
    statusNode.textContent = `Failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    button.disabled = false;
  }
}

button.addEventListener("click", () => void run());
if (new URLSearchParams(location.search).get("autorun") === "1") void run();
