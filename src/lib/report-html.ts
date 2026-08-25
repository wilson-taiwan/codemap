import type { ExportConfig } from "./export-config";
import { describePreset } from "./export-config";
import { buildFrameworkMatrix } from "./framework-matrix";
import type { Code, CodedSegment, Interview, ProjectInfo } from "./types";

export interface HtmlReportOptions {
  project: ProjectInfo;
  config: ExportConfig;
  codes: Code[];
  interviews: Interview[];
  codedSegments: CodedSegment[];
  exportedBy: string;
  exportedAt: string;
  unresolvedConflictCount?: number;
}

function escapeHtml(str: string | null | undefined): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function generateHtmlReport(options: HtmlReportOptions): string {
  const {
    project,
    config,
    codes,
    interviews,
    codedSegments,
    exportedBy,
    exportedAt,
  } = options;
  const unresolvedConflictCount = Math.max(0, options.unresolvedConflictCount ?? 0);

  // Filter interviews if participant scope is selected
  const activeInterviews =
    config.includeParticipantScope === "selected" && config.selectedParticipantIds
      ? interviews.filter((iv) => config.selectedParticipantIds?.includes(iv.id))
      : interviews;
  const activeInterviewIds = new Set(activeInterviews.map((iv) => iv.id));

  // Filter coded segments by participant scope and coder scope
  let activeSegments = codedSegments.filter((cs) => activeInterviewIds.has(cs.interview_id));
  if (config.includeCoderScope === "active-coder" && exportedBy) {
    activeSegments = activeSegments.filter((cs) => cs.coder_name === exportedBy);
  }

  const activeCodes = codes.filter((c) => !c.is_retired);
  const retiredCodes = codes.filter((c) => c.is_retired);

  const topLevelCodes = activeCodes
    .filter((c) => !c.parent_id)
    .sort((a, b) => a.sort_order - b.sort_order);

  const subCodesByParent = new Map<string, Code[]>();
  for (const c of activeCodes) {
    if (c.parent_id) {
      const list = subCodesByParent.get(c.parent_id) ?? [];
      list.push(c);
      subCodesByParent.set(c.parent_id, list);
    }
  }

  const memoCount = activeSegments.filter((cs) => !!cs.memo).length +
    activeInterviews.filter((iv) => !!iv.hub_memo).length;

  const presetMeta = config.preset !== "custom" ? describePreset(config.preset) : null;
  const methodLabel = presetMeta ? presetMeta.label : "Custom qualitative export";

  // Build Framework Matrix if requested
  const matrixData = config.items.includes("framework-matrix")
    ? buildFrameworkMatrix(activeCodes, activeInterviews, activeSegments)
    : null;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(project.title)} — Qualitative Coding Report</title>
  <style>
    :root {
      --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      --font-serif: "Charter", "Bitstream Charter", "Sitka Text", "Cambria", Georgia, serif;
      --font-mono: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace;
      --bg: #ffffff;
      --surface: #f8fafc;
      --surface-card: #ffffff;
      --ink-1: #0f172a;
      --ink-2: #334155;
      --ink-3: #64748b;
      --ink-4: #94a3b8;
      --border: #e2e8f0;
      --border-subtle: #f1f5f9;
      --accent: #d97706;
      --accent-soft: #fef3c7;
      --accent-ink: #92400e;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: var(--font-sans);
      color: var(--ink-1);
      background: var(--bg);
      line-height: 1.5;
      padding: 40px 24px;
      max-width: 900px;
      margin: 0 auto;
    }

    /* Print styling */
    @media print {
      body {
        padding: 0;
        max-width: 100%;
        color: #000;
        background: #fff;
      }
      .page-break {
        page-break-before: always;
        break-before: page;
      }
      .no-break {
        page-break-inside: avoid;
        break-inside: avoid;
      }
      .no-print {
        display: none !important;
      }
      thead {
        display: table-header-group;
      }
      tr {
        page-break-inside: avoid;
        break-inside: avoid;
      }
      .card, .extract-card {
        box-shadow: none !important;
        border: 1px solid #cbd5e1 !important;
      }
      a {
        text-decoration: none;
        color: inherit;
      }
    }

    header.cover {
      border-bottom: 2px solid var(--border);
      padding-bottom: 28px;
      margin-bottom: 36px;
    }

    .eyebrow {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--ink-3);
      margin-bottom: 6px;
    }

    h1 {
      font-size: 28px;
      font-weight: 700;
      line-height: 1.2;
      color: var(--ink-1);
      margin-bottom: 12px;
    }

    .meta-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 16px;
      margin-top: 20px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
    }

    .meta-item .label {
      font-size: 11px;
      color: var(--ink-3);
      text-transform: uppercase;
      font-weight: 600;
    }

    .meta-item .value {
      font-size: 14px;
      font-weight: 500;
      color: var(--ink-1);
      margin-top: 2px;
    }

    section {
      margin-bottom: 40px;
    }

    h2 {
      font-size: 18px;
      font-weight: 600;
      color: var(--ink-1);
      border-bottom: 1px solid var(--border);
      padding-bottom: 8px;
      margin-bottom: 16px;
    }

    h3 {
      font-size: 15px;
      font-weight: 600;
      color: var(--ink-2);
      margin: 16px 0 8px 0;
    }

    .code-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 2px 8px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      background: var(--surface);
      border: 1px solid var(--border);
    }

    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
      flex-shrink: 0;
    }

    .codebook-tree {
      list-style: none;
    }

    .codebook-item {
      padding: 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      margin-bottom: 8px;
      background: var(--surface-card);
    }

    .codebook-sub-item {
      margin-left: 24px;
      margin-top: 8px;
      padding: 10px 12px;
      border-left: 3px solid var(--border);
      background: var(--surface);
      border-radius: 0 6px 6px 0;
    }

    .code-definition {
      font-size: 13px;
      color: var(--ink-2);
      margin-top: 4px;
    }

    .code-criteria {
      font-size: 12px;
      color: var(--ink-3);
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px dashed var(--border);
    }

    .extract-card {
      padding: 14px 16px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface-card);
      margin-bottom: 12px;
    }

    .extract-quote {
      font-family: var(--font-serif);
      font-size: 14px;
      font-style: italic;
      color: var(--ink-1);
      line-height: 1.6;
      margin-bottom: 10px;
    }

    .extract-quote mark {
      background-color: #fef08a;
      padding: 0 2px;
      font-weight: 600;
    }

    .extract-meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 11.5px;
      color: var(--ink-3);
      border-top: 1px solid var(--border-subtle);
      padding-top: 8px;
    }

    .extract-memo {
      margin-top: 8px;
      padding: 6px 10px;
      background: #f8fafc;
      border-left: 3px solid var(--accent);
      border-radius: 0 4px 4px 0;
      font-size: 12px;
      color: var(--ink-2);
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      text-align: left;
      margin-top: 12px;
    }

    th, td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }

    th {
      background: var(--surface);
      font-weight: 600;
      color: var(--ink-2);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .matrix-table th {
      min-width: 160px;
    }

    .matrix-table td {
      font-size: 12px;
      line-height: 1.4;
    }

    .matrix-snippet {
      margin-top: 4px;
      font-family: var(--font-serif);
      font-style: italic;
      color: var(--ink-2);
      font-size: 11px;
    }

    .conflict-notice {
      margin-top: 16px;
      padding: 10px 12px;
      border: 1px solid #f59e0b;
      border-radius: 6px;
      background: var(--accent-soft);
      color: var(--accent-ink);
      font-size: 13px;
    }
  </style>
</head>
<body>

  <!-- Cover Header -->
  <header class="cover">
    <div class="eyebrow">Qualitative Study Report</div>
    <h1>${escapeHtml(project.title)}</h1>
    <p style="color: var(--ink-2); font-size: 14px;">Methodology: <strong>${escapeHtml(methodLabel)}</strong></p>
    ${
      unresolvedConflictCount > 0
        ? `<p class="conflict-notice"><strong>${unresolvedConflictCount} unresolved sync conflict${unresolvedConflictCount === 1 ? "" : "s"}.</strong> This export uses the current canonical study values; pending proposals are not merged into analysis.</p>`
        : ""
    }

    <div class="meta-grid">
      <div class="meta-item">
        <div class="label">Participants</div>
        <div class="value">${activeInterviews.length}</div>
      </div>
      <div class="meta-item">
        <div class="label">Coded Passages</div>
        <div class="value">${activeSegments.length}</div>
      </div>
      <div class="meta-item">
        <div class="label">Active Codes</div>
        <div class="value">${activeCodes.length}</div>
      </div>
      <div class="meta-item">
        <div class="label">Memos & Notes</div>
        <div class="value">${memoCount}</div>
      </div>
      <div class="meta-item">
        <div class="label">Exported By</div>
        <div class="value">${escapeHtml(exportedBy || "Ada Lovelace")}</div>
      </div>
      <div class="meta-item">
        <div class="label">Export Date</div>
        <div class="value">${escapeHtml(exportedAt.slice(0, 10))}</div>
      </div>
    </div>
  </header>

  ${
    config.items.includes("codebook")
      ? `
  <!-- Codebook Section -->
  <section class="page-break">
    <h2>Codebook Structure &amp; Definitions</h2>
    <ul class="codebook-tree">
      ${topLevelCodes
        .map((code) => {
          const subCodes = subCodesByParent.get(code.id) ?? [];
          return `
        <li class="codebook-item no-break">
          <div class="code-chip">
            <span class="dot" style="background-color: ${escapeHtml(code.color)};"></span>
            ${escapeHtml(code.name)}
          </div>
          ${
            code.definition
              ? `<div class="code-definition">${escapeHtml(code.definition)}</div>`
              : ""
          }
          ${
            code.inclusion_criteria || code.exclusion_criteria
              ? `
            <div class="code-criteria">
              ${
                code.inclusion_criteria
                  ? `<div><strong>Inclusion:</strong> ${escapeHtml(code.inclusion_criteria)}</div>`
                  : ""
              }
              ${
                code.exclusion_criteria
                  ? `<div><strong>Exclusion:</strong> ${escapeHtml(code.exclusion_criteria)}</div>`
                  : ""
              }
              ${
                code.example
                  ? `<div><strong>Example:</strong> “${escapeHtml(code.example)}”</div>`
                  : ""
              }
            </div>`
              : ""
          }

          ${
            subCodes.length > 0
              ? `
            <div style="margin-top: 8px;">
              ${subCodes
                .map(
                  (sub) => `
                <div class="codebook-sub-item no-break">
                  <div class="code-chip">
                    <span class="dot" style="background-color: ${escapeHtml(sub.color)};"></span>
                    ${escapeHtml(sub.name)}
                  </div>
                  ${
                    sub.definition
                      ? `<div class="code-definition">${escapeHtml(sub.definition)}</div>`
                      : ""
                  }
                  ${
                    sub.inclusion_criteria || sub.exclusion_criteria
                      ? `
                    <div class="code-criteria">
                      ${
                        sub.inclusion_criteria
                          ? `<div><strong>Inclusion:</strong> ${escapeHtml(sub.inclusion_criteria)}</div>`
                          : ""
                      }
                      ${
                        sub.exclusion_criteria
                          ? `<div><strong>Exclusion:</strong> ${escapeHtml(sub.exclusion_criteria)}</div>`
                          : ""
                      }
                    </div>`
                      : ""
                  }
                </div>
              `,
                )
                .join("")}
            </div>
          `
              : ""
          }
        </li>`;
        })
        .join("")}
    </ul>

    ${
      retiredCodes.length > 0
        ? `
      <div style="margin-top: 24px;">
        <h3 style="color: var(--ink-3);">Retired Codes (${retiredCodes.length})</h3>
        <p style="font-size: 12px; color: var(--ink-3); margin-bottom: 8px;">Codes retired during iterative analysis and preserved for auditability.</p>
        <ul style="list-style: disc; margin-left: 20px; font-size: 13px; color: var(--ink-3);">
          ${retiredCodes.map((rc) => `<li>${escapeHtml(rc.name)}</li>`).join("")}
        </ul>
      </div>
    `
        : ""
    }
  </section>`
      : ""
  }

  ${
    config.items.includes("counts")
      ? `
  <!-- Frequencies / Counts Section -->
  <section class="page-break">
    <h2>Coding Frequencies &amp; Corpus Breadth</h2>
    <table>
      <thead>
        <tr>
          <th>Code Name</th>
          <th style="text-align: right;">Direct Occurrences</th>
          <th style="text-align: right;">Rollup (with sub-codes)</th>
          <th style="text-align: right;">Participants</th>
        </tr>
      </thead>
      <tbody>
        ${topLevelCodes
          .map((parent) => {
            const subCodes = subCodesByParent.get(parent.id) ?? [];
            const subIds = new Set(subCodes.map((s) => s.id));

            const directSegments = activeSegments.filter((cs) => cs.code_ids.includes(parent.id));
            const rollupSegments = activeSegments.filter((cs) =>
              cs.code_ids.some((id) => id === parent.id || subIds.has(id)),
            );
            const rollupParticipants = new Set(rollupSegments.map((cs) => cs.interview_id)).size;

            return `
          <tr>
            <td>
              <span class="code-chip">
                <span class="dot" style="background-color: ${escapeHtml(parent.color)};"></span>
                <strong>${escapeHtml(parent.name)}</strong>
              </span>
            </td>
            <td style="text-align: right; font-family: var(--font-mono);">${directSegments.length}</td>
            <td style="text-align: right; font-family: var(--font-mono);">${rollupSegments.length}</td>
            <td style="text-align: right; font-family: var(--font-mono);">${rollupParticipants} / ${activeInterviews.length}</td>
          </tr>
          ${subCodes
            .map((sub) => {
              const subSegs = activeSegments.filter((cs) => cs.code_ids.includes(sub.id));
              const subParts = new Set(subSegs.map((cs) => cs.interview_id)).size;
              return `
            <tr>
              <td style="padding-left: 28px;">
                <span class="code-chip">
                  <span class="dot" style="background-color: ${escapeHtml(sub.color)};"></span>
                  ${escapeHtml(sub.name)}
                </span>
              </td>
              <td style="text-align: right; font-family: var(--font-mono);">${subSegs.length}</td>
              <td style="text-align: right; font-family: var(--font-mono); color: var(--ink-3);">—</td>
              <td style="text-align: right; font-family: var(--font-mono);">${subParts} / ${activeInterviews.length}</td>
            </tr>`;
            })
            .join("")}
        `;
          })
          .join("")}
      </tbody>
    </table>
  </section>`
      : ""
  }

  ${
    matrixData
      ? `
  <!-- Framework Matrix Section -->
  <section class="page-break">
    <h2>Framework Analysis Matrix (Case × Code)</h2>
    <div style="overflow-x: auto;">
      <table class="matrix-table">
        <thead>
          <tr>
            <th style="min-width: 120px;">Participant</th>
            ${matrixData.columns
              .map(
                (col) => `
              <th>
                <div class="code-chip">
                  <span class="dot" style="background-color: ${escapeHtml(col.color)};"></span>
                  ${escapeHtml(col.codeName)}
                </div>
                ${
                  col.subCodeNames.length > 0
                    ? `<div style="font-size: 10px; color: var(--ink-3); margin-top: 2px;">inc. ${escapeHtml(col.subCodeNames.join(", "))}</div>`
                    : ""
                }
              </th>`,
              )
              .join("")}
          </tr>
        </thead>
        <tbody>
          ${matrixData.rows
            .map(
              (row) => `
            <tr>
              <td style="font-weight: 600;">${escapeHtml(row.participantLabel)}</td>
              ${matrixData.columns
                .map((col) => {
                  const cell = row.cells[col.codeId];
                  if (!cell || cell.count === 0) {
                    return `<td style="color: var(--ink-4); text-align: center;">—</td>`;
                  }
                  return `
                  <td>
                    <div style="font-weight: 600; font-size: 11px; color: var(--accent-ink);">[${cell.count}]</div>
                    ${cell.snippets
                      .map(
                        (s) => `
                      <div class="matrix-snippet">
                        ${s.subCodeName ? `<strong>(${escapeHtml(s.subCodeName)})</strong> ` : ""}“${escapeHtml(s.quote)}”
                      </div>`,
                      )
                      .join("")}
                  </td>`;
                })
                .join("")}
            </tr>`,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  </section>`
      : ""
  }

  ${
    config.items.includes("coded-segments")
      ? `
  <!-- Coded Extracts Section -->
  <section class="page-break">
    <h2>Illustrative Extracts & Coded Passages</h2>
    ${topLevelCodes
      .map((parent) => {
        const subCodes = subCodesByParent.get(parent.id) ?? [];
        const subIds = new Set(subCodes.map((s) => s.id));
        const allRelatedIds = new Set([parent.id, ...subIds]);

        const extracts = activeSegments.filter((cs) =>
          cs.code_ids.some((id) => allRelatedIds.has(id)),
        );

        if (extracts.length === 0) return "";

        return `
      <div style="margin-bottom: 28px;">
        <h3 style="margin-bottom: 12px;">
          <span class="code-chip">
            <span class="dot" style="background-color: ${escapeHtml(parent.color)};"></span>
            ${escapeHtml(parent.name)}
          </span>
          <span style="font-size: 12px; color: var(--ink-3); font-weight: normal; margin-left: 8px;">
            (${extracts.length} ${extracts.length === 1 ? "passage" : "passages"})
          </span>
        </h3>

        ${extracts
          .map((cs) => {
            const iv = interviews.find((i) => i.id === cs.interview_id);
            const appliedCodes = codes.filter((c) => cs.code_ids.includes(c.id));
            return `
          <div class="extract-card no-break">
            <div class="extract-quote">“${escapeHtml(cs.quote_text)}”</div>
            <div class="extract-meta">
              <div>
                <strong>${escapeHtml(iv?.participant_label || cs.participant_label || "Participant")}</strong>
                ${cs.timestamp_start ? ` · <span>${escapeHtml(cs.timestamp_start)}</span>` : ""}
              </div>
              <div style="display: flex; gap: 4px; align-items: center;">
                ${appliedCodes
                  .map(
                    (c) => `
                  <span class="code-chip" style="font-size: 10.5px;">
                    <span class="dot" style="background-color: ${escapeHtml(c.color)}; width: 6px; height: 6px;"></span>
                    ${escapeHtml(c.name)}
                  </span>`,
                  )
                  .join("")}
                <span>· Coder: <strong>${escapeHtml(cs.coder_name)}</strong></span>
              </div>
            </div>
            ${
              cs.memo
                ? `
              <div class="extract-memo">
                <strong>Analytic Note:</strong> ${escapeHtml(cs.memo)}
              </div>`
                : ""
            }
          </div>`;
          })
          .join("")}
      </div>`;
      })
      .join("")}
  </section>`
      : ""
  }

  ${
    config.items.includes("memos") &&
    activeInterviews.some((iv) => !!iv.hub_memo)
      ? `
  <!-- Interview Memos Section -->
  <section class="page-break">
    <h2>Participant / Interview Hub Memos</h2>
    ${activeInterviews
      .filter((iv) => !!iv.hub_memo)
      .map(
        (iv) => `
      <div class="card no-break" style="padding: 14px 16px; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 12px; background: var(--surface-card);">
        <div style="font-weight: 600; font-size: 14px; margin-bottom: 4px;">
          ${escapeHtml(iv.participant_label)}
          ${iv.interview_date ? `<span style="font-size: 12px; color: var(--ink-3); font-weight: normal;"> · ${escapeHtml(iv.interview_date)}</span>` : ""}
        </div>
        <p style="font-size: 13px; color: var(--ink-2); line-height: 1.5;">${escapeHtml(iv.hub_memo)}</p>
      </div>`,
      )
      .join("")}
  </section>`
      : ""
  }

</body>
</html>
`;
}
