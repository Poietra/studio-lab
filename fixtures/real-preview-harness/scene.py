from manim import *


class RealPreviewScene(Scene):
    def construct(self):
        circle = Circle(radius=1.25).set_fill(RED, opacity=1).set_stroke(width=0)
        circle.shift(3 * LEFT)
        rectangle = Rectangle(width=2.5, height=1.5).set_fill(BLUE, opacity=1).set_stroke(width=0)
        rectangle.shift(2 * RIGHT)
        line = Line(4 * LEFT + 2 * UP, 4 * RIGHT + 2 * UP).set_stroke(GREEN, width=80)
        self.add(circle, rectangle, line)
        # poietra:anchor 0.000
