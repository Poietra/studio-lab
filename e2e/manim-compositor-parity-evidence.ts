import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  PINNED_REFERENCE_HOST_PROFILE_HASH_PATH,
  PINNED_REFERENCE_HOST_PROFILE_PATH,
  readPinnedReferenceHostProfile,
  requireReferenceHostPreflight,
} from "./benchmark-environment";
import { manimCompositorParityReportV1Schema, manimCompositorReferenceV1Schema } from "./manim-compositor-parity";

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PINNED_REFERENCE_ROOT = join(REPOSITORY_ROOT, "fixtures", "manim-compositor-parity-v1");
const EVIDENCE_FILENAMES = ["actual.png", "diff.png", "expected.png", "report.json"] as const;

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireEqual(actual: unknown, expected: unknown, label: string) {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`${label} is not consistent with the pinned evidence`);
}

function requireDigest(bytes: Uint8Array, expected: string, label: string) {
  const actual = sha256(bytes);
  if (actual !== expected) throw new Error(`${label} hashes to ${actual}, expected ${expected}`);
}

async function pathExists(path: string) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function verifyManimCompositorParityEvidenceV1(directory: string) {
  const report = manimCompositorParityReportV1Schema.parse(
    JSON.parse(await readFile(join(directory, "report.json"), "utf8")),
  );
  if (!report.gate.passed) throw new Error("the promoted Manim compositor parity report did not pass its gate");

  const pinnedReference = manimCompositorReferenceV1Schema.parse(
    JSON.parse(await readFile(join(PINNED_REFERENCE_ROOT, "reference.json"), "utf8")),
  );
  const pinnedHost = readPinnedReferenceHostProfile(
    await readFile(join(REPOSITORY_ROOT, PINNED_REFERENCE_HOST_PROFILE_PATH)),
    await readFile(join(REPOSITORY_ROOT, PINNED_REFERENCE_HOST_PROFILE_HASH_PATH), "utf8"),
  );
  requireEqual(report.reference, pinnedReference, "the embedded Manim/Cairo reference");
  requireEqual(report.environment.referenceHostProfile, pinnedHost.evidence, "the reference-host profile");
  requireReferenceHostPreflight({
    browserLaunch: { args: report.browser.configuredArgs, channel: report.browser.channel },
    host: report.environment.host,
    referenceHost: pinnedHost,
  });
  const commitIdentity = report.environment.host.commitIdentity;
  if ("status" in commitIdentity || commitIdentity.treeState !== "clean" || commitIdentity.uncommittedPathCount !== 0) {
    throw new Error("the promoted compositor evidence requires a clean measured checkout");
  }
  requireEqual(report.browser.version, pinnedHost.profile.browser.version, "the measured Edge version");
  requireEqual(
    report.browser.pageAdapterHint,
    {
      architecture: pinnedHost.profile.selectedWorkerAdapter.browserArchitecture,
      vendor: pinnedHost.profile.selectedWorkerAdapter.browserVendor,
    },
    "the page adapter hint",
  );

  const [actual, diff, expected, pinnedExpected, source] = await Promise.all([
    readFile(join(directory, report.artifacts.actual.path)),
    readFile(join(directory, report.artifacts.diff.path)),
    readFile(join(directory, report.artifacts.expected.path)),
    readFile(join(PINNED_REFERENCE_ROOT, pinnedReference.png.path)),
    readFile(join(REPOSITORY_ROOT, pinnedReference.scene.sourcePath)),
  ]);
  requireDigest(actual, report.artifacts.actual.sha256, "the actual PNG artifact");
  requireDigest(diff, report.artifacts.diff.sha256, "the diff PNG artifact");
  requireDigest(expected, report.artifacts.expected.sha256, "the expected PNG artifact");
  requireDigest(pinnedExpected, pinnedReference.png.sha256, "the pinned Manim/Cairo PNG");
  requireDigest(source, pinnedReference.scene.sourceSha256, "the real Manim source");
  requireEqual(actual.byteLength, report.capture.pngByteLength, "the actual PNG byte length");
  requireEqual(expected.byteLength, pinnedReference.png.byteLength, "the expected PNG byte length");

  return report;
}

type PromotionInput = Readonly<{
  destinationDirectory: string;
  sourceDirectory: string;
}>;

export async function promoteManimCompositorParityEvidenceV1(input: PromotionInput) {
  const sourceDirectory = resolve(input.sourceDirectory);
  const destinationDirectory = resolve(input.destinationDirectory);
  const report = await verifyManimCompositorParityEvidenceV1(sourceDirectory);
  if (await pathExists(destinationDirectory)) {
    throw new Error(`evidence destination already exists: ${destinationDirectory}`);
  }

  const destinationParent = dirname(destinationDirectory);
  await mkdir(destinationParent, { recursive: true });
  const temporary = await mkdtemp(join(destinationParent, `.${basename(destinationDirectory)}.tmp-`));
  try {
    await Promise.all(
      EVIDENCE_FILENAMES.map((filename) => copyFile(join(sourceDirectory, filename), join(temporary, filename))),
    );
    await verifyManimCompositorParityEvidenceV1(temporary);
    await rename(temporary, destinationDirectory);
    return { destination: destinationDirectory, report } as const;
  } catch (error) {
    await rm(temporary, { force: true, recursive: true });
    throw error;
  }
}
