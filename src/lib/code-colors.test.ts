import { describe, expect, it } from "vitest";
import { CODE_PALETTE, contrast, luminance, readableOn, textOnSolid } from "./code-colors";

const LIGHT_GROUND = "#ffffff";
const DARK_GROUND = "#0f0f0e";
const WHITE = "#ffffff";

describe("contrast", () => {
  it("matches known WCAG pairs", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrast("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });

  it("is symmetric", () => {
    expect(contrast("#8a6410", WHITE)).toBeCloseTo(contrast(WHITE, "#8a6410"), 6);
  });

  it("orders by luminance as expected", () => {
    expect(luminance("#ffffff")).toBeGreaterThan(luminance("#8a6410"));
    expect(luminance("#8a6410")).toBeGreaterThan(luminance("#000000"));
  });
});

describe("the palette keeps its stated promise", () => {
  it("every swatch clears 4.5:1 behind white chip text", () => {
    for (const color of CODE_PALETTE) {
      expect(contrast(color, WHITE), `${color} behind white text`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("swatches are distinguishable from one another", () => {
    // Not a contrast requirement — a sanity check that no two entries are so
    // close that they would read as the same code at chip size.
    for (let i = 0; i < CODE_PALETTE.length; i++) {
      for (let j = i + 1; j < CODE_PALETTE.length; j++) {
        expect(CODE_PALETTE[i]).not.toBe(CODE_PALETTE[j]);
      }
    }
  });
});

describe("readableOn", () => {
  it("🔴 makes every palette colour legible on the dark ground", () => {
    // The bug this exists for: the palette is tuned for white-on-colour chips,
    // so every entry is dark. Drawn as foreground on a dark background — a
    // highlight rule, the filter banner, the codebook count — they vanished.
    for (const color of CODE_PALETTE) {
      const fixed = readableOn(color, DARK_GROUND);
      expect(
        contrast(fixed, DARK_GROUND),
        `${color} -> ${fixed} on dark`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("leaves a colour alone when it already passes", () => {
    for (const color of CODE_PALETTE) {
      // These were chosen to clear 4.5:1 against a light ground already.
      expect(readableOn(color, LIGHT_GROUND)).toBe(color);
    }
  });

  it("keeps the adjusted colour recognisably the same hue family", () => {
    // Lifting toward white must not turn gold into grey — the colour is how a
    // coder identifies which code a highlight belongs to.
    const gold = readableOn("#8a6410", DARK_GROUND);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(gold.slice(i, i + 2), 16));
    expect(r).toBeGreaterThan(b);
    expect(g).toBeGreaterThan(b);
  });

  it("handles shorthand hex and is idempotent", () => {
    const once = readableOn("#333", DARK_GROUND);
    expect(readableOn(once, DARK_GROUND)).toBe(once);
    expect(contrast(once, DARK_GROUND)).toBeGreaterThanOrEqual(4.5);
  });

  it("copes with the extremes without looping forever", () => {
    expect(contrast(readableOn("#000000", DARK_GROUND), DARK_GROUND)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(readableOn("#ffffff", LIGHT_GROUND), LIGHT_GROUND)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("textOnSolid", () => {
  it("clears at least 4.5:1 against every swatch in the default palette", () => {
    for (const color of CODE_PALETTE) {
      const text = textOnSolid(color);
      expect(contrast(text, color), `${text} on ${color}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("handles pure white and pure black fills", () => {
    expect(textOnSolid("#ffffff")).toBe("#000000");
    expect(textOnSolid("#000000")).toBe("#ffffff");
    expect(contrast(textOnSolid("#ffffff"), "#ffffff")).toBeCloseTo(21, 1);
    expect(contrast(textOnSolid("#000000"), "#000000")).toBeCloseTo(21, 1);
  });
});
