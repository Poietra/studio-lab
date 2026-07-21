from manim import *


class GroupedEquation(Scene):
    def construct(self):
        equation = MathTex("E", "=", "m", "c^2")
        label = Text("energy").next_to(equation, DOWN)
        arrow = Arrow(label.get_top(), equation.get_bottom())
        proof_box = SurroundingRectangle(equation)

        self.play(FadeIn(equation), FadeIn(label), run_time=2)
        self.play(Create(arrow), Create(proof_box), run_time=2)
        self.play(equation.animate.shift(0.3333 * RIGHT), run_time=1, rate_func=smooth)

        # poietra:anchor 5.000
        self.play(equation.animate.shift(0.6667 * RIGHT), run_time=2, rate_func=smooth)

        # poietra:anchor 7.000
        self.wait(2.5)
        self.play(FadeOut(arrow), FadeOut(label), run_time=1)
        self.play(FadeOut(proof_box), run_time=1)
        self.wait(0.5)


class FieldSummary(Scene):
    def construct(self):
        title = Text("Electromagnetic field").to_edge(UP)
        field_equations = MathTex(
            r"\nabla \cdot \mathbf{E} = \frac{\rho}{\varepsilon_0}",
            r"\nabla \cdot \mathbf{B} = 0",
            r"\nabla \times \mathbf{E} = -\frac{\partial \mathbf{B}}{\partial t}",
            r"\nabla \times \mathbf{B} = \mu_0\mathbf{J} + \mu_0\varepsilon_0\frac{\partial \mathbf{E}}{\partial t}",
        ).scale(0.75)
        self.play(FadeIn(title), FadeIn(field_equations), run_time=1.5)
        self.wait(1.5)
