import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it } from "vitest";

import { EquationContent } from "./prototype-rendering";

describe("EquationContent", () => {
  it("renders semantic MathTex parts with KaTeX", () => {
    const markup = renderToStaticMarkup(
      <EquationContent lines={["F = ma"]} texParts={["F", "=", "m", "a"]} />,
    );

    expect(markup).toContain("data-rendered-math");
    expect(markup).toContain('class="katex"');
    expect(markup).toContain("<math");
  });

  it("renders each Maxwell equation even when displayLines contain literal TeX", () => {
    const texParts = [
      String.raw`\nabla \cdot \mathbf{E} = \frac{\rho}{\varepsilon_0}`,
      String.raw`\nabla \cdot \mathbf{B} = 0`,
      String.raw`\nabla \times \mathbf{E} = -\frac{\partial \mathbf{B}}{\partial t}`,
      String.raw`\nabla \times \mathbf{B} = \mu_0\mathbf{J} + \mu_0\varepsilon_0\frac{\partial \mathbf{E}}{\partial t}`,
    ];
    const markup = renderToStaticMarkup(
      <EquationContent lines={texParts} texParts={texParts} />,
    );

    expect(markup.match(/data-rendered-math/g)).toHaveLength(4);
    expect(markup).toContain("<mfrac>");
  });

  it("falls back to escaped display text when MathTex cannot be parsed", () => {
    const markup = renderToStaticMarkup(
      <EquationContent lines={["safe < fallback"]} texParts={[String.raw`\notARealCommand{`]} />,
    );

    expect(markup).not.toContain("data-rendered-math");
    expect(markup).toContain("safe &lt; fallback");
  });
});
