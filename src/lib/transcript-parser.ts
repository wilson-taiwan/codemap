import type { ParsedVttCue } from "./types";
import { parseVtt } from "./vtt-parser";

/**
 * Reading transcripts from whatever produced them.
 *
 * Codemap started as a Zoom tool and accepted WebVTT only, which quietly
 * decided who could use it: interviews recorded on a phone, transcribed by a
 * service, or typed up by hand were all locked out. The corpus is the one thing
 * that must reach both coders intact, so the import step should be the least
 * opinionated part of the app.
 *
 * Format is detected from **content, not the file extension**. Transcription
 * services rename things freely, people save `.srt` as `.txt`, and a wrong
 * guess here is not cosmetic: it produces a transcript whose segmentation is
 * junk, and passage ids are derived from segment text, so a bad parse means
 * coding that can never line up with the other coder's.
 */

export type TranscriptFormat = "vtt" | "srt" | "csv" | "text";

/** `HH:MM:SS.mmm`, the shape the rest of the app stores and displays. */
function normalizeTimestamp(
  h: string | undefined,
  m: string,
  s: string,
  ms: string | undefined,
): string {
  const hh = (h ?? "00").padStart(2, "0");
  const mm = m.padStart(2, "0");
  const ss = s.padStart(2, "0");
  return `${hh}:${mm}:${ss}.${(ms ?? "000").padEnd(3, "0").slice(0, 3)}`;
}

export function detectFormat(raw: string, filename?: string): TranscriptFormat {
  const head = raw.replace(/^﻿/, "").trimStart().slice(0, 2000);

  if (/^WEBVTT/.test(head)) return "vtt";

  // SRT's giveaway is the comma decimal separator in its timing line. VTT uses
  // a full stop. Checked before the extension because the two are near enough
  // that mislabelled files are common.
  if (/\d{2}:\d{2}:\d{2},\d{3}\s*-->/.test(head)) return "srt";
  if (/\d{2}:\d{2}:\d{2}\.\d{3}\s*-->/.test(head)) return "vtt";

  // A CSV needs a header naming a text column — otherwise a transcript full of
  // commas would qualify, which is most of them.
  const firstLine = head.split("\n")[0] ?? "";
  if (
    /(^|,)\s*"?(text|utterance|content|transcript|dialogue)"?\s*(,|$)/i.test(
      firstLine,
    ) &&
    firstLine.includes(",")
  ) {
    return "csv";
  }

  if (filename?.toLowerCase().endsWith(".csv") && firstLine.includes(",")) {
    return "csv";
  }

  return "text";
}

/**
 * SubRip. Structurally WebVTT with a comma where the full stop goes and a
 * mandatory sequence number, so it is parsed by translation rather than by a
 * second near-identical state machine.
 */
export function parseSrt(raw: string): ParsedVttCue[] {
  const asVtt = raw
    .replace(/^﻿/, "")
    .replace(/\r\n/g, "\n")
    // Only inside timing lines — a comma with three digits after it occurs in
    // ordinary speech ("about 1,500 people") and must not be touched.
    .replace(
      /(\d{2}:\d{2}:\d{2}),(\d{3})(\s*-->\s*)(\d{2}:\d{2}:\d{2}),(\d{3})/g,
      "$1.$2$3$4.$5",
    );
  return parseVtt(`WEBVTT\n\n${asVtt}`);
}

/** Split one CSV line, honouring quoted fields and doubled quotes. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      out.push(field);
      field = "";
    } else {
      field += c;
    }
  }
  out.push(field);
  return out.map((f) => f.trim());
}

export function parseCsv(raw: string): ParsedVttCue[] {
  const lines = raw
    .replace(/^﻿/, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => l.trim());
  if (lines.length < 2) return [];

  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const find = (...names: string[]) =>
    header.findIndex((h) => names.some((n) => h === n || h.includes(n)));

  const textCol = find("text", "utterance", "content", "transcript", "dialogue");
  const speakerCol = find("speaker", "name", "participant", "who");
  const startCol = find("start", "time", "timestamp", "begin");
  const endCol = find("end", "stop");

  if (textCol === -1) return [];

  const cues: ParsedVttCue[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const text = (cells[textCol] ?? "").trim();
    if (!text) continue;
    cues.push({
      speaker: (speakerCol !== -1 ? cells[speakerCol] : "")?.trim() || "Unknown",
      timestamp_start: parseLooseTimestamp(
        startCol !== -1 ? cells[startCol] : "",
      ),
      timestamp_end:
        endCol !== -1 ? parseLooseTimestamp(cells[endCol]) : null,
      text,
    });
  }
  return cues;
}

/** `1:02`, `01:02:03`, `00:01:02.500` → canonical form; anything else → "". */
export function parseLooseTimestamp(value: string | undefined): string {
  if (!value) return "";
  const m = value
    .trim()
    .match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (!m) return "";
  return normalizeTimestamp(m[1], m[2], m[3], m[4]);
}

