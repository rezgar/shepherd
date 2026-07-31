/** A resettable "nothing happened for this long" timer. `touch()` (re)arms
 *  the deadline; `onTimeout` fires once if `touch()` is never called again
 *  within `ms`. `cancel()` disarms it for good — call once the thing being
 *  watched has finished normally, so a late timer doesn't fire after the
 *  fact. */
export interface IdleTimeout {
  touch: () => void;
  cancel: () => void;
}

export function createIdleTimeout(ms: number, onTimeout: () => void): IdleTimeout {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const touch = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onTimeout, ms);
  };
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  touch();
  return { touch, cancel };
}
