/**
 * Canonical collaboration vocabulary for Fleuron 2.3.0.
 *
 * Rule: Every state-changing action names its scope: this computer, the group, or the list.
 * Normative reference: plans/fleuron-2.3.0-collaboration-model.md Task 1.
 */

export const VOCABULARY = {
  // Section headers
  SECTION_INDIVIDUAL: "On this computer only",
  SECTION_SHARED: "Shared with a group",

  // State-changing actions
  SHARE_WITH_GROUP: "Share with a group…",
  SET_UP_ON_COMPUTER: "Set up on this computer",
  STOP_SYNCING_LOCAL: "Stop syncing on this computer",
  LEAVE_GROUP: "Leave the group…",
  DELETE_FROM_COMPUTER: "Delete from this computer…",
  DELETE_GROUP_FOR_EVERYONE: "Delete the study for everyone…",
  HIDE_FROM_LIST: "Hide from this list",

  // Buttons and chips
  JOIN_WITH_KEY: "Join with a key",
  OPEN_A_FOLDER: "Open a folder",
  ON_THIS_COMPUTER_ONLY_CHIP: "On this computer only",
} as const;
