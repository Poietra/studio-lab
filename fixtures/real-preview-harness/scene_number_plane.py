from manim import NumberPlane, Scene


class StaticNumberPlane(Scene):
    def construct(self):
        grid = NumberPlane()
        self.add(grid)
        self.wait(2)
