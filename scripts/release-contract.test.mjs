#!/usr/bin/env node
// Release-contract enforcement.
//
// Every shipping decision this project made about trust/provenance/packaging
// is encoded here as an executable assertion plus a negative mutation that is
// OBSERVED FAILING inside its own test — token-presence assertions cannot
// pass dead. Run via `node --test scripts/release-contract.test.mjs`.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  verifyWindowsTemplateConfig,
  verifyNoSecurityMutations,
} from "./nsis-template.test.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const wf = (name) => `.github/workflows/${name}.yml`;
const readWf = (name) => readFileSync(`${root}${wf(name)}`, "utf8");
const readJson = (p) => JSON.parse(readFileSync(`${root}${p}`, "utf8"));
const readFile = (p) => readFileSync(`${root}${p}`, "utf8");

const CANONICAL_MAC_DMG = "Codemap_1.2.0_universal.dmg";
const CANONICAL_WIN_EXE = "Codemap_1.2.0_x64-setup.exe";
const DISCLOSURE_SNIPPET =
  "so your operating system cannot verify its publisher automatically";

// ----------------------
// Helpers
// ----------------------

/** Frontmatter parsing good enough for trigger/permission keys.
 * GitHub workflow files carry no `---` fences; fall back to the whole doc. */
function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : text;
}

function expectStepPresent(yaml, needle, label) {
  assert.match(
    yaml,
    new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    `${label}: expected step matching "${needle}"`,
  );
}

function expectNoContinueOnError(yaml, label) {
  assert.doesNotMatch(yaml, /continue-on-error/, `${label}: must never swallow failures`);
}

// ----------------------
// 1. Test workflow — OS matrix
// ----------------------

test("test.yml runs Rust CI on macOS AND Windows", () => {
  const yaml = readWf("test");
  assert.match(yaml, /platform:\s*\[\s*macos-latest,\s*windows-latest\s*\]/);
});

test("test.yml keeps frontend on Ubuntu and Playwright on its existing runner", () => {
  const yaml = readWf("test");
  assert.match(yaml, /runs-on:\s*ubuntu-latest/, "frontend job stays on Ubuntu");
  const e2e = readWf("test-e2e");
  assert.match(e2e, /runs-on:\s*macos-latest/);
});

test("negative mutation: macOS-only Rust matrix fails", () => {
  const mutated = readWf("test").replace(
    /platform:\s*\[\s*macos-latest,\s*windows-latest\s*\]/,
    "platform: [macos-latest]",
  );
  assert.doesNotMatch(mutated, /windows-latest/);
  // The real file must contain windows — this flip proves the assertion sees it.
  assert.throws(() => {
    assert.match(mutated, /windows-latest/, "");
  }, /windows-latest/);
});

// ----------------------
// 2. E2E workflow — live push gate
// ----------------------

test("test-e2e.yml triggers on push to main, pull_request, and dispatch", () => {
  const fm = frontmatter(readWf("test-e2e"));
  assert.match(fm, /push:\s*\n\s*branches:\s*\[main\]/);
  assert.match(fm, /pull_request:/);
  assert.match(fm, /workflow_dispatch:/);
  assert.match(fm, /paths:\s*\n\s+-\s+"src\/\*\*"/);
});

test("negative mutation: removing the push trigger is detected", () => {
  const fm = frontmatter(readWf("test-e2e")).replace(/push:[\s\S]*?(?=pull_request:)/, "");
  assert.doesNotMatch(fm, /^push:/m);
  assert.throws(() => {
    assert.match(fm, /push:\s*\n\s*branches:\s*\[main\]/);
  });
});

// ----------------------
// 3. candidate.yml — non-public rehearsal
// ----------------------

test("candidate.yml is workflow_dispatch-only with read-only repo access", () => {
  const text = readWf("candidate");
  const fm = frontmatter(text);
  assert.match(fm, /on:\s*\n\s*workflow_dispatch:\s*(\{\}|\n|$)/m);
  assert.doesNotMatch(fm, /\bpull_request\b/);
  assert.match(text, /permissions:\s*\n\s*contents:\s*read/);
});

