from manim import MathTex, Scene, TransformMatchingTex, smoothstep


class RealMathTexMorphScene(Scene):
    def construct(self):
        equation = MathTex("E = mc^2")
        self.add(equation)
        self.wait(1, frozen_frame=True)
        maxwell = MathTex(r"\nabla \cdot \mathbf{E} = \frac{\rho}{\varepsilon_0}")
        maxwell.move_to(equation.get_center())
        self.play(
            TransformMatchingTex(equation, maxwell, transform_mismatches=True),
            run_time=1,
            rate_func=smoothstep,
        )
        equation = maxwell
        self.wait(0.5, frozen_frame=True)
        restored = MathTex("E = mc^2")
        restored.move_to(maxwell.get_center())
        self.play(
            TransformMatchingTex(maxwell, restored, transform_mismatches=True),
            run_time=2,
            rate_func=smoothstep,
        )
        maxwell = restored
        equation = restored
        self.wait(1, frozen_frame=True)
