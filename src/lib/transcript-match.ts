import { api } from "./api";
import { parseTranscript, labelFromFilename } from "./transcript-parser";
import { cuesToSegments } from "./vtt-parser";
import { normalizeLabel, editDistance } from "./study-label";
import type { InterviewRosterEntry } from "./types";

export interface CandidateFile {
  path: string;
  name: string;
  rawText: string;
}

export type MatchConfidence = "exact-hash" | "near-miss-filename" | "unmatched";

export interface MatchResult {
  label: string;
  file?: CandidateFile;
  confidence: MatchConfidence;
  why?: string;
}

export type MatchMap = Map<string, MatchResult>;

export interface MatchOptions {
  mergeSameSpeaker?: boolean;
  hashFn?: (segments: Array<{ index: number; text: string }>) => Promise<string | null>;
}

/**
 * Match a folder of candidate transcript files against an interview roster.
 *
 * Algorithm:
 * 1. First pass (content hash):
 *    Parse candidate file, compute deterministic content hash, and match
 *    against remote roster content_hash.
 * 2. Second pass (filename fallback & near-miss rescue):
 *    For unmatched files and roster entries, match by exact normalized filename label,
 *    or near-miss label within edit distance <= 2 (unambiguous only).
 */
export async function matchFolderToRoster(
  files: CandidateFile[],
  roster: InterviewRosterEntry[],
  options: MatchOptions = {},
): Promise<MatchMap> {
  const { mergeSameSpeaker = true, hashFn = api.hashCandidateSegments } = options;

  const results: MatchMap = new Map();
  const matchedFilePaths = new Set<string>();
  const matchedRosterLabels = new Set<string>();

  // Parse files and calculate candidate hashes
  interface FileCandidateInfo {
    file: CandidateFile;
    hash: string | null;
    labelGuess: string;
    normalizedGuess: string;
  }

  const fileInfos: FileCandidateInfo[] = [];

  for (const file of files) {
    let hash: string | null = null;
    try {
      const parsed = parseTranscript(file.rawText, file.name);
      const segments = cuesToSegments(parsed.cues, mergeSameSpeaker);
      if (segments.length > 0) {
        hash = await hashFn(
          segments.map((s, idx) => ({ index: idx, text: s.text })),
        );
      }
    } catch {
      hash = null;
    }

    const labelGuess = labelFromFilename(file.name);
    fileInfos.push({
      file,
      hash,
      labelGuess,
      normalizedGuess: normalizeLabel(labelGuess),
    });
  }

  // Pass 1: Exact Content Hash Match
  for (const r of roster) {
    if (!r.content_hash) continue;
    // Find candidate files matching this hash
    const matchingFiles = fileInfos.filter(
      (f) =>
        !matchedFilePaths.has(f.file.path) &&
        f.hash !== null &&
        f.hash === r.content_hash,
    );

    if (matchingFiles.length === 1) {
      const match = matchingFiles[0];
      matchedFilePaths.add(match.file.path);
      matchedRosterLabels.add(r.study_label);
      results.set(r.study_label, {
        label: r.study_label,
        file: match.file,
        confidence: "exact-hash",
      });
    }
  }

  // Pass 2: Filename exact match fallback (for missing remote hashes or unhashed files)
  for (const r of roster) {
    if (matchedRosterLabels.has(r.study_label)) continue;
    const normalizedTarget = normalizeLabel(r.study_label);

    const matchingFiles = fileInfos.filter(
      (f) =>
        !matchedFilePaths.has(f.file.path) &&
        f.normalizedGuess === normalizedTarget,
    );

    if (matchingFiles.length === 1) {
      const match = matchingFiles[0];
      matchedFilePaths.add(match.file.path);
      matchedRosterLabels.add(r.study_label);
      results.set(r.study_label, {
        label: r.study_label,
        file: match.file,
        confidence: "exact-hash",
        why: `Matched by filename "${match.file.name}"`,
      });
    }
  }

  // Pass 3: Near-miss filename rescue (editDistance <= 2)
  for (const r of roster) {
    if (matchedRosterLabels.has(r.study_label)) continue;
    const normalizedTarget = normalizeLabel(r.study_label);
    const tolerance = normalizedTarget.length <= 4 ? 1 : 2;

    const nearMissFiles = fileInfos.filter((f) => {
      if (matchedFilePaths.has(f.file.path)) return false;
      const d = editDistance(f.normalizedGuess, normalizedTarget);
      return d > 0 && d <= tolerance;
    });

    if (nearMissFiles.length === 1) {
      const match = nearMissFiles[0];
      matchedFilePaths.add(match.file.path);
      matchedRosterLabels.add(r.study_label);
      results.set(r.study_label, {
        label: r.study_label,
        file: match.file,
        confidence: "near-miss-filename",
        why: `Near-miss filename "${match.file.name}" matches "${r.study_label}"`,
      });
    }
  }

  // Final Pass: Mark remaining roster entries as unmatched
  for (const r of roster) {
    if (!matchedRosterLabels.has(r.study_label)) {
      results.set(r.study_label, {
        label: r.study_label,
        confidence: "unmatched",
        why: "No matching transcript file found.",
      });
    }
  }

  return results;
}
