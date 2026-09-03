import { describe, expect, it } from "vitest";
import {
  clampZoom,
  normalizeZoom,
  stepZoom,
  zoomPercent,
  ZOOM_DEFAULT,
  ZOOM_MAX,
  ZOOM_MIN,
} from "./reading-zoom";

describe("reading zoom", () => {
  it("steps in 12.5% increments without float drift", () => {
    expect(stepZoom(1, 1)).toBeCloseTo(1.125, 10);
    expect(stepZoom(1.125, 1)).toBeCloseTo(1.25, 10);
    expect(stepZoom(1, -1)).toBeCloseTo(0.875, 10);
    // Eight steps up from default lands exactly on 200%.
    let z: number | null = 1;
    for (let i = 0; i < 8; i++) z = stepZoom(z, 1);
    expect(z).toBe(ZOOM_MAX);
  });

  it("clamps at 75% and 200%", () => {
    expect(stepZoom(ZOOM_MAX, 1)).toBe(ZOOM_MAX);
    expect(stepZoom(ZOOM_MIN, -1)).toBe(ZOOM_MIN);
    expect(clampZoom(5)).toBe(ZOOM_MAX);
    expect(clampZoom(0.1)).toBe(ZOOM_MIN);
  });

  it("treats null, undefined, and garbage prefs as 100%", () => {
    expect(normalizeZoom(null)).toBe(ZOOM_DEFAULT);
    expect(normalizeZoom(undefined)).toBe(ZOOM_DEFAULT);
    expect(normalizeZoom("150%")).toBe(ZOOM_DEFAULT);
    expect(normalizeZoom(NaN)).toBe(ZOOM_DEFAULT);
    expect(stepZoom(null, 1)).toBeCloseTo(1.125, 10);
  });

  it("formats the header percentage", () => {
    expect(zoomPercent(1)).toBe(100);
    expect(zoomPercent(1.5)).toBe(150);
    expect(zoomPercent(null)).toBe(100);
  });
});
