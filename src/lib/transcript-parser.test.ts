import { describe, expect, it } from "vitest";
import {
  detectFormat,
  parseCsv,
  parseLooseTimestamp,
  parseSpeakerText,
  parseSrt,
  parseTranscript,
  labelFromFilename,
} from "./transcript-parser";

describe("detectFormat", () => {
  it("knows WebVTT by its header", () => {
    expect(detectFormat("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi")).toBe(
      "vtt",
    );
  });

  it("tells SRT from VTT by the decimal separator, not the file name", () => {
    const srt = "1\n00:00:01,000 --> 00:00:04,000\nAda: hello\n";
    // Deliberately lying about the extension: services rename files, and a
    // wrong guess produces junk segmentation rather than an error.
    expect(detectFormat(srt, "interview.vtt")).toBe("srt");
  });

  it("requires a text column before calling something CSV", () => {
    expect(detectFormat("speaker,text\nAda,hello")).toBe("csv");
    expect(
      detectFormat("So, yes, I rehearse, constantly, before any party."),
    ).toBe("text");
  });

  it("falls back to plain text", () => {
    expect(detectFormat("Ada: hello\nParticipant: hi")).toBe("text");
  });
});

describe("parseSrt", () => {
  it("reads cues and speakers", () => {
    const cues = parseSrt(
      "1\n00:00:01,000 --> 00:00:04,000\nAda: how was the party\n\n" +
        "2\n00:00:04,500 --> 00:00:09,000\nP07: exhausting\n",
    );
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({
      speaker: "Ada",
      text: "how was the party",
      timestamp_start: "00:00:01.000",
      timestamp_end: "00:00:04.000",
    });
    expect(cues[1].speaker).toBe("P07");
  });

  it("does not maul a comma inside speech", () => {
    const cues = parseSrt(
      "1\n00:00:01,000 --> 00:00:04,000\nP07: about 1,500 people were there\n",
    );
    expect(cues[0].text).toBe("about 1,500 people were there");
  });
});

describe("parseSpeakerText", () => {
  it("reads the Otter shape — speaker and timestamp on their own line", () => {
    const cues = parseSpeakerText(
      "Ada Lovelace  00:12\nCould you tell me about a typical day?\n\n" +
        "Speaker 1  0:45\nI rehearse everything. Every single conversation.\n",
    );
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({
      speaker: "Ada Lovelace",
      timestamp_start: "00:00:12.000",
      text: "Could you tell me about a typical day?",
    });
    expect(cues[1]).toMatchObject({
      speaker: "Speaker 1",
      timestamp_start: "00:00:45.000",
    });
  });

  it("reads the inline shape", () => {
    const cues = parseSpeakerText(
      "Ada: how was the party\nP07: exhausting, honestly\n",
    );
    expect(cues).toHaveLength(2);
    expect(cues[1]).toMatchObject({
      speaker: "P07",
      text: "exhausting, honestly",
    });
  });

  it("does not mistake a sentence containing a colon for a speaker", () => {
    const cues = parseSpeakerText(
      "P07: here is the thing I keep coming back to: I rehearse everything.\n",
    );
    expect(cues).toHaveLength(1);
    expect(cues[0].speaker).toBe("P07");
    expect(cues[0].text).toBe(
      "here is the thing I keep coming back to: I rehearse everything.",
    );
  });

  it("keeps a wrapped paragraph with the speaker who started it", () => {
    const cues = parseSpeakerText(
      "P07  01:02\nI rehearse everything.\nEvery conversation, before it happens.\n",
    );
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe(
      "I rehearse everything. Every conversation, before it happens.",
    );
  });

  it("handles a transcript with no speakers at all", () => {
    const cues = parseSpeakerText(
      "She described rehearsing conversations.\n\nThen she described the cost.\n",
    );
    expect(cues).toHaveLength(2);
    expect(cues[0].speaker).toBe("Unknown");
    expect(cues[0].timestamp_start).toBe("");
  });
});

describe("parseCsv", () => {
  it("maps columns by name, in any order", () => {
    const cues = parseCsv(
      "start,speaker,text\n00:01,Ada,how was the party\n00:05,P07,exhausting\n",
    );
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({
      speaker: "Ada",
      text: "how was the party",
      timestamp_start: "00:00:01.000",
    });
  });

  it("honours quoted fields containing commas", () => {
    const cues = parseCsv(
      'speaker,text\nP07,"about 1,500 people, all of them watching"\n',
    );
    expect(cues[0].text).toBe("about 1,500 people, all of them watching");
  });

  it("returns nothing rather than guessing when there is no text column", () => {
    expect(parseCsv("a,b\n1,2\n")).toEqual([]);
  });
});

describe("parseLooseTimestamp", () => {
  it("accepts the shapes transcripts actually use", () => {
    expect(parseLooseTimestamp("0:03")).toBe("00:00:03.000");
    expect(parseLooseTimestamp("1:02:03")).toBe("01:02:03.000");
    expect(parseLooseTimestamp("00:01:02.500")).toBe("00:01:02.500");
    expect(parseLooseTimestamp("garbage")).toBe("");
    expect(parseLooseTimestamp(undefined)).toBe("");
  });
});

describe("parseTranscript", () => {
  it("routes each format to its parser and reports which it used", () => {
    expect(parseTranscript("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi").format)
      .toBe("vtt");
    expect(parseTranscript("1\n00:00:01,000 --> 00:00:02,000\nhi").format).toBe(
      "srt",
    );
    expect(parseTranscript("speaker,text\nW,hi").format).toBe("csv");
    expect(parseTranscript("W: hi").format).toBe("text");
  });

  it("produces the same passages from the same interview in two formats", () => {
    // The property that matters downstream: passage ids are derived from
    // segment text, so two coders whose transcription service handed them
    // different containers of the same words still line up.
    const fromSrt = parseTranscript(
      "1\n00:00:01,000 --> 00:00:04,000\nAda: how was the party\n",
    ).cues;
    const fromText = parseTranscript("Ada  0:01\nhow was the party\n").cues;
    expect(fromSrt[0].text).toBe(fromText[0].text);
    expect(fromSrt[0].speaker).toBe(fromText[0].speaker);
  });
});

describe("labelFromFilename", () => {
  it("strips whichever container the transcript arrived in", () => {
    // The label decides the interview id, so a stray extension would put two
    // coders on different interviews for the same words.
    expect(labelFromFilename("/Box/Study/transcript1.vtt")).toBe("transcript1");
    expect(labelFromFilename("/Box/Study/transcript1.docx")).toBe("transcript1");
    expect(labelFromFilename("C:\\Box\\P07.SRT")).toBe("P07");
    expect(labelFromFilename("P07.csv")).toBe("P07");
  });

  it("leaves a name that merely contains a dot alone", () => {
    expect(labelFromFilename("P07.visit2.txt")).toBe("P07.visit2");
    expect(labelFromFilename("P07")).toBe("P07");
  });
});
