import { describe, expect, it } from "vitest";
import { checkStudyLabel, nextParticipantId, normalizeLabel } from "./study-label";

const KNOWN = ["P07", "P12", "P03-2"];

describe("normalizeLabel", () => {
  it("matches the backend's rule — case and inner whitespace folded", () => {
    expect(normalizeLabel("P07")).toBe("p07");
    expect(normalizeLabel("  p07  ")).toBe("p07");
    expect(normalizeLabel("P 07")).toBe("p 07");
    expect(normalizeLabel("P\t07")).toBe("p 07");
  });
});

describe("checkStudyLabel", () => {
  it("recognises a label the study already holds, however typed", () => {
    for (const typed of ["P07", "p07", "  P07 "]) {
      const v = checkStudyLabel(typed, KNOWN);
      expect(v.status).toBe("matches");
      expect(v.matched).toBe("P07");
    }
  });

  it("🔑 catches the near-miss that silently forks an interview", () => {
    // The failure this module exists for: P7 and P07 hash differently, so two
    // coders end up with two interviews holding identical words.
    const v = checkStudyLabel("P7", KNOWN);
    expect(v.status).toBe("new");
    expect(v.didYouMean).toBe("P07");
  });

  it("flags a filename", () => {
    const v = checkStudyLabel("interview1.docx", KNOWN);
    expect(v.warnings.join(" ")).toMatch(/filename/i);
  });

  it("flags something that looks like a person's name or initials", () => {
    for (const name of ["Sarah Jones", "JH", "J.H.", "W.Y.", "WY", "J.D.E.", "ABC"]) {
      const v = checkStudyLabel(name, KNOWN);
      expect(v.warnings.join(" ")).toMatch(/person's name or initials/i);
    }
  });

  it("does not flag an ordinary study ID or longer code token", () => {
    expect(checkStudyLabel("P21", KNOWN).warnings).toEqual([]);
    expect(checkStudyLabel("P03-3", KNOWN).warnings).toEqual([]);
    expect(checkStudyLabel("PILOT", KNOWN).warnings).toEqual([]);
    expect(checkStudyLabel("CONTROL", KNOWN).warnings).toEqual([]);
    expect(checkStudyLabel("CTRLGRP", KNOWN).warnings).toEqual([]);
  });

  it("flags unchanged filename-derived guess, including interview1-transcript", () => {
    const v = checkStudyLabel(
      "interview1-transcript",
      KNOWN,
      "interview1-transcript",
    );
    expect(v.warnings.join(" ")).toMatch(/came from your file name/i);

    // If edited, the warning clears
    const edited = checkStudyLabel("P01", KNOWN, "interview1-transcript");
    expect(edited.warnings.join(" ")).not.toMatch(/came from your file name/i);
  });

  it("treats a genuinely new participant as new, with no false near-miss", () => {
    // Two edits on a three-character ID is a different person, not a slip.
    for (const other of ["P99", "P21", "P44"]) {
      const v = checkStudyLabel(other, KNOWN);
      expect(v.status, other).toBe("new");
      expect(v.didYouMean, other).toBeUndefined();
    }
  });

  it("allows a second edit once the label is long enough to warrant it", () => {
    expect(checkStudyLabel("P03-22", KNOWN).didYouMean).toBe("P03-2");
  });

  it("reports empty rather than guessing", () => {
    expect(checkStudyLabel("   ", KNOWN).status).toBe("empty");
  });

  it("works with an empty study", () => {
    const v = checkStudyLabel("P07", []);
    expect(v.status).toBe("new");
    expect(v.didYouMean).toBeUndefined();
  });

  it("never suggests the label as a typo of itself", () => {
    const v = checkStudyLabel("P07", KNOWN);
    expect(v.didYouMean).toBeUndefined();
  });
});

describe("nextParticipantId", () => {
  it("defaults to P01 on an empty study", () => {
    expect(nextParticipantId([])).toBe("P01");
    expect(nextParticipantId(["   "])).toBe("P01");
  });

  it("handles pure numbers", () => {
    expect(nextParticipantId(["1", "2", "3"])).toBe("4");
    expect(nextParticipantId(["10"])).toBe("11");
  });

  it("preserves padding width for padded numbers", () => {
    expect(nextParticipantId(["01", "02", "03"])).toBe("04");
    expect(nextParticipantId(["001", "002"])).toBe("003");
  });

  it("preserves prefix and pad for prefixed numbers", () => {
    expect(nextParticipantId(["P01", "P02"])).toBe("P03");
    expect(nextParticipantId(["P01", "P02", "P04"])).toBe("P05");
  });

  it("handles hyphenated and separated prefixes", () => {
    expect(nextParticipantId(["P-01", "P-02"])).toBe("P-03");
    expect(nextParticipantId(["Participant 1", "Participant 2"])).toBe("Participant 3");
  });

  it("returns empty string when there is no discernible numerical pattern", () => {
    expect(nextParticipantId(["Pilot", "Followup"])).toBe("");
    expect(nextParticipantId(["Alpha", "Beta", "Gamma"])).toBe("");
  });
});
