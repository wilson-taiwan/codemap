import { describe, it, expect } from "vitest";
import {
  scrollFraction,
  scrollPlan,
  scrollTopForFraction,
  SCROLL_MARGIN,
} from "./scroll-into-view";

describe("scrollFraction", () => {
  it("names the reader's place as a fraction of the scroll range", () => {
    expect(scrollFraction(500, 1500, 500)).toBe(0.5);
    expect(scrollFraction(0, 1500, 500)).toBe(0);
    expect(scrollFraction(1000, 1500, 500)).toBe(1);
  });

  it("clamps overshoot and guards a zero-height range", () => {
    expect(scrollFraction(-10, 1500, 500)).toBe(0);
    expect(scrollFraction(9999, 1500, 500)).toBe(1);
    expect(scrollFraction(0, 500, 500)).toBe(0);
    expect(scrollFraction(0, 0, 0)).toBe(0);
  });

  it("round-trips through scrollTopForFraction", () => {
    for (const top of [0, 137, 500, 999, 1000]) {
      const f = scrollFraction(top, 1500, 500);
      expect(scrollTopForFraction(f, 1500, 500)).toBeCloseTo(top, 6);
    }
  });

  it("restores the same fraction against a shorter filtered list", () => {
    const f = scrollFraction(750, 3000, 500);
    expect(scrollTopForFraction(f, 1200, 500)).toBeCloseTo(
      ((750 / 2500) * 700),
      6,
    );
  });
});

describe("scrollPlan", () => {
  const viewportHeight = 600;

  it("1. intent === 'restore' centres the element", () => {
    const target = scrollPlan({
      elTop: 1000,
      elHeight: 100,
      scrollTop: 0,
      viewportHeight,
      intent: "restore",
    });
    // 1000 - 300 + 50 = 750
    expect(target).toBe(750);
  });

  it("2. intent === 'jump' centres the element", () => {
    const target = scrollPlan({
      elTop: 1000,
      elHeight: 100,
      scrollTop: 0,
      viewportHeight,
      intent: "jump",
    });
    expect(target).toBe(750);
  });

  describe("tall elements (elHeight >= viewportHeight)", () => {
    it("returns null if any part of the tall element is visible", () => {
      const target = scrollPlan({
        elTop: 200,
        elHeight: 800,
        scrollTop: 400,
        viewportHeight,
        intent: "click",
      });
      expect(target).toBeNull();
    });

    it("aligns top to viewport top minus margin if off-screen", () => {
      const target = scrollPlan({
        elTop: 1200,
        elHeight: 800,
        scrollTop: 0,
        viewportHeight,
        intent: "click",
      });
      expect(target).toBe(1200 - SCROLL_MARGIN);
    });
  });

  describe("normal elements with click/keys intent", () => {
    it("returns null when element is fully visible within margins", () => {
      const target = scrollPlan({
        elTop: 200,
        elHeight: 100,
        scrollTop: 100, // viewport from 100 to 700. Margins: 148 to 652. Element: 200 to 300
        viewportHeight,
        intent: "click",
      });
      expect(target).toBeNull();
    });

    it("scrolls to nearest edge with margin when element is above visible area", () => {
      const target = scrollPlan({
        elTop: 120, // above 148
        elHeight: 100,
        scrollTop: 100,
        viewportHeight,
        intent: "keys",
      });
      expect(target).toBe(120 - SCROLL_MARGIN);
    });

    it("scrolls to nearest edge with margin when element is below visible area", () => {
      const target = scrollPlan({
        elTop: 600, // element 600 to 700, below 652
        elHeight: 100,
        scrollTop: 100,
        viewportHeight,
        intent: "click",
      });
      // 600 + 100 - 600 + 48 = 148
      expect(target).toBe(600 + 100 - viewportHeight + SCROLL_MARGIN);
    });
  });
});
