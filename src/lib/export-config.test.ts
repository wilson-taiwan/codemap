import { describe, expect, it } from "vitest";
import {
  describePreset,
  getDefaultConfig,
  isCustom,
  PRESETS,
  type ExportConfig,
} from "./export-config";

describe("export-config", () => {
  it("defines exactly the 3 methodology presets with required metadata", () => {
    expect(Object.keys(PRESETS)).toEqual([
      "reflexive-ta",
      "content-analysis",
      "framework-analysis",
    ]);

    const rta = describePreset("reflexive-ta");
    expect(rta.label).toBe("Reflexive thematic analysis");
    expect(rta.defaultItems).toContain("report-html");
    expect(rta.defaultItems).toContain("report-pdf");
    expect(rta.defaultItems).toContain("coded-segments");
    expect(rta.defaultItems).toContain("codebook");
    expect(rta.defaultItems).toContain("memos");
    expect(rta.defaultItems).not.toContain("counts");
    expect(rta.defaultItems).not.toContain("framework-matrix");
    expect(rta.rationale).toContain("Braun & Clarke");

    const ca = describePreset("content-analysis");
    expect(ca.label).toBe("Qualitative content analysis");
    expect(ca.defaultItems).toContain("report-pdf");
    expect(ca.defaultItems).toContain("counts");
    expect(ca.defaultItems).not.toContain("framework-matrix");

    const fa = describePreset("framework-analysis");
    expect(fa.label).toBe("Framework analysis");
    expect(fa.defaultItems).toContain("report-pdf");
    expect(fa.defaultItems).toContain("framework-matrix");
    expect(fa.defaultItems).toContain("counts");
  });

  it("getDefaultConfig returns pristine default preset config", () => {
    const config = getDefaultConfig("reflexive-ta");
    expect(config.preset).toBe("reflexive-ta");
    expect(config.includeParticipantScope).toBe("all");
    expect(config.includeCoderScope).toBe("all");
    expect(isCustom(config)).toBe(false);
  });

  it("detects when config diverges from preset defaults (isCustom)", () => {
    const config: ExportConfig = getDefaultConfig("reflexive-ta");
    expect(isCustom(config)).toBe(false);

    // Adding counts diverges from reflexive-ta
    const modified: ExportConfig = {
      ...config,
      items: [...config.items, "counts"],
    };
    expect(isCustom(modified)).toBe(true);

    // Explicit custom preset is always custom
    const customConfig: ExportConfig = {
      preset: "custom",
      items: ["report-html"],
      includeParticipantScope: "all",
      includeCoderScope: "all",
    };
    expect(isCustom(customConfig)).toBe(true);
  });
});
