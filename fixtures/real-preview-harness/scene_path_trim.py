from manim import *


class DynamicPathTrimScene(Scene):
    def construct(self):
        sentinel = Circle(radius=0.35).set_fill(WHITE, opacity=1).set_stroke(width=0).shift([-5, 3, 0])
        circle = Circle(radius=0.75).set_fill(opacity=0).set_stroke(RED, width=40).shift([-3, 0, 0])
        rectangle = Rectangle(width=1.5, height=1).set_fill(opacity=0).set_stroke(BLUE, width=40).shift([-1, 0, 0])
        line = Line([1, -0.5, 0], [3, 0.5, 0]).set_stroke(GREEN, width=40)
        immediate_circle = Circle(radius=0.65).set_fill(opacity=0).set_stroke(YELLOW, width=40).shift([4, 0, 0])
        self.add(sentinel)
        self.play(Create(circle, rate_func=linear), run_time=1)
        self.add(rectangle)
        self.play(Uncreate(rectangle, rate_func=linear), run_time=1)
        self.play(Create(line, rate_func=linear), run_time=1)
        self.wait(1, frozen_frame=True)
        self.play(Uncreate(line, rate_func=linear), run_time=1)
        self.play(Create(immediate_circle, rate_func=linear), run_time=1)
        self.play(Uncreate(immediate_circle, rate_func=linear), run_time=1)
        self.wait(1, frozen_frame=True)
