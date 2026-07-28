from manim import *


class UnsupportedPreviewScene(Scene):
    def construct(self):
        circle = Circle(radius=1).set_fill(YELLOW, opacity=1).set_stroke(width=0)
        self.add(circle)
        self.wait(1)
