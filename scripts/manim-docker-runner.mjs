import { spawn } from "node:child_process";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const image = process.env.POIETRA_MANIM_DOCKER_IMAGE ?? "manimcommunity/manim:v0.20.1";
const user = typeof process.getuid === "function" && typeof process.getgid === "function"
  ? `${process.getuid()}:${process.getgid()}`
  : null;

function runDocker(arguments_) {
  return new Promise((resolveExit) => {
    const child = spawn("docker", arguments_, { stdio: "inherit" });
    child.once("error", (error) => {
      process.stderr.write(`${error.message}\n`);
      resolveExit(1);
    });
    child.once("exit", (code, signal) => {
      if (signal) {
        process.stderr.write(`Docker Manim stopped by ${signal}.\n`);
        resolveExit(1);
        return;
      }
      resolveExit(code ?? 1);
    });
  });
}

async function main() {
  const manimArguments = process.argv.slice(2);
  if (manimArguments.length === 1 && manimArguments[0] === "--version") {
    return runDocker([
      "run",
      "--rm",
      "--network",
      "none",
      image,
      "manim",
      "--version",
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
  const containerPreviewPath = (hostPath) => {
    const relativePath = relative(previewRoot, hostPath);
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new Error(`${hostPath} is outside the isolated preview directory.`);
    }
    return `/poietra-preview/${relativePath.split(sep).join("/")}`;
  };

  let rewrittenArguments;
  try {
    rewrittenArguments = manimArguments.map((argument) => (
      isAbsolute(argument) && (argument === sourcePath || argument === mediaPath)
        ? containerPreviewPath(argument)
        : argument
    ));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Invalid preview path."}\n`);
    return 2;
  }

  return runDocker([
    "run",
    "--rm",
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
