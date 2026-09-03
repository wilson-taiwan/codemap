import type { Code } from "./types";

/**
 * Codebook search predicate (T07).
 *
 * Matches a word in the code's name or any of its descriptive text —
 * definition, inclusion/exclusion criteria, example — not just the name. A
 * code named "Trust" with "asks who holds the notes" only in its definition
 * must still surface. Case-insensitive; a blank query matches everything.
 */
export function codeMatchesQuery(code: Code, query: string): boolean {
  const q = query.toLowerCase().trim();
  if (!q) return true;
  const haystacks = [
    code.name,
    code.definition,
    code.inclusion_criteria,
    code.exclusion_criteria,
    code.example,
  ];
  return haystacks.some(
    (field) => field != null && field.toLowerCase().includes(q),
  );
}
