import { describe, it, expect } from "vitest";
import {
  evaluateSyncPlateau,
  initialPlateauState,
  type PlateauState,
} from "./sync-plateau";

describe("sync-plateau decision logic", () => {
  it("triggers an idle pull on a zero plateau after POLL_MS * 2", () => {
    let state: PlateauState = initialPlateauState(0);

    // t = 5000: first poll tick sees now = 0 (previous was -1) -> not on plateau yet
    const r1 = evaluateSyncPlateau(state, {
      now: 0,
      hardFail: false,
      currentTime: 5000,
    });
    expect(r1.shouldSync).toBe(false);
    state = r1.nextState;

    // t = 10000: second tick sees now = 0 (previous was 0) -> on plateau!
    // Since currentTime (10000) - lastPull (0) >= 10000 (POLL_MS * 2), it should sync.
    const r2 = evaluateSyncPlateau(state, {
      now: 0,
      hardFail: false,
      currentTime: 10000,
    });
    expect(r2.shouldSync).toBe(true);
    expect(r2.nextState.sentThisPlateau).toBe(true);
    state = r2.nextState;

    // t = 15000: third tick sees now = 0 -> still on plateau, but already sentThisPlateau
    const r3 = evaluateSyncPlateau(state, {
      now: 0,
      hardFail: false,
      currentTime: 15000,
    });
    expect(r3.shouldSync).toBe(false);
    state = r3.nextState;

    // t = 130000: PULL_MS (120000) has elapsed since last pull at 10000 -> periodic pull due
    const r4 = evaluateSyncPlateau(state, {
      now: 0,
      hardFail: false,
      currentTime: 130000,
    });
    expect(r4.shouldSync).toBe(true);
  });

  it("triggers when non-zero pending changes plateau", () => {
    let state: PlateauState = initialPlateauState(0);

    // Coding in progress: pending rising 0 -> 1 -> 2
    state = evaluateSyncPlateau(state, {
      now: 1,
      hardFail: false,
      currentTime: 5000,
    }).nextState;

    state = evaluateSyncPlateau(state, {
      now: 2,
      hardFail: false,
      currentTime: 10000,
    }).nextState;

    // Pending plateaus at 2:
    const r3 = evaluateSyncPlateau(state, {
      now: 2,
      hardFail: false,
      currentTime: 15000,
    });
    expect(r3.shouldSync).toBe(true);
    expect(r3.nextState.sentThisPlateau).toBe(true);
    state = r3.nextState;

    // Next tick still at 2 does not re-fire:
    const r4 = evaluateSyncPlateau(state, {
      now: 2,
      hardFail: false,
      currentTime: 20000,
    });
    expect(r4.shouldSync).toBe(false);
  });

  it("does not fire plateau pull during hardFail, preventing 409 metronome", () => {
    let state: PlateauState = initialPlateauState(0);

    state = evaluateSyncPlateau(state, {
      now: 1,
      hardFail: true,
      currentTime: 5000,
    }).nextState;

    // Plateaus at 1 but hardFail is true
    const r2 = evaluateSyncPlateau(state, {
      now: 1,
      hardFail: true,
      currentTime: 10000,
    });
    expect(r2.shouldSync).toBe(false);

    const r3 = evaluateSyncPlateau(r2.nextState, {
      now: 1,
      hardFail: true,
      currentTime: 15000,
    });
    expect(r3.shouldSync).toBe(false);
  });
});
