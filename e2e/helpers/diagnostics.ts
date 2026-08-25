import type { Page, TestInfo } from "@playwright/test";

type ConsoleLine = { type: string; text: string };

export function watchPageDiagnostics(page: Page) {
  const consoleLines: ConsoleLine[] = [];
  page.on("console", (msg) => {
    consoleLines.push({ type: msg.type(), text: msg.text() });
  });
  page.on("pageerror", (err) => {
    consoleLines.push({ type: "pageerror", text: err.message });
  });
  return consoleLines;
}

export async function flushDiagnostics(
  page: Page,
  testInfo: TestInfo,
  consoleLines: ConsoleLine[],
) {
  testInfo.attach("browser-console", {
    body: Buffer.from(JSON.stringify(consoleLines)),
    contentType: "application/json",
  });

  const ipcLog = await page
    .evaluate(() => {
      const w = window as unknown as { __CODEMAP_IPC_LOG__?: unknown[] };
      return w.__CODEMAP_IPC_LOG__ ?? [];
    })
    .catch(() => []);

  testInfo.attach("ipc-log", {
    body: Buffer.from(JSON.stringify(ipcLog)),
    contentType: "application/json",
  });
}
