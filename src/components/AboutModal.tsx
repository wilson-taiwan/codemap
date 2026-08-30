import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { AppVersionInfo } from "../lib/types";
import { useAppStore } from "../store/app-store";
import { useGuideStore } from "../store/guide-store";
import {
  DATA_BOUNDARY_SUMMARY,
  OFFICIAL_URLS,
} from "../content/trust-and-permissions";
import { UpdateAction } from "./UpdateAction";
import { Modal } from "./ui/Surfaces";

export function AboutModal() {
  const showAbout = useAppStore((s) => s.showAbout);
  const closeAbout = useAppStore((s) => s.closeAbout);
  const openGuide = useGuideStore((s) => s.openGuide);
  const openTrustCenterSection = useAppStore((s) => s.openTrustCenter);
  const [info, setInfo] = useState<AppVersionInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const [reportText, setReportText] = useState<string | null>(null);
  const [loadingReport, setLoadingReport] = useState(false);
  const [copiedReport, setCopiedReport] = useState(false);

  useEffect(() => {
    if (!showAbout) {
      setReportText(null);
      setLoadingReport(false);
      setCopiedReport(false);
      return;
    }
    api.getAppVersion().then(setInfo).catch(() => setInfo(null));
  }, [showAbout]);

  async function copyBuildDetails() {
    if (!info) return;
    const text = [
      `Fleuron ${info.version}`,
      `Build: ${info.build_commit ?? "unknown"}`,
      `Platform: ${navigator.platform}`,
      `Source: ${info.source_url ?? OFFICIAL_URLS.repository}`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be denied; the details are visible on screen anyway.
    }
  }

  async function handleGenerateReport() {
    setLoadingReport(true);
    try {
      const report = await api.generateDiagnosticReport();
      setReportText(report);
    } catch (err) {
      setReportText(`Error generating diagnostic report: ${err}`);
    } finally {
      setLoadingReport(false);
    }
  }

  async function copyReport() {
    if (!reportText) return;
    try {
      await navigator.clipboard.writeText(reportText);
      setCopiedReport(true);
      window.setTimeout(() => setCopiedReport(false), 1500);
    } catch {
      // Clipboard may be denied
    }
  }

  function saveReportToFile() {
    if (!reportText) return;
    const blob = new Blob([reportText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const dateStr = new Date().toISOString().slice(0, 10);
    a.download = `fleuron-diagnostic-report-${dateStr}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <Modal
      open={showAbout}
      onClose={closeAbout}
      title={info?.name ?? "Fleuron"}
      subtitle={`Version ${info?.version ?? "…"}`}
      footer={
        reportText ? (
          <>
            <button
              type="button"
              onClick={() => setReportText(null)}
              className="btn btn-ghost"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => void copyReport()}
              className="btn btn-ghost"
            >
              {copiedReport ? "Copied" : "Copy report"}
            </button>
            <button
              type="button"
              onClick={() => saveReportToFile()}
              className="btn btn-primary"
            >
              Save to file…
            </button>
            <button
              type="button"
              onClick={() => closeAbout()}
              className="btn btn-ghost"
            >
              Done
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => {
                closeAbout();
                openTrustCenterSection();
              }}
              className="btn btn-ghost gap-1.5"
            >
              Trust &amp; permissions
            </button>
            <button
              type="button"
              onClick={() => {
                closeAbout();
                openGuide("getting-started");
              }}
              className="btn btn-ghost"
            >
              User guide
            </button>
            <button
              type="button"
              onClick={() => void copyBuildDetails()}
              className="btn btn-ghost"
              disabled={!info}
            >
              {copied ? "Copied" : "Copy build details"}
            </button>
            <button
              type="button"
              onClick={() => void handleGenerateReport()}
              className="btn btn-ghost"
              disabled={loadingReport}
            >
              {loadingReport ? "Generating…" : "Generate diagnostic report"}
            </button>
            <button
              type="button"
              onClick={() => closeAbout()}
              className="btn btn-primary"
            >
              Done
            </button>
          </>
        )
      }
    >
      {reportText ? (
        <div className="space-y-3">
          <div className="rounded-[12px] border border-[var(--border)] bg-[var(--fill)] p-3">
            <p className="text-[12.5px] font-medium" style={{ color: "var(--ink-1)" }}>
              Diagnostic report preview
            </p>
            <p className="mt-1 text-[12px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
              This is everything that will be saved. It contains no transcript text, participant labels, or code names. Read it before you share it.
            </p>
          </div>
          <div className="max-h-[260px] overflow-y-auto rounded-[12px] border border-[var(--border)] bg-[var(--bg-inset)] p-3">
            <pre className="font-mono text-[11.5px] whitespace-pre-wrap select-text leading-relaxed" style={{ color: "var(--ink-2)" }}>
              {reportText}
            </pre>
          </div>
        </div>
      ) : (
        <>
      <p className="text-[13.5px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
        Offline-first qualitative coding for reflexive thematic analysis.
        Import transcripts in any common format, code passages against a living
        codebook, and export coded segments as CSV and markdown.{" "}
        {DATA_BOUNDARY_SUMMARY}
      </p>

      <div className="mt-4 rounded-[12px] border border-[var(--border)] p-3">
        <div className="text-[12.5px]" style={{ color: "var(--ink-2)" }}>
          <span className="font-medium">Build</span>{" "}
          <span className="font-mono break-all">{info?.build_commit ?? "…"}</span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px]">
          <a href={OFFICIAL_URLS.website} target="_blank" rel="noreferrer" className="underline">
            Website
          </a>
          <a href={info?.source_url ?? undefined} target="_blank" rel="noreferrer" className="underline">
            Source
          </a>
          <a href={OFFICIAL_URLS.releases} target="_blank" rel="noreferrer" className="underline">
            Official releases
          </a>
          <a href={info?.install_guide_url ?? undefined} target="_blank" rel="noreferrer" className="underline">
            Install guide
          </a>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <UpdateAction />
      </div>

      {info?.copyright && <p className="hint mt-4">{info.copyright}</p>}
        </>
      )}
    </Modal>
  );
}
