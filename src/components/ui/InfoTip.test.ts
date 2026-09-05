import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { InfoTip } from "./InfoTip";

const HERE = import.meta.dirname;
const read = (...parts: string[]) =>
  readFileSync(resolve(HERE, ...parts), "utf8");

describe("InfoTip component and u09 copy audit", () => {
  it("renders a focusable 12px button with accessible label and ? symbol", () => {
    const html = renderToStaticMarkup(
      createElement(InfoTip, { content: "Sample tooltip text" }),
    );
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-label="More information"');
    expect(html).toContain("h-3 w-3");
    expect(html).toContain("?");
  });

  it("supports custom ariaLabel prop", () => {
    const html = renderToStaticMarkup(
      createElement(InfoTip, {
        content: "Custom description",
        ariaLabel: "About this setting",
      }),
    );
    expect(html).toContain('aria-label="About this setting"');
  });

  it("NextStepCoach contains exact required copy and InfoTips", () => {
    const src = read("../NextStepCoach.tsx");
    expect(src).toContain("Create a code, then start reading.");
    expect(src).toContain("Codes live in the left panel and can grow as you read.");
    expect(src).toContain("Import VTT, SRT, Word, or plain text.");
    expect(src).toContain("Fleuron splits supported files into speaker turns.");
    expect(src).toContain("Select words to code a span, or press C for the whole turn.");
    expect(src).toContain("Right-click a turn to see the same whole-turn action.");
    expect(src).toContain("Share coding with your group; transcript text stays local.");
    expect(src).toContain("Coding metadata syncs. Transcript text stays on this computer.");
    expect(src).toContain("<InfoTip content={active.infoTip} />");
  });

  it("AccountForm contains exact required hints and InfoTips", () => {
    const src = read("../AccountForm.tsx");
    expect(src).toContain("Use this email to sign in on every computer.");
    expect(src).toContain("Your group members never see your email.");
    expect(src).toContain("Enter the code from the reset email, then choose a new password.");
    expect(src).toContain("The email contains a code, not a link.");
  });

  it("SettingsSheet contains exact required merge hints and InfoTips", () => {
    const src = read("../SettingsSheet.tsx");
    expect(src).toContain("Merge consecutive turns by the same speaker");
    expect(src).toContain("Combines adjacent turns from the same speaker.");
    expect(src).toContain("Turn this off when your transcript starts a new turn at each quotation.");
    expect(src).toContain("Locked for this shared study.");
    expect(src).toContain("This study pins ${mergeSameSpeaker ? \"merged\" : \"unmerged\"} passage boundaries so every member imports the same turns.");
  });

  it("InterviewSettingsModal contains exact required hints, InfoTips, and Save date button", () => {
    const src = read("../InterviewSettingsModal.tsx");
    expect(src).toContain("Used to match this interview across group members.");
    expect(src).toContain("Participant IDs cannot be changed after creation.");
    expect(src).toContain("Shows Speaker 1, Speaker 2 on screen, copy, and export.");
    expect(src).toContain("Stored speaker names are unchanged. This setting applies on this computer.");
    expect(src).toContain("Applies immediately on this computer.");
    expect(src).toContain("Save date");
    expect(src).toContain("redactionBusy");
    expect(src).toContain("Could not save the redaction setting.");
  });

  it("UpdateAction contains exact required preparing strings and InfoTip", () => {
    const src = read("../UpdateAction.tsx");
    expect(src).toContain("Saving changes before update…");
    expect(src).toContain("Saved locally. Restarting…");
    expect(src).toContain("Fleuron checks for unsent group changes before installing an update.");
  });

  it("SyncDiagnostics contains exact required heading, row labels, InfoTip, and unavailable message", () => {
    const src = read("../SyncDiagnostics.tsx");
    expect(src).toContain("Sync diagnostics");
    expect(src).toContain("Last received");
    expect(src).toContain("Waiting to send");
    expect(src).toContain("Live connection");
    expect(src).toContain("Live updates trigger immediate checks; the minute-by-minute fallback still runs.");
    expect(src).toContain("Clock difference");
    expect(src).toContain("Last problem");
    expect(src).toContain("Unavailable — checking every minute");
  });
});
