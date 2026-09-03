/**
 * Passage-text zoom (T03): scale factor for the reading serif only.
 *
 * Range 75%-200% in 12.5% steps. The helpers snap to the step grid so
 * repeated +/- clicks never drift into values like 112.50000000001, which
 * would show a ragged percentage label.
 */

export const ZOOM_MIN = 0.75;
export const ZOOM_MAX = 2;
export const ZOOM_STEP = 0.125;
export const ZOOM_DEFAULT = 1;

function snap(v: number): number {
  return Math.round(v / ZOOM_STEP) * ZOOM_STEP;
}

export function clampZoom(v: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, snap(v)));
}

/** Prefs carry `number | null | undefined` — absent means default 100%. */
export function normalizeZoom(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return ZOOM_DEFAULT;
  return clampZoom(v);
}

export function stepZoom(current: number | null | undefined, dir: 1 | -1): number {
  return clampZoom(normalizeZoom(current) + dir * ZOOM_STEP);
}

/** 1.5 -> 150, for the header label. */
export function zoomPercent(zoom: number | null | undefined): number {
  return Math.round(normalizeZoom(zoom) * 100);
}
