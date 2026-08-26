import { useEffect, useRef, useState } from "react";
import { useSyncStore } from "../store/sync-store";
import { BetaNotice } from "./BetaNotice";
import {
  joinPasswordProblem,
  parseRecoveryPaste,
  recoveryPasteHint,
  type JoinAccount,
} from "../lib/join-flow";

type FormMode = JoinAccount | "recover";

/**
 * Create-account / sign-in / reset, used from Settings (the home for the
 * account) and from the join wizard when the person has not signed in yet.
 *
 * The account is app-wide: it is not a property of a group, and signing out
 * does not unbind any folder.
 */
export function AccountForm({
  idPrefix = "account",
  autoFocus = false,
  onSignedIn,
}: {
  /** Avoid colliding ids when Settings and the join wizard both mount. */
  idPrefix?: string;
  autoFocus?: boolean;
  onSignedIn?: () => void;
}) {
  const signIn = useSyncStore((s) => s.signIn);
  const signUp = useSyncStore((s) => s.signUp);
  const requestPasswordReset = useSyncStore((s) => s.requestPasswordReset);
  const completePasswordReset = useSyncStore((s) => s.completePasswordReset);
  const storeError = useSyncStore((s) => s.error);
  const clearError = useSyncStore((s) => s.clearError);

  const [mode, setMode] = useState<FormMode>("new");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordAgain, setPasswordAgain] = useState("");
  const [recoveryPaste, setRecoveryPaste] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<"submit" | "send" | "finish" | null>(null);
  const [resetSent, setResetSent] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const recoveryRef = useRef<HTMLTextAreaElement>(null);

  const confirmMode = mode === "new" || mode === "recover";
  const passwordProblem = joinPasswordProblem(
    mode === "recover" ? "recover" : mode,
    password,
    passwordAgain,
  );
  const parsed = parseRecoveryPaste(recoveryPaste);
  const pasteHint = recoveryPasteHint(parsed);
  const emailOk = email.trim().includes("@");
  const ready =
    emailOk &&
    password.length > 0 &&
    (!confirmMode || (passwordAgain.length > 0 && !passwordProblem));
  const resetReady =
    emailOk &&
    parsed.kind !== "empty" &&
    password.length > 0 &&
    passwordAgain.length > 0 &&
    !passwordProblem;

  useEffect(() => {
    if (resetSent) recoveryRef.current?.focus();
  }, [resetSent]);

  function switchMode(next: FormMode) {
    setMode(next);
    setNotice(null);
    setPassword("");
    setPasswordAgain("");
    setRecoveryPaste("");
    setResetSent(false);
    setShowPassword(false);
    clearError();
  }

  async function submit() {
    if (!ready || busy) return;
    setBusy("submit");
    setNotice(null);
    try {
      if (mode === "new") {
        const result = await signUp(email.trim(), password);
        if (result === "confirm") {
          // Keep the notice; switchMode would wipe it.
          setMode("existing");
          setPassword("");
          setPasswordAgain("");
          setNotice(
            "Account created. Check your email for a confirmation link, then come back and choose “I already have one”.",
          );
          return;
        }
        if (result !== "ok") return;
      } else {
        const ok = await signIn(email.trim(), password);
        if (!ok) return;
      }
      setPassword("");
      setPasswordAgain("");
      onSignedIn?.();
    } finally {
      setBusy(null);
    }
  }

  async function sendReset() {
    if (!emailOk || busy) return;
    setBusy("send");
    setNotice(null);
    try {
      const ok = await requestPasswordReset(email.trim());
      if (!ok) return;
      setResetSent(true);
      setNotice(
        `If ${email.trim()} has an account, it now has a reset code. Type the code below, then choose a new password.`,
      );
    } finally {
      setBusy(null);
    }
  }

  async function finishReset() {
    if (!resetReady || busy) return;
    setBusy("finish");
    setNotice(null);
    try {
      const secret =
        parsed.kind === "otp"
          ? { token: parsed.token }
          : parsed.kind === "hash"
            ? { tokenHash: parsed.tokenHash }
            : parsed.kind === "session"
              ? {
                  accessToken: parsed.accessToken,
                  refreshToken: parsed.refreshToken,
                }
              : {};
      const ok = await completePasswordReset({
        email: email.trim(),
        password,
        ...secret,
      });
      if (!ok) return;
      setPassword("");
      setPasswordAgain("");
      setRecoveryPaste("");
      onSignedIn?.();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {mode !== "recover" && (
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className={mode === "new" ? "btn btn-outline btn-sm" : "btn btn-ghost btn-sm"}
            onClick={() => switchMode("new")}
          >
            Create an account
          </button>
          <button
            type="button"
            className={mode === "existing" ? "btn btn-outline btn-sm" : "btn btn-ghost btn-sm"}
            onClick={() => switchMode("existing")}
          >
            I already have one
          </button>
        </div>
      )}

      {mode === "new" && <BetaNotice />}

      <div>
        <label className="label" htmlFor={`${idPrefix}-email`}>
          Email
        </label>
        <input
          id={`${idPrefix}-email`}
          className="field"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          autoComplete="username"
          autoFocus={autoFocus}
        />
        {mode === "new" && (
          <p className="hint mt-1">
            Yours alone — colleagues never see it. You will use it on every
            machine you code from.
          </p>
        )}
      </div>

      {mode !== "recover" && (
        <PasswordField
          id={`${idPrefix}-password`}
          label="Password"
          value={password}
          onChange={setPassword}
          placeholder={mode === "new" ? "At least 6 characters" : undefined}
          autoComplete={mode === "new" ? "new-password" : "current-password"}
          revealed={showPassword}
          onRevealToggle={() => setShowPassword((v) => !v)}
          onEnter={() => {
            if (mode === "existing") void submit();
            else if (ready) void submit();
          }}
        />
      )}

      {mode === "new" && (
        <div>
          <PasswordField
            id={`${idPrefix}-password-again`}
            label="Confirm password"
            value={passwordAgain}
            onChange={setPasswordAgain}
            autoComplete="new-password"
            revealed={showPassword}
            onEnter={() => void submit()}
          />
          {passwordProblem && (
            <p className="mt-1 text-[12.5px]" style={{ color: "var(--warn)" }}>
              {passwordProblem}
            </p>
          )}
        </div>
      )}

      {mode === "recover" && (
        <>
          <p className="hint">
            We email a short code. Type it here, then choose a new password.
            There is nothing to click in the message.
          </p>
          <button
            type="button"
            className="btn btn-outline btn-sm self-start"
            disabled={!emailOk || busy !== null}
            onClick={() => void sendReset()}
          >
            {busy === "send" ? "Sending…" : resetSent ? "Send again" : "Send reset email"}
          </button>
          <div>
            <label className="label" htmlFor={`${idPrefix}-recovery`}>
              Reset code
            </label>
            <textarea
              ref={recoveryRef}
              id={`${idPrefix}-recovery`}
              className="field"
              rows={2}
              value={recoveryPaste}
              onChange={(e) => setRecoveryPaste(e.target.value)}
              placeholder="The code from the email"
              autoComplete="off"
              spellCheck={false}
            />
            {pasteHint && <p className="hint mt-1">{pasteHint}</p>}
          </div>
          <PasswordField
            id={`${idPrefix}-new-password`}
            label="New password"
            value={password}
            onChange={setPassword}
            placeholder="At least 6 characters"
            autoComplete="new-password"
            revealed={showPassword}
            onRevealToggle={() => setShowPassword((v) => !v)}
          />
          <div>
            <PasswordField
              id={`${idPrefix}-new-password-again`}
              label="Confirm password"
              value={passwordAgain}
              onChange={setPasswordAgain}
              autoComplete="new-password"
              revealed={showPassword}
              onEnter={() => void finishReset()}
            />
            {passwordProblem && (
              <p className="mt-1 text-[12.5px]" style={{ color: "var(--warn)" }}>
                {passwordProblem}
              </p>
            )}
          </div>
        </>
      )}

      {notice && <div className="notice notice-warn">{notice}</div>}
      {storeError && (
        <p className="text-[12.5px]" style={{ color: "var(--danger)" }} role="alert">
          {storeError}
        </p>
      )}

      {mode === "recover" ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!resetReady || busy !== null}
            onClick={() => void finishReset()}
          >
            {busy === "finish" ? "Saving…" : "Set new password"}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={busy !== null}
            onClick={() => switchMode("existing")}
          >
            Back to sign in
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn btn-primary btn-sm self-start"
            disabled={!ready || busy !== null}
            onClick={() => void submit()}
          >
            {busy === "submit"
              ? "Working…"
              : mode === "new"
                ? "Create account"
                : "Sign in"}
          </button>
          {mode === "existing" && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy !== null}
              onClick={() => switchMode("recover")}
            >
              Forgot password?
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  placeholder,
  revealed,
  onRevealToggle,
  onEnter,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  placeholder?: string;
  revealed: boolean;
  onRevealToggle?: () => void;
  onEnter?: () => void;
}) {
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          className="field min-w-0 flex-1"
          type={revealed ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          onKeyDown={(e) => {
            if (e.key === "Enter") onEnter?.();
          }}
        />
        {onRevealToggle && (
          <button
            type="button"
            className="btn btn-ghost btn-sm shrink-0"
            onClick={onRevealToggle}
            aria-pressed={revealed}
          >
            {revealed ? "Hide" : "Show"}
          </button>
        )}
      </div>
    </div>
  );
}
