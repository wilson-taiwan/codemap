import type { RecentProject, MembershipSummary } from "./types";

export type StudyReadiness =
  | { kind: "missing-transcripts"; missingCount: number }
  | { kind: "unlinked" }
  | { kind: "behind"; behindCount: number }
  | { kind: "diverged" }
  | { kind: "ready" };

export type HomeRow =
  | {
      kind: "bound-group";
      projectId: string;
      title: string;
      path: string;
      coderName: string;
      members: string[];
      role: string;
      lastOpenedAt: string;
      isOffline: boolean;
      readiness?: StudyReadiness;
      duplicateOf?: string[];
      groupKeyPrefix?: string;
    }
  | {
      kind: "remote-group-unbound";
      projectId: string;
      title: string;
      coderName: string;
      members: string[];
      role: string;
      readiness?: StudyReadiness;
      duplicateOf?: string[];
      groupKeyPrefix?: string;
    }
  | {
      kind: "standalone-project";
      path: string;
      title: string;
      lastOpenedAt: string;
      readiness?: StudyReadiness;
      formerGroupId?: string;
      formerGroupTitle?: string;
    };

export type SharedHomeRow = Extract<HomeRow, { kind: "bound-group" | "remote-group-unbound" }>;
export type IndividualHomeRow = Extract<HomeRow, { kind: "standalone-project" }>;

export interface HomeSections {
  individual: IndividualHomeRow[];
  shared: SharedHomeRow[];
}

export function getRowReadiness(row: HomeRow): StudyReadiness {
  if (row.readiness) return row.readiness;
  if (row.kind === "remote-group-unbound") return { kind: "unlinked" };
  return { kind: "ready" };
}

export function readinessPriority(readiness: StudyReadiness): number {
  switch (readiness.kind) {
    case "missing-transcripts":
      return 1;
    case "unlinked":
      return 2;
    case "behind":
      return 3;
    case "diverged":
      return 4;
    case "ready":
      return 5;
  }
}

