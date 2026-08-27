import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { AppVersionInfo } from "../lib/types";
import { isMac, platform } from "../lib/platform";
import {
  CANONICAL_ASSETS,
  CRASH_LOG_CAUTION,
  DATA_BOUNDARY,
  DATA_BOUNDARY_SUMMARY,
  FILE_ACCESS_NOTES,
  MACOS_WARNING_CARDS,
  NETWORK_BEHAVIOR,
  NETWORK_NOTES,
  NOT_REQUESTED_CAPABILITIES,
  OFFICIAL_URLS,
  PROVENANCE_SIGNALS,
  PUBLISHER_VERIFICATION_NOTICE,
  STORED_SIGN_IN,
  SUPPORT_CHANNELS,
  SUPPORT_MATRIX,
  WINDOWS_WARNING_CARDS,
  type WarningCard,
} from "../content/trust-and-permissions";
import { useAppStore } from "../store/app-store";
import { SideSheet } from "./ui/Surfaces";

type OsTab = "macos" | "windows";
type TrustSection =
  | "build"
  | "warnings"
  | "files"
  | "data"
  | "network"
  | "signin"
  | "support";

const SECTION_IDS: TrustSection[] = [
  "warnings",
  "files",
  "data",
  "network",
  "signin",
  "support",
];

const SECTION_TITLES: Record<TrustSection, string> = {
  build: "This build",
  warnings: "Installation warnings",
  files: "Files & permissions",
  data: "Local vs collaboration",
  network: "Network",
  signin: "Stored sign-in",
  support: "Support",
};

function WarningRow({ card }: { card: WarningCard }) {
  const stop = card.meaning !== "expected";
  return (
    <div
      className="rounded-[12px] border p-3"
      style={{
        borderColor: stop ? "var(--danger)" : "var(--border)",
        background: stop ? "var(--danger-soft)" : "var(--fill)",
      }}
    >
      <p className="text-[13px] font-medium">{card.signal}</p>
      <p className="mt-1 text-[12.5px]" style={{ color: "var(--ink-2)" }}>
        {card.explanation}
      </p>
      {card.userAction && (
        <p className="mt-1 text-[12.5px]">
          <span className="font-medium">
            {stop ? "Stop." : "What to do:"}
          </span>{" "}
          {!stop && card.userAction}
          {stop &&
            // The userAction for stop-cards starts with its own instruction;
            // strip a redundant leading "Stop." for readability.
            card.userAction.replace(/^Stop\. /, "")}
        </p>
      )}
    </div>
  );
}

/**
 * The calm, always-reachable trust surface. Never appears on its own at
 * launch; every entry point (first-run link, Welcome, Settings, About, guide)
 * opens this sheet explicitly.
 */
