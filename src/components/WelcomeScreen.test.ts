/**
 * Intent-first onboarding static guards.
 *
 * The behavioral matrix (fresh fixture sees no account input; disclosure
 * precedes the form; returning users skip) is covered by Playwright specs;
 * these source checks pin the structural decisions that make those behaviors
 * possible, so neither a refactor nor a copy edit can quietly reintroduce a
 * credential-first first run.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const HERE = import.meta.dirname;

const read = (...parts: string[]) =>
  readFileSync(resolve(HERE, ...parts), "utf8");

describe("first-run choice is intent-first", () => {
  const welcome = read("WelcomeScreen.tsx");

  it("never leads with an account form; the old credential gate is gone", () => {
    expect(welcome).not.toContain("showFirstRunSignIn");
    // AccountForm appears only inside the collaboration steps, after the
    // intent choice and its disclosure.
    expect(welcome).toContain("Collaborate with a team");
    expect(welcome).toContain("Work locally");
  });

  it("local is primary/recommended; account needs explicit continuation", () => {
    const localIdx = welcome.indexOf("Work locally");
    const collabIdx = welcome.indexOf("Collaborate with a team");
    const accountIdx = welcome.indexOf("<AccountForm");
    expect(localIdx).toBeGreaterThan(-1);
    expect(collabIdx).toBeGreaterThan(-1);
    expect(accountIdx).toBeGreaterThan(collabIdx);
    expect(welcome).toContain("Recommended");
    const flatWelcome = welcome.replace(/\s+/g, " ");
    expect(flatWelcome).toContain("Continue to account");
  });

  it("gates on session restore completing to prevent the signed-in flash", () => {
    expect(welcome).toContain("sessionRestoreComplete");
    expect(welcome).toContain("onboardingChoiceSeen(preferences)");
  });

  it("marks the choice seen on both paths", () => {
    expect(welcome.match(/setOnboardingChoiceSeen\(true\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("offers a non-blocking trust link on the choice screen", () => {
    expect(welcome).toContain("openTrustCenter");
    expect(welcome).toContain("Trust, privacy &amp; permissions");
  });

  it("empty home orders local/join/open with local primary", () => {
    const newIdx = welcome.indexOf('title="Start a local study"');
    const joinIdx = welcome.indexOf('title="Join a collaborative study"');
    const openIdx = welcome.indexOf('title="Open an existing study"');
    expect(newIdx).toBeLessThan(joinIdx);
    expect(joinIdx).toBeLessThan(openIdx);
    const emptyBlock = welcome.slice(
      welcome.indexOf("{isEmpty ?"),
      welcome.indexOf("{/* Non-empty state"),
    );
    expect(emptyBlock.replace(/\s+/g, " ")).toMatch(/primary\s+disabled=\{loading\}\s+onClick=\{\(\) => openSetup\(\)\}/);
  });
});

describe("join flow discloses before credentials", () => {
  const join = read("JoinStudyModal.tsx");

  it("shows CollaborationDisclosure above AccountForm when signed out", () => {
    const idxDisclosure = join.indexOf("<CollaborationDisclosure />");
    const idxAccount = join.indexOf("<AccountForm");
    expect(idxDisclosure).toBeGreaterThan(-1);
    expect(idxDisclosure).toBeLessThan(idxAccount);
  });
});

describe("session store exposes restore completion", () => {
  const syncStoreFlat = read("../store/sync-store.ts").replace(/\s+/g, " ");

  it("declares the flag and settles it after restore", () => {
    expect(syncStoreFlat).toContain("sessionRestoreComplete: boolean;");
    expect(syncStoreFlat).toContain("set({ sessionRestoreComplete: true })");
    expect(syncStoreFlat).toContain("set({ sessionRestoreComplete: false })");
  });
});
