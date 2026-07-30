from manim import ImageMobject, RESAMPLING_ALGORITHMS, Scene


class RealImageScene(Scene):
    def construct(self):
        image = ImageMobject("image.png", resampling_algorithm=RESAMPLING_ALGORITHMS["nearest"])
        self.add(image)
        # poietra:anchor 0.000
        self.wait(1)
