import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const baseBranch = process.env.GITHUB_BASE_REF?.trim() || "main";
const eventBaseRef = process.env.POIETRA_FORMAT_BASE_REF?.trim();

function git(args) {
  return execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function existingRef(candidates) {
  return candidates.find((candidate) => {
    try {
      git(["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  });
}

const hasEventBaseRef = Boolean(eventBaseRef && !/^0+$/.test(eventBaseRef));
const baseRef = existingRef(hasEventBaseRef ? [eventBaseRef] : [`origin/${baseBranch}`, baseBranch]);
if (!baseRef) {
  const requested = eventBaseRef ? `event base ${eventBaseRef}` : `${baseBranch} base`;
  console.error(`Cannot find the ${requested} ref. Fetch it before running the format check.`);
  process.exitCode = 1;
} else {
  const mergeBase = git(["merge-base", "HEAD", baseRef]).trim();
  const changedOutput = git(["diff", "--name-only", "-z", "--diff-filter=ACMRTUXB", mergeBase, "--"]);
  const untrackedOutput = git(["ls-files", "--others", "--exclude-standard", "-z"]);
  const files = [...new Set(`${changedOutput}${untrackedOutput}`.split("\0"))].filter(Boolean).sort();

  if (files.length === 0) {
    console.log(`No Biome-supported files changed from ${baseRef}.`);
  } else {
    const executable = process.platform === "win32" ? "biome.cmd" : "biome";
    const write = process.argv.includes("--write") ? ["--write"] : [];
    const result = spawnSync(executable, ["format", "--files-ignore-unknown=true", ...write, "--", ...files], {
      cwd: projectRoot,
      stdio: "inherit",
    });

    if (result.error) console.error(result.error.message);
    process.exitCode = result.status ?? 1;
  }
}
