import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { save } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { api } from "../lib/api";
import type { ProjectFileEntry } from "../lib/types";
import { fileManagerName } from "../lib/platform";
import { useProjectStore } from "../store/project-store";
import { SideSheet } from "./ui/Surfaces";
import { Icon } from "./ui/Icon";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ProjectFilesPanel() {
  const {
    showProjectFiles,
    setShowProjectFiles,
    project,
    requestExportProject,
    exporting,
  } = useProjectStore(
    useShallow((s) => ({
      showProjectFiles: s.showProjectFiles,
      setShowProjectFiles: s.setShowProjectFiles,
      project: s.project,
      requestExportProject: s.requestExportProject,
      exporting: s.exporting,
    })),
  );
  const [files, setFiles] = useState<ProjectFileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prevExporting = useRef(false);

  async function loadFiles() {
    setLoading(true);
    setError(null);
    try {
      const entries = await api.listProjectFiles();
      setFiles(entries);
      if (entries.length > 0) {
        setSelectedPath((current) =>
          current && entries.some((e) => e.path === current)
            ? current
            : entries[0].path,
        );
      } else {
        setSelectedPath(null);
        setPreview(null);
      }
    } catch (e) {
      setError(String(e));
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!showProjectFiles) return;
    loadFiles();
  }, [showProjectFiles]);

  useEffect(() => {
    if (prevExporting.current && !exporting && showProjectFiles) loadFiles();
    prevExporting.current = exporting;
  }, [exporting, showProjectFiles]);

  useEffect(() => {
    if (!selectedPath) {
      setPreview(null);
      return;
    }
    const entry = files.find((f) => f.path === selectedPath);
    if (!entry || entry.kind === "other") {
      setPreview(null);
      return;
    }
    setPreviewLoading(true);
    api
      .readTextFile(selectedPath)
      .then(setPreview)
      .catch(() => setPreview("(Could not preview this file.)"))
      .finally(() => setPreviewLoading(false));
  }, [selectedPath, files]);

  async function handleCopyOut(file: ProjectFileEntry) {
    const dest = await save({ defaultPath: file.name, title: "Copy export to…" });
    if (!dest) return;
    await api.copyProjectFile(file.path, dest as string);
  }

  async function handleRevealExports() {
    if (!project) return;
    await openPath(`${project.path}/exports`);
  }

  const selectedFile = files.find((f) => f.path === selectedPath);

  return (
    <SideSheet
      open={showProjectFiles}
      onClose={() => setShowProjectFiles(false)}
      title="Project files"
      subtitle="Exported CSV, HTML reports, and matrix"
      width="max-w-2xl"
      actions={
        <>
          <button
            type="button"
            onClick={() => requestExportProject()}
            disabled={exporting}
            className="btn btn-outline btn-sm"
          >
            <Icon name="refresh" size={13} />
            {exporting ? "Exporting…" : "Export…"}
          </button>
          <button
            type="button"
            onClick={() => handleRevealExports()}
            className="btn btn-ghost btn-sm"
          >
            {fileManagerName}
          </button>
        </>
      }
    >
      {error && (
        <p
          className="mx-5 mt-3 rounded-[12px] px-3 py-2 text-[12.5px]"
          style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
        >
          {error}
        </p>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,240px)_1fr]">
        <div className="scroll p-2.5">
          {loading ? (
            <p className="hint p-2">Loading…</p>
          ) : files.length === 0 ? (
            <p className="hint p-2">
              No exports yet. Use Export… to generate CSV, HTML reports, and matrix.
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {files.map((file) => {
                const active = selectedPath === file.path;
                return (
                  <li key={file.path}>
                    <button
                      type="button"
                      onClick={() => setSelectedPath(file.path)}
                      className="w-full rounded-[11px] px-2.5 py-2 text-left text-[12px] transition-colors"
                      style={{
                        background: active ? "var(--accent-soft)" : "transparent",
                        color: active ? "var(--accent)" : "var(--ink)",
                      }}
                    >
                      <span className="block truncate font-medium">
                        {file.name}
                      </span>
                      <span
                        className="mt-0.5 block truncate text-[11px]"
                        style={{ color: active ? "inherit" : "var(--ink-3)" }}
                      >
                        {file.relative_path} · {formatSize(file.size)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex min-h-0 flex-col">
          {selectedFile ? (
            <>
              <div className="flex items-center justify-between gap-2 px-3 py-2">
                <p className="truncate text-[12px] font-medium">
                  {selectedFile.name}
                </p>
                <button
                  type="button"
                  onClick={() => handleCopyOut(selectedFile)}
                  className="btn btn-ghost btn-sm shrink-0"
                >
                  Copy to…
                </button>
              </div>
              <pre
                className="scroll flex-1 whitespace-pre-wrap px-3 pb-3 font-mono text-[11.5px] leading-relaxed"
                style={{ color: "var(--ink-2)" }}
              >
                {previewLoading
                  ? "Loading preview…"
                  : (preview ?? "(No preview for this file type.)")}
              </pre>
            </>
          ) : (
            <p className="hint p-4">Select a file to preview.</p>
          )}
        </div>
      </div>
    </SideSheet>
  );
}
