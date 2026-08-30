import type { Adjustments } from "../types";

export const IDENTITY_ADJUSTMENTS: Adjustments = {
  brightness: 100,
  contrast: 100,
  saturation: 100,
  sharpness: 0,
  invert: false,
  preset: "original",
};

/** Named looks, expressed as the same parameters the sliders drive plus the
 * two filter terms (grayscale, sepia) that have no slider of their own. */
export interface AdjustPreset {
  id: string;
  label: string;
  values: Omit<Adjustments, "preset">;
  /** Extra `ctx.filter` terms this preset contributes. */
  extraFilter?: string;
}

export const ADJUST_PRESETS: AdjustPreset[] = [
  {
    id: "original",
    label: "Original",
    values: { brightness: 100, contrast: 100, saturation: 100, sharpness: 0, invert: false },
  },
  {
    id: "noir",
    label: "Noir",
    values: { brightness: 96, contrast: 145, saturation: 0, sharpness: 0, invert: false },
    extraFilter: "grayscale(1)",
  },
  {
    id: "mono",
    label: "Mono",
    values: { brightness: 100, contrast: 100, saturation: 0, sharpness: 0, invert: false },
    extraFilter: "grayscale(1)",
  },
  {
    id: "sepia",
    label: "Sepia",
    values: { brightness: 104, contrast: 105, saturation: 100, sharpness: 0, invert: false },
    extraFilter: "sepia(0.75)",
  },
  {
    id: "fade",
    label: "Fade",
    values: { brightness: 106, contrast: 84, saturation: 78, sharpness: 0, invert: false },
  },
  {
    id: "vivid",
    label: "Vivid",
    values: { brightness: 100, contrast: 118, saturation: 145, sharpness: 0, invert: false },
  },
];

export function presetById(id: string): AdjustPreset | undefined {
  return ADJUST_PRESETS.find((p) => p.id === id);
}

/** True when the adjustments would leave the image byte-for-byte unchanged,
 * so callers can skip the whole pipeline and keep using the base canvas. */
export function isIdentity(a: Adjustments): boolean {
  const extra = presetById(a.preset ?? "original")?.extraFilter;
  return (
    a.brightness === 100 &&
    a.contrast === 100 &&
    a.saturation === 100 &&
    a.sharpness === 0 &&
    !a.invert &&
    !extra
  );
}

/** The `ctx.filter` string for everything except sharpness, which has no CSS
 * filter equivalent and runs as a convolution afterwards. */
export function filterString(a: Adjustments): string {
  const parts: string[] = [];
  if (a.brightness !== 100) parts.push(`brightness(${a.brightness / 100})`);
  if (a.contrast !== 100) parts.push(`contrast(${a.contrast / 100})`);
  if (a.saturation !== 100) parts.push(`saturate(${a.saturation / 100})`);
  if (a.invert) parts.push("invert(1)");
  const extra = presetById(a.preset ?? "original")?.extraFilter;
  if (extra) parts.push(extra);
  return parts.length > 0 ? parts.join(" ") : "none";
}

/** Whether this webview actually *applies* `ctx.filter` during `drawImage`.
 *
 * Probed by filtering a known pixel and reading the result back, rather than
 * by checking that the property retains its value: some WebKit builds accept
 * and echo the property but ignore it when compositing, which a property
 * check reports as supported and then silently draws unfiltered. Cached --
 * the answer cannot change within a session. */
let filterSupport: boolean | null = null;

export function supportsCanvasFilter(): boolean {
  if (filterSupport !== null) return filterSupport;
  try {
    const src = document.createElement("canvas");
    src.width = 1;
    src.height = 1;
    const sctx = src.getContext("2d")!;
    sctx.fillStyle = "#ffffff";
    sctx.fillRect(0, 0, 1, 1);

    const probe = document.createElement("canvas");
    probe.width = 1;
    probe.height = 1;
    const pctx = probe.getContext("2d")!;
    pctx.filter = "brightness(0)";
    pctx.drawImage(src, 0, 0);
    pctx.filter = "none";
    // White through brightness(0) must come back black if the filter ran.
    filterSupport = pctx.getImageData(0, 0, 1, 1).data[0] < 128;
  } catch {
    filterSupport = false;
  }
  return filterSupport;
}

