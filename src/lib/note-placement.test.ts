import { describe, expect, it } from "vitest";
import {
  computeNotePlacement,
  type PlacementRect,
} from "./note-placement";

describe("computeNotePlacement", () => {
  const defaultScroller: PlacementRect = {
    top: 50,
    bottom: 850,
    left: 200,
    right: 1000,
    width: 800,
    height: 800,
  };

  const defaultRow: PlacementRect = {
    top: 300,
    bottom: 380,
    left: 250,
    right: 600,
    width: 350,
    height: 80,
  };

  it("places beside in the right gutter when reading column has room", () => {
    const result = computeNotePlacement({
      rowRect: defaultRow,
      scrollerRect: defaultScroller,
      cardHeight: 160,
      viewportHeight: 900,
      viewportWidth: 1200,
    });

    expect(result.placement).toBe("beside");
    // scroller.right (1000) - (300 + 16) = 684
    expect(result.left).toBe(684);
    // row center: 300 + 40 = 340. card center: 340 - 80 = 260
    expect(result.top).toBe(260);
    // Does not overlap row rect
    expect(result.left).toBeGreaterThan(defaultRow.right);
  });

  it("places below row when reading column is narrower than 560px", () => {
    const narrowScroller: PlacementRect = {
      top: 50,
      bottom: 850,
      left: 100,
      right: 600,
      width: 500,
      height: 800,
    };
    const row: PlacementRect = {
      top: 200,
      bottom: 260,
      left: 120,
      right: 560,
      width: 440,
      height: 60,
    };

    const result = computeNotePlacement({
      rowRect: row,
      scrollerRect: narrowScroller,
      cardHeight: 150,
      viewportHeight: 900,
      viewportWidth: 1000,
    });

    expect(result.placement).toBe("below");
    expect(result.top).toBeGreaterThanOrEqual(row.bottom);
  });

  it("places below row if beside placement would overlap the row text rect", () => {
    // Wide scroller, but row extends far to the right into the gutter
    const scroller: PlacementRect = {
      top: 50,
      bottom: 850,
      left: 100,
      right: 700,
      width: 600,
      height: 800,
    };
    const wideRow: PlacementRect = {
      top: 200,
      bottom: 260,
      left: 120,
      right: 690, // extends past besideLeft (700 - 316 = 384)
      width: 570,
      height: 60,
    };

    const result = computeNotePlacement({
      rowRect: wideRow,
      scrollerRect: scroller,
      cardHeight: 150,
      viewportHeight: 900,
      viewportWidth: 1000,
    });

    expect(result.placement).toBe("below");
    expect(result.top).toBeGreaterThanOrEqual(wideRow.bottom);
  });

  it("clamps top at top of viewport when row is at the very top", () => {
    const topRow: PlacementRect = {
      top: 0,
      bottom: 40,
      left: 250,
      right: 550,
      width: 300,
      height: 40,
    };

    const result = computeNotePlacement({
      rowRect: topRow,
      scrollerRect: defaultScroller,
      cardHeight: 160,
      viewportHeight: 900,
      viewportWidth: 1200,
    });

    expect(result.placement).toBe("beside");
    expect(result.top).toBe(8); // clamped to 8
  });

  it("clamps top at bottom of viewport when row is at the very bottom", () => {
    const bottomRow: PlacementRect = {
      top: 860,
      bottom: 900,
      left: 250,
      right: 550,
      width: 300,
      height: 40,
    };

    const result = computeNotePlacement({
      rowRect: bottomRow,
      scrollerRect: defaultScroller,
      cardHeight: 160,
      viewportHeight: 900,
      viewportWidth: 1200,
    });

    expect(result.placement).toBe("beside");
    // viewportHeight (900) - cardHeight (160) - 8 = 732
    expect(result.top).toBe(732);
  });
});
