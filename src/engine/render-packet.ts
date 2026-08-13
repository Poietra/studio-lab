import { z } from "zod";

const MAX_VIEWPORT_PIXELS = 33_554_432;

export const renderViewportV1Schema = z
  .object({
    heightPx: z.number().int().positive().max(16_384),
    widthPx: z.number().int().positive().max(16_384),
  })
  .strict()
  .refine((viewport) => viewport.widthPx * viewport.heightPx <= MAX_VIEWPORT_PIXELS, {
    message: `A viewport may contain at most ${MAX_VIEWPORT_PIXELS} pixels.`,
  });
