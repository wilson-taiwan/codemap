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

  useEffect(() => {
    if (!showAbout) {
      return;
    }
    api.getAppVersion().then(setInfo).catch(() => setInfo(null));
  }, [showAbout]);

  async function copyBuildDetails() {
    if (!info) return;
    const text = [
      `Codemap ${info.version}`,
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

  return (
    <Modal
      open={showAbout}
      onClose={closeAbout}
      title={info?.name ?? "Codemap"}
      subtitle={`Version ${info?.version ?? "…"}`}
      footer={
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
            onClick={() => closeAbout()}
            className="btn btn-primary"
          >
            Done
          </button>
        </>
      }
    >
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
    </Modal>
  );
}
