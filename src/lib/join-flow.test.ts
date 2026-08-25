import { describe, expect, it } from "vitest";
import {
  guessNameFromEmail,
  joinConnectReady,
  joinPasswordProblem,
  joinRailSteps,
  parseRecoveryPaste,
  recoveryPasteHint,
} from "./join-flow";

const signedIn = {
  signedIn: true,
  hideServer: true,
  setupFilled: false,
  coderName: "Sam",
};

describe("joinRailSteps", () => {
  it("skips the picker when a key is present, and names the account step only when unsigned-in", () => {
    const signedOut = joinRailSteps({ hasKey: true, signedIn: false });
    expect(signedOut.map((s) => s.id)).toEqual(["connect", "copy", "transcripts"]);
    expect(signedOut[0].caption).toMatch(/Account/);

    const signedInRail = joinRailSteps({ hasKey: true, signedIn: true });
    expect(signedInRail.map((s) => s.id)).toEqual(["connect", "copy", "transcripts"]);
    expect(signedInRail[0].caption).not.toMatch(/Account/);

    const presetRail = joinRailSteps({ hasKey: true, signedIn: true, presetMembership: true });
    expect(presetRail.map((s) => s.id)).toEqual(["copy", "transcripts"]);
  });
});

describe("joinConnectReady", () => {
  it("lets a signed-in coder continue with just a name (key is the next field, not a gate here)", () => {
    expect(joinConnectReady(signedIn)).toBe(true);
  });

  it("still needs a name when the account is already signed in", () => {
    expect(joinConnectReady({ ...signedIn, coderName: "" })).toBe(false);
  });

  it("does not continue the group step until they have signed in", () => {
    expect(joinConnectReady({ ...signedIn, signedIn: false })).toBe(false);
  });
});

describe("joinPasswordProblem", () => {
  it("is silent until a new account has started typing a password", () => {
    expect(joinPasswordProblem("existing", "x", "x")).toBeNull();
    expect(joinPasswordProblem("new", "", "")).toBeNull();
    expect(joinPasswordProblem("new", "ab", "ab")).toMatch(/6 characters/);
    expect(joinPasswordProblem("new", "secret1", "nope")).toMatch(/match/);
    expect(joinPasswordProblem("new", "secret1", "secret1")).toBeNull();
  });

  it("applies the same checks when setting a new password after reset", () => {
    expect(joinPasswordProblem("recover", "short", "short")).toMatch(/6 characters/);
    expect(joinPasswordProblem("recover", "secret1", "nope")).toMatch(/match/);
    expect(joinPasswordProblem("recover", "secret1", "secret1")).toBeNull();
  });
});

describe("guessNameFromEmail", () => {
  it("turns a dotted local-part into a name", () => {
    expect(guessNameFromEmail("ada.lovelace@example.com")).toBe("Ada Lovelace");
    expect(guessNameFromEmail("sam@example.com")).toBe("Sam");
  });
});

describe("parseRecoveryPaste", () => {
  it("accepts a short code, a leftover verify URL as a hash, or a redirected session", () => {
    expect(parseRecoveryPaste("")).toEqual({ kind: "empty" });
    expect(parseRecoveryPaste(" 482193 ")).toEqual({ kind: "otp", token: "482193" });
    expect(
      parseRecoveryPaste(
        "https://example.supabase.co/auth/v1/verify?token=abc123&type=recovery",
      ),
    ).toEqual({ kind: "hash", tokenHash: "abc123" });
    expect(
      parseRecoveryPaste(
        "https://www.google.com/url?q=https%3A%2F%2Fexample.supabase.co%2Fauth%2Fv1%2Fverify%3Ftoken%3Dabc123%26type%3Drecovery",
      ),
    ).toEqual({ kind: "hash", tokenHash: "abc123" });
    expect(
      parseRecoveryPaste("https://app.example/reset#token_hash=deadbeef"),
    ).toEqual({ kind: "hash", tokenHash: "deadbeef" });
    expect(
      parseRecoveryPaste(
        "https://app.example/#access_token=aaa&refresh_token=bbb&type=recovery",
      ),
    ).toEqual({
      kind: "session",
      accessToken: "aaa",
      refreshToken: "bbb",
    });
  });

  it("pulls a code out of a whole-email paste that has no link", () => {
    expect(
      parseRecoveryPaste(
        "Reset your Codemap password\nType this code in Codemap: 482193\nIf you did not ask, ignore this.",
      ),
    ).toEqual({ kind: "otp", token: "482193" });
  });

  it("still pulls a leftover token_hash URL out of a whole-email paste", () => {
    expect(
      parseRecoveryPaste(
        "Reset your password:\nhttps://app.example/reset#token_hash=deadbeef\nIf you did not ask, ignore this.",
      ),
    ).toEqual({ kind: "hash", tokenHash: "deadbeef" });
  });
});

describe("recoveryPasteHint", () => {
  it("names what was recognised so a paste does not look like it did nothing", () => {
    expect(recoveryPasteHint({ kind: "empty" })).toBeNull();
    expect(recoveryPasteHint({ kind: "otp", token: "482193" })).toMatch(/code/);
    expect(recoveryPasteHint({ kind: "hash", tokenHash: "x" })).toMatch(/link/);
  });
});
