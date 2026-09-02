/**
 * Behavior contract for the one app-owned confirmation system: single open
 * dialog, promise always settles, dedupe coalesces duplicate intents.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appConfirm, useConfirmStore } from "./confirm-store";

async function flushMicro(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 0));
}

describe("confirm store", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useConfirmStore.setState({
      open: false,
      options: null,
      currentResolve: null,
      pendingByKey: new Map(),
    });
  });

  it("opens with options and resolves true on answer(true)", async () => {
    const promise = appConfirm({ title: "Delete?", destructive: true });
    expect(useConfirmStore.getState().open).toBe(true);
    expect(useConfirmStore.getState().options?.title).toBe("Delete?");

    useConfirmStore.getState().answer(true);
    await expect(promise).resolves.toBe(true);
    expect(useConfirmStore.getState().open).toBe(false);
  });

  it("cancel resolves false and never leaves a hanging promise", async () => {
    const promise = appConfirm({ title: "Leave the group?" });
    useConfirmStore.getState().answer(false);
    await expect(promise).resolves.toBe(false);
  });

  it("dedupes a second request under the same key while open", async () => {
    const first = appConfirm({ title: "A", dedupeKey: "same" });
    const second = appConfirm({ title: "B", dedupeKey: "same" });
    expect(second).toBe(first);
    useConfirmStore.getState().answer(true);
    await expect(first).resolves.toBe(true);
    expect(useConfirmStore.getState().pendingByKey.size).toBe(0);
  });

  it("replaces an open dialog from another key by resolving it false first", async () => {
    const first = appConfirm({ title: "A", dedupeKey: "a" });
    void flushMicro();
    const second = appConfirm({ title: "B", dedupeKey: "b" });
    await expect(first).resolves.toBe(false);
    expect(useConfirmStore.getState().options?.title).toBe("B");
    useConfirmStore.getState().answer(true);
    await expect(second).resolves.toBe(true);
  });
});
