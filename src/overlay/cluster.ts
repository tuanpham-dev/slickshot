/** Selection expressed as fractions of the monitor, the form `Overlay.tsx`
 * already computes for its mask bars. */
export interface SelectionFractions {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ClusterPlacement {
  /** Horizontal centre, in CSS pixels -- the caller renders with
   * `translateX(-50%)`. */
  left: number;
  /** Top edge, in CSS pixels. */
  top: number;
}

/** Places a floating cluster (the action buttons, the quick-tools bar) beside
 * the selection and fully on this monitor.
 *
 * Vertical preference: the requested side first, then the other side, then
 * pinned inside the nearest edge -- a selection filling the monitor's height,
 * or sitting hard against an edge, has no room outside it at all. Horizontally
 * the centre is clamped so a cluster centred on a selection near either edge
 * cannot hang off it.
 *
 * Shared by both clusters so they cannot drift apart, and pure so the corner
 * cases are testable without a monitor. */
export function placeCluster(
  sel: SelectionFractions,
  container: { w: number; h: number },
  size: { w: number; h: number },
  prefer: "above" | "below",
  /** A band already taken by another cluster. When the placement would land
   * on it, this one stacks clear of it -- on the far side, away from the
   * selection. A selection hugging the top edge forces both clusters below
   * it, and without this they land on exactly the same row. */
  avoid?: { top: number; height: number } | null,
  margin = 8,
  gap = 10,
): ClusterPlacement {
  const half = size.w / 2;
  const minLeft = margin + half;
  const left = Math.min(
    Math.max(((sel.left + sel.right) / 2) * container.w, minLeft),
    Math.max(container.w - margin - half, minLeft),
  );

  const below = sel.bottom * container.h + gap;
  const above = sel.top * container.h - size.h - gap;
  const fitsBelow = below + size.h + margin <= container.h;
  const fitsAbove = above >= margin;

  let top: number;
  if (prefer === "below") {
    top = fitsBelow
      ? below
      : fitsAbove
        ? above
        : Math.max(margin, container.h - size.h - margin);
  } else {
    top = fitsAbove ? above : fitsBelow ? below : margin;
  }

  if (avoid && top < avoid.top + avoid.height && avoid.top < top + size.h) {
    // Stack on the far side of the taken band, so the two clusters read as
    // one group rather than one hiding the other.
    const selTop = sel.top * container.h;
    const stacked =
      avoid.top < selTop ? avoid.top - size.h - gap : avoid.top + avoid.height + gap;
    top =
      stacked >= margin && stacked + size.h <= container.h - margin
        ? stacked
        : Math.max(margin, Math.min(top, container.h - size.h - margin));
  }
  return { left, top };
}
