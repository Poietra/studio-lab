from manim import *


class FailedPreviewScene(Scene):
    def construct(self):
        circle = Circle(radius=1).set_fill(PURPLE, opacity=1).set_stroke(width=0)
        self.add(circle)
        raise BaseException
