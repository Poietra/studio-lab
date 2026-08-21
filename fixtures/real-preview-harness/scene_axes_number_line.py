from manim import Axes, NumberLine, Scene


class StaticAxes(Scene):
    def construct(self):
        axes = Axes()
        self.add(axes)
        self.wait(2)


class StaticNumberLine(Scene):
    def construct(self):
        number_line = NumberLine()
        self.add(number_line)
        self.wait(2)
