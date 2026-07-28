import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

function argumentValue(name) {
  const prefix = `--${name}=`;
  const match = process.argv.find((argument) => argument.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

// Mirrors the server's canonical JSON so the producer independently recomputes
// digests instead of blindly echoing request hashes.
function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonicalization requires finite numbers.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new TypeError("Canonicalization received a non-JSON value.");
}

function canonicalF64Hex(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleBE(value, 0);
  return `f64:${buffer.toString("hex")}`;
}

function digestRuntimeConfig(config) {
  const digestInput = {
    ...config,
    frame: { height: canonicalF64Hex(config.frame.height), width: canonicalF64Hex(config.frame.width) },
  };
  return createHash("sha256").update(canonicalJson(digestInput)).digest("hex");
}

// Mirrors canonicalAssetManifestV1: JSON.stringify with this exact key order.
function digestAssetManifest(manifestId) {
  const canonical = JSON.stringify({
    assets: [],
    manifestId,
    schema: "poietra.asset-manifest",
    version: 1,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

async function writeStdout(text) {
  await new Promise((resolve) => {
    process.stdout.write(text, () => resolve());
  });
}

const mode = argumentValue("mode") ?? "compiled";
const pidFile = argumentValue("pid-file");
if (pidFile) await writeFile(pidFile, String(process.pid), "utf8");
const envFile = argumentValue("env-probe");
if (envFile) {
  await writeFile(
    envFile,
    JSON.stringify({
      CWD: process.cwd(),
      HOME: process.env.HOME ?? null,
      PYTHONHASHSEED: process.env.PYTHONHASHSEED ?? null,
      PATH: process.env.PATH ?? null,
      PYTHONPATH: process.env.PYTHONPATH ?? null,
      SENTINEL: process.env.POIETRA_TEST_SENTINEL_SECRET ?? null,
      TMPDIR: process.env.TMPDIR ?? null,
    }),
    "utf8",
  );
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const requestJson = Buffer.concat(chunks).toString("utf8");

if (mode === "exit-2") {
  // Simulates workspace Python printing secrets, host paths, and tracebacks:
  // none of these bytes may ever appear in server logs or HTTP responses.
  process.stderr.write(
    [
      "fake producer failure detail that must never reach the browser",
      "leaked-workspace-secret-9f8e7d6c5b4a",
      'Traceback (most recent call last): File "/home/builder/secret-project/scene.py", line 3',
    ].join("\n"),
  );
  process.exit(2);
}
if (mode === "garbage") {
  process.stdout.write("this is not JSON {");
  process.exit(0);
}
if (mode === "huge") {
  const filler = "x".repeat(64 * 1024);
  for (let written = 0; written < 13 * 1024 * 1024; written += filler.length) {
    if (!process.stdout.write(filler)) {
      await new Promise((resolve) => process.stdout.once("drain", resolve));
    }
  }
  process.exit(0);
}
if (mode === "stderr-flood") {
  const filler = "e".repeat(64 * 1024);
  for (let written = 0; written < 2 * 1024 * 1024; written += filler.length) {
    if (!process.stderr.write(filler)) {
      await new Promise((resolve) => process.stderr.once("drain", resolve));
    }
  }
  await new Promise(() => setInterval(() => undefined, 1_000));
}

const request = JSON.parse(requestJson);
if (!request.runtimeConfig || typeof request.runtimeConfig !== "object") {
  process.stderr.write("Producer request is missing the canonical runtime config object.\n");
  process.exit(4);
}
// Mutual determinism contract with the real fast-manim CLI: the request must
// pin randomSeed to exactly 0 and the process must run under
// PYTHONHASHSEED=0, or the producer refuses to compile at all.
if (request.runtimeConfig.randomSeed !== 0) {
  process.stderr.write("Producer request runtime config must pin randomSeed to 0.\n");
  process.exit(4);
}
if (process.env.PYTHONHASHSEED !== "0") {
  process.stderr.write("The fast-manim producer requires PYTHONHASHSEED=0.\n");
  process.exit(4);
}
const recomputedRuntimeConfigHash = digestRuntimeConfig(request.runtimeConfig);
if (recomputedRuntimeConfigHash !== request.runtimeConfigHash) {
  process.stderr.write("Producer request runtimeConfigHash does not match the canonical runtime config.\n");
  process.exit(4);
}
// The producer compiles the immutable request sourceText; it never re-opens
// sourcePath, so both hashes below are recomputed from the request itself.
if (typeof request.sourceText !== "string") {
  process.stderr.write("Producer request is missing the immutable source text.\n");
  process.exit(4);
}
const recomputedSourceHash = createHash("sha256").update(request.sourceText, "utf8").digest("hex");
if (recomputedSourceHash !== request.sourceHash) {
  process.stderr.write("Producer request sourceHash does not match its immutable source text.\n");
  process.exit(4);
}
const recomputedSceneId = `scene:${createHash("sha256")
  .update(`${request.sourcePath}\u0000${request.sceneName}`, "utf8")
  .digest("hex")}`;
if (recomputedSceneId !== request.sceneId) {
  process.stderr.write("Producer request sceneId does not match its canonical derivation.\n");
  process.exit(4);
}
const releaseFifo = argumentValue("release-fifo");
const releaseHandle = releaseFifo ? await open(releaseFifo, "r") : null;
const readyFifo = argumentValue("ready-fifo");
if (readyFifo) await writeFile(readyFifo, "ready", "utf8");
if (releaseHandle) {
  try {
    await releaseHandle.read(Buffer.alloc(16), 0, 16, null);
  } finally {
    await releaseHandle.close();
  }
}
if (mode === "hang") {
  await new Promise(() => setInterval(() => undefined, 1_000));
}
const runtimeConfigHash =
  mode === "config-drift"
    ? digestRuntimeConfig({ ...request.runtimeConfig, capabilities: request.runtimeConfig.capabilities.slice(1) })
    : recomputedRuntimeConfigHash;
const sourceHash =
  mode === "source-drift"
    ? createHash("sha256").update(`${request.sourceText}\n# drifted\n`, "utf8").digest("hex")
    : recomputedSourceHash;

const delayMs = Number(argumentValue("delay-ms") ?? "0");
if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));

if (mode === "import-helper") {
  // Mimics Python module resolution: a project-local helper is only reachable
  // through the process working directory or PYTHONPATH. The hardened server
  // runs producers from a private empty runtime directory with no PYTHONPATH,
  // so this lookup must fail there — proving helper content can never feed a
  // snapshot correlated solely by the selected source's hash.
  const searchDirs = [process.cwd(), ...(process.env.PYTHONPATH ?? "").split(":").filter(Boolean)];
  let helperSource = null;
  for (const dir of searchDirs) {
    try {
      helperSource = await readFile(join(dir, "snapshot_helper.py"), "utf8");
      break;
    } catch {
      // Keep searching the remaining sys.path-equivalent entries.
    }
  }
  if (helperSource === null) {
    process.stderr.write("ModuleNotFoundError: No module named 'snapshot_helper'\n");
    process.exit(5);
  }
  // Helper reachable: fall through and emit a compiled bundle even though the
  // request sourceText never changed — the legacy false-verified vector.
}

const ns = (suffix) => `${recomputedSceneId}/${suffix}`;
const requestId = mode === "stale-correlation" ? `${request.requestId}-stale` : request.requestId;
const envelope = {
  projectId: request.projectId,
  requestId,
  runtimeConfigHash,
  sceneId: recomputedSceneId,
  sceneName: request.sceneName,
  schema: "poietra.fast-manim-snapshot-result",
  sourceHash,
  sourcePath: request.sourcePath,
  version: 1,
};

if (mode === "unsupported" || mode === "leak-unsupported") {
  const issues =
    mode === "unsupported"
      ? [
          {
            code: "runtime-semantics-unsupported",
            evidence: ["fake producer reports unsupported runtime semantics"],
            message: "The requested Scene uses runtime semantics the exporter cannot snapshot.",
          },
        ]
      : [
          {
            code: "runtime-semantics-unsupported",
            evidence: [
              "traceback at /home/builder/project/scene.py line 12",
              "compiled under C:\\Users\\builder\\project\\scene.py",
            ],
            message: "failed while importing /home/builder/project/scene.py",
            runtimeObjectId: "home/builder/project/scene.py#leaked-object",
          },
          {
            code: "geometry-evidence-incomplete",
            evidence: [request.sourceText.split("\n").find((line) => line.trim().length >= 16) ?? "class fallback"],
            message: "raw source fragment follows",
          },
        ];
  await writeStdout(JSON.stringify({ ...envelope, issues, kind: "unsupported" }));
  process.exit(0);
}

const bundlePath = argumentValue("bundle");
if (!bundlePath) {
  process.stderr.write("Missing --bundle=<scene-ir-bundle.json>\n");
  process.exit(3);
}
const fixture = JSON.parse(await readFile(bundlePath, "utf8"));
const snapshotHash = mode === "sealed" ? "1".repeat(64) : "0".repeat(64);

// Remap every identifier onto the mutual exporter/server v1 convention: the
// manifest at `${sceneId}/manifest`, entities at
// `${sceneId}/entity:${sceneOrder}`, channels at
// `${sceneId}/channel:${kind}:${targetSceneOrder}`, one scene provenance
// record at `${sceneId}/provenance:scene`, and one entity provenance record
// per entity at `${sceneId}/provenance:entity:${sceneOrder}` (referenced by
// that entity and by channels targeting it).
const manifestId = ns("manifest");
const manifestDigest = digestAssetManifest(manifestId);
const assets = { assets: [], manifestDigest, manifestId, schema: "poietra.asset-manifest", version: 1 };
const sceneProvenanceId = ns("provenance:scene");
const entityProvenanceId = (sceneOrder) => ns(`provenance:entity:${sceneOrder}`);
const provenanceEvidence =
  mode === "leak-compiled"
    ? [`compiled at ${process.cwd()}/scene.py by the fake producer`]
    : ["fake fast-manim snapshot producer"];
const sceneOrderById = new Map(fixture.scene.entities.map((entity) => [entity.id, entity.sceneOrder]));
const entityId = (fixtureId) => ns(`entity:${sceneOrderById.get(fixtureId)}`);
let entities = fixture.scene.entities.map((entity) => ({
  ...entity,
  id: entityId(entity.id),
  parentId: entity.parentId === null ? null : entityId(entity.parentId),
  provenanceId: entityProvenanceId(entity.sceneOrder),
}));
let animationChannels = fixture.scene.animationChannels.map((channel) => ({
  ...channel,
  entityId: entityId(channel.entityId),
  id: ns(`channel:${channel.kind}:${sceneOrderById.get(channel.entityId)}`),
  provenanceId: entityProvenanceId(sceneOrderById.get(channel.entityId)),
}));
let requiredCapabilities = fixture.scene.requiredCapabilities;

if (mode === "leak-id") {
  entities = entities.map((entity, index) => (index === 0 ? { ...entity, id: "not-namespaced-producer-id" } : entity));
  animationChannels = animationChannels.map((channel) => ({ ...channel, entityId: entities[1].id }));
}

const straightSegment = (from, to) => ({ control1: from, control2: to, end: to });
const closedPolygon = (points) => ({
  closed: true,
  segments: points.slice(1).map((point, index) => straightSegment(points[index], point)),
  start: points[0],
});
const filledAppearance = fixture.scene.entities[0].appearance;
const strokedAppearance = fixture.scene.entities.find((entity) => entity.appearance.stroke !== null).appearance;
const cubicEntity = (path, appearance) => ({
  ...fixture.scene.entities[0],
  appearance,
  geometry: { kind: "cubic-path", path },
  id: ns("entity:0"),
  parentId: null,
  provenanceId: entityProvenanceId(0),
  sceneOrder: 0,
});
// Schema-valid cubic constructions the server refuses as outside the proven
// static profile: two subpaths, a non-convex fill, and a multi-segment stroke.
const outsideProfileEntity = {
  "multi-subpath": () =>
    cubicEntity(
      {
        subpaths: [
          closedPolygon([
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 1, y: 1 },
            { x: 0, y: 1 },
          ]),
          closedPolygon([
            { x: 2, y: 0 },
            { x: 3, y: 0 },
            { x: 3, y: 1 },
            { x: 2, y: 1 },
          ]),
        ],
      },
      filledAppearance,
    ),
  "non-convex": () =>
    cubicEntity(
      {
        subpaths: [
          closedPolygon([
            { x: 0, y: 0 },
            { x: 2, y: 0 },
            { x: 2, y: 1 },
            { x: 1, y: 1 },
            { x: 1, y: 2 },
            { x: 0, y: 2 },
          ]),
        ],
      },
      filledAppearance,
    ),
  "open-stroked": () =>
    cubicEntity(
      {
        subpaths: [
          {
            closed: false,
            segments: [
              straightSegment({ x: 0, y: 0 }, { x: 1, y: 0 }),
              straightSegment({ x: 1, y: 0 }, { x: 2, y: 1 }),
            ],
            start: { x: 0, y: 0 },
          },
        ],
      },
      strokedAppearance,
    ),
};
if (outsideProfileEntity[mode]) {
  animationChannels = [];
  requiredCapabilities = ["cubic-path-geometry"];
  entities = [outsideProfileEntity[mode]()];
}

// The scene record first, then one record per entity ascending by sceneOrder.
const provenance = [
  {
    evidence: provenanceEvidence,
    id: sceneProvenanceId,
    origin: "fast-manim-server-snapshot",
  },
  ...entities
    .map((entity) => entity.sceneOrder)
    .sort((left, right) => left - right)
    .map((sceneOrder) => ({
      evidence: provenanceEvidence,
      id: entityProvenanceId(sceneOrder),
      origin: "fast-manim-server-snapshot",
    })),
];
if (mode === "exfil-provenance") {
  // A schema-valid namespaced suffix carrying a secret in an unreferenced
  // provenance record: the server must reject it, never seal and return it.
  provenance.push({
    evidence: ["producer-chosen provenance"],
    id: ns("ghp_EXFILTRATED_SECRET"),
    origin: "fast-manim-server-snapshot",
  });
}

const bundle = {
  assets,
  scene: {
    ...fixture.scene,
    animationChannels,
    assetManifest: { manifestDigest, manifestId },
    entities,
    provenance,
    requiredCapabilities,
    sceneId: recomputedSceneId,
    source: {
      kind: "imported-manim-server-snapshot",
      runtimeConfigHash,
      snapshotHash,
      snapshotVersion: 1,
      sourceHash,
    },
  },
};

const snapshotResult = { ...envelope, bundle, kind: "compiled", snapshotHash };
let resultJson = JSON.stringify(snapshotResult);

if (mode.startsWith("combined-identity")) {
  const snapshotJson = canonicalJson(snapshotResult);
  const snapshotDigest = createHash("sha256").update(snapshotJson, "utf8").digest("hex");
  const assignmentSpan = { endColumn: 14, endLine: 5, startColumn: 8, startLine: 5 };
  const usageSpan = { endColumn: 23, endLine: 6, startColumn: 17, startLine: 6 };
  const identityName = argumentValue("identity-name") ?? "circle";
  const identityOrdinal = Number(argumentValue("identity-ordinal") ?? "1");
  const identityLine = Number(argumentValue("identity-line") ?? "0");
  let span = mode === "combined-identity-usage-span" ? usageSpan : assignmentSpan;
  if (identityLine > 0) {
    const rawLine = request.sourceText.split(/\r?\n/)[identityLine - 1] ?? "";
    const characterColumn =
      argumentValue("identity-occurrence") === "last"
        ? rawLine.lastIndexOf(identityName)
        : rawLine.indexOf(identityName);
    if (characterColumn < 0) {
      process.stderr.write("Configured identity token is missing from its source line.\n");
      process.exit(4);
    }
    const startColumn = Buffer.byteLength(rawLine.slice(0, characterColumn), "utf8");
    span = {
      endColumn: startColumn + Buffer.byteLength(identityName, "utf8"),
      endLine: identityLine,
      startColumn,
      startLine: identityLine,
    };
  }
  const bindingPayload = [
    "poietra.fast-manim-source-runtime-identity",
    "1",
    recomputedSourceHash,
    recomputedSceneId,
    identityName,
    String(identityOrdinal),
    String(span.startLine),
    String(span.startColumn),
    String(span.endLine),
    String(span.endColumn),
  ].join("\u0000");
  const binding = {
    id: `source-binding:${createHash("sha256").update(bindingPayload, "utf8").digest("hex")}`,
    name: identityName,
    ordinal: identityOrdinal,
    span,
  };
  if (mode === "combined-identity-binding-id-tamper") binding.id = `source-binding:${"f".repeat(64)}`;
  const mappedRecord = {
    bindings: [{ binding, boundSequence: 1, releasedSequence: null }],
    entityId: entities[0].id,
    familyPath: [],
    lifecycle: [{ action: "add", sequence: 1 }],
    provenanceId: entities[0].provenanceId,
    reasons: [],
    runtimeType: "manim.mobject.geometry.arc.Circle",
    sceneOrder: 0,
    status: "mapped",
  };
  const unmatchedRecords = entities.slice(1).map((entity) => ({
    bindings: [],
    entityId: entity.id,
    familyPath: [],
    lifecycle: [],
    provenanceId: entity.provenanceId,
    reasons: ["no-active-source-binding"],
    runtimeType: "manim.mobject.mobject.Mobject",
    sceneOrder: entity.sceneOrder,
    status: "unmatched",
  }));
  if (mode === "combined-identity-duplicate-sequence") {
    unmatchedRecords[0].bindings = [{ binding, boundSequence: 1, releasedSequence: null }];
    unmatchedRecords[0].reasons = [];
    unmatchedRecords[0].status = "mapped";
  }
  const records = [mappedRecord, ...unmatchedRecords];
  if (mode === "combined-identity-missing-record") records.pop();
  const evidence = {
    issues: [],
    kind: "complete",
    projectId: request.projectId,
    records,
    requestId: request.requestId,
    runtimeConfigHash: recomputedRuntimeConfigHash,
    sceneId: recomputedSceneId,
    sceneName: request.sceneName,
    snapshotDigest,
    sourceHash: mode === "combined-identity-stale-source" ? "f".repeat(64) : recomputedSourceHash,
    sourcePath: request.sourcePath,
  };
  const combined = {
    evidence,
    schema: "poietra.fast-manim-source-runtime-identity",
    snapshotDigest: mode === "combined-identity-digest-tamper" ? "f".repeat(64) : snapshotDigest,
    snapshotJson,
    version: 1,
  };
  const canonicalCombined = canonicalJson(combined);
  resultJson =
    mode === "combined-identity-noncanonical"
      ? canonicalCombined.replace('"evidence":', '"evidence": ')
      : canonicalCombined;
}

const orphanModes = new Set(["orphan-hang", "orphan-flood", "orphan-setsid", "orphan-parent-hang"]);
if (orphanModes.has(mode)) {
  await writeStdout(resultJson);
  const orphanPidFile = argumentValue("orphan-pid-file") ?? "";
  // Self-expiry backstop: every fixture descendant exits on its own within a
  // bounded window so a test that relies on the server NOT signalling it (the
  // documented #80 residuals) never leaks a process, and so best-effort PID
  // cleanup in the test never has to target a long-lived — and thus
  // potentially reused — PID.
  const selfExpiry = "setTimeout(() => process.exit(0), 30000);";
  const orphanBody =
    mode === "orphan-flood"
      ? `${selfExpiry}
         const filler = "x".repeat(65536); let sent = 0;
         const write = () => {
           while (sent < 208) {
             sent += 1;
             if (!process.stdout.write(filler)) { process.stdout.once("drain", write); return; }
           }
           setInterval(() => undefined, 1000);
         };
         process.stdout.write(filler, () => {
           sent = 1;
           process.once("disconnect", () => setImmediate(write));
           process.send?.("stdout-started");
         });`
      : // A same-group descendant that ignores catchable termination signals
        // and does not exit on its own before the self-expiry backstop.
        `${selfExpiry} process.on("SIGTERM", () => undefined); process.on("SIGHUP", () => undefined); setInterval(() => undefined, 1000);`;
  // `orphan-setsid` moves the descendant into its OWN session/process group
  // (out-of-group escape): the server cannot verify or safely signal that
  // group, so it is the documented residual under #80 and the parent exits
  // immediately, leaving it behind. All other variants keep the descendant
  // in the leader's group with inherited stdio.
  const orphan = spawn(process.execPath, ["-e", orphanBody], {
    detached: mode === "orphan-setsid",
    stdio:
      mode === "orphan-setsid"
        ? "ignore"
        : mode === "orphan-flood"
          ? ["inherit", "inherit", "inherit", "ipc"]
          : "inherit",
  });
  // The parent records the descendant PID synchronously so the test never
  // races the detached child's own startup before reading the file.
  if (orphanPidFile) await writeFile(orphanPidFile, String(orphan.pid), "utf8");
  if (mode === "orphan-flood") {
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        orphan.off("disconnect", onDisconnect);
        orphan.off("error", onError);
        orphan.off("exit", onExit);
        orphan.off("message", onMessage);
      };
      const fail = (error) => {
        cleanup();
        reject(error);
      };
      const onDisconnect = () => fail(new Error("Flood descendant disconnected before writing stdout."));
      const onError = (error) => {
        fail(error);
      };
      const onExit = (code, signal) =>
        fail(new Error(`Flood descendant exited before writing stdout (code=${code}, signal=${signal}).`));
      const onMessage = (message) => {
        if (message !== "stdout-started") return;
        cleanup();
        resolve();
      };
      orphan.once("disconnect", onDisconnect);
      orphan.once("error", onError);
      orphan.once("exit", onExit);
      orphan.on("message", onMessage);
    });
  }
  if (mode === "orphan-parent-hang") {
    // The leader itself ignores SIGTERM and never exits on its own, so it is
    // observably alive when the +2s SIGKILL lands on the whole group: that
    // uncatchable signal reaps both the leader and the same-group descendant.
    process.on("SIGTERM", () => undefined);
    process.on("SIGHUP", () => undefined);
    await new Promise(() => setInterval(() => undefined, 1_000));
  }
  process.exit(0);
}

await writeStdout(resultJson);
