/**
 * Checking a study label before it becomes an identity.
 *
 * 🔑 The label is the single most consequential field in the app and looks like
 * the least. `interview_id` is a hash of it, so two coders who type `P07` and
 * `P7` for the same interview end up with two different interviews holding the
 * same words, and their coding never meets. Nothing downstream can detect this
 * — by the time it matters, both machines are internally consistent and simply
 * disagree.
 *
 * So the checking happens here, at the keystroke, where it is still free.
 */

/** Mirrors the backend's normalisation exactly — see `src-tauri/src/ids.rs`. */
export function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().split(/\s+/).join(" ");
}

/** Edit distance, capped — we only care about "nearly the same". */
export function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const cur = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

export interface LabelVerdict {
  /** "empty" | "matches" an interview the study already knows | "new" */
  status: "empty" | "matches" | "new";
  /** The existing label this input resolves to, when it matches one. */
  matched?: string;
  /** An existing label this is probably a typo of. */
  didYouMean?: string;
  /** Things worth saying out loud before this becomes permanent. */
  warnings: string[];
}

const FILE_EXTENSION = /\.(docx?|vtt|srt|txt|md|csv|tsv|rtf|pdf)$/i;

/**
 * What to tell someone about the label they are typing.
 *
 * `known` is every label the study already holds, including ones learned from a
 * colleague through the roster — which is the whole point, because the joining
 * coder is exactly the person who has to reproduce a label they never chose.
 */
export function checkStudyLabel(
  input: string,
  known: string[],
  filenameGuess?: string,
): LabelVerdict {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { status: "empty", warnings: [] };

  const normalized = normalizeLabel(trimmed);
  const warnings: string[] = [];

  const exact = known.find((k) => normalizeLabel(k) === normalized);
  if (exact) {
    return { status: "matches", matched: exact, warnings };
  }

  if (filenameGuess && trimmed === filenameGuess.trim()) {
    warnings.push(
      "This came from your file name. Participant IDs come from your protocol — P07, not a file name.",
    );
  }

  if (FILE_EXTENSION.test(trimmed)) {
    warnings.push(
      "That looks like a filename. The label identifies the participant, not the file — try the study ID from your protocol.",
    );
  }

  // Two or more capitalised words with no digit anywhere is what a person's
  // name looks like, and 2-4 uppercase letters (optionally dot/space separated)
  // is what participant initials look like.
  const isFullName = /^[A-Z][a-z]+(\s+[A-Z][a-z]+)+$/.test(trimmed);
  const isInitials = /^[A-Z](?:[.\s]*[A-Z]){1,3}[.\s]*$/.test(trimmed);
  if (!/\d/.test(trimmed) && (isFullName || isInitials)) {
    warnings.push(
      "That looks like a person's name or initials. Use the de-identified study ID from your protocol — this label appears in every export and is sent to the sync server.",
    );
  }

  // The tolerance has to scale with length. Study IDs are short, and on a
  // three-character label two edits is a *different participant* — `P99` is
  // distance 2 from `P07` and means someone else entirely. One flat threshold
  // either misses `P7` for `P07` or accuses `P99` of being a typo.
  const tolerance = normalized.length <= 4 ? 1 : 2;

  let didYouMean: string | undefined;
  let best = tolerance + 1;
  for (const k of known) {
    const d = editDistance(normalized, normalizeLabel(k));
    if (d > 0 && d < best) {
      best = d;
      didYouMean = k;
    }
  }

  return { status: "new", didYouMean, warnings };
}

/**
 * Detects the participant ID numbering pattern across existing labels and
 * produces the next logical ID.
 *
 * Defaults to "P01" for an empty study. Returns "" if existing labels have
 * no discernible numerical pattern.
 */
export function nextParticipantId(existingLabels: string[]): string {
  const clean = existingLabels
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (clean.length === 0) {
    return "P01";
  }

  // Parse each label ending in digits: prefix, digits string, numeric value
  const parsed: { prefix: string; rawDigits: string; num: number; pad: number }[] = [];
  for (const label of clean) {
    const match = label.match(/^(.*?)(\d+)$/);
    if (match) {
      const prefix = match[1];
      const rawDigits = match[2];
      const num = parseInt(rawDigits, 10);
      const pad = rawDigits.length;
      parsed.push({ prefix, rawDigits, num, pad });
    }
  }

  // If none or less than half of labels end in numbers, do not guess
  if (parsed.length === 0 || parsed.length < Math.ceil(clean.length / 2)) {
    return "";
  }

  // Group by prefix to find the dominant prefix pattern
  const prefixCounts = new Map<string, number>();
  for (const p of parsed) {
    prefixCounts.set(p.prefix, (prefixCounts.get(p.prefix) ?? 0) + 1);
  }

  let bestPrefix = parsed[parsed.length - 1].prefix;
  let maxCount = 0;
  for (const [prefix, count] of prefixCounts.entries()) {
    if (count > maxCount) {
      maxCount = count;
      bestPrefix = prefix;
    }
  }

  const matching = parsed.filter((p) => p.prefix === bestPrefix);
  let maxNum = 0;
  let maxPad = 1;
  for (const item of matching) {
    if (item.num > maxNum) maxNum = item.num;
    if (item.pad > maxPad) maxPad = item.pad;
  }

  const nextNum = maxNum + 1;
  const formattedDigits = String(nextNum).padStart(maxPad, "0");
  return `${bestPrefix}${formattedDigits}`;
}
