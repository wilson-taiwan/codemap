import { describe, expect, it } from "vitest";
import { cuesToSegments, mergeConsecutiveSpeaker, parseVtt } from "./vtt-parser";

const SAMPLE_VTT = `WEBVTT

1
00:00:27.850 --> 00:00:29.140
Luci Diaz: Hi!

2
00:00:30.100 --> 00:00:31.570
Ada Lovelace: Oh my gosh, I can play.

3
00:00:35.490 --> 00:00:38.519
Luci Diaz: I think we're having the same issue.

4
00:00:41.550 --> 00:00:45.969
Luci Diaz: Because I can kind of hear you now.
`;

describe("parseVtt", () => {
  it("parses speaker-labeled cues", () => {
    const cues = parseVtt(SAMPLE_VTT);
    expect(cues).toHaveLength(4);
    expect(cues[0]).toMatchObject({
      speaker: "Luci Diaz",
      timestamp_start: "00:00:27.850",
      text: "Hi!",
    });
    expect(cues[1].speaker).toBe("Ada Lovelace");
  });

  it("merges consecutive same-speaker utterances", () => {
    const cues = parseVtt(SAMPLE_VTT);
    const merged = mergeConsecutiveSpeaker(cues);
    expect(merged).toHaveLength(3);
    expect(merged[2].speaker).toBe("Luci Diaz");
    expect(merged[2].text).toContain("Because I can kind of hear you now");
  });

  it("exports segments via cuesToSegments", () => {
    const cues = parseVtt(SAMPLE_VTT);
    const segments = cuesToSegments(cues, true);
    expect(segments[0].section_tag).toBeNull();
    expect(segments[0].timestamp_end).toBe("00:00:29.140");
  });

  it("parses MM:SS.mmm timestamps (no hours group) and normalizes to HH:MM:SS.mmm", () => {
    const vtt = `WEBVTT

12:34.567 --> 13:45.678
Luci Diaz: short clip
`;
    const cues = parseVtt(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0].timestamp_start).toBe("00:12:34.567");
    expect(cues[0].timestamp_end).toBe("00:13:45.678");
  });

  it("assigns Unknown speaker to cues with no speaker label", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:02.000
narration without a speaker
`;
    const cues = parseVtt(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0].speaker).toBe("Unknown");
    expect(cues[0].text).toBe("narration without a speaker");
  });

  it("parses cues that carry cue-settings after the end timestamp", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:02.000 align:start position:0%
Luci Diaz: aligned cue
`;
    const cues = parseVtt(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0].speaker).toBe("Luci Diaz");
    expect(cues[0].text).toBe("aligned cue");
  });

  it("strips a leading UTF-8 BOM", () => {
    const vtt = `\uFEFFWEBVTT

00:00:01.000 --> 00:00:02.000
Luci Diaz: bom-prefixed
`;
    const cues = parseVtt(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("bom-prefixed");
  });

  it("returns an empty array for empty input", () => {
    expect(parseVtt("")).toEqual([]);
  });
});

describe("cuesToSegments", () => {
  it("does not merge when mergeSameSpeaker is false", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:02.000
Luci Diaz: first

00:00:02.000 --> 00:00:03.000
Luci Diaz: second
`;
    const cues = parseVtt(vtt);
    const segments = cuesToSegments(cues, false);
    expect(segments).toHaveLength(2);
    expect(segments[0].text).toBe("first");
    expect(segments[1].text).toBe("second");
  });
});
