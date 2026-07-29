from manim import *


class DynamicOpacityLifetimeScene(Scene):
    def construct(self):
        circle = Circle(radius=1.25).set_fill(RED, opacity=1).set_stroke(width=0)
        self.wait(1, frozen_frame=True)
        self.play(FadeIn(circle, rate_func=linear), run_time=2)
        self.wait(1, frozen_frame=True)
        self.play(FadeOut(circle, rate_func=linear), run_time=2)
        self.wait(1, frozen_frame=True)
