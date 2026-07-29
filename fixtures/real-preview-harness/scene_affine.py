from manim import *


class DynamicAffineScene(Scene):
    def construct(self):
        sentinel = Circle(radius=0.35).set_fill(WHITE, opacity=1).set_stroke(width=0).shift([-5, 3, 0])
        translation = Rectangle(width=0.8, height=0.5).set_fill(BLUE, opacity=1).set_stroke(width=0).shift([-5, -2, 0])
        rotation = Rectangle(width=1, height=0.4).set_fill(GREEN, opacity=1).set_stroke(width=0).shift([-3, -2, 0])
        scale = Circle(radius=0.35).set_fill(YELLOW, opacity=1).set_stroke(width=0).shift([-1, -2, 0])
        stretch = Circle(radius=0.35).set_fill(PURPLE, opacity=1).set_stroke(width=0).shift([1, -2, 0])
        shear = Rectangle(width=0.8, height=0.5).set_fill(ORANGE, opacity=1).set_stroke(width=0).shift([3, -2, 0])
        reflection = Rectangle(width=0.8, height=0.6).set_fill(RED, opacity=1).set_stroke(width=0).shift([2, 1, 0])
        self.add(sentinel, translation, rotation, scale, stretch, shear, reflection)
        self.play(translation.animate(rate_func=linear).shift([1, 0, 0]), run_time=1)
        self.play(rotation.animate(rate_func=linear).rotate(PI / 2, about_point=[-3, -2, 0]), run_time=1)
        self.play(scale.animate(rate_func=linear).scale(1.5, about_point=[-1, -2, 0]), run_time=1)
        self.play(stretch.animate(rate_func=linear).stretch(1.5, 1, about_point=[1, -2, 0]), run_time=1)
        self.play(shear.animate(rate_func=linear).apply_matrix([[1, 0.5], [0, 1]], about_point=[3, -2, 0]), run_time=1)
        self.play(reflection.animate(rate_func=linear).stretch(-1, 0, about_point=[3, 1, 0]), run_time=1)
        self.wait(1, frozen_frame=True)