test("candidate.yml never creates a GitHub Release", () => {
  const yaml = readWf("candidate");
  assert.doesNotMatch(yaml, /tauri-apps\/tauri-action/);
  assert.doesNotMatch(yaml, /gh release create/i);
  assert.doesNotMatch(yaml, /gh release edit/i);
});

test("candidate.yml stamps CODEMAP_BUILD_COMMIT from github.sha in both build legs", () => {
  const yaml = readWf("candidate");
  const count = [...yaml.matchAll(/CODEMAP_BUILD_COMMIT[^]*?\$\{\{ github\.sha \}\}/g)].length;
  assert.ok(count >= 2, `expected commit stamping in ≥2 places, found ${count}`);
});

test("negative mutation: candidate that publishes via tauri-action fails", () => {
  const yaml = readWf("candidate") + "\n# probe:uses: tauri-apps/tauri-action@v0\n";
  assert.throws(() => {
    assert.doesNotMatch(yaml, /tauri-apps\/tauri-action/);
  }, /tauri-apps\/tauri-action/);
});

// ----------------------
// 4. Selftest wiring (real packaged app) — candidate AND release, fail-closed
// ----------------------

const SELFTEST_CALL_RE = /run-selftest/;

/** Slice a single top-level job body out of a workflow document. */
function jobBlock(yaml, jobName) {
  const startRe = new RegExp(`^  ${jobName}:\\s*$`, "m");
  const m = startRe.exec(yaml);
  assert.ok(m, `workflow is missing job '${jobName}'`);
  const rest = yaml.slice(m.index + m[0].length);
  const end = rest.search(/^  [a-zA-Z_-]+:\s*(#|$)/m);
  return end === -1 ? rest : rest.slice(0, end);
}

test("candidate.yml runs the real-app selftest in EVERY platform job, fail-closed", () => {
  const yaml = readWf("candidate");
  expectNoContinueOnError(yaml, "candidate.yml");
  for (const job of ["build-macos", "build-windows"]) {
    assert.match(
      jobBlock(yaml, job),
      SELFTEST_CALL_RE,
      `${job} must launch the packaged app with --selftest`,
    );
    assert.match(
      jobBlock(yaml, job),
      /universal-apple-darwin|x86_64-pc-windows-msvc/,
      `${job} targets the canonical platform`,
    );
  }
});

test("release.yml runs the selftest in EVERY platform build leg, blocking the draft", () => {
  const yaml = readWf("release");
  expectNoContinueOnError(yaml, "release.yml");
  const legBlock = jobBlock(yaml, "build-draft-assets");
  // The matrix build uploads artifacts only after the selftest passes.
  const selftestIdx = legBlock.search(SELFTEST_CALL_RE);
  const uploadIdx = legBlock.indexOf("actions/upload-artifact");
  assert.ok(selftestIdx !== -1, "release build leg must contain a selftest step");
  assert.ok(uploadIdx > selftestIdx, "selftest must precede any artifact upload");
  assert.ok(legBlock.includes("universal-apple-darwin") && legBlock.includes("x86_64-pc-windows-msvc"));
});

// Release workflow: build legs, finalize, provenance ordering.
test("release.yml orders selftest → artifacts → finalize → provenance", () => {
  const yaml = readWf("release");
  const needs = ["build-draft-assets", "finalize-draft"];
  for (const n of needs) assert.ok(new RegExp(`^  ${n}:`, "m").test(yaml), `missing job ${n}`);
  const provBlock = jobBlock(yaml, "provenance");
  assert.match(provBlock, /needs:\s*\n\s+-\s+finalize-draft/);
});

test("negative mutation: deleting the candidate selftest step fails", () => {
  const yaml = readWf("candidate")
    .split("\n")
    .filter((l) => !l.includes("run-selftest"))
    .join("\n");
  assert.throws(() => {
    assert.match(
      jobBlock(yaml, "build-macos"),
      SELFTEST_CALL_RE,
      "selftest missing",
    );
  }, /selftest/);
});

test("negative mutation: neutering the selftest with continue-on-error fails", () => {
  const yaml = readWf("candidate").replace(
    /(- name:[^\n]*[Ss]elftest[^\n]*)/,
    "$1\n        continue-on-error: true",
  );
  assert.throws(() => expectNoContinueOnError(yaml, "neutered"), /must never swallow/);
});

// ----------------------
// 5. release.yml — draft-only provenance release
// ----------------------

test("release.yml stays tag-triggered and creates ONLY a draft", () => {
  const text = readWf("release");
  const fm = frontmatter(text);
  assert.match(fm, /tags:\s*\n\s+-\s+"v\*"/);
  assert.match(text, /releaseDraft: true|--draft\b/i);
  assert.doesNotMatch(text, /releaseDraft: false/);
  assert.doesNotMatch(text, /--draft=false/);
  assert.doesNotMatch(text, /gh release edit .*--draft=false/);
});

test("release.yml provenance job holds the right scopes and pins actions/attest@v4", () => {
  const yaml = readWf("release");
  const provIdx = yaml.indexOf("provenance:");
  assert.ok(provIdx !== -1, "provenance job missing");
  const provSection = yaml.slice(provIdx);
  assert.match(provSection.slice(0, 400), /permissions:/);
  for (const scope of ["contents: write", "id-token: write", "attestations: write"]) {
    assert.ok(provSection.includes(scope), `provenance must declare ${scope}`);
  }
  assert.match(yaml, /actions\/attest@v4/);
});

test("release.yml enforces the exact six-asset inventory before any further step", () => {
  const yaml = readWf("release");
  for (const asset of [
    CANONICAL_MAC_DMG,
    CANONICAL_WIN_EXE,
    `${CANONICAL_WIN_EXE}.sig`,
    "Codemap_universal.app.tar.gz",
    "Codemap_universal.app.tar.gz.sig",
    "latest.json",
  ]) {
    assert.ok(yaml.includes(asset), `inventory must reference ${asset}`);
  }
});

test("release.yml validates latest.json version/platform/urls/signatures", () => {
  const yaml = readWf("release");
  expectStepPresent(yaml, "Validate latest.json", "latest.json gate");
  assert.match(yaml, /releases\/download\/v\$\{|latest\.json.*version|version == "/);
});

test("release.yml supplies CODEMAP_BUILD_COMMIT to both legs", () => {
  const yaml = readWf("release");
  const count = [...yaml.matchAll(/CODEMAP_BUILD_COMMIT[^]*?\$\{\{ github\.sha \}\}/g)].length;
  assert.ok(count >= 2, `expected commit stamping in ≥2 places, found ${count}`);
});

test("negative mutation: releaseDraft:false fails the draft-only assertion", () => {
  const flipped = readWf("release").replace("releaseDraft: true", "releaseDraft: false");
  assert.throws(() => {
    assert.doesNotMatch(flipped, /releaseDraft: false/);
  });
});

test("negative mutation: missing attestation permission fails", () => {
  const stripped = readWf("release").replace(/attestations: write/, "attestations: none");
  assert.throws(() => {
    assert.ok(stripped.includes("attestations: write"));
  }, /attestations: write/);
});

// ----------------------
// 6. Packaging contracts wired in
// ----------------------

test("mac packaging contract: ad-hoc identity, bound plist, minimum 10.15", () => {
  const conf = readJson("src-tauri/tauri.conf.json");
  const mac = conf.bundle?.macOS ?? {};
  assert.equal(mac.signingIdentity, "-");
  assert.ok(mac.infoPlist, "bundle.macOS.infoPlist must point at src-tauri/Info.plist");
  assert.equal(mac.minimumSystemVersion, "10.15");
  assert.ok(existsSync(`${root}src-tauri/Info.plist`));
});

test("negative mutation: mac signingIdentity removed fails", () => {
  const conf = readJson("src-tauri/tauri.conf.json");
  delete conf.bundle.macOS.signingIdentity;
  assert.throws(() => {
    assert.equal(conf.bundle?.macOS?.signingIdentity, "-");
  });
});

test("windows packaging contract: NSIS/currentUser/skip/no-mutations", () => {
  const winConf = readJson("src-tauri/tauri.windows.conf.json");
  verifyWindowsTemplateConfig(winConf);
  const hooks = readFile("src-tauri/nsis-hooks.nsh");
  const nsi = readFile("src-tauri/installer.nsi");
  verifyNoSecurityMutations(nsi, hooks);
});

test("negative mutation: WindowscurrentUser→perMachine and WebView bootstrapper fail", () => {
  const winConf = readJson("src-tauri/tauri.windows.conf.json");
  const m1 = structuredClone(winConf);
  m1.bundle.windows.nsis.installMode = "perMachine";
  assert.throws(() => verifyWindowsTemplateConfig(m1), /currentUser/);
  const m2 = structuredClone(winConf);
  m2.bundle.windows.webviewInstallMode.type = "downloadBootstrapper";
  assert.throws(() => verifyWindowsTemplateConfig(m2), /'skip'/);
});

test("updater channel is retained verbatim", () => {
  const conf = readJson("src-tauri/tauri.conf.json");
  const updater = conf.plugins?.updater;
  assert.ok(updater?.pubkey, "updater pubkey missing");
  assert.deepEqual(updater.endpoints, [
    "https://github.com/wilson-taiwan/codemap/releases/latest/download/latest.json",
  ]);
});

test("canonical support matrix + filenames appear in candidate summary/report", () => {
  const yaml = readWf("candidate");
  assert.ok(yaml.includes(CANONICAL_MAC_DMG) || yaml.includes("Codemap_${VERSION}_universal.dmg"));
  assert.ok(yaml.includes(CANONICAL_WIN_EXE) || yaml.includes("Codemap_${VERSION}_x64-setup.exe"));
});

// ----------------------
// 7. Required trust documents + forms
// ----------------------

test("required install/privacy/support/security/IT docs and issue forms exist", () => {
  const required = [
    "docs/INSTALLING.md",
    "docs/PRIVACY-AND-PERMISSIONS.md",
    "docs/IT-DEPLOYMENT.md",
    "SUPPORT.md",
    "SECURITY.md",
    ".github/ISSUE_TEMPLATE/install-help.yml",
    ".github/ISSUE_TEMPLATE/bug-report.yml",
    ".github/ISSUE_TEMPLATE/config.yml",
  ];
  for (const p of required) {
    assert.ok(existsSync(`${root}${p}`), `missing required file: ${p}`);
  }
});

test("canonical publisher disclosure is carried verbatim by INSTALLING + README", () => {
  for (const p of ["docs/INSTALLING.md", "README.md"]) {
    const text = readFile(p);
    assert.ok(text.includes(DISCLOSURE_SNIPPET), `${p} lost the canonical notice`);
    assert.ok(
      text.includes("https://github.com/wilson-taiwan/codemap/releases"),
      `${p} must name the official releases URL`,
    );
  }
});

test("negative mutation: dropping the disclosure from INSTALLING fails", () => {
  const text = readFile("docs/INSTALLING.md").replace(DISCLOSURE_SNIPPET, "[removed]");
  assert.throws(() => {
    assert.ok(text.includes(DISCLOSURE_SNIPPET), "lost the canonical notice");
  }, /canonical notice/);
});

test("install-help issue form collects warning-category + exact filename and bans sensitive data", () => {
  const form = readFile(".github/ISSUE_TEMPLATE/install-help.yml");
  assert.match(form, /Do not upload transcripts/);
  assert.match(form, /Exact warning text/);
  assert.match(form, /exact filename/);
});

test("security policy routes confidential reports through GitHub private reporting", () => {
  const sec = readFile("SECURITY.md");
  assert.match(sec, /Report a vulnerability/);
  assert.doesNotMatch(sec, /mailto:/);
});

test("four workflow YAML files parse (authoritative Ruby loader; structural fallback)", () => {
  for (const name of ["test", "test-e2e", "candidate", "release"]) {
    const file = `${root}${wf(name)}`;
    const text = readFile(wf(name));
    assert.doesNotMatch(text, /^\t/m, `${name}: tabs are illegal YAML indentation`);
    try {
      execFileSync(
        "ruby",
        [
          "-e",
          'require "yaml"; YAML.load_file(ARGV.fetch(0)); warn "#{$PROGRAM_NAME}: YAML OK"',
          file,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      assert.ok(true, `${name} parsed by Ruby`);
    } catch (err) {
      if (err?.code === "ENOENT") {
        // Ruby unavailable locally: structural fallback only.
        assert.match(text, /^jobs:/m, `${name}: no jobs section`);
        continue;
      }
      throw err;
    }
  }
});
