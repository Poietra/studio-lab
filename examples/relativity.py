from manim import *


class GroupedEquation(Scene):
    def construct(self):
        equation = MathTex("E", "=", "m", "c^2")
        label = Text("energy").next_to(equation, DOWN)
        arrow = Arrow(label.get_top(), equation.get_bottom())
        proof_box = SurroundingRectangle(equation)

        self.play(FadeIn(equation), FadeIn(label), run_time=2)
        self.play(Create(arrow), Create(proof_box), run_time=2)
        self.play(equation.animate.shift(RIGHT), run_time=3, rate_func=smooth)

        # poietra:anchor 7.000
        self.wait(2.5)
        self.play(FadeOut(arrow), FadeOut(label), run_time=1)
        self.play(FadeOut(proof_box), run_time=1)
        self.wait(0.5)
