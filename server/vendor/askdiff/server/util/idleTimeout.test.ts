import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdleTimeout } from "./idleTimeout.js";

// Regression coverage for askdiff asks hanging forever with zero feedback:
// streamAnswer had no bound on how long it would wait for the next chunk of
// `claude -p --resume` output, so a stalled child process left the ask
// stuck in "streaming" state permanently. This is the timer that fix relies
// on — tested in isolation (fake timers, no real process) so the contract
// (fires once when untouched, never fires when kept alive) is pinned down
// independent of the actual CLI.
describe("createIdleTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires onTimeout after ms with no touch()", () => {
    const onTimeout = vi.fn();
    createIdleTimeout(1000, onTimeout);

    vi.advanceTimersByTime(999);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("does not fire if touch() keeps resetting the deadline", () => {
    const onTimeout = vi.fn();
    const timeout = createIdleTimeout(1000, onTimeout);

    vi.advanceTimersByTime(700);
    timeout.touch();
    vi.advanceTimersByTime(700);
    timeout.touch();
    vi.advanceTimersByTime(700);

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("cancel() disarms it for good", () => {
    const onTimeout = vi.fn();
    const timeout = createIdleTimeout(1000, onTimeout);

    timeout.cancel();
    vi.advanceTimersByTime(5000);

    expect(onTimeout).not.toHaveBeenCalled();
  });
});