/** Per-pixel fallback for brightness/contrast/saturation/invert, used where
 * `ctx.filter` is unavailable. Slower than the GPU path, which is why it is
 * only reached on older webviews. */
function applyPerPixel(ctx: CanvasRenderingContext2D, w: number, h: number, a: Adjustments) {
  const image = ctx.getImageData(0, 0, w, h);
  const d = image.data;
  const brightness = a.brightness / 100;
  const contrast = a.contrast / 100;
  const saturation = a.saturation / 100;
  const grayscale = (presetById(a.preset ?? "original")?.extraFilter ?? "").includes("grayscale");

  for (let i = 0; i < d.length; i += 4) {
    let r = d[i] * brightness;
    let g = d[i + 1] * brightness;
    let b = d[i + 2] * brightness;

    // Contrast pivots around mid-grey, the same as the CSS filter.
    r = (r - 128) * contrast + 128;
    g = (g - 128) * contrast + 128;
    b = (b - 128) * contrast + 128;

    // Rec. 601 luma, matching what the CSS saturate() filter uses.
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    if (grayscale) {
      r = g = b = luma;
    } else if (saturation !== 1) {
      r = luma + (r - luma) * saturation;
      g = luma + (g - luma) * saturation;
      b = luma + (b - luma) * saturation;
    }

    if (a.invert) {
      r = 255 - r;
      g = 255 - g;
      b = 255 - b;
    }

    d[i] = Math.max(0, Math.min(255, r));
    d[i + 1] = Math.max(0, Math.min(255, g));
    d[i + 2] = Math.max(0, Math.min(255, b));
  }
  ctx.putImageData(image, 0, 0);
}

/** Unsharp mask: a 3x3 sharpening convolution whose strength is scaled by
 * `amount` (0..100). There is no CSS filter for sharpening, so this runs on
 * pixels regardless of `ctx.filter` support. */
function applySharpen(ctx: CanvasRenderingContext2D, w: number, h: number, amount: number) {
  const strength = amount / 100;
  const src = ctx.getImageData(0, 0, w, h);
  const out = ctx.createImageData(w, h);
  const s = src.data;
  const o = out.data;
  // Center weight rises with strength while the neighbours go negative, so
  // amount 0 is the identity kernel and higher values sharpen more.
  const center = 1 + 4 * strength;
  const side = -strength;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // Edge pixels have no full neighbourhood; copying them avoids a dark
      // or smeared border where the kernel would sample outside the image.
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
        o[i] = s[i];
        o[i + 1] = s[i + 1];
        o[i + 2] = s[i + 2];
        o[i + 3] = s[i + 3];
        continue;
      }
      for (let c = 0; c < 3; c++) {
        const value =
          s[i + c] * center +
          s[i - 4 + c] * side +
          s[i + 4 + c] * side +
          s[i - w * 4 + c] * side +
          s[i + w * 4 + c] * side;
        o[i + c] = Math.max(0, Math.min(255, value));
      }
      o[i + 3] = s[i + 3];
    }
  }
  ctx.putImageData(out, 0, 0);
}

/** Returns a canvas holding `base` with `adjustments` applied.
 *
 * Identity adjustments return `base` itself so the common case costs nothing.
 * The result is what both the on-screen canvas and the export composite
 * against, so the preview and the saved file can't diverge. */
export function applyAdjustments(base: HTMLCanvasElement, adjustments: Adjustments): HTMLCanvasElement {
  if (isIdentity(adjustments)) return base;

  const out = document.createElement("canvas");
  out.width = base.width;
  out.height = base.height;
  const ctx = out.getContext("2d")!;

  const filter = filterString(adjustments);
  if (filter !== "none" && supportsCanvasFilter()) {
    ctx.filter = filter;
    ctx.drawImage(base, 0, 0);
    ctx.filter = "none";
  } else {
    ctx.drawImage(base, 0, 0);
    if (filter !== "none") applyPerPixel(ctx, out.width, out.height, adjustments);
  }

  if (adjustments.sharpness > 0) {
    applySharpen(ctx, out.width, out.height, adjustments.sharpness);
  }
  return out;
}
