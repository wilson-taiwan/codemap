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
  const windowsBundle = windowsConfJson?.bundle?.windows;
  const nsisConf = windowsBundle?.nsis;
  if (!nsisConf) {
    throw new Error("Missing bundle.windows.nsis configuration in tauri.windows.conf.json");
  }
  if (nsisConf.template !== "installer.nsi") {
    throw new Error(`NSIS template must be configured as 'installer.nsi', got: ${nsisConf.template}`);
  }
  if (nsisConf.installerHooks !== "nsis-hooks.nsh") {
    throw new Error(`NSIS installerHooks must be 'nsis-hooks.nsh', got: ${nsisConf.installerHooks}`);
  }
  if (JSON.stringify(windowsConfJson?.bundle?.targets) !== JSON.stringify(["nsis"])) {
    throw new Error(`Windows bundle targets must be exactly ["nsis"], got: ${JSON.stringify(windowsConfJson?.bundle?.targets)}`);
  }
  if (windowsBundle?.webviewInstallMode?.type !== "skip") {
    throw new Error("webviewInstallMode must be exactly 'skip' — Fleuron never downloads, bundles, or repairs WebView2");
  }
  if (nsisConf.installMode !== "currentUser") {
    throw new Error(`NSIS installMode must be exactly 'currentUser' (no elevation), got: ${nsisConf.installMode}`);
  }
}

/**
 * Security-control tripwire: the shipped installer surface (template + hooks)
 * must not mutate Defender/SmartScreen/firewall/Cert stores or kill
 * processes/apps broadly. Matched case-insensitively against instruction
 * shaped lines only (comments about NOT doing these are fine).
 */
