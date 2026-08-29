#!/usr/bin/env node
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const root = fileURLToPath(new URL("../../", import.meta.url));

function redactWithBash(raw) {
  const script = `
    source "${root}support/fleuron-probe.sh" >/dev/null 2>&1 || true
    redact_panic_payload "$1"
  `;
  return execFileSync("bash", ["-c", script, "bash-runner", raw], { encoding: "utf8" }).trim();
}

function redactWithPwsh(raw) {
  if (!existsSync("/opt/homebrew/bin/pwsh") && !existsSync("/usr/local/bin/pwsh")) {
    try {
      execFileSync("which", ["pwsh"], { stdio: "ignore" });
    } catch {
      return null;
    }
  }
  const psCmd = `
    . "${root}support/Get-FleuronProbe.ps1"
    $inputRaw = [System.Environment]::GetEnvironmentVariable("TEST_RAW_PAYLOAD")
    Redact-PanicPayload -Raw $inputRaw
  `;
  try {
    return execFileSync("pwsh", ["-NoProfile", "-Command", psCmd], {
      env: { ...process.env, TEST_RAW_PAYLOAD: raw },
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

test("cross-implementation redaction agreement on short payload", () => {
  const input = "assertion failed: `(left == right)` with code: 42";
  const bashResult = redactWithBash(input);
  assert.ok(bashResult.startsWith("[payload truncated for privacy]"));
  assert.doesNotMatch(bashResult, /[`]/);

  const pwshResult = redactWithPwsh(input);
  if (pwshResult) {
    assert.equal(bashResult, pwshResult);
  }
});

test("cross-implementation redaction agreement on long payload (>120 chars)", () => {
  const input = "PANIC_PAYLOAD_ABC_".repeat(10); // 180 chars
  const bashResult = redactWithBash(input);
  assert.ok(bashResult.includes("...(+60 chars withheld)"));

  const pwshResult = redactWithPwsh(input);
  if (pwshResult) {
    assert.equal(bashResult, pwshResult);
  }
});
