/**
 * Per-interview speaker redaction aliases (T06).
 *
 * Each interview maps its real speaker names to Speaker 1, Speaker 2 in
 * first-appearance (segment_index) order, so readers can still tell speakers
 * apart with no real name on screen, on the clipboard, or in an export.
 *
 * Rules, settled in the plan and not to be re-opened lightly:
 * - "Interviewer" (exact match) is never aliased and never numbered.
 * - Every other distinct name — including the parser default "Unknown" — is
 *   numbered in first-appearance order. Treating "Unknown" as a speaker keeps
 *   one consistent rule instead of a special case that leaks ("Speaker ?"
 *   would mark exactly the passages with no attribution).
 * - Numbering is independent per interview: each interview's first speaker is
 *   Speaker 1. A global map would join identities across interviews and risk
 *   re-identification.
 * - The map is derived, not stored: real names stay in the database and the
 *   only persisted state is the per-interview on/off toggle (app preferences,
 *   local-only, never synced).
 */

/** Exact-match exemption. Never aliased, never numbered. */
export const INTERVIEWER_SPEAKER = "Interviewer";

/**
 * Number distinct non-Interviewer speakers in first-appearance order.
 * Empty/whitespace names are skipped — they carry nothing to redact.
 */
export function buildSpeakerAliases(
  speakersInOrder: string[],
): Map<string, string> {
  const aliases = new Map<string, string>();
  let n = 0;
  for (const raw of speakersInOrder) {
    const name = raw.trim();
    if (!name || name === INTERVIEWER_SPEAKER || aliases.has(name)) continue;
    n += 1;
    aliases.set(name, `Speaker ${n}`);
  }
  return aliases;
}

/** Alias for one name, or the name itself when it has none (Interviewer). */
export function aliasForSpeaker(
  name: string,
  aliases: Map<string, string> | null,
): string {
  if (!aliases) return name;
  return aliases.get(name.trim()) ?? name;
}

/** First-appearance preview pairs for the settings toggle, up to `limit`. */
export function aliasPreview(
  speakersInOrder: string[],
  limit = 3,
): { real: string; alias: string }[] {
  const out: { real: string; alias: string }[] = [];
  for (const [real, alias] of buildSpeakerAliases(speakersInOrder)) {
    out.push({ real, alias });
    if (out.length >= limit) break;
  }
  return out;
}
