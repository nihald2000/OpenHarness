export interface FrameRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Map pointer coordinates through an object-fit:contain frame, excluding its letterbox bars. */
export function mapFramePointToViewport(
  clientX: number,
  clientY: number,
  rect: FrameRect,
  targetWidth: number,
  targetHeight: number,
): { x: number; y: number } | null {
  if (
    !Number.isFinite(rect.width) || !Number.isFinite(rect.height) ||
    rect.width <= 0 || rect.height <= 0 || targetWidth <= 0 || targetHeight <= 0
  ) return null;

  const bitmapAspect = targetWidth / targetHeight;
  const boxAspect = rect.width / rect.height;
  let renderWidth = rect.width;
  let renderHeight = rect.height;
  let offsetX = 0;
  let offsetY = 0;
  if (boxAspect > bitmapAspect) {
    renderWidth = rect.height * bitmapAspect;
    offsetX = (rect.width - renderWidth) / 2;
  } else if (boxAspect < bitmapAspect) {
    renderHeight = rect.width / bitmapAspect;
    offsetY = (rect.height - renderHeight) / 2;
  }

  const relativeX = clientX - rect.left - offsetX;
  const relativeY = clientY - rect.top - offsetY;
  if (relativeX < 0 || relativeY < 0 || relativeX > renderWidth || relativeY > renderHeight) return null;

  return {
    x: Math.max(0, Math.min(targetWidth - 1, Math.round((relativeX / renderWidth) * targetWidth))),
    y: Math.max(0, Math.min(targetHeight - 1, Math.round((relativeY / renderHeight) * targetHeight))),
  };
}
