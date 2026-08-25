import type {
  FullConfig,
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type ConsoleLine = { type: string; text: string };

class LastFailureReporter implements Reporter {
  private outputDir = "test-results";

  onBegin(config: FullConfig) {
    this.outputDir = config.outputDir ?? "test-results";
  }

  onTestEnd(test: TestCase, result: TestResult) {
    if (result.status === "passed" || result.status === "skipped") return;

    mkdirSync(this.outputDir, { recursive: true });
    const path = join(this.outputDir, "last-failure.md");
    const consoleLines = (result.attachments ?? [])
      .filter((a) => a.name === "browser-console")
      .flatMap((a) => {
        try {
          return JSON.parse(a.body?.toString("utf8") ?? "[]") as ConsoleLine[];
        } catch {
          return [];
        }
      });

    const ipcLines = (result.attachments ?? [])
      .filter((a) => a.name === "ipc-log")
      .flatMap((a) => {
        try {
          return JSON.parse(a.body?.toString("utf8") ?? "[]") as unknown[];
        } catch {
          return [];
        }
      });

    const trace = result.attachments?.find((a) => a.name === "trace");
    const screenshot = result.attachments?.find((a) => a.name === "screenshot");

    const body = [
      `# Last Playwright failure`,
      ``,
      `**Test:** ${test.titlePath().join(" › ")}`,
      `**Status:** ${result.status}`,
      `**Duration:** ${result.duration}ms`,
      ``,
      `## Error`,
      ``,
      "```",
      result.error?.message ?? "(no message)",
      "```",
      ``,
      `## Last console lines`,
      ``,
      ...consoleLines.slice(-15).map((l) => `- [${l.type}] ${l.text}`),
      ``,
      `## Last IPC calls (dev-mock)`,
      ``,
      "```json",
      JSON.stringify(ipcLines.slice(-15), null, 2),
      "```",
      ``,
      `## Artifacts`,
      ``,
      screenshot ? `- screenshot: ${screenshot.path}` : "- screenshot: (none)",
      trace ? `- trace: ${trace.path}` : "- trace: (none)",
      ``,
      `_Read this file first, then open the trace zip if present._`,
      ``,
    ].join("\n");

    writeFileSync(path, body, "utf8");
  }

  onEnd(_result: FullResult) {}
}

export default LastFailureReporter;
