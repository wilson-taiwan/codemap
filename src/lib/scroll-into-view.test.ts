import { describe, it, expect } from "vitest";
import { scrollPlan, SCROLL_MARGIN } from "./scroll-into-view";

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
