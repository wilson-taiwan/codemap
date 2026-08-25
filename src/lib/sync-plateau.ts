/**
 * Pure helper for the sync plateau decision logic.
 *
 * Checks whether pending changes have plateaued (settled) or if a periodic
 * idle pull is due.
 */

export const POLL_MS = 5 * 1000;
export const PULL_MS = 2 * 60 * 1000;

export interface PlateauState {
  previous: number;
  lastPull: number;
  sentThisPlateau: boolean;
}

export interface PlateauDecisionInput {
  now: number;
  hardFail: boolean;
  currentTime: number;
  pollMs?: number;
  pullMs?: number;
}

export interface PlateauDecisionResult {
  shouldSync: boolean;
  nextState: PlateauState;
}

export function initialPlateauState(currentTime = Date.now()): PlateauState {
  return {
    previous: -1,
    lastPull: currentTime,
    sentThisPlateau: false,
  };
}

export function evaluateSyncPlateau(
  state: PlateauState,
  input: PlateauDecisionInput,
): PlateauDecisionResult {
  const pollMs = input.pollMs ?? POLL_MS;
  const pullMs = input.pullMs ?? PULL_MS;
  const now = input.now;
  const hardFail = input.hardFail;
  const currentTime = input.currentTime;

  const onPlateau = now === state.previous;
  let sentThisPlateau = onPlateau ? state.sentThisPlateau : false;

  let settled = false;
  if (onPlateau && !hardFail && !sentThisPlateau) {
    if (now > 0) {
      settled = true;
    } else if (now === 0) {
      // A zero plateau also counts once settled, provided at least POLL_MS * 2
      // has elapsed since last pull, giving an idle coder the codebook promptly.
      if (currentTime - state.lastPull >= pollMs * 2) {
        settled = true;
      }
    }
  }

  const pullDue = currentTime - state.lastPull >= pullMs;
  const shouldSync = settled || pullDue;

  let lastPull = state.lastPull;
  if (shouldSync) {
    if (settled) {
      sentThisPlateau = true;
    }
    lastPull = currentTime;
  }

  return {
    shouldSync,
    nextState: {
      previous: now,
      lastPull,
      sentThisPlateau,
    },
  };
}
