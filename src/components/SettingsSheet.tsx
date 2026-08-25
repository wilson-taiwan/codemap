import { useEffect, useState } from "react";
import { useAppStore, type ThemePreference } from "../store/app-store";
import { useSyncStore } from "../store/sync-store";
import { SideSheet } from "./ui/Surfaces";
import { AccountForm } from "./AccountForm";
import { api } from "../lib/api";
import { UpdateStatus } from "./UpdateAction";

const THEMES: { value: ThemePreference; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

/**
 * App-wide preferences, one sheet. Everything here is also reachable from
 * somewhere more specific — theme used to live in both overflow menus, the
 * merge toggle used to sit under the transcript — but "where was that
 * checkbox again" is a question the app should never make somebody ask.
 * Changes save immediately; there is no Apply.
 */
export function SettingsSheet() {
  const open = useAppStore((s) => s.showSettings);
  const close = useAppStore((s) => s.closeSettings);
  const theme = useAppStore((s) => s.preferences.theme);
  const reopenLast = useAppStore((s) => s.preferences.reopen_last_project);
  const mergeSameSpeaker = useAppStore(
    (s) => s.preferences.merge_same_speaker,
  );
  const coachDismissed = useAppStore((s) => s.preferences.coach_dismissed);
  const setTheme = useAppStore((s) => s.setTheme);
  const setReopenLast = useAppStore((s) => s.setReopenLastProject);
  const setMergeSameSpeaker = useAppStore((s) => s.setMergeSameSpeaker);
  const setCoachDismissed = useAppStore((s) => s.setCoachDismissed);
  const inGroup = useSyncStore((s) => s.status?.inGroup ?? false);
  const signedIn = useSyncStore((s) => s.status?.signedIn ?? false);
  const signedInEmail = useSyncStore((s) => s.status?.signedInEmail);
  const signOut = useSyncStore((s) => s.signOut);
  const refreshStatus = useSyncStore((s) => s.refreshStatus);
  const [crashCopyStatus, setCrashCopyStatus] = useState<string | null>(null);

  async function handleCopyCrashLog() {
    try {
      const log = await api.readCrashLog();
      if (!log || log.trim().length === 0) {
        setCrashCopyStatus("No crash logs recorded");
      } else {
        await navigator.clipboard.writeText(log);
        setCrashCopyStatus("Copied to clipboard");
      }
    } catch {
      setCrashCopyStatus("Failed to read crash log");
    }
    setTimeout(() => setCrashCopyStatus(null), 2500);
  }

  useEffect(() => {
    if (open) void refreshStatus();
  }, [open, refreshStatus]);

  const resolved: ThemePreference =
    theme === "dark" || theme === "system" ? theme : "light";

  return (
    <SideSheet
      open={open}
      onClose={close}
      title="Settings"
      subtitle="App-wide preferences. Changes save immediately."
      width="max-w-md"
    >
      <div className="scroll flex-1 space-y-7 px-5 py-5">
        <section>
          <h3 className="eyebrow">Account</h3>
          {signedIn ? (
            <div className="mt-3">
              <p className="text-[13px]">
                Signed in
                {signedInEmail ? (
                  <>
                    {" "}
                    as <span className="font-medium">{signedInEmail}</span>
                  </>
                ) : null}
                . A sign-in token stays in this machine's keychain so you do
                not re-enter the password every launch. The password itself is
                never stored.
              </p>
              <button
                type="button"
                className="btn btn-outline btn-sm mt-3"
                onClick={() => void signOut()}
              >
                Sign out of Codemap
              </button>
              <p className="hint mt-2">
                Signing out does not leave a group or unbind a folder. It only
                forgets this account on this machine.
              </p>
            </div>
          ) : (
            <div className="mt-3">
              <p className="hint mb-3">
                One account per person. Joining a group is a separate step —
                an account on its own grants nothing.
              </p>
              <AccountForm autoFocus />
            </div>
          )}
        </section>

        <section>
          <h3 className="eyebrow">Appearance</h3>
          <div
            className="mt-3 grid grid-cols-3 gap-1 rounded-[var(--r-md)] p-1"
            style={{ background: "var(--fill)" }}
            role="radiogroup"
            aria-label="Theme"
          >
            {THEMES.map((t) => {
              const active = resolved === t.value;
              return (
                <button
                  key={t.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => void setTheme(t.value)}
                  className="btn"
                  style={
                    active
                      ? {
                          background: "var(--fill-on)",
                          boxShadow: "var(--shadow-1)",
                          fontWeight: 600,
                        }
                      : { background: "transparent", color: "var(--ink-2)" }
                  }
                >
                  {t.label}
                </button>
              );
            })}
          </div>
          <p className="hint mt-2">
            System follows macOS. Light is the default — transcripts are
            long-form reading.
          </p>
        </section>

        <section>
          <h3 className="eyebrow">Transcript import</h3>
          <label className={`mt-3 flex items-start gap-2.5 ${inGroup ? "opacity-60 cursor-not-allowed" : "cursor-pointer"}`}>
            <input
              type="checkbox"
              checked={mergeSameSpeaker}
              disabled={inGroup}
              onChange={(e) => void setMergeSameSpeaker(e.target.checked)}
              className="mt-0.5"
              style={{ accentColor: "var(--accent)" }}
            />
            <span>
              <span className="block text-[13px] font-medium">
                Merge consecutive turns by the same speaker
              </span>
              <span className="hint mt-0.5 block">
                {inGroup
                  ? `This setting is pinned to the study (${
                      mergeSameSpeaker ? "merged" : "unmerged"
                    }) so all coders produce identical passage segmentation.`
                  : "When importing, glue adjacent turns by one speaker into a single turn. Turn this off if your transcripts mark a new turn wherever a quotation starts."}
              </span>
            </span>
          </label>
        </section>

        <section>
          <h3 className="eyebrow">General</h3>
          <label className="mt-3 flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={reopenLast}
              onChange={(e) => void setReopenLast(e.target.checked)}
              className="mt-0.5"
              style={{ accentColor: "var(--accent)" }}
            />
            <span>
              <span className="block text-[13px] font-medium">
                Reopen the last project on launch
              </span>
              <span className="hint mt-0.5 block">
                Off means Codemap always starts at the project library.
              </span>
            </span>
          </label>
        </section>

        <section>
          <h3 className="eyebrow">Guidance</h3>
          <button
            type="button"
            className="btn btn-outline mt-3"
            disabled={!coachDismissed}
            onClick={() => void setCoachDismissed(false)}
          >
            Show the next-step coach again
          </button>
          <p className="hint mt-2">
            {coachDismissed
              ? "Brings back the floating card that suggests what to do next."
              : "The coach is already visible — it appears whenever a setup step is still ahead of you."}
          </p>
        </section>

        <UpdateStatus />

        <section>
          <h3 className="eyebrow">Support & Diagnostics</h3>
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={() => void handleCopyCrashLog()}
            >
              Copy crash log
            </button>
            {crashCopyStatus && (
              <span className="text-[12.5px] font-medium" style={{ color: "var(--ink-2)" }}>
                {crashCopyStatus}
              </span>
            )}
          </div>
          <p className="hint mt-2">
            Crash logs are stored locally on this machine and contain no participant data or credentials.
          </p>
        </section>
      </div>
    </SideSheet>
  );
}