export function verifyNoSecurityMutations(nsiText, hooksText = "") {
  const combined = `${nsiText}\n${hooksText}`;
  const banned = [
    /netsh\s+advfirewall/i,
    /Add-MpPreference|Set-MpPreference|MpCmdRun/i,
    /add-firewall|netsh.*firewall/i,
    /certutil|Import-Certificate/i,
    /DisableObsoleteCipherSuites|SmartScreenDism/i,
    /taskkill\s+\/f\s+\/im\s+(?!.*(fleuron))/i,
  ];
  for (const re of banned) {
    // Strip pure comment lines first so guidance comments don't false-positive.
    const stripped = combined.replace(/^\s*#.*$/gm, "").replace(/^\s*;.*/gm, "");
    if (re.test(stripped)) {
      throw new Error(`Installer surface contains a forbidden security mutation matching ${re}`);
    }
  }
}

export function verifyCurrentUserExecutionBranch(nsiText) {
  const perMachineAdmin = /!if\s+"\$\{INSTALLMODE\}"\s*==\s*"perMachine"[\s\S]{0,120}?RequestExecutionLevel admin/.test(nsiText);
  if (!perMachineAdmin) {
    throw new Error("Template drift expected upstream shape: perMachine branch maps to RequestExecutionLevel admin");
  }
  const currentUserUser = /!if\s+"\$\{INSTALLMODE\}"\s*==\s*"currentUser"[\s\S]{0,120}?RequestExecutionLevel user/.test(nsiText);
  if (!currentUserUser) {
    throw new Error("currentUser branch must request execution level 'user' — no elevation ever");
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
  if (!/\.fleuron-update/i.test(combined)) {
    throw new Error("Uninstaller must clean up .fleuron-update transaction directory");
  }
  if (/RMDir\s+\/r\s+.*app_data|RMDir\s+\/r\s+.*app\.fleuron/i.test(combined)) {
    throw new Error("Uninstaller must never delete persistent application data");
  }
}

export function verifySingleSilentGuardedQuit(nsiText) {
  const lines = nsiText.split(/\r?\n/);
  const onInstSuccess = lines.findIndex((line) => line.trim() === "Function .onInstSuccess");
  if (onInstSuccess === -1) {
    throw new Error("Missing Function .onInstSuccess callback");
  }
  const onInstSuccessEnd = lines.findIndex(
    (line, index) => index > onInstSuccess && line.trim() === "FunctionEnd"
  );
  if (onInstSuccessEnd === -1) {
    throw new Error("Function .onInstSuccess is missing FunctionEnd");
  }

  const silentGuardedQuits = [];
  for (let start = 0; start < lines.length - 1; start += 1) {
    const isSilentPassiveGuard =
      /^\s*\$\{If\}\s+\$PassiveMode\s*=\s*1\s*$/.test(lines[start]) &&
      /^\s*\$\{OrIf\}\s+\$\{Silent\}\s*$/.test(lines[start + 1]);
    if (!isSilentPassiveGuard) continue;

    const scopeEnd = lines.findIndex(
      (line, index) => index > start && /^(FunctionEnd|SectionEnd)$/.test(line.trim())
    );
    if (scopeEnd === -1) {
      throw new Error("$PassiveMode/${Silent} guard has no enclosing FunctionEnd or SectionEnd");
    }

    let depth = 1;
    let end = -1;
    let quitCount = 0;
    for (let lineIndex = start + 2; lineIndex < scopeEnd; lineIndex += 1) {
      const line = lines[lineIndex];
      if (/^\s*Quit\s*$/.test(line)) quitCount += 1;
      if (/^\s*\$\{(?:If|IfNot|IfThen)\}\s*/.test(line)) depth += 1;
      if (/^\s*\$\{EndIf\}\s*$/.test(line)) {
        depth -= 1;
        if (depth === 0) {
          end = lineIndex;
          break;
        }
      }
    }
    if (end === -1) {
      if (quitCount > 0) {
        throw new Error("Unclosed $PassiveMode/${Silent} guard containing Quit in installer.nsi");
      }
      continue;
    }
    if (quitCount > 0) {
      silentGuardedQuits.push({ start, end, quitCount });
    }
    start = end;
  }

  if (silentGuardedQuits.length !== 1) {
    throw new Error(
      `Expected exactly one Quit inside a $PassiveMode/\${Silent} guard, found ${silentGuardedQuits.length}`
    );
  }

  const [guard] = silentGuardedQuits;
  if (guard.quitCount !== 1) {
    throw new Error(`Expected one Quit in the silent/passive guard, found ${guard.quitCount}`);
  }
  if (guard.start <= onInstSuccess || guard.end >= onInstSuccessEnd) {
    throw new Error("The only silent/passive Quit must be inside Function .onInstSuccess");
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

test("windows package contract: NSIS-only targets, currentUser, WebView skip", () => {
  const winConf = JSON.parse(readFileSync(`${root}src-tauri/tauri.windows.conf.json`, "utf8"));
  // Covered implicitly by verifyWindowsTemplateConfig via the config test
  // above; assert the specific invariants here so a mutation names itself.
  verifyWindowsTemplateConfig(winConf);
});

test("installer surface performs no security-control mutations", () => {
  const hooks = readFileSync(`${root}src-tauri/nsis-hooks.nsh`, "utf8");
  const nsi = readFileSync(`${root}src-tauri/installer.nsi`, "utf8");
  verifyNoSecurityMutations(nsi, hooks);
});

test("execution-level branches map perMachine→admin, currentUser→user", () => {
  const nsi = readFileSync(`${root}src-tauri/installer.nsi`, "utf8");
  verifyCurrentUserExecutionBranch(nsi);
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

test("silent/passive relaunch has exactly one Quit in .onInstSuccess", () => {
  const nsi = readFileSync(`${root}src-tauri/installer.nsi`, "utf8");
  verifySingleSilentGuardedQuit(nsi);
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

test("negative mutation: currentUser→perMachine fails verification", () => {
  const winConf = JSON.parse(readFileSync(`${root}src-tauri/tauri.windows.conf.json`, "utf8"));
  const mutated = structuredClone(winConf);
  mutated.bundle.windows.nsis.installMode = "perMachine";
  assert.throws(() => verifyWindowsTemplateConfig(mutated), /must be exactly 'currentUser'/);
});

test("negative mutation: skip→downloadBootstrapper WebView mode fails verification", () => {
  const winConf = JSON.parse(readFileSync(`${root}src-tauri/tauri.windows.conf.json`, "utf8"));
  const mutated = structuredClone(winConf);
  mutated.bundle.windows.webviewInstallMode.type = "downloadBootstrapper";
  assert.throws(() => verifyWindowsTemplateConfig(mutated), /webviewInstallMode must be exactly 'skip'/);
});

test("negative mutation: extra MSI target fails verification", () => {
  const winConf = JSON.parse(readFileSync(`${root}src-tauri/tauri.windows.conf.json`, "utf8"));
  const mutated = structuredClone(winConf);
  mutated.bundle.targets = ["nsis", "msi"];
  assert.throws(() => verifyWindowsTemplateConfig(mutated), /exactly \["nsis"\]/);
});

test("negative mutation: added Defender exclusion fails security-mutation scan", () => {
  assert.throws(
    () => verifyNoSecurityMutations("ExecWait 'powershell -Command Add-MpPreference -ExclusionPath $INSTDIR'", ""),
    /forbidden security mutation/
  );
});

test("negative mutation: firewall allow rule in template fails scan", () => {
  assert.throws(
    () => verifyNoSecurityMutations('ExecWait \'netsh advfirewall firewall add rule name="Fleuron" dir=in\'', ""),
    /forbidden security mutation/
  );
});

test("negative mutation: duplicate silent/passive Quit fails verification", () => {
  const nsi = readFileSync(`${root}src-tauri/installer.nsi`, "utf8");
  const duplicateGuard = [
    "  ${If} $PassiveMode = 1",
    "  ${OrIf} ${Silent}",
    "    Quit",
    "  ${EndIf}",
  ].join("\n");
  const withDuplicate = nsi.replace(
    "SectionEnd\n\nFunction .onInstSuccess",
    `${duplicateGuard}\nSectionEnd\n\nFunction .onInstSuccess`
  );
  assert.throws(
    () => verifySingleSilentGuardedQuit(withDuplicate),
    /Expected exactly one Quit/
  );
});
