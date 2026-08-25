import type { StepSpec } from "../components/setup/StepRail";

/**
 * Join-wizard rails and "can I continue" rules, extracted so the signed-in
 * skip and the copy-vs-new step can be unit tested without mounting the
 * modal.
 */

export type JoinAccount = "new" | "existing";

export function joinRailSteps(opts: {
  hasKey: boolean;
  signedIn: boolean;
  presetMembership?: boolean;
}): StepSpec[] {
  const connect: StepSpec = {
    id: "connect",
    title: "Connect",
    caption: opts.signedIn
      ? "Group key and your name"
      : "Account, group key, and your name",
  };
  const copy: StepSpec = {
    id: "copy",
    title: "Copy",
    caption: "New folder or one you have",
  };
  const transcripts: StepSpec = {
    id: "transcripts",
    title: "Transcripts",
    caption: "Link your copies",
  };
  if (opts.presetMembership) return [copy, transcripts];
  if (opts.hasKey) return [connect, copy, transcripts];
  return [
    connect,
    { id: "study", title: "Group", caption: "Pick the one you were sent" },
    copy,
    transcripts,
  ];
}

/** Whether the connect step's Continue button should enable. */
export function joinConnectReady(opts: {
  signedIn: boolean;
  hideServer: boolean;
  setupFilled: boolean;
  coderName: string;
}): boolean {
  if (!opts.signedIn) return false;
  if (!opts.coderName.trim()) return false;
  if (!opts.hideServer && !opts.setupFilled) return false;
  return true;
}

export function joinPasswordProblem(
  account: JoinAccount | "recover",
  password: string,
  passwordAgain: string,
): string | null {
  if (account === "existing" || password.length === 0) return null;
  if (password.length < 6) return "Use at least 6 characters.";
  if (passwordAgain.length > 0 && password !== passwordAgain) {
    return "The two passwords do not match.";
  }
  return null;
}

/** "ada.lovelace@…" → "Ada Lovelace". A guess, not a name. */
export function guessNameFromEmail(email: string): string {
  const local = email.split("@")[0]?.trim() ?? "";
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/** What a pasted reset email can contain. */
export type RecoveryPaste =
  | { kind: "empty" }
  | { kind: "otp"; token: string }
  | { kind: "hash"; tokenHash: string }
  | { kind: "session"; accessToken: string; refreshToken: string };

/**
 * Pull a recovery secret out of whatever the coder pasted.
 *
 * The email is a short code. Leftover “Reset password” URLs from the old
 * template still parse: `/auth/v1/verify?token=` is a token_hash, not an OTP.
 */
export function parseRecoveryPaste(raw: string): RecoveryPaste {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "empty" };
  if (/^\d{6,8}$/.test(trimmed)) return { kind: "otp", token: trimmed };

  const urlMatch = trimmed.match(/https?:\/\/[^\s<>"']+/i);
  const source = urlMatch ? unwrapRedirect(urlMatch[0]) : trimmed;

  const tokenHash = firstParam(source, "token_hash");
  if (tokenHash) return { kind: "hash", tokenHash };

  const accessToken = firstParam(source, "access_token");
  const refreshToken = firstParam(source, "refresh_token");
  if (accessToken && refreshToken) {
    return { kind: "session", accessToken, refreshToken };
  }

  const token = firstParam(source, "token");
  if (token) {
    if (/\/auth\/v1\/verify\b/i.test(source) || token.length > 8) {
      return { kind: "hash", tokenHash: token };
    }
    return { kind: "otp", token };
  }

  const codes = [...trimmed.matchAll(/(?<!\d)(\d{6,8})(?!\d)/g)].map(
    (m) => m[1],
  );
  if (codes.length === 1) return { kind: "otp", token: codes[0] };

  if (trimmed.length >= 8 && !/\s/.test(trimmed)) {
    return { kind: "otp", token: trimmed };
  }
  return { kind: "empty" };
}

/** Quiet confirmation that the paste parsed, so they know they can continue. */
export function recoveryPasteHint(parsed: RecoveryPaste): string | null {
  switch (parsed.kind) {
    case "otp":
      return parsed.token.length <= 8
        ? "Looks like a reset code."
        : "Looks like a reset token.";
    case "hash":
    case "session":
      return "Looks like a reset link.";
    case "empty":
      return null;
  }
}

function unwrapRedirect(raw: string): string {
  try {
    const parsed = new URL(raw);
    if (
      parsed.hostname === "www.google.com" &&
      parsed.pathname === "/url"
    ) {
      const nested = parsed.searchParams.get("q");
      if (nested) return nested;
    }
  } catch {
    return raw;
  }
  return raw;
}

function firstParam(raw: string, name: string): string | null {
  const re = new RegExp(`[?&#]${name}=([^&#\\s]+)`, "i");
  const match = raw.match(re);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}
