import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const HERE = import.meta.dirname;
const read = (...parts: string[]) =>
  readFileSync(resolve(HERE, ...parts), "utf8");

describe("AboutModal diagnostic report UI", () => {
  const about = read("AboutModal.tsx");
  const trustCenter = read("TrustCenterPanel.tsx");

  it("renders the generate diagnostic report button beside copy build details", () => {
    expect(about).toContain("Generate diagnostic report");
    expect(about).toContain("Copy build details");
    const copyIdx = about.indexOf("Copy build details");
    const genIdx = about.indexOf("Generate diagnostic report");
    expect(copyIdx).toBeGreaterThan(-1);
    expect(genIdx).toBeGreaterThan(-1);
  });

  it("wires the diagnostic report API call", () => {
    expect(about).toContain("api.generateDiagnosticReport()");
  });

  it("shows the disclosure notice before saving", () => {
    expect(about).toContain(
      "This is everything that will be saved. It contains no transcript text, participant labels, or code names. Read it before you share it.",
    );
  });

  it("offers Copy and Save to file actions once report preview is present", () => {
    expect(about).toContain("Save to file…");
    expect(about).toContain("Copy report");
  });

  it("TrustCenterPanel points to the in-app diagnostic report in support section", () => {
    expect(trustCenter).toContain("About → Generate diagnostic report");
    expect(trustCenter).toContain("no transcript text, participant labels, or code names");
  });
});
