from manim import BLUE, YELLOW, Circle, Create, CubicBezier, MathTex, MoveAlongPath, Scene, linear


class MixedMathDemo(Scene):
    def construct(self):
        equation = MathTex(r"E = mc^2")
        ring = (
            Circle(radius=1.2)
            .set_fill(opacity=0)
            .set_stroke(BLUE, width=24)
            .shift([-3, 0, 0])
        )
        particle = (
            Circle(radius=0.2)
            .set_fill(YELLOW, opacity=1)
            .set_stroke(width=0)
            .move_to([1, -1, 0])
        )
        path = CubicBezier([1, -1, 0], [2, 2, 0], [3, -2, 0], [4, 1, 0])

        self.add(equation)
        self.play(Create(ring, rate_func=linear), run_time=1)
        self.play(MoveAlongPath(particle, path, rate_func=linear), run_time=2)
        self.wait(1, frozen_frame=True)
