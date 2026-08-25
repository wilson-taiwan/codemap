import { describe, expect, it } from "vitest";
import type { DiagnosticsReport } from "../lib/types";

describe("Sync Diagnostics", () => {
  it("formats clock skew accurately", () => {
    const formatSkew = (skew: number | null | undefined) => {
      if (skew === undefined || skew === null) return "Unknown";
      if (Math.abs(skew) < 2) return "In sync (<2s)";
      return `${skew}s difference`;
    };

    expect(formatSkew(null)).toBe("Unknown");
    expect(formatSkew(0)).toBe("In sync (<2s)");
    expect(formatSkew(1)).toBe("In sync (<2s)");
    expect(formatSkew(-1)).toBe("In sync (<2s)");
    expect(formatSkew(5)).toBe("5s difference");
    expect(formatSkew(-12)).toBe("-12s difference");
  });

  it("handles diagnostics report with missing remote coding", () => {
    const report: DiagnosticsReport = {
      localCodedCount: 10,
      localCodeCount: 5,
      remoteCodedCount: 15,
      remoteCodeCount: 5,
      missingRemoteCodedCount: 5,
      missingRemoteCoderNames: ["Bob"],
      pendingToSendCount: 0,
      clockSkewSeconds: 0,
      summaryMessage: "5 coded passages from Bob are missing on this computer.",
      rawCodedCursor: "2026-08-22T00:00:00Z",
      rawCodebookCursor: "2026-08-22T00:00:00Z",
      rawInterviewCursor: "2026-08-22T00:00:00Z",
      lastSyncedAt: "2026-08-22T12:00:00Z",
      needsRepair: true,
      needsSend: false,
      lastError: null,
      lastOutcome: null,
    };

    expect(report.needsRepair).toBe(true);
    expect(report.missingRemoteCodedCount).toBe(5);
    expect(report.summaryMessage).toContain("missing on this computer");
  });

  it("handles clean matching state", () => {
    const report: DiagnosticsReport = {
      localCodedCount: 20,
      localCodeCount: 8,
      remoteCodedCount: 20,
      remoteCodeCount: 8,
      missingRemoteCodedCount: 0,
      missingRemoteCoderNames: [],
      pendingToSendCount: 0,
      clockSkewSeconds: 0,
      summaryMessage: "Everything matches. 20 coded passages, 8 codes.",
      rawCodedCursor: "2026-08-22T12:00:00Z",
      rawCodebookCursor: "2026-08-22T12:00:00Z",
      rawInterviewCursor: "2026-08-22T12:00:00Z",
      lastSyncedAt: "2026-08-22T12:00:00Z",
      needsRepair: false,
      needsSend: false,
      lastError: null,
      lastOutcome: null,
    };

    expect(report.needsRepair).toBe(false);
    expect(report.needsSend).toBe(false);
    expect(report.summaryMessage).toBe("Everything matches. 20 coded passages, 8 codes.");
  });
});
