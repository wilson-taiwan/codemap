import type { ParsedVttCue, SegmentInput } from "./types";

const TIMESTAMP_RE =
  /^(?:(\d{2}):)?(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(?:(\d{2}):)?(\d{2}):(\d{2})\.(\d{3})/;

const SPEAKER_RE = /^([^:]+):\s*(.*)$/;

export function parseVtt(raw: string): ParsedVttCue[] {
  const stripped = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
  const lines = stripped.replace(/\r\n/g, "\n").split("\n");
  const cues: ParsedVttCue[] = [];
  let i = 0;

  while (i < lines.length && !lines[i].trim()) i++;
  if (lines[i]?.trim() === "WEBVTT") i++;

  while (i < lines.length) {
    while (i < lines.length && !lines[i].trim()) i++;
    if (i >= lines.length) break;

    // Optional cue identifier (numeric or other)
    if (lines[i] && !lines[i].includes("-->")) i++;

    const timingLine = lines[i];
    if (!timingLine || !timingLine.includes("-->")) {
      i++;
      continue;
    }

    const match = timingLine.match(TIMESTAMP_RE);
    if (!match) {
      i++;
      continue;
    }

    const timestamp_start = `${match[1] ?? "00"}:${match[2]}:${match[3]}.${match[4]}`;
    const timestamp_end = `${match[5] ?? "00"}:${match[6]}:${match[7]}.${match[8]}`;
    i++;

    const textLines: string[] = [];
    while (i < lines.length && lines[i].trim()) {
      textLines.push(lines[i]);
      i++;
    }

    const fullText = textLines.join(" ").trim();
    if (!fullText) continue;

    const speakerMatch = fullText.match(SPEAKER_RE);
    if (speakerMatch) {
      cues.push({
        speaker: speakerMatch[1].trim(),
        timestamp_start,
        timestamp_end,
        text: speakerMatch[2].trim(),
      });
    } else {
      cues.push({
        speaker: "Unknown",
        timestamp_start,
        timestamp_end,
        text: fullText,
      });
    }
  }

  return cues;
}

export function mergeConsecutiveSpeaker(
  cues: ParsedVttCue[],
): SegmentInput[] {
  if (cues.length === 0) return [];

  const merged: SegmentInput[] = [];
  let current: SegmentInput = {
    speaker: cues[0].speaker,
    timestamp_start: cues[0].timestamp_start,
    timestamp_end: cues[0].timestamp_end,
    text: cues[0].text,
    section_tag: null,
  };

  for (let i = 1; i < cues.length; i++) {
    const cue = cues[i];
    if (cue.speaker === current.speaker) {
      current.text = `${current.text} ${cue.text}`.trim();
      current.timestamp_end = cue.timestamp_end;
    } else {
      merged.push(current);
      current = {
        speaker: cue.speaker,
        timestamp_start: cue.timestamp_start,
        timestamp_end: cue.timestamp_end,
        text: cue.text,
        section_tag: null,
      };
    }
  }
  merged.push(current);
  return merged;
}

export function cuesToSegments(
  cues: ParsedVttCue[],
  mergeSameSpeaker = true,
): SegmentInput[] {
  if (mergeSameSpeaker) {
    return mergeConsecutiveSpeaker(cues);
  }
  return cues.map((cue) => ({
    speaker: cue.speaker,
    timestamp_start: cue.timestamp_start,
    timestamp_end: cue.timestamp_end,
    text: cue.text,
    section_tag: null,
  }));
}

export function formatTimestampDisplay(ts: string): string {
  const parts = ts.split(":");
  if (parts.length >= 3) {
    return `${parts[1]}:${parts[2]}`;
  }
  return ts;
}
