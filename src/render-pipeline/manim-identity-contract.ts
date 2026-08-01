import { z } from "zod";

export const MANIM_PROJECT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
export const MAX_MANIM_SCENE_NAME_LENGTH_V1 = 240;

export const manimProjectIdSchema = z
  .string()
  .regex(MANIM_PROJECT_ID_PATTERN, "Project ID must be an opaque lower-case identifier.");

export const manimSceneNameSchema = z
  .string()
  .max(MAX_MANIM_SCENE_NAME_LENGTH_V1, `Scene names accept at most ${MAX_MANIM_SCENE_NAME_LENGTH_V1} characters.`)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u, "Scene name must be a Python identifier.");

export function isManimSourcePath(value: string) {
  if (
    value.length === 0 ||
    value.length > 500 ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    !value.endsWith(".py")
  )
    return false;
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export const manimSourcePathSchema = z
  .string()
  .refine(isManimSourcePath, "Source path must be a normalized relative Python file path.");
