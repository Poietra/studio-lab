from manim import *


class DynamicMotionPathScene(Scene):
    def construct(self):
        sentinel = Circle(radius=0.35).set_fill(WHITE, opacity=1).set_stroke(width=0).shift([-5, 3, 0])
        curve = CubicBezier([-4, -1, 0], [-3, 2.5, 0], [-1, -2, 0], [0.5, 1, 0])
        rectangle = Rectangle(width=0.3, height=0.2).set_fill(BLUE, opacity=1).set_stroke(width=0).shift([-4, -1, 0])
        orbit = Circle(radius=0.8).stretch(1.5, 0).shift([3, 0, 0])
        circle = Circle(radius=0.3).set_fill(RED, opacity=1).set_stroke(width=0).shift([4.2, 0, 0])

        self.add(sentinel, rectangle)
        self.play(MoveAlongPath(rectangle, curve, rate_func=linear), run_time=1)
        self.add(circle)
        self.play(MoveAlongPath(circle, orbit, rate_func=linear), run_time=1)
        self.wait(1, frozen_frame=True)
