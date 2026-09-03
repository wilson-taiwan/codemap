import { describe, expect, it } from "vitest";
import { fitRails, workspaceColumns } from "./WorkspaceLayout";

/**
 * The transcript is the app's core artifact and the only column whose width is
 * a legibility constraint rather than a preference. These assert the property
 * the layout exists to hold: at the app's own `minWidth: 1024`, the rails give
 * way and the reading column keeps its measure.
 *
 * Measured in the running app at 1024×640 after this landed: rails 232/270,
 * transcript 512, median 63 characters per line (target 60–75). Before it:
 * transcript 466, ~48 characters, and the Import button clipped off-screen.
 */

const RESIZER = 5;
const TRANSCRIPT_MIN = 512;
const MIN_PANEL = 190;

const transcriptWidth = (
  r: { codebook: number; memos: number },
  viewport: number,
) => viewport - r.codebook - r.memos - 2 * RESIZER;

describe("fitRails", () => {
  it("leaves the stored widths alone when there is room", () => {
    expect(fitRails(248, 300, 1400)).toEqual({ codebook: 248, memos: 300 });
  });

  it("keeps the transcript at its floor at the app's minimum window", () => {
    const r = fitRails(248, 300, 1024);
    expect(transcriptWidth(r, 1024)).toBeGreaterThanOrEqual(TRANSCRIPT_MIN);
  });

  it("never shrinks a rail below MIN_PANEL", () => {
    for (const viewport of [1024, 1100, 1280, 1440]) {
      for (const [c, m] of [
        [248, 300],
        [400, 480],
        [190, 190],
        [400, 190],
      ] as const) {
        const r = fitRails(c, m, viewport);
        expect(r.codebook).toBeGreaterThanOrEqual(MIN_PANEL);
        expect(r.memos).toBeGreaterThanOrEqual(MIN_PANEL);
      }
    }
  });

  it("takes from each rail in proportion to its slack", () => {
    // memos starts wider, so it gives up more than the codebook does
    const r = fitRails(248, 300, 1024);
    expect(300 - r.memos).toBeGreaterThan(248 - r.codebook);
  });

  it("takes nothing from a rail already at its floor", () => {
    const r = fitRails(MIN_PANEL, 480, 1024);
    expect(r.codebook).toBe(MIN_PANEL);
    expect(r.memos).toBeLessThan(480);
  });

  it("gives up rather than pushing a rail below its floor on a tiny window", () => {
    // narrower than the app supports; the transcript absorbs it instead of a
    // control being driven off-screen
    const r = fitRails(MIN_PANEL, MIN_PANEL, 700);
    expect(r).toEqual({ codebook: MIN_PANEL, memos: MIN_PANEL });
  });

  it("restores the stored widths when the window widens again", () => {
    expect(fitRails(248, 300, 1024)).not.toEqual({ codebook: 248, memos: 300 });
    expect(fitRails(248, 300, 1600)).toEqual({ codebook: 248, memos: 300 });
  });
});

describe("workspaceColumns", () => {
  it("renders the full codebook rail when expanded", () => {
    expect(
      workspaceColumns({ collapsed: false, memoRail: false, codebook: 248, memos: 300 }),
    ).toBe("248px 5px minmax(0, 1fr)");
    expect(
      workspaceColumns({ collapsed: false, memoRail: true, codebook: 248, memos: 300 }),
    ).toBe("248px 5px minmax(0, 1fr) 5px 300px");
  });

  it("replaces the codebook with the slim rail when collapsed", () => {
    expect(
      workspaceColumns({ collapsed: true, memoRail: false, codebook: 248, memos: 300 }),
    ).toBe("28px minmax(0, 1fr)");
  });

  it("leaves the memo rail untouched while collapsed", () => {
    expect(
      workspaceColumns({ collapsed: true, memoRail: true, codebook: 248, memos: 300 }),
    ).toBe("28px minmax(0, 1fr) 5px 300px");
  });

  it("keeps the stored codebook width out of the collapsed template", () => {
    // Expanding restores the previous width because collapsing never writes
    // it anywhere: the collapsed template must not mention it.
    const collapsed = workspaceColumns({
      collapsed: true,
      memoRail: false,
      codebook: 372,
      memos: 300,
    });
    expect(collapsed).not.toContain("372");
    expect(
      workspaceColumns({ collapsed: false, memoRail: false, codebook: 372, memos: 300 }),
    ).toContain("372px");
  });
});