// "Jordan Lee:", "PARTICIPANT:", "Speaker 1:" — a label, then a colon. Bounded
// in length so that a sentence containing a colon is not read as a speaker.
const INLINE_SPEAKER_RE = /^([^:]{1,60}?)\s*:\s*(.*)$/;

// Otter/Teams style: the speaker on a line of their own, with the timestamp
// trailing and no colon — "Jordan Lee  00:12" or "Speaker 1 0:03".
const SPEAKER_HEADER_RE =
  /^(.{1,60}?)\s{1,}((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\s*$/;

/**
 * Plain text: Otter, Rev, Teams, Google Meet, or something typed by hand.
 *
 * Three shapes, which appear mixed inside one file more often than not:
 * a speaker header on its own line with a trailing timestamp; an inline
 * `Speaker: text` prefix; and bare paragraphs continuing whoever spoke last.
 */
export function parseSpeakerText(raw: string): ParsedVttCue[] {
  const lines = raw
    .replace(/^﻿/, "")
    .replace(/\r\n/g, "\n")
    .split("\n");

  const cues: ParsedVttCue[] = [];
  let speaker = "Unknown";
  let timestamp = "";
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join(" ").replace(/\s+/g, " ").trim();
    buffer = [];
    if (!text) return;
    cues.push({
      speaker,
      timestamp_start: timestamp,
      timestamp_end: null,
      text,
    });
    // A timestamp labels the turn it opened, not everything after it.
    timestamp = "";
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flush();
      continue;
    }

    const header = line.match(SPEAKER_HEADER_RE);
    if (header && !/[.?!,]$/.test(header[1])) {
      flush();
      speaker = header[1].trim();
      timestamp = parseLooseTimestamp(header[2]);
      continue;
    }

    const inline = line.match(INLINE_SPEAKER_RE);
    // A label, not a sentence: no terminal punctuation and few enough words
    // that "One thing I noticed: she rehearses" cannot pass for a speaker.
    if (
      inline &&
      !/[.?!]$/.test(inline[1]) &&
      inline[1].trim().split(/\s+/).length <= 5 &&
      inline[2]
    ) {
      flush();
      // A timestamp may ride along: "Jordan  00:12: text"
      const withTime = inline[1].match(
        /^(.*?)\s+((?:\d{1,2}:)?\d{1,2}:\d{2})$/,
      );
      if (withTime) {
        speaker = withTime[1].trim();
        timestamp = parseLooseTimestamp(withTime[2]);
      } else {
        speaker = inline[1].trim();
      }
      buffer.push(inline[2]);
      continue;
    }

    buffer.push(line);
  }
  flush();

  return cues;
}

/** Parse a transcript of any supported format into cues. */
export function parseTranscript(
  raw: string,
  filename?: string,
): { cues: ParsedVttCue[]; format: TranscriptFormat } {
  const format = detectFormat(raw, filename);
  switch (format) {
    case "vtt":
      return { cues: parseVtt(raw), format };
    case "srt":
      return { cues: parseSrt(raw), format };
    case "csv":
      return { cues: parseCsv(raw), format };
    case "text":
      return { cues: parseSpeakerText(raw), format };
  }
}

export const TRANSCRIPT_EXTENSIONS = [
  "vtt",
  "srt",
  "txt",
  "md",
  "csv",
  "tsv",
  "docx",
] as const;

/**
 * A first guess at the study label, from the file the coder picked.
 *
 * 🔴 This is not cosmetic. The label decides the interview's id, and the id is
 * what makes two coders' work line up — so a label carrying a stray `.docx`
 * would put one coder on a different interview from the other, silently. The
 * extension must come off whichever container the transcript arrived in, not
 * just `.vtt`.
 *
 * Only ever a suggestion: it is written into an editable field, because a
 * filename is not a study ID and the coder is the one who knows theirs.
 */
export function labelFromFilename(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const stripped = base.replace(
    new RegExp(`\\.(${TRANSCRIPT_EXTENSIONS.join("|")})$`, "i"),
    "",
  );
  return stripped.trim();
}
