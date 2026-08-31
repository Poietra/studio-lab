import type { FrameSnapBounds } from "./frame-alignment-snap";

export type TextWrapResizeDirection = "e" | "w";

export type TextWrapResizeGesture = Readonly<{
  direction: TextWrapResizeDirection;
  fromHeight: number;
  fromWidth: number;
  sceneUnitsPerClientPixel: number;
  startClientX: number;
}>;

const MINIMUM_POINTER_DELTA_PX = 0.5;

export function createTextWrapResizeGesture(
  input: Readonly<{
    cameraScale: number;
    configuredWidth?: number;
    direction: TextWrapResizeDirection;
    entityScale: number;
    frame: Readonly<{ height: number; width: number }>;
    preparedBounds: FrameSnapBounds;
    startClientX: number;
    surfaceWidth: number;
    viewport: Readonly<{ height: number; width: number }>;
  }>,
): TextWrapResizeGesture | null {
  const compositeScale = input.cameraScale * input.entityScale;
  const preparedWidth = input.preparedBounds.right - input.preparedBounds.left;
  const preparedHeight = input.preparedBounds.bottom - input.preparedBounds.top;
  const fromWidth =
    input.configuredWidth === undefined
      ? (preparedWidth / input.viewport.width / compositeScale) * input.frame.width
      : input.configuredWidth;
  if (
    !Number.isFinite(compositeScale) ||
    compositeScale <= 0 ||
    !Number.isFinite(input.frame.height) ||
    input.frame.height <= 0 ||
    !Number.isFinite(input.frame.width) ||
    input.frame.width <= 0 ||
    !Number.isFinite(preparedWidth) ||
    preparedWidth <= 0 ||
    !Number.isFinite(preparedHeight) ||
    preparedHeight <= 0 ||
    !Number.isFinite(fromWidth) ||
    fromWidth <= 0 ||
    !Number.isFinite(input.startClientX) ||
    !Number.isFinite(input.surfaceWidth) ||
    input.surfaceWidth <= 0 ||
    !Number.isFinite(input.viewport.height) ||
    input.viewport.height <= 0 ||
    !Number.isFinite(input.viewport.width) ||
    input.viewport.width <= 0
  )
    return null;

  return {
    direction: input.direction,
    fromHeight: (preparedHeight / input.viewport.height / compositeScale) * input.frame.height,
    fromWidth,
    sceneUnitsPerClientPixel: input.frame.width / input.surfaceWidth / compositeScale,
    startClientX: input.startClientX,
  };
}

/** Resolves a center-preserving Text box width. The renderer remains the sole
 * authority for line breaks and the resulting glyph bounds. */
export function resolveTextWrapWidth(gesture: TextWrapResizeGesture, clientX: number): number | null {
  if (!Number.isFinite(clientX)) return null;
  const clientDelta = clientX - gesture.startClientX;
  if (Math.abs(clientDelta) < MINIMUM_POINTER_DELTA_PX) return null;
  const direction = gesture.direction === "e" ? 1 : -1;
  const width = gesture.fromWidth + 2 * direction * clientDelta * gesture.sceneUnitsPerClientPixel;
  return Number.isFinite(width) && width > 0 ? width : null;
}
