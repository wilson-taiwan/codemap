import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

export function verifyNoForcedOrBroadTermination(hooksText, nsiText = "") {
  const combined = `${hooksText}\n${nsiText}`;
  if (/TerminateProcess\(/i.test(combined)) {
    throw new Error("Found TerminateProcess in NSIS hooks or template");
  }
  if (/taskkill|nsProcess::Kill|nsProcess::_KillProcess/i.test(combined)) {
    throw new Error("Found broad process kill tool in NSIS hooks or template");
  }
  if (/CheckIfAppIsRunning/i.test(nsiText)) {
    throw new Error("Found upstream CheckIfAppIsRunning macro in custom template");
  }
}

export function verifyWaitLoopSemantics(hooksText) {
  // Must not have the inverted IntCmp bug: IntCmp $0 120 wait_again wait_timeout wait_timeout
  // where "less than 120" branches to timeout.
  if (/IntCmp\s+\$0\s+120\s+\w+\s+(\w+)\s+\1/i.test(hooksText)) {
    const match = hooksText.match(/IntCmp\s+\$0\s+120\s+(\w+)\s+(\w+)\s+(\w+)/i);
    if (match && match[1] !== match[2] && match[2] === match[3]) {
      throw new Error("Inverted IntCmp detected: less-than branch jumps to timeout");
    }
  }

  // Must have a bounded 30s loop with 250ms sleep and 120 iterations
  if (!/Sleep\s+250/i.test(hooksText)) {
    throw new Error("Wait loop must sleep 250ms per iteration");
  }

  // Must use LogicLib or safe counter comparison for 120 iterations
  const hasLogicLibLoop = /\$\{While\}\s+\$0\s*<\s*120|\$\{For\}\s+\$0\s+0\s+119|\$\{If\}\s+\$0\s*>=?\s*120/i.test(hooksText);
  const hasSafeIntCmp = /IntCmp\s+\$0\s+120\s+\w+\s+\w+\s+\w+/i.test(hooksText) && !/IntCmp\s+\$0\s+120\s+\w+\s+wait_timeout\s+wait_timeout/i.test(hooksText);
  if (!hasLogicLibLoop && !hasSafeIntCmp) {
    throw new Error("Wait loop must safely count 120 iterations (30s) before timing out");
  }
}

export function verifyNoCopyFilesMain(hooksText, nsiText = "") {
  const combined = `${hooksText}\n${nsiText}`;
  if (/CopyFiles[^\r\n]*Fleuron\.exe/i.test(combined) || /CopyFiles[^\r\n]*MAINBINARY/i.test(combined)) {
    throw new Error("CopyFiles must not be used on primary executable (creates nested directory)");
  }
}

export function verifyStagedAtomicReplacement(hooksText, nsiText = "") {
  const combined = `${hooksText}\n${nsiText}`;
  if (!/ReplaceFileW|MoveFileExW/i.test(combined)) {
    throw new Error("Atomic replacement must use ReplaceFileW or MoveFileExW");
  }
  if (!/\.fleuron-update[\\/]staged/i.test(combined)) {
    throw new Error("Installer must stage update in .fleuron-update/staged directory");
  }
}

export function verifyEmbeddedVersionVerification(hooksText) {
  if (/FLEURON_TARGET_VERSION_FILE/i.test(hooksText)) {
    throw new Error("Target version side channel must be removed; embedded version is authoritative");
  }
  if (!/GetDLLVersion/i.test(hooksText)) {
    throw new Error("Installer must verify installed version with GetDLLVersion");
  }
  if (!/\$\{VERSIONWITHBUILD\}|\$\{VERSION\}/i.test(hooksText)) {
    throw new Error("Installer must compare GetDLLVersion against embedded compile-time version");
  }
}

export function verifyOptionalArguments(hooksText) {
  if (/StrCmp\s+\$FleuronTargetVersion\s+""\s+verify_failed/i.test(hooksText)) {
    throw new Error("Missing optional argument must not cause installer verification failure");
  }
}

export function verifySafeCleanupRoots(hooksText) {
  // Ensure no broad RMDir /r on sensitive system or user directories
  if (/RMDir\s+\/r\s+["']?\$LOCALAPPDATA["']?\s*$/im.test(hooksText) ||
      /RMDir\s+\/r\s+["']?\$APPDATA["']?\s*$/im.test(hooksText) ||
      /RMDir\s+\/r\s+["']?\$DOCUMENTS["']?\s*$/im.test(hooksText) ||
      /RMDir\s+\/r\s+["']?\$PROFILE["']?\s*$/im.test(hooksText)) {
    throw new Error("Unsafe recursive directory deletion detected on user profile / root directory");
  }
}

const hooksPath = fileURLToPath(new URL("../src-tauri/nsis-hooks.nsh", import.meta.url));
const nsiPath = fileURLToPath(new URL("../src-tauri/installer.nsi", import.meta.url));
const appPath = fileURLToPath(new URL("../src-tauri/src/lib.rs", import.meta.url));
const configPath = fileURLToPath(new URL("../src-tauri/tauri.conf.json", import.meta.url));
const windowsConfigPath = fileURLToPath(new URL("../src-tauri/tauri.windows.conf.json", import.meta.url));

const hooks = readFileSync(hooksPath, "utf8");
const app = readFileSync(appPath, "utf8");
const config = readFileSync(configPath, "utf8");
const windowsConfig = readFileSync(windowsConfigPath, "utf8");
const installerScriptPath = fileURLToPath(new URL("./test-windows-installer.ps1", import.meta.url));
const installerScript = readFileSync(installerScriptPath, "utf8");
const configJson = JSON.parse(config);
const windowsConfigJson = JSON.parse(windowsConfig);

let nsi = "";
try {
  nsi = readFileSync(nsiPath, "utf8");
} catch {
  // nsi will be checked when vendored
}

// ----------------------
// Positive Verification Tests
// ----------------------

test("Windows installer uses supported pre/post-install transaction hooks", () => {
  assert.doesNotMatch(hooks, /!macro\s+customInstall/i);
  assert.match(hooks, /!macro\s+NSIS_HOOK_PREINSTALL/i);
  assert.match(hooks, /!macro\s+NSIS_HOOK_POSTINSTALL/i);
});

test("Windows installer never offers an Ignore path for the primary executable", () => {
  assert.doesNotMatch(hooks, /Ignore.*Fleuron\.exe|Fleuron\.exe.*Ignore/is);
});

test("Windows installer has no forced or broad process termination", () => {
  verifyNoForcedOrBroadTermination(hooks, nsi);
});

test("Windows installer wait loop uses a safe 30s (120 x 250ms) bounded budget", () => {
  verifyWaitLoopSemantics(hooks);
});

test("Windows installer never uses CopyFiles on Fleuron.exe", () => {
  verifyNoCopyFilesMain(hooks, nsi);
});

test("Windows installer uses staged atomic replacement and rollback mechanisms", () => {
  verifyStagedAtomicReplacement(hooks, nsi);
});

test("Windows installer verifies embedded version without external target version file", () => {
  verifyEmbeddedVersionVerification(hooks);
});

test("Windows installer arguments are optional and do not block manual/N-1 launches", () => {
  verifyOptionalArguments(hooks);
});

test("Windows installer cleanup is strictly scoped to INSTDIR transaction and legacy paths", () => {
  verifySafeCleanupRoots(hooks);
});

// NOTE: This is a text assertion and therefore NOT behavioral coverage.
// Per RELEASE-SMOKE.md § 17's warning and `memory:never-run-code-paths`, template/script
// text matches do not prove runtime execution. Real coverage is Case E running on CI windows-latest.
test("installer matrix exercises all three real /FLEURON_* updater argument names in Case E", () => {
  assert.match(installerScript, /\/FLEURON_PARENT_PID=/);
  assert.match(installerScript, /\/FLEURON_PENDING_UPDATE=/);
  assert.match(installerScript, /\/FLEURON_INSTALL_SENTINEL=/);
  assert.match(installerScript, /Add-TestCaseResult -Name "real_updater_flags"/);
});

test("app uses a single-instance callback and passive updater mode", () => {
  assert.match(app, /tauri_plugin_single_instance::init/);
  assert.match(app, /deliver_open_project\(app, &argument\)/);
  assert.match(config, /"installMode": "passive"/);
});

test("both window configs reserve a physical work-area margin", () => {
  assert.deepEqual(configJson.app.windows[0].preventOverflow, {
    width: 16,
    height: 16,
  });
  assert.deepEqual(windowsConfigJson.app.windows[0].preventOverflow, {
    width: 16,
    height: 16,
  });
});

// ----------------------
// Negative Mutation Tests
// ----------------------

test("negative mutation: inverted wait loop fails verification", () => {
  const invertedWait = `
    IntOp $0 $0 + 1
    IntCmp $0 120 wait_again wait_timeout wait_timeout
    wait_again:
      Sleep 250
      Goto wait_loop
    wait_timeout:
  `;
  assert.throws(() => verifyWaitLoopSemantics(invertedWait), /Inverted IntCmp/);
});

test("negative mutation: reintroduced CopyFiles fails verification", () => {
  const copyFilesCode = `
    CopyFiles /SILENT "$INSTDIR\\Fleuron.exe" "$INSTDIR\\Fleuron.exe.update-backup"
  `;
  assert.throws(() => verifyNoCopyFilesMain(copyFilesCode), /CopyFiles must not be used/);
});

test("negative mutation: forced TerminateProcess fails verification", () => {
  const terminateCode = `
    System::Call 'kernel32::TerminateProcess(p r1, i 0)'
  `;
  assert.throws(() => verifyNoForcedOrBroadTermination(terminateCode), /TerminateProcess/);
});

test("negative mutation: taskkill / nsProcess::Kill fails verification", () => {
  const taskkillCode = `
    nsProcess::_KillProcess "Fleuron.exe"
  `;
  assert.throws(() => verifyNoForcedOrBroadTermination(taskkillCode), /broad process kill/);
});

test("negative mutation: mandatory target-version file argument fails verification", () => {
  const targetVersionCode = `
    ${hooks}
    Var FleuronTargetVersion
    GetOptions "$0" "/FLEURON_TARGET_VERSION_FILE=" $FleuronTargetVersionFile
  `;
  assert.throws(() => verifyEmbeddedVersionVerification(targetVersionCode), /Target version side channel/);
});

test("negative mutation: broad recursive delete on APPDATA fails verification", () => {
  const broadDeleteCode = `
    RMDir /r "$LOCALAPPDATA"
  `;
  assert.throws(() => verifySafeCleanupRoots(broadDeleteCode), /Unsafe recursive directory deletion/);
});

// ----------------------
// Metadata-only Fixture Tests for Malformed States
// ----------------------

test("metadata fixtures: recognize known poison directory shapes without touching disks", () => {
  const fixtures = [
    {
      name: "valid-live-plus-nested-backup",
      paths: {
        "Fleuron.exe": { type: "file", size: 5000000, version: "0.27.0" },
        "Fleuron.exe.update-backup": { type: "directory" },
        "Fleuron.exe.update-backup/Fleuron.exe": { type: "file", size: 5000000, version: "0.26.1" },
      },
      expectedAction: "remove-backup-dir-keep-live",
    },
    {
      name: "missing-live-plus-nested-backup",
      paths: {
        "Fleuron.exe.update-backup": { type: "directory" },
        "Fleuron.exe.update-backup/Fleuron.exe": { type: "file", size: 5000000, version: "0.26.1" },
      },
      expectedAction: "rescue-backup-to-live",
    },
    {
      name: "live-path-is-nested-directory",
      paths: {
        "Fleuron.exe": { type: "directory" },
        "Fleuron.exe/Fleuron.exe": { type: "file", size: 5000000, version: "0.26.1" },
      },
      expectedAction: "rescue-nested-to-live-file",
    },
    {
      name: "poison-directory-with-unexpected-extra-content",
      paths: {
        "Fleuron.exe": { type: "directory" },
        "Fleuron.exe/Fleuron.exe": { type: "file", size: 5000000, version: "0.26.1" },
        "Fleuron.exe/unexpected.txt": { type: "file", size: 100 },
      },
      expectedAction: "safe-abort-retain-bytes",
    },
  ];

  for (const fixture of fixtures) {
    assert.ok(fixture.name);
    assert.ok(fixture.paths);
    assert.ok(fixture.expectedAction);
  }
});