export function TrustCenterPanel() {
  const open = useAppStore((s) => s.showTrustCenter);
  const close = useAppStore((s) => s.closeTrustCenter);
  const trustSection = useAppStore((s) => s.trustSection);
  const [tab, setTab] = useState<OsTab>(isMac ? "macos" : "windows");
  const [info, setInfo] = useState<AppVersionInfo | null>(null);

  useEffect(() => {
    if (!open) return;
    api.getAppVersion().then(setInfo).catch(() => setInfo(null));
  }, [open]);

  // Deep-link scroll target when opened with a specific section.
  useEffect(() => {
    if (!open || !trustSection) return;
    const el = document.getElementById(`trust-section-${trustSection}`);
    el?.scrollIntoView({ block: "start" });
  }, [open, trustSection]);

  const cards = tab === "macos" ? MACOS_WARNING_CARDS : WINDOWS_WARNING_CARDS;

  return (
    <SideSheet
      open={open}
      onClose={close}
      title="Trust & permissions"
      subtitle="What Codemap asks of your system, and what to expect."
    >
      <div className="scroll flex-1 space-y-7 px-5 py-5">
        {/* This build */}
        <section id="trust-section-build">
          <h3 className="eyebrow">This build</h3>
          <div className="mt-3 rounded-[12px] border border-[var(--border)] p-3 text-[13px]">
            <div className="flex items-center justify-between gap-3">
              <span>Version</span>
              <span className="font-mono">{info?.version ?? "…"}</span>
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-3">
              <span>Build commit</span>
              <span className="font-mono break-all text-right">
                {info?.build_commit ?? "…"}
              </span>
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-3">
              <span>Platform</span>
              <span className="font-mono capitalize">
                {platform === "other" ? "desktop" : platform}
              </span>
            </div>
            <button
              type="button"
              className="btn btn-outline btn-sm mt-3"
              onClick={() => {
                void navigator.clipboard
                  .writeText(
                    [
                      `Codemap ${info?.version ?? ""}`,
                      `Build: ${info?.build_commit ?? ""}`,
                      `Platform: ${navigator.platform}`,
                      `Source: ${info?.source_url ?? OFFICIAL_URLS.repository}`,
                    ].join("\n"),
                  )
                  .catch(() => {});
              }}
            >
              Copy build details
            </button>
          </div>
          <p className="hint mt-2">{PUBLISHER_VERIFICATION_NOTICE}</p>
          <ul className="mt-2 space-y-1.5">
            {PROVENANCE_SIGNALS.map((signal) => (
              <li key={signal.signal} className="text-[12.5px]" style={{ color: "var(--ink-2)" }}>
                <span className="font-medium">{signal.signal}:</span>{" "}
                {signal.proves} <em>{signal.doesNotProve}</em>
              </li>
            ))}
          </ul>
        </section>

        {/* Installation warnings */}
        <section id="trust-section-warnings">
          <h3 className="eyebrow">Installation warnings</h3>
          <div className="mt-3 flex items-center gap-2" role="tablist" aria-label="Operating system">
            {(["macos", "windows"] as OsTab[]).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`btn btn-sm ${
                  tab === t ? "btn-primary" : "btn-outline"
                }`}
              >
                {t === "macos" ? "macOS" : "Windows"}
              </button>
            ))}
          </div>

          {/* Supported matrix */}
          <div className="mt-3 rounded-[12px] border border-[var(--border)] p-3">
            {SUPPORT_MATRIX.map((row) => (
              <div key={row.platform} className="text-[12.5px] leading-relaxed">
                <span
                  className="font-medium"
                  style={{
                    color:
                      row.tier === "supported"
                        ? "var(--accent)"
                        : row.tier === "unsupported"
                          ? "var(--danger)"
                          : "var(--ink-2)",
                  }}
                >
                  {row.tier === "supported"
                    ? "Supported:"
                    : row.tier === "best-effort"
                      ? "Best effort:"
                      : "Unsupported:"}
                </span>{" "}
                {row.platform} — {row.note}
              </div>
            ))}
          </div>

          <div className="mt-3 flex flex-col gap-2.5">
            {cards.map((card) => (
              <WarningRow key={card.signal} card={card} />
            ))}
          </div>
        </section>

        {/* Files & permissions */}
        <section id="trust-section-files">
          <h3 className="eyebrow">Files &amp; permissions</h3>
          {FILE_ACCESS_NOTES.map((note) => (
            <div key={note.title} className="mt-2 text-[13px]">
              <p className="font-medium">{note.title}</p>
              <p className="mt-0.5 text-[12.5px]" style={{ color: "var(--ink-2)" }}>
                {note.detail}
              </p>
            </div>
          ))}
          <p className="hint mt-2">
            Codemap does not request: {NOT_REQUESTED_CAPABILITIES.join(", ")}.
          </p>
        </section>

        {/* Local vs collaboration */}
        <section id="trust-section-data">
          <h3 className="eyebrow">Local vs collaboration</h3>
          <p className="mt-2 text-[13px] font-medium">{DATA_BOUNDARY_SUMMARY}</p>
          <table className="mt-3 w-full text-left text-[12px]">
            <thead>
              <tr style={{ color: "var(--ink-3)" }}>
                <th className="py-1 pr-2 font-medium">Category</th>
                <th className="py-1 pr-2 font-medium">Synced when collaborating</th>
                <th className="py-1 font-medium">Stays local</th>
              </tr>
            </thead>
            <tbody>
              {DATA_BOUNDARY.map((row) => (
                <tr key={row.category} className="border-t border-[var(--border)] align-top">
                  <td className="py-2 pr-2 font-medium">{row.category}</td>
                  <td className="py-2 pr-2" style={{ color: "var(--ink-2)" }}>
                    {row.syncedWhenCollaborating}
                  </td>
                  <td className="py-2" style={{ color: "var(--ink-2)" }}>
                    {row.keptLocal}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* Network */}
        <section id="trust-section-network">
          <h3 className="eyebrow">Network</h3>
          <div className="mt-2 space-y-1.5 text-[12.5px]">
            {NETWORK_BEHAVIOR.map((n) => (
              <p key={n.purpose}>
                <span className="font-medium">{n.purpose}</span> —{" "}
                {n.endpoint}, outbound {n.protocol.replace("Outbound ", "")}.
                {n.enabledByDefault
                  ? " On by default (see Settings)."
                  : " Only after you act."}
              </p>
            ))}
          </div>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[12.5px]" style={{ color: "var(--ink-2)" }}>
            {NETWORK_NOTES.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </section>

        {/* Stored sign-in */}
        <section id="trust-section-signin">
          <h3 className="eyebrow">Stored sign-in</h3>
          <p className="mt-2 text-[12.5px]" style={{ color: "var(--ink-2)" }}>
            {isMac ? STORED_SIGN_IN.macos : STORED_SIGN_IN.windows}
          </p>
          <p className="mt-2 text-[12.5px]" style={{ color: "var(--ink-2)" }}>
            {STORED_SIGN_IN.universalNote}
          </p>
        </section>

        {/* Support */}
        <section id="trust-section-support">
          <h3 className="eyebrow">Support</h3>
          <div className="mt-2 space-y-2 text-[13px]">
            {SUPPORT_CHANNELS.map((channel) => (
              <div key={channel.label}>
                <a href={channel.url} target="_blank" rel="noreferrer" className="underline">
                  {channel.label}
                </a>
                <span style={{ color: "var(--ink-3)" }}> — {channel.where}</span>
                {channel.caution && (
                  <p className="text-[12px]" style={{ color: "var(--ink-2)" }}>
                    {channel.caution}
                  </p>
                )}
              </div>
            ))}
          </div>
          <p className="hint mt-3">{CRASH_LOG_CAUTION}</p>
          <p className="hint mt-2">
            Downloads live only at{" "}
            <a href={OFFICIAL_URLS.releases} target="_blank" rel="noreferrer" className="underline">
              {OFFICIAL_URLS.releases}
            </a>{" "}
            ({CANONICAL_ASSETS.macos} / {CANONICAL_ASSETS.windows}). Advanced
            verification steps are in the install guide.
          </p>
        </section>
      </div>
    </SideSheet>
  );
}

export { SECTION_IDS as TRUST_SECTION_IDS, SECTION_TITLES as TRUST_SECTION_TITLES };
