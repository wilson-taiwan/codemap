import { describe, expect, it } from "vitest";
import {
  aliasForSpeaker,
  aliasPreview,
  buildSpeakerAliases,
} from "./speaker-alias";

describe("buildSpeakerAliases", () => {
  it("numbers distinct speakers in first-appearance order", () => {
    const aliases = buildSpeakerAliases([
      "Ada Lovelace",
      "Ada Lovelace",
      "Grace Hopper",
      "Interviewer",
      "Ada Lovelace",
    ]);
    expect(aliases.get("Ada Lovelace")).toBe("Speaker 1");
    expect(aliases.get("Grace Hopper")).toBe("Speaker 2");
    expect(aliases.has("Interviewer")).toBe(false);
  });

  it("exempts only the exact Interviewer match", () => {
    const aliases = buildSpeakerAliases(["interviewer", "Interviewer "]);
    // "interviewer" (lowercase) is a real name and gets a number; the padded
    // "Interviewer " trims to the exempt match and does not.
    expect(aliases.get("interviewer")).toBe("Speaker 1");
    expect(aliases.has("Interviewer")).toBe(false);
  });

  it("numbers Unknown like any other speaker", () => {
    const aliases = buildSpeakerAliases(["Unknown", "Ada Lovelace"]);
    expect(aliases.get("Unknown")).toBe("Speaker 1");
    expect(aliases.get("Ada Lovelace")).toBe("Speaker 2");
  });

  it("is stable across re-runs and skips blanks", () => {
    const speakers = ["Bo", "", "  ", "Ada Lovelace", "Bo"];
    expect(buildSpeakerAliases(speakers)).toEqual(
      buildSpeakerAliases(speakers),
    );
    expect(buildSpeakerAliases(speakers).size).toBe(2);
  });
});

describe("aliasForSpeaker", () => {
  it("returns the name itself without a map or without an entry", () => {
    expect(aliasForSpeaker("Ada Lovelace", null)).toBe("Ada Lovelace");
    expect(
      aliasForSpeaker("Interviewer", buildSpeakerAliases(["Ada Lovelace"])),
    ).toBe("Interviewer");
  });
});

describe("aliasPreview", () => {
  it("lists real-to-alias pairs for the settings toggle", () => {
    expect(
      aliasPreview(["Ada Lovelace", "Grace Hopper", "Interviewer"]),
    ).toEqual([
      { real: "Ada Lovelace", alias: "Speaker 1" },
      { real: "Grace Hopper", alias: "Speaker 2" },
    ]);
  });
});
