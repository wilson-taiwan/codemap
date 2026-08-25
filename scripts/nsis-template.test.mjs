import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

export function verifyTauriCliPin(pkgJson, pkgLockJson) {
  const cliDep = pkgJson.devDependencies?.["@tauri-apps/cli"];
  if (cliDep !== "2.11.3") {
    throw new Error(`@tauri-apps/cli must be pinned exactly to 2.11.3, got: ${cliDep}`);
  }
}

export function verifyWindowsTemplateConfig(windowsConfJson) {
  const nsisConf = windowsConfJson?.bundle?.windows?.nsis;
  if (!nsisConf) {
    throw new Error("Missing bundle.windows.nsis configuration in tauri.windows.conf.json");
  }
  if (nsisConf.template !== "installer.nsi") {
    throw new Error(`NSIS template must be configured as 'installer.nsi', got: ${nsisConf.template}`);
  }
  if (nsisConf.installerHooks !== "nsis-hooks.nsh") {
    throw new Error(`NSIS installerHooks must be 'nsis-hooks.nsh', got: ${nsisConf.installerHooks}`);
  }
}

export function verifyTemplateProvenance(nsiText) {
  if (!/20f4ecc730defb71f1342eaeaec4021df13be3d843abba0effe88ea5835fa079/i.test(nsiText)) {
    throw new Error("Vendored installer.nsi must declare upstream SHA-256 20f4ecc730defb71f1342eaeaec4021df13be3d843abba0effe88ea5835fa079 in header");
  }
  if (!/tauri-cli-v2\.11\.3/i.test(nsiText)) {
    throw new Error("Vendored installer.nsi header must reference upstream tag tauri-cli-v2.11.3");
  }
}

export function verifyTemplateStagedExtraction(nsiText) {
  if (/CheckIfAppIsRunning/i.test(nsiText)) {
    throw new Error("Custom template must remove upstream CheckIfAppIsRunning process-name checks");
  }
  if (!/staged/i.test(nsiText)) {
    throw new Error("Custom template must stage main binary into transaction directory");
  }
}

export function verifyUninstallCleanup(hooksText, nsiText) {
  const combined = `${hooksText}\n${nsiText}`;
  if (!/\.codemap-update/i.test(combined)) {
    throw new Error("Uninstaller must clean up .codemap-update transaction directory");
  }
  if (/RMDir\s+\/r\s+.*app_data|RMDir\s+\/r\s+.*app\.codemap/i.test(combined)) {
    throw new Error("Uninstaller must never delete persistent application data");
  }
}

// ----------------------
// Tests
// ----------------------

test("package.json pins @tauri-apps/cli exactly to 2.11.3", () => {
  const pkg = JSON.parse(readFileSync(`${root}package.json`, "utf8"));
  const pkgLock = JSON.parse(readFileSync(`${root}package-lock.json`, "utf8"));
  verifyTauriCliPin(pkg, pkgLock);
});

test("tauri.windows.conf.json configures custom template installer.nsi", () => {
  const winConf = JSON.parse(readFileSync(`${root}src-tauri/tauri.windows.conf.json`, "utf8"));
  verifyWindowsTemplateConfig(winConf);
});

test("src-tauri/installer.nsi exists and records upstream 2.11.3 provenance", () => {
  assert.ok(existsSync(`${root}src-tauri/installer.nsi`), "src-tauri/installer.nsi must exist");
  const nsi = readFileSync(`${root}src-tauri/installer.nsi`, "utf8");
  verifyTemplateProvenance(nsi);
  verifyTemplateStagedExtraction(nsi);
});

test("uninstaller cleans transaction directories without touching app data", () => {
  const hooks = readFileSync(`${root}src-tauri/nsis-hooks.nsh`, "utf8");
  const nsi = existsSync(`${root}src-tauri/installer.nsi`)
    ? readFileSync(`${root}src-tauri/installer.nsi`, "utf8")
    : "";
  verifyUninstallCleanup(hooks, nsi);
});

// ----------------------
// Negative Mutation Tests
// ----------------------

test("negative mutation: unpinned CLI fails verification", () => {
  assert.throws(
    () => verifyTauriCliPin({ devDependencies: { "@tauri-apps/cli": "^2.11.3" } }, {}),
    /@tauri-apps\/cli must be pinned exactly/
  );
});

test("negative mutation: missing template config fails verification", () => {
  assert.throws(
    () => verifyWindowsTemplateConfig({ bundle: { windows: { nsis: { installMode: "currentUser" } } } }),
    /NSIS template must be configured/
  );
});

test("negative mutation: wrong template hash fails verification", () => {
  assert.throws(
    () => verifyTemplateProvenance("; upstream tag tauri-cli-v2.11.3 sha: deadbeef"),
    /must declare upstream SHA-256/
  );
});

test("negative mutation: retained CheckIfAppIsRunning fails verification", () => {
  assert.throws(
    () => verifyTemplateStagedExtraction("!insertmacro CheckIfAppIsRunning staged"),
    /Custom template must remove upstream CheckIfAppIsRunning/
  );
});
