import { spawn } from "node:child_process";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const manimArguments = process.argv.slice(2);
const sourcePath = manimArguments.find((argument) => isAbsolute(argument) && argument.endsWith(".py"));
const mediaIndex = manimArguments.indexOf("--media_dir");
const mediaPath = mediaIndex >= 0 ? manimArguments[mediaIndex + 1] : null;
if (!sourcePath || !mediaPath || !isAbsolute(mediaPath)) {
  process.stderr.write("The Docker runner requires absolute preview source and media paths.\n");
  process.exit(2);
}

const projectRoot = resolve(process.cwd());
const previewRoot = dirname(sourcePath);
function containerPreviewPath(hostPath) {
  const relativePath = relative(previewRoot, hostPath);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    process.stderr.write(`${hostPath} is outside the isolated preview directory.\n`);
    process.exit(2);
  }
  return `/poietra-preview/${relativePath.split(sep).join("/")}`;
}

const rewrittenArguments = manimArguments.map((argument) => (
  isAbsolute(argument) && (argument === sourcePath || argument === mediaPath)
    ? containerPreviewPath(argument)
    : argument
));
const image = process.env.POIETRA_MANIM_DOCKER_IMAGE ?? "manimcommunity/manim:v0.20.1";
const user = typeof process.getuid === "function" && typeof process.getgid === "function"
  ? `${process.getuid()}:${process.getgid()}`
  : null;
const dockerArguments = [
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
];

const child = spawn("docker", dockerArguments, {
  stdio: "inherit",
});
child.once("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
child.once("exit", (code, signal) => {
  if (signal) {
    process.stderr.write(`Docker Manim stopped by ${signal}.\n`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
