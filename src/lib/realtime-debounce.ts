/**
 * Realtime event debounce helper.
 *
 * Coalesces rapid Realtime database notification events into a single
 * background REST pull after a 400ms quiet window.
 */

export function createDebouncedSync(
  syncFn: () => void | Promise<void>,
  delayMs = 400,
) {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const trigger = () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      void syncFn();
    }, delayMs);
  };

  const cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return { trigger, cancel };
}
