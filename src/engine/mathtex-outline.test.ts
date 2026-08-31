import { describe, expect, it, vi } from "vitest";

import {
  canonicalTextOutlineInputV1,
  createSegmentedTexOutlineCompilerV1,
  initializePoietraMathTexOutlineBindingsV1,
  POIETRA_SEGMENTED_TEX_OUTLINE_ABI_VERSION,
  POIETRA_TEXT_OUTLINE_ABI_VERSION,
  segmentedTexOutlineRequestV1Schema,
  textOutlineLayoutV1Schema,
  textOutlineRequestV1Schema,
  textOutlineResponseV1Schema,
} from "./mathtex-outline";

function candidate(initialize: (input?: unknown) => Promise<unknown>) {
  return {
    compileMathTexOutlineV1: () => new Uint8Array(),
    default: initialize,
    poietraMathTexOutlineAbiVersion: () => 1,
  };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function compiledSegmentedResponse() {
  return {
    result: {
      bounds: { bottom: -0.5, left: -0.5, right: 0.5, top: 0.5 },
      contentDigest: "a".repeat(64),
      fontDigest: "b".repeat(64),
      fragments: [
        {
          bounds: { bottom: -0.5, left: -0.5, right: 0.5, top: 0.5 },
          fillEntityId: "fragment-0000:fill",
          fillRule: "nonzero",
          id: "fragment-0000",
          kind: "glyph",
          order: 0,
          outlineEntityId: "fragment-0000:outline",
          paint: { alpha: 1, blue: 1, green: 1, red: 1 },
          path: {
            subpaths: [
              {
                closed: true,
                segments: [
                  {
                    control1: { x: -0.5, y: 0.5 },
                    control2: { x: 0.5, y: 0.5 },
                    end: { x: -0.5, y: -0.5 },
                  },
                ],
                start: { x: -0.5, y: -0.5 },
              },
            ],
          },
          sourceCorrelation: { kind: "expression-byte-range", sourceEndByte: 1, sourceStartByte: 0 },
        },
      ],
      kind: "compiled",
      mode: "mathtex-math",
      paintSpans: [],
      source: "x",
      toolchainDigest: "c".repeat(64),
      writePlan: {
        fragmentLagRatio: 0.2,
        outlineStrokeWidth: 2,
        phaseBoundary: 0.5,
        representation: "separate-outline-and-fill-entities",
      },
    },
    schema: "poietra.segmented-tex-outline-response",
    version: 1,
  } as const;
}

describe("MathTex outline WASM initialization", () => {
  it("uses the generated module's browser initializer without an explicit asset", async () => {
    const initialize = vi.fn(async () => undefined);

    await initializePoietraMathTexOutlineBindingsV1(candidate(initialize));

    expect(initialize).toHaveBeenCalledOnce();
    expect(initialize).toHaveBeenCalledWith();
  });

  it("passes Node-loaded WASM bytes to the generated initializer", async () => {
    const initialize = vi.fn(async () => undefined);
    const input = { module_or_path: new Uint8Array([0, 97, 115, 109]) };

    await initializePoietraMathTexOutlineBindingsV1(candidate(initialize), input);

    expect(initialize).toHaveBeenCalledWith(input);
  });
});

describe("segmented Tex outline browser adapter", () => {
  it("pins and sends the existing segmented V1 request to the generated binding", async () => {
    const requests: unknown[] = [];
    const compile = createSegmentedTexOutlineCompilerV1(async () => ({
      compileSegmentedTexOutlineV1: (requestJson) => {
        requests.push(JSON.parse(decoder.decode(requestJson)));
        return encoder.encode(JSON.stringify(compiledSegmentedResponse()));
      },
      poietraSegmentedTexOutlineAbiVersion: () => POIETRA_SEGMENTED_TEX_OUTLINE_ABI_VERSION,
    }));

    await expect(
      compile({ mode: "mathtex-math", paintMatches: [], source: "x", sourceKind: "literal" }),
    ).resolves.toEqual(compiledSegmentedResponse());
    expect(requests).toEqual([
      {
        mode: "mathtex-math",
        paintMatches: [],
        schema: "poietra.segmented-tex-outline-request",
        source: "x",
        sourceKind: "literal",
        version: 1,
      },
    ]);
  });

  it("preserves structured unsupported results from the segmented compiler", async () => {
    const response = {
      result: {
        code: "dynamic-source-unsupported",
        kind: "unsupported",
        message: "Dynamic Tex source cannot be correlated to deterministic fragments",
      },
      schema: "poietra.segmented-tex-outline-response",
      version: 1,
    } as const;
    const compile = createSegmentedTexOutlineCompilerV1(async () => ({
      compileSegmentedTexOutlineV1: () => encoder.encode(JSON.stringify(response)),
      poietraSegmentedTexOutlineAbiVersion: () => 1,
    }));

    await expect(
      compile({ mode: "tex-text", paintMatches: [], source: "dynamic()", sourceKind: "dynamic" }),
    ).resolves.toEqual(response);
  });

  it("rejects a missing sibling ABI and malformed compiled artifacts", async () => {
    const wrongAbi = createSegmentedTexOutlineCompilerV1(async () => ({
      compileSegmentedTexOutlineV1: () => encoder.encode(JSON.stringify(compiledSegmentedResponse())),
      poietraSegmentedTexOutlineAbiVersion: () => 2,
    }));
    await expect(
      wrongAbi({ mode: "mathtex-math", paintMatches: [], source: "x", sourceKind: "literal" }),
    ).rejects.toThrow("does not implement ABI version 1");

    const validResponse = compiledSegmentedResponse();
    const malformed = {
      ...validResponse,
      result: {
        ...validResponse.result,
        fragments: [{ ...validResponse.result.fragments[0], fillEntityId: "wrong:fill" }],
      },
    };
    const malformedCompiler = createSegmentedTexOutlineCompilerV1(async () => ({
      compileSegmentedTexOutlineV1: () => encoder.encode(JSON.stringify(malformed)),
      poietraSegmentedTexOutlineAbiVersion: () => 1,
    }));
    await expect(
      malformedCompiler({ mode: "mathtex-math", paintMatches: [], source: "x", sourceKind: "literal" }),
    ).rejects.toThrow("violated the v1 response contract");
  });

  it("uses UTF-8 byte bounds and rejects unknown request fields", () => {
    const baseRequest = {
      mode: "tex-text",
      paintMatches: [],
      schema: "poietra.segmented-tex-outline-request",
      sourceKind: "literal",
      version: 1,
    } as const;

    expect(segmentedTexOutlineRequestV1Schema.safeParse({ ...baseRequest, source: "é".repeat(128) }).success).toBe(
      true,
    );
    expect(segmentedTexOutlineRequestV1Schema.safeParse({ ...baseRequest, source: "é".repeat(129) }).success).toBe(
      false,
    );
    expect(
      segmentedTexOutlineRequestV1Schema.safeParse({ ...baseRequest, source: "x", unsupportedOption: true }).success,
    ).toBe(false);
  });
});

describe("plain Text outline input", () => {
  it("pins the closed font-family and weight request ABI", () => {
    expect(POIETRA_TEXT_OUTLINE_ABI_VERSION).toBe(9);
  });

  it("accepts only a positive finite optional wrap width", () => {
    const legacy = {
      alignment: "left",
      fontFamily: "sans",
      fontWeight: "regular",
      lineHeight: 1.2,
    };
    expect(textOutlineLayoutV1Schema.parse(legacy)).toEqual(legacy);
    expect(textOutlineLayoutV1Schema.parse({ ...legacy, wrapWidthEm: 4 })).toEqual({
      ...legacy,
      wrapWidthEm: 4,
    });
    for (const wrapWidthEm of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(textOutlineLayoutV1Schema.safeParse({ ...legacy, wrapWidthEm }).success).toBe(false);
    }
  });

  it("defers wrapped line length to Rust while preserving the legacy line limit", () => {
    const request = {
      layout: { alignment: "left", lineHeight: 1.2 },
      schema: "poietra.text-outline-request",
      text: "a".repeat(129),
      version: 1,
    };
    expect(textOutlineRequestV1Schema.safeParse(request).success).toBe(false);
    expect(
      textOutlineRequestV1Schema.safeParse({
        ...request,
        layout: { ...request.layout, wrapWidthEm: 20 },
      }).success,
    ).toBe(true);
  });

  it("accepts bounded Japanese multiline text and canonicalizes line endings and Unicode", () => {
    expect(canonicalTextOutlineInputV1("日本語で動画を作る\r\nこんにちは")).toBe("日本語で動画を作る\nこんにちは");
    expect(canonicalTextOutlineInputV1("Cafe\u0301")).toBe("Caf\u00e9");
    expect(canonicalTextOutlineInputV1("supplementary: 🚀")).toBe("supplementary: 🚀");
  });

  it("requires ordered glyph fragments to exactly partition the aggregate path", () => {
    const subpath = {
      closed: true as const,
      segments: [
        {
          control1: { x: -0.5, y: 0.5 },
          control2: { x: 0.5, y: 0.5 },
          end: { x: -0.5, y: -0.5 },
        },
      ],
      start: { x: -0.5, y: -0.5 },
    };
    const response = {
      result: {
        bounds: { bottom: -0.5, left: -0.5, right: 0.5, top: 0.5 },
        fillRule: "nonzero" as const,
        fragments: [
          { order: 0, path: { subpaths: [subpath] }, sourceCorrelation: { key: "A", kind: "nfc-scalar" as const } },
        ],
        kind: "compiled" as const,
        path: { subpaths: [subpath] },
      },
      schema: "poietra.text-outline-response" as const,
      version: 1 as const,
    };

    expect(textOutlineResponseV1Schema.safeParse(response).success).toBe(true);
    const wrappedSubpath = {
      ...subpath,
      segments: subpath.segments.map((segment) => ({
        control1: { x: segment.control1.x, y: segment.control1.y * 2 },
        control2: { x: segment.control2.x, y: segment.control2.y * 2 },
        end: { x: segment.end.x, y: segment.end.y * 2 },
      })),
      start: { x: subpath.start.x, y: subpath.start.y * 2 },
    };
    const wrappedResponse = {
      ...response,
      result: {
        ...response.result,
        bounds: { bottom: -1, left: -0.5, right: 0.5, top: 1 },
        fragments: [{ ...response.result.fragments[0], path: { subpaths: [wrappedSubpath] } }],
        path: { subpaths: [wrappedSubpath] },
      },
    };
    expect(textOutlineResponseV1Schema.parse(wrappedResponse)).toEqual(wrappedResponse);
    expect(
      textOutlineResponseV1Schema.safeParse({
        ...wrappedResponse,
        result: { ...wrappedResponse.result, bounds: { bottom: -0.75, left: -0.5, right: 0.5, top: 1.25 } },
      }).success,
    ).toBe(false);
    expect(
      textOutlineResponseV1Schema.safeParse({
        ...response,
        result: {
          ...response.result,
          fragments: [{ order: 0, path: { subpaths: [subpath] } }],
        },
      }).success,
    ).toBe(false);
    expect(
      textOutlineResponseV1Schema.safeParse({
        ...response,
        result: {
          ...response.result,
          fragments: [{ order: 1, path: { subpaths: [subpath] }, sourceCorrelation: { key: "A", kind: "nfc-scalar" } }],
        },
      }).success,
    ).toBe(false);
    expect(
      textOutlineResponseV1Schema.safeParse({
        ...response,
        result: {
          ...response.result,
          fragments: [{ order: 0, path: { subpaths: [] }, sourceCorrelation: { key: "A", kind: "nfc-scalar" } }],
        },
      }).success,
    ).toBe(false);
    expect(
      textOutlineResponseV1Schema.safeParse({
        ...response,
        result: {
          ...response.result,
          fragments: [{ ...response.result.fragments[0], sourceCorrelation: { key: "e\u0301", kind: "nfc-scalar" } }],
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    "tab\tcharacter",
    ["a", "b", "c", "d", "e", "f", "g", "h", "i"].join("\n"),
    "a".repeat(129),
    String.fromCharCode(0xd800),
    String.fromCharCode(0xdc00),
  ])("rejects text outside the bounded multiline contract: %s", (text) =>
    expect(canonicalTextOutlineInputV1(text)).toBeNull(),
  );
});
