from manim import *


class SmokeScene(Scene):
    def construct(self):
        circle = Circle(radius=0.5)
        self.add(circle)
        self.wait(0.2)

        # poietra:anchor 0.200
        self.wait(0.5)
