from manim import *


class DynamicPathMorphScene(Scene):
    def construct(self):
        sentinel = Circle(radius=0.35).set_fill(WHITE, opacity=1).set_stroke(width=0).shift([-5, 3, 0])
        shape = Circle(radius=0.8).set_fill(BLUE, opacity=1).set_stroke(width=0).shift([-1.5, 0, 0])
        warped = Circle(radius=0.8).set_fill(BLUE, opacity=1).set_stroke(width=0).set_points_as_corners([[-0.4, 0, 0], [-0.7, 0.7, 0], [-1.5, 1, 0], [-2.3, 0.7, 0], [-2.6, 0, 0], [-2.3, -0.7, 0], [-1.5, -1, 0], [-0.7, -0.7, 0], [-0.4, 0, 0]])
        restored = Circle(radius=0.8).set_fill(BLUE, opacity=1).set_stroke(width=0).shift([-1.5, 0, 0])
        line = Line([-2.1, -2, 0], [1.4, -3, 0]).set_stroke(RED, width=40)
        line_target = Line([-2.1, -2, 0], [1.4, -3, 0]).set_stroke(RED, width=40).stretch(1.3, 0).rotate(0.2).shift([0.1, -0.2, 0])
        self.add(sentinel, shape, line)
        self.play(Transform(shape, warped, rate_func=linear), run_time=1)
        self.wait(1, frozen_frame=True)
        self.play(Transform(shape, restored, rate_func=linear), run_time=1)
        self.play(Transform(line, line_target, rate_func=linear), run_time=1)
        self.wait(1, frozen_frame=True)
