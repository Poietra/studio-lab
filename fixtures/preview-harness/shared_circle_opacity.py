from manim import *


class SharedCircleOpacity(Scene):
    def construct(self):
        earlier = Circle(radius=1).set_fill(RED, opacity=1).set_stroke(width=0)
        # Keep this runtime transform intentionally opaque to the static importer.
        getattr(earlier, "shift")(LEFT)
        earlier.set_opacity(0)
        later = Circle(radius=0.5).set_fill(BLUE, opacity=1).set_stroke(width=0)
        later.shift(RIGHT)
        stroke = Line(4 * LEFT + 2 * UP, 2 * LEFT + 2 * UP).set_stroke(GREEN, width=100, opacity=0.5)
        self.add(earlier, later, stroke)
        # poietra:anchor 0.000
        self.play(earlier.animate.set_opacity(1), run_time=2)
