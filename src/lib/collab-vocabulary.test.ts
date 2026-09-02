import { describe, it, expect } from "vitest";
import { VOCABULARY } from "./collab-vocabulary";

describe("collab-vocabulary", () => {
  it("locks canonical collaboration vocabulary strings", () => {
    expect(VOCABULARY.SECTION_INDIVIDUAL).toBe("On this computer only");
    expect(VOCABULARY.SECTION_SHARED).toBe("Shared with a group");
    expect(VOCABULARY.SHARE_WITH_GROUP).toBe("Share with a group…");
    expect(VOCABULARY.SET_UP_ON_COMPUTER).toBe("Set up on this computer");
    expect(VOCABULARY.STOP_SYNCING_LOCAL).toBe("Stop syncing on this computer");
    expect(VOCABULARY.LEAVE_GROUP).toBe("Leave the group…");
    expect(VOCABULARY.DELETE_FROM_COMPUTER).toBe("Delete from this computer…");
    expect(VOCABULARY.DELETE_GROUP_FOR_EVERYONE).toBe("Delete the study for everyone…");
    expect(VOCABULARY.HIDE_FROM_LIST).toBe("Hide from this list");
    expect(VOCABULARY.JOIN_WITH_KEY).toBe("Join with a key");
    expect(VOCABULARY.OPEN_A_FOLDER).toBe("Open a folder");
    expect(VOCABULARY.ON_THIS_COMPUTER_ONLY_CHIP).toBe("On this computer only");
  });
});
