import { defaultEntityContent, type StudioEntityInput } from "./authoring-commands";

export const STUDIO_STARTER_COMPOSITION_TITLE = "Hello, Poietra";

/** One editable title card built entirely from the existing creation command. */
export function studioStarterCompositionEntities(): readonly StudioEntityInput[] {
  return [
    {
      content: defaultEntityContent("Rectangle", ""),
      dimensions: { height: 3, width: 8 },
      position: { x: 320, y: 180 },
      type: "Rectangle",
    },
    {
      content: defaultEntityContent("Text", STUDIO_STARTER_COMPOSITION_TITLE),
      position: { x: 320, y: 180 },
      type: "Text",
    },
  ];
}
