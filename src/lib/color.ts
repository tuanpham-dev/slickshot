export type ColorFormat = "hex" | "rgb" | "hsl";

export const COLOR_FORMATS: ColorFormat[] = ["hex", "rgb", "hsl"];

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

export function toRgbString({ r, g, b }: Rgb): string {
  return `rgb(${r}, ${g}, ${b})`;
}

export function toHslString({ r, g, b }: Rgb): string {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  const l = (max + min) / 2;

  let h = 0;
  if (delta !== 0) {
    if (max === rn) h = ((gn - bn) / delta) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;
  }
  h = Math.round(h * 60);
  if (h < 0) h += 360;

  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
  return `hsl(${h}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
}

export function formatColor(rgb: Rgb, format: ColorFormat): string {
  if (format === "rgb") return toRgbString(rgb);
  if (format === "hsl") return toHslString(rgb);
  return toHex(rgb);
}

/** Distance readout shared by the overlay's measure mode and the editor's
 * measure tool, so both report a measurement the same way. */
export function measurementLabel(
  start: { x: number; y: number },
  end: { x: number; y: number },
): string {
  const dx = Math.abs(Math.round(end.x - start.x));
  const dy = Math.abs(Math.round(end.y - start.y));
  return `${dx} × ${dy} (${Math.round(Math.hypot(dx, dy))} px)`;
}
