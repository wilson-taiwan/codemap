import { describe, expect, it, vi } from "vitest";
import { createDebouncedSync } from "./realtime-debounce";

describe("createDebouncedSync", () => {
  it("coalesces multiple rapid triggers into a single invocation after 400ms", async () => {
    vi.useFakeTimers();
    const syncFn = vi.fn();
    const debounced = createDebouncedSync(syncFn, 400);

    debounced.trigger();
    debounced.trigger();
    debounced.trigger();

    expect(syncFn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);
    expect(syncFn).not.toHaveBeenCalled();

    debounced.trigger();
    vi.advanceTimersByTime(200);
    expect(syncFn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);
    expect(syncFn).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it("can be cancelled before firing", () => {
    vi.useFakeTimers();
    const syncFn = vi.fn();
    const debounced = createDebouncedSync(syncFn, 400);

    debounced.trigger();
    debounced.cancel();

    vi.advanceTimersByTime(500);
    expect(syncFn).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});
