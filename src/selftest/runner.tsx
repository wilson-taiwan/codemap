import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { api } from "../lib/api";
import { auditContrast } from "../lib/contrast-audit";

interface SuiteResult {
  suite: string;
  passed: boolean;
  status?: "passed" | "failed" | "skipped";
  error?: string;
  duration_ms?: number;
}

export function SelftestRunner() {
  const [activeSuite, setActiveSuite] = useState<string>("Initializing");
  const [results, setResults] = useState<SuiteResult[]>([]);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function runAllSuites() {
      const suiteResults: SuiteResult[] = [];

      async function runSuite(
        name: string,
        fn: () => Promise<void>,
        options?: { allowSkip?: boolean },
      ) {
        if (cancelled) return;
        setActiveSuite(name);
        const start = performance.now();
        try {
          await fn();
          const duration_ms = Math.round(performance.now() - start);
          suiteResults.push({
            suite: name,
            passed: true,
            status: "passed",
            duration_ms,
          });
        } catch (e) {
          const duration_ms = Math.round(performance.now() - start);
          const error = e instanceof Error ? e.message : String(e);
          if (options?.allowSkip && error.startsWith("SKIP:")) {
            suiteResults.push({
              suite: name,
              passed: true,
              status: "skipped",
              error: error.slice(5).trim(),
              duration_ms,
            });
          } else {
            suiteResults.push({
              suite: name,
              passed: false,
              status: "failed",
              error,
              duration_ms,
            });
          }
        }
        setResults([...suiteResults]);
      }

      // Suite 1: bundle-freshness
      await runSuite("bundle-freshness", async () => {
        const ver = await api.getAppVersion();
        if (!ver || !ver.name) {
          throw new Error("Failed to retrieve valid app version info");
        }
      });

      // Suite 2: window-drag
      await runSuite("window-drag", async () => {
        const dragRegions = document.querySelectorAll("[data-tauri-drag-region]");
        if (dragRegions.length === 0) {
          throw new Error("No data-tauri-drag-region elements found in DOM");
        }
        const topStrip = document.querySelector('[data-tauri-drag-region="deep"]');
        if (!topStrip) {
          throw new Error("Missing data-tauri-drag-region='deep' titlebar strip");
        }
      });

      let projectDir = "";

      // Suite 3: codebook-drag-nest
      await runSuite("codebook-drag-nest", async () => {
        // Seed test project
        const seedResult = await invoke<{ project_path: string }>("selftest_seed", {
          suite: "codebook-drag-nest",
        });
        if (seedResult?.project_path) {
          projectDir = seedResult.project_path;
        }
        const codesBefore = await api.listCodes();
        const c1 = codesBefore.find((c) => c.id === "c1");
        const c2 = codesBefore.find((c) => c.id === "c2");
        if (!c1 || !c2) throw new Error("Seed codes c1 and c2 not found");

        // Reparent c2 -> c1
        await api.updateCode({ ...c2, parent_id: c1.id });
        const codesAfterNest = await api.listCodes();
        const c2Nested = codesAfterNest.find((c) => c.id === "c2");
        if (c2Nested?.parent_id !== "c1") {
          throw new Error(`Expected c2.parent_id to be 'c1', got ${c2Nested?.parent_id}`);
        }

        // Promote c2 back to top level
        await api.updateCode({ ...c2, parent_id: null });
        const codesAfterPromote = await api.listCodes();
        const c2Promoted = codesAfterPromote.find((c) => c.id === "c2");
        if (c2Promoted?.parent_id !== null) {
          throw new Error(`Expected c2.parent_id to be null, got ${c2Promoted?.parent_id}`);
        }
      });

      // Suite 4: pdf-export
      await runSuite("pdf-export", async () => {
        const tempPath = projectDir
          ? `${projectDir}/selftest_export_${Date.now()}.pdf`
          : `selftest_export_${Date.now()}.pdf`;
        const sampleHtml = `<!DOCTYPE html><html><body><h1>Selftest Qualitative Report</h1><p>Verifying WKWebView / Edge PDF export in CI.</p></body></html>`;
        await api.renderReportPdf(sampleHtml, tempPath);
      });

      // Suite 5: dark-mode-contrast
      await runSuite("dark-mode-contrast", async () => {
        const findings = auditContrast(document);
        if (findings.length > 0) {
          throw new Error(
            `Found ${findings.length} contrast violations (expected 0): ${findings[0]?.selector}`,
          );
        }
      });

      // Suite 7: ipc-surface
      await runSuite("ipc-surface", async () => {
        const prefs = await api.getAppPreferences();
        if (!prefs) throw new Error("getAppPreferences returned null");
        const activity = await api.listActivity();
        if (!Array.isArray(activity)) throw new Error("listActivity did not return an array");
        const info = await api.getProjectInfo();
        if (!info || !info.title) throw new Error("getProjectInfo returned invalid data");
      });

      // Suite 8: group-lifecycle-online (Task 9: 4-phase full lifecycle)
      await runSuite(
        "group-lifecycle-online",
        async () => {
          const isOnlineAvailable = await invoke<boolean>("selftest_online_status");
          if (!isOnlineAvailable) {
            throw new Error(
              "SKIP: Missing CODEMAP_STAGING_* environment variables for online lifecycle suite",
            );
          }

          // Phase 1: Owner creates study, Joiner joins, baseline roster
          await invoke("selftest_sign_in_as", { role: "owner" });
          const ownerPath = await invoke<string>("selftest_seed_unbound", { coderName: "Owner Coder" });

          const testTitle = `Selftest Lifecycle ${Date.now()}`;
          const created = await api.syncCreateProject(testTitle);
          if (!created.groupKey || !created.projectId) {
            throw new Error("syncCreateProject failed to return groupKey or projectId");
          }

          const ownerInfo = await api.syncGroupInfo();
          if (ownerInfo.members.length !== 1 || !ownerInfo.members[0].isYou) {
            throw new Error("Owner not reflected in group info roster");
          }

          // Joiner signs in and joins
          await invoke("selftest_sign_in_as", { role: "joiner" });
          const joinerPath = await invoke<string>("selftest_seed_unbound", { coderName: "Joiner Coder" });
          const joined = await api.syncJoinGroup(created.groupKey, "Joiner Coder");
          if (joined.projectId !== created.projectId) {
            throw new Error("Joined project ID did not match created group ID");
          }

          // Phase 2: Joiner uses syncDetachLocal, creates 2 local memos, codes passages. Owner codes on server.
          await api.syncDetachLocal();

          await api.createCode({ name: "Detached Code 1", color: "#3b82f6" });
          await api.createCode({ name: "Detached Code 2", color: "#10b981" });
          const joinerIv = await api.createInterview({
            participant_label: "P-Joiner",
            interviewers: [],
          });
          await api.updateHubMemo(joinerIv.id, "Private local memo from joiner");

          const deletionSummaryBefore = await api.projectDeletionSummary(joinerPath);
          if (deletionSummaryBefore.memo_count < 1) {
            throw new Error("Local memo not detected in deletion summary");
          }

          // Owner signs back in and creates codes on server
          await invoke("selftest_sign_in_as", { role: "owner" });
          await api.openProject(ownerPath);
          await api.syncJoinProject(created.projectId);
          await api.createCode({ name: "Owner Code 1", color: "#ec4899" });
          await api.createCode({ name: "Owner Code 2", color: "#8b5cf6" });
          await api.syncNow();

          // Phase 3: Joiner re-joins study; both sync; verify convergence & memo privacy
          await invoke("selftest_sign_in_as", { role: "joiner" });
          await api.openProject(joinerPath);
          await api.syncJoinGroup(created.groupKey, "Joiner Coder");
          await api.syncNow();

          const joinerDeletionSummary = await api.projectDeletionSummary(joinerPath);
          if (joinerDeletionSummary.memo_count < 1) {
            throw new Error("Joiner lost local memos after rebind");
          }

          // Owner pulls and verifies joiner's codes arrived, but NOT local memos
          await invoke("selftest_sign_in_as", { role: "owner" });
          await api.openProject(ownerPath);
          await api.syncNow();
          const ownerCodes = await api.listCodes();
          const hasJoinerCode = ownerCodes.some((c) => c.name === "Detached Code 1");
          if (!hasJoinerCode) {
            throw new Error("Owner did not receive Joiner's re-bound codes");
          }
          const ownerDeletionSummary = await api.projectDeletionSummary(ownerPath);
          if (ownerDeletionSummary.memo_count !== 0) {
            throw new Error("Joiner's local memos leaked to Owner via sync");
          }

          // Phase 4: Owner deletes group on server; Joiner leaves locally (404 clean leave); both delete project folders
          await api.syncDeleteGroup(testTitle);

          await invoke("selftest_sign_in_as", { role: "joiner" });
          await api.openProject(joinerPath);
          await api.syncLeaveGroup(); // Should cleanly succeed on 404

          // Both delete folders with fallback
          await api.deleteProjectFolder(joinerPath);
          await api.deleteProjectFolder(ownerPath);
        },
        { allowSkip: true },
      );

      setDone(true);

      // Report back to backend
      try {
        await invoke("selftest_report", { results: suiteResults });
      } catch (err) {
        console.error("Failed to report selftest results:", err);
      }
    }

    void runAllSuites();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-[999999] flex flex-col p-8 font-mono text-xs"
      style={{ backgroundColor: "rgb(10, 10, 10)", color: "rgb(245, 245, 245)" }}
    >
      <div
        className="mb-6 flex items-center justify-between border-b pb-4"
        style={{ borderColor: "rgb(38, 38, 38)" }}
      >
        <div>
          <h1
            className="text-base font-bold"
            style={{ color: "rgb(255, 255, 255)", backgroundColor: "rgb(10, 10, 10)" }}
          >
            CODEMAP SELFTEST RUNNER
          </h1>
          <p
            className="mt-1"
            style={{ color: "rgb(163, 163, 163)", backgroundColor: "rgb(10, 10, 10)" }}
          >
            Status: {done ? "Completed" : `Running: ${activeSuite}`}
          </p>
        </div>
        <div className="text-right">
          <span
            className="rounded px-2.5 py-1"
            style={{ backgroundColor: "rgb(38, 38, 38)", color: "rgb(212, 212, 212)" }}
          >
            {results.filter((r) => r.passed).length}/{results.length} Passed
          </span>
        </div>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto">
        {results.map((r) => (
          <div
            key={r.suite}
            className="flex items-center justify-between rounded p-2.5"
            style={{
              backgroundColor: r.passed
                ? "rgb(6, 44, 28)"
                : r.status === "skipped"
                  ? "rgb(40, 35, 10)"
                  : "rgb(60, 15, 20)",
              color: r.passed
                ? "rgb(167, 243, 208)"
                : r.status === "skipped"
                  ? "rgb(253, 224, 71)"
                  : "rgb(254, 205, 211)",
            }}
          >
            <div className="flex items-center gap-2">
              <span>{r.passed ? (r.status === "skipped" ? "↷" : "✓") : "❌"}</span>
              <span className="font-semibold">{r.suite}</span>
              {r.error && (
                <span
                  className="ml-2"
                  style={{
                    color: r.status === "skipped" ? "rgb(250, 204, 21)" : "rgb(251, 113, 133)",
                  }}
                >
                  ({r.error})
                </span>
              )}
            </div>
            {r.duration_ms !== undefined && (
              <span style={{ color: "rgb(115, 115, 115)" }}>{r.duration_ms}ms</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
