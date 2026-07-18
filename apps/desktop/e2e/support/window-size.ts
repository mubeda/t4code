export interface DesktopUiWindowSize {
  readonly width: number;
  readonly height: number;
}

export function scaleDesktopUiWindowSize(
  size: DesktopUiWindowSize,
  devicePixelRatio: number,
): DesktopUiWindowSize {
  const scale = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return {
    width: Math.ceil(size.width * scale),
    height: Math.ceil(size.height * scale),
  };
}
