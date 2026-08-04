import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  evaluateSegmentedTexWriteV1,
  initializePoietraSegmentedTexOutlineBindingsV1,
  parseSegmentedTexOutlineResponseV1,
  type SegmentedTexOutlineArtifactV1,
  type SegmentedTexOutlineResponseV1,
  type SegmentedTexWriteSampleV1,
  segmentedTexOutlineResponseV1Schema,
} from "./segmented-tex-outline";

type EvidenceCase = Readonly<{
  expected: Readonly<{
    bounds: SegmentedTexOutlineArtifactV1["bounds"];
    contentDigest: string;
    entityCount: number;
    fontDigest: string;
    fragmentCount: number;
    fragmentKinds: readonly SegmentedTexOutlineArtifactV1["fragments"][number]["kind"][];
    paintSpans: SegmentedTexOutlineArtifactV1["paintSpans"];
    paintedFragmentOrders: readonly number[];
    toolchainDigest: string;
  }>;
  id: string;
  phaseSamples: readonly Readonly<{
    expected: SegmentedTexWriteSampleV1;
    fragmentOrder: number;
    id: string;
    progress: number;
  }>[];
  request: Readonly<{
    mode: SegmentedTexOutlineArtifactV1["mode"];
    source: string;
  }>;
}>;

type Evidence = Readonly<{
  cases: readonly EvidenceCase[];
  schema: string;
  version: number;
}>;

const WHITE = { alpha: 1, blue: 1, green: 1, red: 1 } as const;
const YELLOW = { alpha: 1, blue: 0, green: 1, red: 1 } as const;
const encoder = new TextEncoder();

const evidence = JSON.parse(
  await readFile(
    new URL("../../fixtures/segmented-tex-outline-v1/official-write-stuff-evidence.json", import.meta.url),
    "utf8",
  ),
) as Evidence;

function lineAsCubic(start: { x: number; y: number }, end: { x: number; y: number }) {
  return {
    control1: { x: start.x + (end.x - start.x) / 3, y: start.y + (end.y - start.y) / 3 },
    control2: { x: start.x + (2 * (end.x - start.x)) / 3, y: start.y + (2 * (end.y - start.y)) / 3 },
    end,
  };
}

const compactPath = {
  subpaths: [
    {
      closed: true,
      segments: [
        lineAsCubic({ x: -0.1, y: -0.1 }, { x: 0.1, y: -0.1 }),
        lineAsCubic({ x: 0.1, y: -0.1 }, { x: 0.1, y: 0.1 }),
        lineAsCubic({ x: 0.1, y: 0.1 }, { x: -0.1, y: 0.1 }),
        lineAsCubic({ x: -0.1, y: 0.1 }, { x: -0.1, y: -0.1 }),
      ],
      start: { x: -0.1, y: -0.1 },
    },
  ],
} as const;

function exactTextRanges(source: string) {
  const ranges: { sourceEndByte: number; sourceStartByte: number }[] = [];
  let byteOffset = 0;
  for (const character of source) {
    const start = byteOffset;
    byteOffset += encoder.encode(character).byteLength;
    if (!/\s/u.test(character)) ranges.push({ sourceEndByte: byteOffset, sourceStartByte: start });
  }
  return ranges;
}

function responseForCase(fixture: EvidenceCase): SegmentedTexOutlineResponseV1 {
  const sourceByteLength = encoder.encode(fixture.request.source).byteLength;
  const exactRanges = exactTextRanges(fixture.request.source);
  return segmentedTexOutlineResponseV1Schema.parse({
    result: {
      bounds: fixture.expected.bounds,
      contentDigest: fixture.expected.contentDigest,
      fontDigest: fixture.expected.fontDigest,
      fragments: fixture.expected.fragmentKinds.map((kind, order) => {
        const id = `fragment-${order.toString().padStart(4, "0")}`;
        return {
          bounds: { bottom: -0.1, left: -0.1, right: 0.1, top: 0.1 },
          fillEntityId: `${id}:fill`,
          fillRule: "nonzero",
          id,
          kind,
          order,
          outlineEntityId: `${id}:outline`,
          paint: fixture.expected.paintedFragmentOrders.includes(order) ? YELLOW : WHITE,
          path: compactPath,
          sourceCorrelation:
            fixture.request.mode === "tex-text"
              ? { kind: "exact-byte-range", ...exactRanges[order] }
              : { kind: "expression-byte-range", sourceEndByte: sourceByteLength, sourceStartByte: 0 },
        };
      }),
      kind: "compiled",
      mode: fixture.request.mode,
      paintSpans: fixture.expected.paintSpans,
      source: fixture.request.source,
      toolchainDigest: fixture.expected.toolchainDigest,
      writePlan: {
        fragmentLagRatio: Math.min(4 / fixture.expected.fragmentCount, 0.2),
        outlineStrokeWidth: 2,
        phaseBoundary: 0.5,
        representation: "separate-outline-and-fill-entities",
      },
    },
    schema: "poietra.segmented-tex-outline-response",
    version: 1,
  });
}

