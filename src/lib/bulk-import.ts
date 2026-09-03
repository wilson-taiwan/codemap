import { basename } from "./format";
import { normalizeLabel, nextParticipantId } from "./study-label";

/**
 * Bulk transcript import helpers (T05).
 *
 * Pure filename → label suggestion plus duplicate detection. The actual
 * create+import loop lives in the modal and reuses the store's
 * `createInterview` / `importVtt`, so parsing, merging, and migration stay in
 * exactly one place.
 */

/** "C:\audio\P07 intake.vtt" → "P07 intake". Empty stem → "". */
export function suggestLabelForFile(filePath: string): string {
  const base = basename(filePath);
  const stem = base.replace(/\.[^./\\]+$/, "").trim();
  return stem;
}

/**
 * Duplicate check for one review-screen row.
 *
 * `taken` is every label the study already holds plus the other rows' current
 * labels. Comparison is normalized (case/whitespace-insensitive), mirroring
 * `checkStudyLabel`. `suggestion` is the next free ID when the study has a
 * numbering pattern, else "".
 */
export function duplicateInfo(
  label: string,
  taken: string[],
): { isDuplicate: boolean; suggestion: string } {
  const trimmed = label.trim();
  if (!trimmed) return { isDuplicate: false, suggestion: "" };
  const normalized = normalizeLabel(trimmed);
  const isDuplicate = taken.some(
    (t) => t.trim().length > 0 && normalizeLabel(t) === normalized,
  );
  if (!isDuplicate) return { isDuplicate: false, suggestion: "" };
  return { isDuplicate: true, suggestion: nextParticipantId(taken) };
}

/** Seed labels for a fresh file pick: stems, falling back to P-series IDs. */
export function seedLabelsForFiles(
  filePaths: string[],
  knownLabels: string[],
): string[] {
  const taken = [...knownLabels];
  return filePaths.map((fp) => {
    const stem = suggestLabelForFile(fp);
    if (stem && !duplicateInfo(stem, taken).isDuplicate) {
      taken.push(stem);
      return stem;
    }
    const next = nextParticipantId(taken);
    const label = next || stem || `Import ${taken.length + 1}`;
    taken.push(label);
    return label;
  });
}
