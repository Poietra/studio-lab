import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

const image = process.env.POIETRA_MANIM_DOCKER_IMAGE ?? "manimcommunity/manim:v0.20.1";
const user =
  typeof process.getuid === "function" && typeof process.getgid === "function"
    ? `${process.getuid()}:${process.getgid()}`
    : null;
const runId = (process.env.POIETRA_MANIM_SMOKE_RUN_ID ?? randomUUID()).replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 48);
const signalExitCodes = { SIGINT: 130, SIGTERM: 143 };

function waitForClose(child, timeoutMs = 10_000) {
  return new Promise((resolveClose) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveClose(result);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: 1, signal: "SIGKILL", timedOut: true });
    }, timeoutMs);
    timeout.unref();
    child.once("error", (error) => finish({ code: 1, error, signal: null, timedOut: false }));
    child.once("close", (code, signal) => finish({ code: code ?? 1, signal, timedOut: false }));
  });
}

async function dockerControl(arguments_) {
  return waitForClose(spawn("docker", arguments_, { stdio: "ignore" }));
}

async function removeOwnedContainer(name) {
  await dockerControl(["container", "rm", "--force", name]);
  const inspected = await dockerControl(["container", "inspect", name]);
  return inspected.code !== 0;
}

async function runDocker(arguments_) {
  const name = `poietra-manim-${runId}-${randomUUID().slice(0, 8)}`;
  const controlRoot = process.env.POIETRA_MANIM_SMOKE_CONTROL_ROOT;
  const controlPath = controlRoot ? resolve(controlRoot, `${name}.json`) : null;
  if (controlPath) {
    await mkdir(controlRoot, { recursive: true });
    await writeFile(controlPath, `${JSON.stringify({ name, pid: process.pid })}\n`, { encoding: "utf8", flag: "wx" });
  }
  const child = spawn(
    "docker",
    ["run", "--rm", "--name", name, "--label", `io.poietra.smoke-run=${runId}`, ...arguments_],
    { stdio: "inherit" },
  );
  let requestedSignal = null;
  let cleanupRequest = null;
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      if (requestedSignal) return;
      requestedSignal = signal;
      child.kill(signal);
      cleanupRequest = removeOwnedContainer(name);
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }

  try {
    const result = await waitForClose(child, 180_000);
    if (cleanupRequest) await cleanupRequest;
    const removed = await removeOwnedContainer(name);
    if (!removed) {
      process.stderr.write(`Could not remove owned Docker container ${name}.\n`);
      return 1;
    }
    if (result.error) process.stderr.write(`${result.error.message}\n`);
    if (result.timedOut) process.stderr.write("Docker did not exit within 180 seconds.\n");
    if (requestedSignal) return signalExitCodes[requestedSignal];
    if (result.signal) {
      process.stderr.write(`Docker Manim stopped by ${result.signal}.\n`);
      return 1;
    }
    return result.code;
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    if (controlPath) await rm(controlPath, { force: true });
  }
}

function previewPathMapper(previewRoot) {
  return (hostPath) => {
    const relativePath = relative(previewRoot, hostPath);
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new Error(`${hostPath} is outside the isolated preview directory.`);
    }
    return `/poietra-preview/${relativePath.split(sep).join("/")}`;
  };
}

async function main() {
  const manimArguments = process.argv.slice(2);
  if (manimArguments.length === 1 && manimArguments[0] === "--version") {
    return runDocker(["--network", "none", image, "manim", "--version"]);
  }
  if (manimArguments.length === 2 && manimArguments[0] === "--poietra-probe-json") {
    const videoPath = manimArguments[1];
    if (!isAbsolute(videoPath)) {
      process.stderr.write("The Docker MP4 probe requires an absolute video path.\n");
      return 2;
    }
    const mediaRoot = dirname(videoPath);
    return runDocker([
      "--network",
      "none",
      "--volume",
      `${mediaRoot}:/poietra-media:ro`,
      image,
      "/opt/venv/bin/python",
      "-c",
      [
        "import av, json, sys",
        "container = av.open(sys.argv[1])",
        "videos = [stream for stream in container.streams if stream.type == 'video']",
        "frames = sum(1 for _ in container.decode(video=0)) if videos else 0",
        "duration = float(container.duration / av.time_base) if container.duration else 0",
        "print(json.dumps({'decoded_frames': frames, 'format': {'duration': str(duration), 'format_name': container.format.name}, 'streams': [{'codec_type': stream.type, 'height': stream.height, 'width': stream.width} for stream in videos]}))",
        "container.close()",
      ].join("; "),
      `/poietra-media/${basename(videoPath)}`,
    ]);
  }

  const sourcePath = manimArguments.find((argument) => isAbsolute(argument) && argument.endsWith(".py"));
  const mediaIndex = manimArguments.indexOf("--media_dir");
  const mediaPath = mediaIndex >= 0 ? manimArguments[mediaIndex + 1] : null;
  if (!sourcePath || !mediaPath || !isAbsolute(mediaPath)) {
    process.stderr.write("The Docker runner requires absolute preview source and media paths.\n");
    return 2;
  }

  const projectRoot = resolve(process.cwd());
  const previewRoot = dirname(sourcePath);
  const containerPreviewPath = previewPathMapper(previewRoot);
  let rewrittenArguments;
  try {
    rewrittenArguments = manimArguments.map((argument) =>
      isAbsolute(argument) && (argument === sourcePath || argument === mediaPath)
        ? containerPreviewPath(argument)
        : argument,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Invalid preview path."}\n`);
    return 2;
  }

  return runDocker([
    "--network",
    "none",
    ...(user ? ["--user", user] : []),
    "--volume",
    `${projectRoot}:/workspace:ro`,
    "--volume",
    `${previewRoot}:/poietra-preview`,
    "--workdir",
    "/workspace",
    "--env",
    "PYTHONPATH=/workspace",
    image,
    "manim",
    ...rewrittenArguments,
  ]);
}

process.exitCode = await main();
