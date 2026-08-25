import type { Code, CodedSegment, Interview } from "./types";

export interface MatrixCell {
  codeId: string;
  codeName: string;
  count: number;
  snippets: {
    quote: string;
    subCodeName?: string;
    coderName?: string;
    memo?: string | null;
  }[];
}

export interface MatrixRow {
  interviewId: string;
  participantLabel: string;
  cells: Record<string, MatrixCell>;
}

export interface FrameworkMatrixData {
  columns: { codeId: string; codeName: string; color: string; subCodeNames: string[] }[];
  rows: MatrixRow[];
}

/**
 * Builds a structured participant-by-code Framework Analysis matrix (Gale et al. 2013).
 *
 * Each cell includes total frequency for that participant × code (including sub-code rollup),
 * plus up to 2 illustrative quote snippets.
 */
export function buildFrameworkMatrix(
  codes: Code[],
  interviews: Interview[],
  codedSegments: CodedSegment[],
): FrameworkMatrixData {
  // Only top-level codes form the columns; sub-codes roll up into their parents
  const topLevelCodes = codes
    .filter((c) => !c.is_retired && !c.parent_id)
    .sort((a, b) => a.sort_order - b.sort_order);

  const subCodesByParent = new Map<string, Code[]>();
  for (const c of codes) {
    if (c.parent_id && !c.is_retired) {
      const list = subCodesByParent.get(c.parent_id) ?? [];
      list.push(c);
      subCodesByParent.set(c.parent_id, list);
    }
  }

  const columns = topLevelCodes.map((parent) => {
    const subCodes = subCodesByParent.get(parent.id) ?? [];
    return {
      codeId: parent.id,
      codeName: parent.name,
      color: parent.color,
      subCodeNames: subCodes.map((s) => s.name),
    };
  });

  // Map participant rows
  const rows: MatrixRow[] = interviews.map((iv) => {
    const ivSegments = codedSegments.filter((cs) => cs.interview_id === iv.id);
    const cells: Record<string, MatrixCell> = {};

    for (const col of columns) {
      const subCodes = subCodesByParent.get(col.codeId) ?? [];
      const subCodeIds = new Set(subCodes.map((s) => s.id));
      const subCodeMap = new Map(subCodes.map((s) => [s.id, s.name]));

      // Segments matching parent code directly OR any sub-code
      const matchingSegments = ivSegments.filter((cs) =>
        cs.code_ids.some((id) => id === col.codeId || subCodeIds.has(id)),
      );

      const snippets: MatrixCell["snippets"] = [];
      for (const cs of matchingSegments) {
        if (snippets.length >= 2) break;
        // Determine if it was applied via sub-code
        const subId = cs.code_ids.find((id) => subCodeIds.has(id));
        const subCodeName = subId ? subCodeMap.get(subId) : undefined;
        snippets.push({
          quote: cs.quote_text.trim(),
          subCodeName,
          coderName: cs.coder_name,
          memo: cs.memo,
        });
      }

      cells[col.codeId] = {
        codeId: col.codeId,
        codeName: col.codeName,
        count: matchingSegments.length,
        snippets,
      };
    }

    return {
      interviewId: iv.id,
      participantLabel: iv.participant_label,
      cells,
    };
  });

  return { columns, rows };
}

/**
 * Serializes the framework matrix to an RFC 4180 CSV string with UTF-8 BOM for Excel.
 */
export function generateFrameworkMatrixCsv(data: FrameworkMatrixData): string {
  function escapeCsv(val: string): string {
    if (val.includes(",") || val.includes('"') || val.includes("\n") || val.includes("\r")) {
      return `"${val.replace(/"/g, '""')}"`;
    }
    return val;
  }

  const header = ["Participant ID", ...data.columns.map((c) => c.codeName)];
  const lines: string[] = [header.map(escapeCsv).join(",")];

  for (const row of data.rows) {
    const rowValues = [
      row.participantLabel,
      ...data.columns.map((col) => {
        const cell = row.cells[col.codeId];
        if (!cell || cell.count === 0) return "";
        const parts: string[] = [`[${cell.count}]`];
        for (const s of cell.snippets) {
          const sub = s.subCodeName ? `(${s.subCodeName}) ` : "";
          parts.push(`${sub}“${s.quote}”`);
        }
        return parts.join("\n");
      }),
    ];
    lines.push(rowValues.map(escapeCsv).join(","));
  }

  return `\uFEFF${lines.join("\r\n")}\r\n`;
}
