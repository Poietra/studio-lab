from manim import BLUE, GREEN, RED, CubicBezier, Polygon, Scene, Square


class GenericVmobjectScene(Scene):
    def construct(self):
        concave = Polygon(
            [-4, -1.25, 0],
            [-1.5, -1.25, 0],
            [-1.5, 1.25, 0],
            [-2.75, 0, 0],
            [-4, 1.25, 0],
        ).set_fill(BLUE, opacity=0.8).set_stroke(width=0)
        curve = CubicBezier(
            [-1, 0, 0],
            [-0.5, 2.25, 0],
            [0.5, -2.25, 0],
            [1, 0, 0],
        ).set_fill(opacity=0).set_stroke(GREEN, width=8)
        outlined = Square(side_length=2).move_to([3, 0, 0])
        outlined.set_fill(RED, opacity=0.5).set_stroke(BLUE, width=6)
        self.add(concave, curve, outlined)