export function normalizeStudyTitle(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

export interface DeriveHomeRowsParams {
  recents: RecentProject[];
  cachedMemberships: MembershipSummary[];
  liveMemberships: MembershipSummary[] | null;
  signedIn: boolean;
}

/**
 * Pure function to derive grouped home screen sections.
 *
 * Returned structure:
 * - individual: Standalone local projects not bound to any shared group.
 * - shared: Bound groups on this computer followed by remote groups not yet set up locally.
 *
 * Bound groups and standalone projects are ordered by readinessPriority ascending, then lastOpenedAt descending.
 */
export function deriveHomeRows({
  recents,
  cachedMemberships,
  liveMemberships,
  signedIn,
}: DeriveHomeRowsParams): HomeSections {
  const isOffline = liveMemberships === null;
  const memberships = liveMemberships ?? cachedMemberships;

  const membershipMap = new Map<string, MembershipSummary>();
  for (const m of memberships) {
    if (m.projectId && !membershipMap.has(m.projectId)) {
      membershipMap.set(m.projectId, m);
    }
  }

  const cachedMap = new Map<string, MembershipSummary>();
  for (const m of cachedMemberships) {
    if (m.projectId && !cachedMap.has(m.projectId)) {
      cachedMap.set(m.projectId, m);
    }
  }

  const boundGroupRows: SharedHomeRow[] = [];
  const standaloneRows: IndividualHomeRow[] = [];
  const boundGroupIds = new Set<string>();
  const formerGroupIds = new Set<string>();

  // Process recents in their given order
  for (const r of recents) {
    if (r.former_group_id) {
      formerGroupIds.add(r.former_group_id);
    }

    if (r.group_id) {
      if (boundGroupIds.has(r.group_id)) {
        // Prevent duplicate bound cards for the same group id
        continue;
      }
      boundGroupIds.add(r.group_id);

      const mem = membershipMap.get(r.group_id) ?? cachedMap.get(r.group_id);
      if (mem) {
        boundGroupRows.push({
          kind: "bound-group",
          projectId: r.group_id,
          title: mem.title || r.group_title || r.title,
          path: r.path,
          coderName: mem.coderName || r.coder_name || "You",
          members: mem.members && mem.members.length > 0 ? mem.members : [mem.coderName || "You"],
          role: mem.role || "coder",
          lastOpenedAt: r.last_opened_at,
          isOffline: isOffline || !membershipMap.has(r.group_id),
          readiness: r.readiness,
        });
      } else {
        // Bound locally, but not found in live/cached memberships (e.g. offline cold launch or signed out)
        boundGroupRows.push({
          kind: "bound-group",
          projectId: r.group_id,
          title: r.group_title || r.title,
          path: r.path,
          coderName: r.coder_name || "You",
          members: r.coder_name ? [r.coder_name] : ["You"],
          role: "coder",
          lastOpenedAt: r.last_opened_at,
          isOffline: true,
          readiness: r.readiness,
        });
      }
    } else {
      standaloneRows.push({
        kind: "standalone-project",
        path: r.path,
        title: r.title,
        lastOpenedAt: r.last_opened_at,
        readiness: r.readiness,
        formerGroupId: r.former_group_id,
        formerGroupTitle: r.former_group_title,
      });
    }
  }

  // Any membership not bound to a local recent becomes a remote-group-unbound row,
  // unless its projectId matches a recent's former_group_id (Task 6 ghost suppression).
  const unboundGroupRows: SharedHomeRow[] = [];
  if (signedIn || memberships.length > 0) {
    for (const m of memberships) {
      if (!boundGroupIds.has(m.projectId) && !formerGroupIds.has(m.projectId)) {
        unboundGroupRows.push({
          kind: "remote-group-unbound",
          projectId: m.projectId,
          title: m.title,
          coderName: m.coderName,
          members: m.members && m.members.length > 0 ? m.members : [m.coderName],
          role: m.role || "coder",
        });
      }
    }
  }

  // Sorter: readinessPriority ascending, then lastOpenedAt descending
  const compareRows = (a: HomeRow, b: HomeRow): number => {
    const prioA = readinessPriority(getRowReadiness(a));
    const prioB = readinessPriority(getRowReadiness(b));
    if (prioA !== prioB) return prioA - prioB;

    const dateA = "lastOpenedAt" in a ? a.lastOpenedAt : "";
    const dateB = "lastOpenedAt" in b ? b.lastOpenedAt : "";
    return dateB.localeCompare(dateA);
  };

  standaloneRows.sort(compareRows);
  boundGroupRows.sort(compareRows);

  const sharedRows: SharedHomeRow[] = [...boundGroupRows, ...unboundGroupRows];

  // Detect duplicate groups sharing normalized titles (Task 7)
  const sharedByTitle = new Map<string, Array<{ row: SharedHomeRow; projectId: string }>>();
  for (const row of sharedRows) {
    const norm = normalizeStudyTitle(row.title);
    const existing = sharedByTitle.get(norm) ?? [];
    existing.push({ row, projectId: row.projectId });
    sharedByTitle.set(norm, existing);
  }

  for (const group of sharedByTitle.values()) {
    if (group.length >= 2) {
      const allIds = group.map((g) => g.projectId);
      for (const item of group) {
        item.row.duplicateOf = allIds.filter((id) => id !== item.projectId);
      }
    }
  }

  return {
    individual: standaloneRows,
    shared: sharedRows,
  };
}

/**
 * Format teammate names for home screen row subtitle.
 * e.g. "with Hiroko and Sam" or "with Hiroko, Sam and 2 others"
 */
export function formatMembersPhrase(members: string[], myCoderName: string): string {
  const myLower = myCoderName.trim().toLowerCase();
  const others = members.filter((m) => m.trim().toLowerCase() !== myLower);
  if (others.length === 0) return "";
  if (others.length === 1) return `with ${others[0]}`;
  if (others.length === 2) return `with ${others[0]} and ${others[1]}`;
  if (others.length === 3) return `with ${others[0]}, ${others[1]} and ${others[2]}`;
  return `with ${others[0]}, ${others[1]} and ${others.length - 2} others`;
}
