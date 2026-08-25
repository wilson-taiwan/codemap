export interface CodebookTemplate {
  id: string;
  label: string;
  /** One line, shown on the option card. */
  blurb: string;
  codes: { name: string; definition: string }[];
}

/**
 * Starter codebooks offered during setup.
 *
 * Note the deliberate restraint: in reflexive TA, codes are *generated from*
 * the data, so shipping a set of analytic codes would be pre-empting the
 * analysis. The one non-empty template here is housekeeping only — labels for
 * managing the corpus, not claims about it. Empty stays the default.
 */
export const CODEBOOK_TEMPLATES: CodebookTemplate[] = [
  {
    id: "empty",
    label: "Start empty",
    blurb:
      "Codes come from the data. Recommended for reflexive thematic analysis.",
    codes: [],
  },
  {
    id: "housekeeping",
    label: "Add housekeeping codes",
    blurb:
      "Four workflow labels for managing the corpus — no analytic content.",
    codes: [
      {
        name: "Key quote",
        definition:
          "Verbatim passage worth citing in the manuscript. Not an analytic claim — a shortlist for writing up.",
      },
      {
        name: "Revisit",
        definition:
          "Unclear, ambiguous, or hard to place. Flag now, come back after a full pass.",
      },
      {
        name: "Contradiction",
        definition:
          "Participant contradicts themselves, or contradicts a pattern forming elsewhere in the corpus.",
      },
      {
        name: "Method note",
        definition:
          "Something about the interview itself — a leading question, an interruption, a recording problem.",
      },
    ],
  },
];

export function getCodebookTemplate(id: string): CodebookTemplate {
  return (
    CODEBOOK_TEMPLATES.find((t) => t.id === id) ?? CODEBOOK_TEMPLATES[0]
  );
}
