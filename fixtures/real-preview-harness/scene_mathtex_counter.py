from manim import MathTex, Scene


class RealMathTexCounterScene(Scene):
    def construct(self):
        letter = MathTex("O")
        self.add(letter)
