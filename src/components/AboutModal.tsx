import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { AppVersionInfo } from "../lib/types";
import { useAppStore } from "../store/app-store";
import { useGuideStore } from "../store/guide-store";
import { UpdateAction } from "./UpdateAction";
import { Modal } from "./ui/Surfaces";

export function AboutModal() {
  const showAbout = useAppStore((s) => s.showAbout);
  const closeAbout = useAppStore((s) => s.closeAbout);
  const openGuide = useGuideStore((s) => s.openGuide);
  const [info, setInfo] = useState<AppVersionInfo | null>(null);

  useEffect(() => {
    if (!showAbout) {
      return;
    }
    api.getAppVersion().then(setInfo).catch(() => setInfo(null));
  }, [showAbout]);

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
              openGuide("getting-started");
            }}
            className="btn btn-ghost"
          >
            User guide
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
        Offline-first qualitative coding for reflexive thematic analysis. Import
        transcripts in any common format, code passages against a living
        codebook, and export coded segments as CSV and markdown. Coding syncs
        between coders as opaque ids; transcripts never leave your computer.
      </p>

      <div className="mt-4 flex items-center gap-3">
        <UpdateAction />
      </div>

      {info?.copyright && <p className="hint mt-4">{info.copyright}</p>}
    </Modal>
  );
}