describe("segmented Tex/MathTex outline V1", () => {
  it("validates both official contracts and agrees with Rust phase evidence", () => {
    expect(evidence.schema).toBe("poietra.segmented-tex-outline-evidence");
    expect(evidence.version).toBe(1);
    expect(evidence.cases).toHaveLength(2);
    for (const fixture of evidence.cases) {
      const response = responseForCase(fixture);
      if (response.result.kind !== "compiled") throw new Error(`${fixture.id} must compile`);
      expect(response.result.fragments.length * 2).toBe(fixture.expected.entityCount);
      for (const sample of fixture.phaseSamples) {
        expect(evaluateSegmentedTexWriteV1(response.result, sample.progress)[sample.fragmentOrder]).toEqual(
          sample.expected,
        );
      }
    }
  });

  it("rejects reordered identities, paint drift, and false macro byte correlation", () => {
    const text = structuredClone(responseForCase(evidence.cases[0]!));
    if (text.result.kind !== "compiled") throw new Error("text fixture must compile");
    text.result.fragments[0]!.id = "fragment-0001";
    expect(segmentedTexOutlineResponseV1Schema.safeParse(text).success).toBe(false);

    const paint = structuredClone(responseForCase(evidence.cases[0]!));
    if (paint.result.kind !== "compiled") throw new Error("text fixture must compile");
    paint.result.fragments[11]!.paint = WHITE;
    expect(segmentedTexOutlineResponseV1Schema.safeParse(paint).success).toBe(false);

    const math = structuredClone(responseForCase(evidence.cases[1]!));
    if (math.result.kind !== "compiled") throw new Error("math fixture must compile");
    math.result.fragments[0]!.sourceCorrelation = {
      kind: "exact-byte-range",
      sourceEndByte: 4,
      sourceStartByte: 0,
    };
    expect(segmentedTexOutlineResponseV1Schema.safeParse(math).success).toBe(false);

    const utf8 = structuredClone(responseForCase(evidence.cases[0]!));
    if (utf8.result.kind !== "compiled") throw new Error("text fixture must compile");
    utf8.result.source = `🙂${utf8.result.source}`;
    expect(segmentedTexOutlineResponseV1Schema.safeParse(utf8).success).toBe(false);

    const zeroWidth = structuredClone(responseForCase(evidence.cases[0]!));
    if (zeroWidth.result.kind !== "compiled") throw new Error("text fixture must compile");
    Object.assign(zeroWidth.result.writePlan, { outlineStrokeWidth: 0 });
    expect(segmentedTexOutlineResponseV1Schema.safeParse(zeroWidth).success).toBe(false);
  });

  it("rejects duplicate, omitted, and wrong Tex glyph byte ranges", () => {
    const duplicate = structuredClone(responseForCase(evidence.cases[0]!));
    if (duplicate.result.kind !== "compiled") throw new Error("text fixture must compile");
    duplicate.result.fragments[1]!.sourceCorrelation = structuredClone(
      duplicate.result.fragments[0]!.sourceCorrelation,
    );
    expect(segmentedTexOutlineResponseV1Schema.safeParse(duplicate).success).toBe(false);

    const omitted = structuredClone(responseForCase(evidence.cases[0]!));
    if (omitted.result.kind !== "compiled") throw new Error("text fixture must compile");
    omitted.result.fragments.pop();
    expect(segmentedTexOutlineResponseV1Schema.safeParse(omitted).success).toBe(false);

    const wrong = structuredClone(responseForCase(evidence.cases[0]!));
    if (wrong.result.kind !== "compiled") throw new Error("text fixture must compile");
    wrong.result.fragments[0]!.sourceCorrelation = structuredClone(wrong.result.fragments[1]!.sourceCorrelation);
    expect(segmentedTexOutlineResponseV1Schema.safeParse(wrong).success).toBe(false);
  });

  it("keeps the sibling ABI handshake independent and parses bounded wire responses", async () => {
    const candidate = {
      compileSegmentedTexOutlineV1: (bytes: Uint8Array) => bytes,
      default: async () => undefined,
      poietraSegmentedTexOutlineAbiVersion: () => 1,
    };
    await expect(initializePoietraSegmentedTexOutlineBindingsV1(candidate)).resolves.toBe(candidate);
    await expect(
      initializePoietraSegmentedTexOutlineBindingsV1({ ...candidate, poietraSegmentedTexOutlineAbiVersion: () => 2 }),
    ).rejects.toThrow("ABI version 1");

    const response = responseForCase(evidence.cases[0]!);
    expect(parseSegmentedTexOutlineResponseV1(encoder.encode(JSON.stringify(response)))).toEqual(response);
    expect(() => parseSegmentedTexOutlineResponseV1(encoder.encode("not json"))).toThrow("malformed UTF-8 JSON");
  });
});
