import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Modal } from "./ui/Surfaces";
import { Icon } from "./ui/Icon";
import { basename } from "../lib/format";
import { checkStudyLabel } from "../lib/study-label";
import {
  duplicateInfo,
  seedLabelsForFiles,
  suggestLabelForFile,
} from "../lib/bulk-import";
import { useProjectStore } from "../store/project-store";
import { TranscriptLinkPanel } from "./TranscriptLinkPanel";

type RowStatus = "ready" | "working" | "done" | "skipped" | "failed";

interface BulkRow {
  key: string;
  filePath: string;
  label: string;
  status: RowStatus;
  passages: number;
  error: string | null;
}

const TRANSCRIPT_FILTERS = [
  {
    name: "Transcripts",
    extensions: ["vtt", "srt", "txt", "md", "csv", "tsv", "docx"],
  },
  { name: "All files", extensions: ["*"] },
];

/**
 * Bulk transcript import (T05a): many files, one review screen, per-file
 * results. Each row reuses the store's `createInterview` + `importVtt`, so
 * parsing, same-speaker merging, and migration stay in exactly one place.
 * A failing file marks its row and the rest still import.
 */
export function BulkImportModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const interviews = useProjectStore((s) => s.interviews);
  const createInterview = useProjectStore((s) => s.createInterview);
  const importVtt = useProjectStore((s) => s.importVtt);
  const showStatus = useProjectStore((s) => s.showStatus);

  const [rows, setRows] = useState<BulkRow[]>([]);
  const [picking, setPicking] = useState(false);
  const [importing, setImporting] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [showLink, setShowLink] = useState(false);

  useEffect(() => {
    if (open) {
      setRows([]);
      setSummary(null);
      setImporting(false);
      setShowLink(false);
    }
  }, [open ]);

  const knownLabels = interviews.map((i) => i.participant_label);

  async function handlePickFiles() {
    setPicking(true);
    try {
      const picked = await openDialog({
        multiple: true,
        filters: TRANSCRIPT_FILTERS,
      });
      if (!picked) return;
      const files = (Array.isArray(picked) ? picked : [picked]).filter(
        (f): f is string => typeof f === "string",
      );
      if (files.length === 0) return;
      const seeds = seedLabelsForFiles(files, knownLabels);
      setRows(
        files.map((filePath, i) => ({
          key: `${filePath}::${i}`,
          filePath,
          label: seeds[i],
          status: "ready" as RowStatus,
          passages: 0,
          error: null,
        })),
      );
      setSummary(null);
    } finally {
      setPicking(false);
    }
  }

  function setRowLabel(key: string, label: string) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, label } : r)));
  }

  function applySuggestion(key: string, suggestion: string) {
    setRowLabel(key, suggestion);
  }

  const takenFor = (key: string) => [
    ...knownLabels,
    ...rows.filter((r) => r.key !== key).map((r) => r.label),
  ];

  const rowProblems = rows.map((r) => {
    if (!r.label.trim()) return "blank" as const;
    if (duplicateInfo(r.label, takenFor(r.key)).isDuplicate) return "duplicate" as const;
    return null;
  });
  const blocked = importing || rows.some((r) => r.status === "working") ||
    rows.length === 0 || rowProblems.some((p) => p !== null);

  async function handleImportAll() {
    if (blocked) return;
    setImporting(true);
    setSummary(null);
    let ok = 0;
    let passages = 0;
    let failed = 0;
    const today = new Date().toISOString().slice(0, 10);
    for (const row of rows) {
      setRows((prev) =>
        prev.map((r) => (r.key === row.key ? { ...r, status: "working", error: null } : r)),
      );
      try {
        const interview = await createInterview(row.label.trim(), today);
        void interview;
        const count = await importVtt(row.filePath);
        if (count === 0) {
          setRows((prev) =>
            prev.map((r) =>
              r.key === row.key ? { ...r, status: "skipped", error: "Import cancelled." } : r,
            ),
          );
        } else {
          ok += 1;
          passages += count;
          setRows((prev) =>
            prev.map((r) =>
              r.key === row.key ? { ...r, status: "done", passages: count } : r,
            ),
          );
        }
      } catch (err) {
        failed += 1;
        setRows((prev) =>
          prev.map((r) =>
            r.key === row.key
              ? { ...r, status: "failed", error: err instanceof Error ? err.message : String(err) }
              : r,
          ),
        );
      }
    }
    const skipped = rows.length - ok - failed;
    const line = `Imported ${ok} transcript${ok === 1 ? "" : "s"} (${passages} passages)${failed > 0 ? `, ${failed} failed` : ""}${skipped > 0 ? `, ${skipped} skipped` : ""}.`;
    setSummary(line);
    showStatus(line, failed > 0 ? "error" : "success");
    setImporting(false);
  }

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title="Add transcripts"
        subtitle="Pick many files, check the participant IDs, import once."
        width="max-w-lg"
        footer={
          rows.length > 0 ? (
            <>
              <button
                type="button"
                onClick={() => setShowLink(true)}
                className="btn btn-ghost mr-auto"
              >
                Scan a folder instead
              </button>
              <button type="button" onClick={onClose} className="btn btn-ghost">
                {summary ? "Done" : "Cancel"}
              </button>
              {!summary && (
                <button
                  type="button"
                  onClick={handleImportAll}
                  disabled={blocked}
                  className="btn btn-primary"
                >
                  {importing
                    ? "Importing…"
                    : `Import ${rows.length} transcript${rows.length === 1 ? "" : "s"}`}
                </button>
              )}
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setShowLink(true)}
                className="btn btn-ghost mr-auto"
              >
                Scan a folder instead
              </button>
              <button type="button" onClick={onClose} className="btn btn-ghost">
                Cancel
              </button>
              <button
                type="button"
                onClick={handlePickFiles}
                disabled={picking}
                className="btn btn-primary"
              >
                {picking ? "Choosing…" : "Choose files…"}
              </button>
            </>
          )
        }
      >
        {rows.length === 0 ? (
          <div className="flex flex-col gap-2 py-2">
            <p className="hint text-[12.5px]">
              Each file becomes its own participant. Suggested IDs come from
              the file names — fix them here, because the ID is how copies line
              up and it cannot be changed later.
            </p>
            <p className="hint text-[12.5px]">
              Participants already exist without transcript text?{" "}
              <button
                type="button"
                onClick={() => setShowLink(true)}
                className="underline underline-offset-2 hover:text-[var(--ink)]"
              >
                Scan a folder to match files to them
              </button>{" "}
              instead.
            </p>
          </div>
        ) : (
          <div className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto pr-0.5">
            <div className="flex items-center justify-between">
              <p className="hint text-[12px]">
                {rows.length} file{rows.length === 1 ? "" : "s"} — IDs must be
                unique and non-blank.
              </p>
              {!summary && (
                <button
                  type="button"
                  onClick={handlePickFiles}
                  disabled={picking || importing}
                  className="btn btn-ghost btn-sm"
                >
                  <Icon name="plus" size={12} />
                  Add more
                </button>
              )}
            </div>
            {rows.map((row, i) => {
              const problem = rowProblems[i];
              const dup = problem === "duplicate"
                ? duplicateInfo(row.label, takenFor(row.key))
                : null;
              const verdict = checkStudyLabel(
                row.label,
                takenFor(row.key),
                suggestLabelForFile(row.filePath),
              );
              return (
                <div
                  key={row.key}
                  className="rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-2.5"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-[11.5px]"
                      style={{ color: "var(--ink-3)" }}
                      title={row.filePath}
                    >
                      {basename(row.filePath)}
                    </span>
                    <RowBadge status={row.status} passages={row.passages} />
                  </div>
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <input
                      value={row.label}
                      disabled={importing || row.status !== "ready"}
                      onChange={(e) => setRowLabel(row.key, e.target.value)}
                      aria-label={`Participant ID for ${basename(row.filePath)}`}
                      className="field field-sm min-w-0 flex-1"
                    />
                  </div>
                  {problem === "duplicate" && (
                    <p className="mt-1 text-[11.5px]" style={{ color: "var(--danger)" }}>
                      Already in this study.{" "}
                      {dup?.suggestion ? (
                        <button
                          type="button"
                          onClick={() => applySuggestion(row.key, dup.suggestion)}
                          className="underline underline-offset-2"
                        >
                          Use {dup.suggestion}
                        </button>
                      ) : (
                        "Pick a different ID."
                      )}
                    </p>
                  )}
                  {problem === "blank" && (
                    <p className="mt-1 text-[11.5px]" style={{ color: "var(--danger)" }}>
                      Enter a Participant ID to continue.
                    </p>
                  )}
                  {!problem && verdict.warnings.length > 0 && (
                    <p className="hint mt-1 text-[11.5px]">{verdict.warnings[0]}</p>
                  )}
                  {row.status === "failed" && row.error && (
                    <p className="mt-1 text-[11.5px]" style={{ color: "var(--danger)" }}>
                      {row.error}
                    </p>
                  )}
                  {row.status === "skipped" && (
                    <p className="hint mt-1 text-[11.5px]">Skipped — nothing imported.</p>
                  )}
                </div>
              );
            })}
            {summary && (
              <p className="hint mt-1 text-[12.5px]" role="status">
                {summary}
              </p>
            )}
          </div>
        )}
      </Modal>

      {showLink && (
        <TranscriptLinkPanel open={showLink} onClose={() => setShowLink(false)} />
      )}
    </>
  );
}

function RowBadge({ status, passages }: { status: RowStatus; passages: number }) {
  if (status === "done") {
    return (
      <span className="chip shrink-0" title={`${passages} passages imported`}>
        <Icon name="check" size={11} />
        {passages}
      </span>
    );
  }
  if (status === "working") {
    return (
      <span className="chip shrink-0">
        <Icon name="refresh" size={11} />
        Importing…
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="chip shrink-0" style={{ color: "var(--danger)" }}>
        <Icon name="alert" size={11} />
        Failed
      </span>
    );
  }
  if (status === "skipped") {
    return <span className="chip shrink-0">Skipped</span>;
  }
  return null;
}
