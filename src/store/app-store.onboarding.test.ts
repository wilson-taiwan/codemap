/**
 * Intent-first onboarding migration truth table + the no-flash guarantee.
 *
 * The gate has two inputs: which preference marker exists, and whether the
 * silent session restore has finished. A returning v1.1 user must never see
 * the choice again; a returning signed-in user must never see it flash.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { api } = vi.hoisted(() => ({
  api: {
    getAppPreferences: vi.fn(),
    setAppPreferences: vi.fn(async (p) => p),
    syncRestoreSession: vi.fn<() => Promise<void>>(async () => {}),
    syncStatus: vi.fn(async () => null),
    listRecentProjects: vi.fn(async () => []),
    listCachedMemberships: vi.fn(async () => ({ memberships: [], cachedAt: null })),
  },
}));

vi.mock("../lib/api", () => ({ api }));

import { api as mockedApi } from "../lib/api";
import {
  onboardingChoiceSeen,
  useAppStore,
} from "./app-store";
import { useSyncStore } from "./sync-store";
import type { AppPreferences } from "../lib/types";

function defaultPrefs(): AppPreferences {
  return {
    reopen_last_project: false,
    signin_prompt_seen: false,
    onboarding_choice_seen: false,
    last_guide_section_id: null,
    panel_widths: null,
    coach_dismissed: false,
    merge_same_speaker: true,
    theme: "light",
    coder_identities: {},
    sync_url: null,
    sync_anon_key: null,
  };
}

describe("onboardingChoiceSeen migration truth table", () => {
  it("fresh install: neither marker → not seen", () => {
    expect(onboardingChoiceSeen({})).toBe(false);
  });

  it("v1.1 user who saw the credential gate → seen (never re-onboarded)", () => {
    expect(onboardingChoiceSeen({ signin_prompt_seen: true })).toBe(true);
  });

  it("v1.1 user who never saw it → not seen", () => {
    expect(onboardingChoiceSeen({ signin_prompt_seen: false })).toBe(false);
  });

  it("explicit new marker true → seen", () => {
    expect(onboardingChoiceSeen({ onboarding_choice_seen: true })).toBe(true);
  });

  it("explicit new marker false with old marker absent/false → not seen", () => {
    expect(
      onboardingChoiceSeen({ onboarding_choice_seen: false }),
    ).toBe(false);
    expect(
      onboardingChoiceSeen({
        onboarding_choice_seen: false,
        signin_prompt_seen: false,
      }),
    ).toBe(false);
  });
});

describe("setOnboardingChoiceSeen persists through preferences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({
      preferences: defaultPrefs(),
      initialized: false,
    });
  });

  it("writes the marker and updates local state", async () => {
    await useAppStore.getState().setOnboardingChoiceSeen(true);
    expect(mockedApi.setAppPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ onboarding_choice_seen: true }),
    );
    expect(useAppStore.getState().preferences.onboarding_choice_seen).toBe(
      true,
    );
  });

  it("keeps the optimistic state even if persistence fails", async () => {
    vi.mocked(mockedApi.setAppPreferences).mockRejectedValueOnce(new Error("disk"));
    await useAppStore.getState().setOnboardingChoiceSeen(true);
    expect(useAppStore.getState().preferences.onboarding_choice_seen).toBe(true);
  });
});

describe("sessionRestoreComplete settles after silent restore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSyncStore.setState({ status: null, sessionRestoreComplete: false });
  });

  it("is false during restore and true afterwards", async () => {
    let resolveRestore: (value: boolean) => void = () => {};
    vi.mocked(mockedApi.syncRestoreSession).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveRestore = resolve;
        }),
    );

    const pending = useSyncStore.getState().restoreSession();
    expect(useSyncStore.getState().sessionRestoreComplete).toBe(false);

    resolveRestore(false);
    await pending;
    expect(useSyncStore.getState().sessionRestoreComplete).toBe(true);
  });

  it("is still true when the restore throws — no flash either way", async () => {
    vi.mocked(mockedApi.syncRestoreSession).mockRejectedValueOnce(
      new Error("offline"),
    );
    await useSyncStore.getState().restoreSession();
    expect(useSyncStore.getState().sessionRestoreComplete).toBe(true);
  });
});
