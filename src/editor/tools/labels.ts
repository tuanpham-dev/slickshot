import type { ArrowStyle, CensorMode, SpotlightForm, TextAlign } from "../types";

/** Option lists shared by the editor's properties panel and the capture
 * overlay's settings dropdown. One copy so the same setting cannot end up
 * labelled two different ways depending on where you edit it. */

export const SPOTLIGHT_FORMS: { value: SpotlightForm; label: string }[] = [
  { value: "rect", label: "Rectangle" },
  { value: "ellipse", label: "Circle" },
];

export const ARROW_STYLES: { value: ArrowStyle; label: string }[] = [
  // Listed first because it is what the Line tool produces, and switching
  // away from it is how a line becomes an arrow.
  { value: "none", label: "No head (line)" },
  { value: "single", label: "Single head" },
  { value: "double", label: "Double-headed" },
  { value: "open", label: "Open head" },
  { value: "tail", label: "Fletched tail" },
];

export const TEXT_ALIGNMENTS: { value: TextAlign; label: string }[] = [
  { value: "left", label: "Left" },
  { value: "center", label: "Center" },
  { value: "right", label: "Right" },
];

export const CENSOR_MODES: { value: CensorMode; label: string }[] = [
  { value: "pixelate", label: "Pixels" },
  { value: "blur", label: "Blur" },
  { value: "solid", label: "Solid" },
];

/** Slider bounds shared by the editor's properties panel and the overlay's
 * settings dropdown. Both edit the same shapes, so a control that stops at 40
 * in one place and 60 in the other is the same setting disagreeing with
 * itself -- keeping the numbers here is what stops that happening again. */
export const RANGES = {
  strokeWidth: { min: 1, max: 20 },
  cornerRadius: { min: 0, max: 100 },
  fontSize: { min: 10, max: 72 },
  /** Pixel block, or blur radius when the censor is in blur mode. */
  censorAmount: { min: 4, max: 40 },
  /** Percent of full dim, stored on the shape as 0..1. */
  spotlightDim: { min: 10, max: 90 },
  markerSize: { min: 8, max: 40 },
  stampSize: { min: 12, max: 200 },
  loupeFactor: { min: 1.5, max: 4, step: 0.5 },
  /** Signed degrees, so the untouched default sits mid-track. */
  rotation: { min: -180, max: 180 },
} as const;
