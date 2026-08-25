import { useState } from "react";
import { api } from "../lib/api";
import { useSyncStore } from "../store/sync-store";
import type { DiagnosticsReport, SyncStatus } from "../lib/types";
import { Icon } from "./ui/Icon";

interface SyncDiagnosticsProps {
  status: SyncStatus | null;
}

export function SyncDiagnostics({ status }: SyncDiagnosticsProps) {
  const syncing = useSyncStore((s) => s.syncing);
  const error = useSyncStore((s) => s.error);
  const lastOutcome = useSyncStore((s) => s.lastOutcome);
  const syncNow = useSyncStore((s) => s.syncNow);

  const [checking, setChecking] = useState(false);
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [copied, setCopied] = useState(false);
  const [repairing, setRepairing] = useState(false);

  const handleCheck = async () => {
    setChecking(true);
    try {
      const res = await api.syncDeepVerify();
      setReport(res);
    } catch (e) {
      console.error("Failed to deep verify sync:", e);
    } finally {
      setChecking(false);
    }
  };

  const handleRepair = async () => {
    setRepairing(true);
    try {
      await api.syncRepair();
      await handleCheck();
    } catch (e) {
      console.error("Failed to repair sync:", e);
    } finally {
      setRepairing(false);
    }
  };

  const handleCopyDiagnostics = async () => {
    try {
      const text = await api.syncDiagnosticsDump();
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error("Failed to copy diagnostics:", e);
    }
  };

  const lastReceived = status?.lastSyncedAt
    ? new Date(status.lastSyncedAt).toLocaleString()
    : "Never";

  const isConnected =
    status?.realtimeHealth === "connected" ||
    (status?.realtimeHealth === undefined && status?.realtimeConnected);

  const liveState = isConnected
    ? "Connected"
    : status?.realtimeHealth === "connecting"
      ? "Connecting…"
      : "Live updates are unavailable; Codemap is still checking for changes every minute.";

  return (
    <section className="mb-5 border-t pt-4">
      <h3 className="label mb-2">Sync Diagnostics</h3>

      <div className="rounded-lg border bg-surface-base p-3 text-xs space-y-2">
        <div className="flex justify-between">
          <span className="text-muted">Last received from study:</span>
          <span className="font-mono">{lastReceived}</span>
        </div>

        <div className="flex justify-between">
          <span className="text-muted">Waiting to send:</span>
          <span>
            {status?.pendingChanges
              ? `${status.pendingChanges} change${status.pendingChanges === 1 ? "" : "s"}`
              : "0 changes"}
          </span>
        </div>

        <div className="flex justify-between">
          <span className="text-muted">Live connection:</span>
          <span
            className={
              isConnected
                ? "text-[var(--success)] font-medium"
                : "text-muted"
            }
          >
            {liveState}
          </span>
        </div>

        {report?.clockSkewSeconds !== undefined && report.clockSkewSeconds !== null && (
          <div className="flex justify-between">
            <span className="text-muted">Your clock vs. study:</span>
            <span className="font-mono">
              {Math.abs(report.clockSkewSeconds) < 2
                ? "In sync (<2s)"
                : `${report.clockSkewSeconds}s difference`}
            </span>
          </div>
        )}

        <div className="flex justify-between">
          <span className="text-muted">Last problem:</span>
          <span
            className={error ? "text-[var(--danger)] font-medium" : "text-muted"}
          >
            {error || "None"}
          </span>
        </div>

        {report && (
          <div className="mt-3 p-2.5 rounded bg-surface-sunken border border-border/50">
            <p className="font-medium text-xs mb-1.5">{report.summaryMessage}</p>
            <div className="flex gap-2 mt-2">
              {report.needsRepair && (
                <button
                  type="button"
                  className="btn btn-primary btn-xs gap-1"
                  disabled={repairing}
                  onClick={() => void handleRepair()}
                >
                  <Icon name="refresh" size={12} />
                  {repairing ? "Repairing…" : "Repair"}
                </button>
              )}
              {report.needsSend && (
                <button
                  type="button"
                  className="btn btn-outline btn-xs gap-1"
                  disabled={syncing}
                  onClick={() => void syncNow()}
                >
                  <Icon name="refresh" size={12} />
                  Send now
                </button>
              )}
            </div>
          </div>
        )}

        <div className="pt-2 flex items-center gap-2">
          <button
            type="button"
            className="btn btn-outline btn-xs gap-1.5"
            disabled={checking}
            onClick={() => void handleCheck()}
          >
            <Icon name="search" size={12} />
            {checking ? "Checking…" : "Check for problems"}
          </button>
        </div>

        <details className="mt-3 pt-2 border-t border-border/40 text-[11px] text-muted">
          <summary className="cursor-pointer select-none font-medium hover:text-foreground">
            Technical details
          </summary>
          <div className="mt-2 space-y-1.5 font-mono">
            <div>
              <span className="text-muted">Coded cursor: </span>
              <span>{report?.rawCodedCursor ?? "1970-01-01T00:00:00Z"}</span>
            </div>
            <div>
              <span className="text-muted">Codebook cursor: </span>
              <span>{report?.rawCodebookCursor ?? "1970-01-01T00:00:00Z"}</span>
            </div>
            <div>
              <span className="text-muted">Interview cursor: </span>
              <span>{report?.rawInterviewCursor ?? "1970-01-01T00:00:00Z"}</span>
            </div>
            {lastOutcome && lastOutcome.codedReceipt && (
              <>
                <div className="pt-1 text-muted">Last receipt counts:</div>
                <div className="pl-2">
                  Coded: applied {lastOutcome.codedReceipt.applied}, superseded{" "}
                  {lastOutcome.codedReceipt.superseded}, deferred{" "}
                  {lastOutcome.codedReceipt.deferred}
                </div>
                <div className="pl-2">
                  Codes: applied {lastOutcome.codesReceipt.applied}, superseded{" "}
                  {lastOutcome.codesReceipt.superseded}, deferred{" "}
                  {lastOutcome.codesReceipt.deferred}
                </div>
                <div className="pl-2">
                  Interviews: applied {lastOutcome.interviewsReceipt.applied},
                  superseded {lastOutcome.interviewsReceipt.superseded}, deferred{" "}
                  {lastOutcome.interviewsReceipt.deferred}
                </div>
                <div className="pl-2">
                  Truncated: {lastOutcome.truncated ? "Yes" : "No"}
                </div>
              </>
            )}
            <div className="pt-2">
              <button
                type="button"
                className="btn btn-ghost btn-xs gap-1"
                onClick={() => void handleCopyDiagnostics()}
              >
                <Icon name="note" size={12} />
                {copied ? "Copied diagnostics" : "Copy diagnostics"}
              </button>
            </div>
          </div>
        </details>
      </div>
    </section>
  );
}
