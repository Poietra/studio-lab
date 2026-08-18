import { z } from "zod";

const durationScaleSchema = z
  .object({
    brief: z.number().finite().positive(),
    deliberate: z.number().finite().positive(),
    standard: z.number().finite().positive(),
  })
  .strict();

export const styleProfileSchema = z
  .object({
    durationSeconds: durationScaleSchema,
    easing: z.literal("smooth"),
    id: z.string().min(1).max(80),
    version: z.literal(1),
  })
  .strict();

export const styleProfileRefSchema = styleProfileSchema.pick({ id: true, version: true });

export type StyleProfile = Readonly<
  Omit<z.infer<typeof styleProfileSchema>, "durationSeconds"> & {
    durationSeconds: Readonly<z.infer<typeof durationScaleSchema>>;
  }
>;

export type StyleProfileRef = Readonly<z.infer<typeof styleProfileRefSchema>>;

export const STUDIO_STYLE_PROFILE = {
  durationSeconds: {
    brief: 0.4,
    deliberate: 1.5,
    standard: 1,
  },
  easing: "smooth",
  id: "poietra-balanced",
  version: 1,
} as const satisfies StyleProfile;

export function styleProfileRef(profile: StyleProfile): StyleProfileRef {
  return { id: profile.id, version: profile.version };
}
