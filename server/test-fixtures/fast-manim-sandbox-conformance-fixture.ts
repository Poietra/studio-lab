export const FAST_MANIM_SANDBOX_CONFORMANCE_LEAK_SENTINELS_V1 = Object.freeze([
  "POIETRA_SNAPSHOT_CONFORMANCE_SOURCE_SECRET",
  "/home/poietra-private/snapshot-source.py",
] as const);

const sourceSentinelComment = `# ${FAST_MANIM_SANDBOX_CONFORMANCE_LEAK_SENTINELS_V1.join(" ")}`;

export const FAST_MANIM_SANDBOX_CONFORMANCE_CASES_V1 = Object.freeze({
  supported: Object.freeze({
    expectedKind: "compiled" as const,
    sceneName: "GatedStaticScene",
    sourcePath: "supported.py",
    sourceText: `from manim import Circle, Line, Rectangle, Scene

${sourceSentinelComment}
class GatedStaticScene(Scene):
    def construct(self):
        circle = Circle().set_fill("#ef4444", opacity=1.0).set_stroke(width=0)
        rectangle = Rectangle().set_fill("#22c55e", opacity=1.0).set_stroke(width=0)
        line = Line([-2.0, -1.0, 0.0], [2.0, 1.0, 0.0]).set_stroke("#3b82f6", width=4)
        self.add(circle, rectangle, line)
`,
  }),
  unsupported: Object.freeze({
    expectedKind: "unsupported" as const,
    sceneName: "GatedUnsupportedScene",
    sourcePath: "unsupported.py",
    sourceText: `from manim import Circle, Scene

${sourceSentinelComment}
class GatedUnsupportedScene(Scene):
    def construct(self):
        circle = Circle().set_fill("#ef4444", opacity=1.0).set_stroke(width=0)
        self.add(circle)
        self.wait(1)
`,
  }),
});
