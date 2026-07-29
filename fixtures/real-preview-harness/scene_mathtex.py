from manim import MathTex, Scene


class RealMathTexScene(Scene):
    def construct(self):
        equation = MathTex("E = mc^2")
        self.add(equation)
