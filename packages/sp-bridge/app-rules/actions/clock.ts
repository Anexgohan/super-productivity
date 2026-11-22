/**
 * The caller's time for one action build (anex/app-actions).
 *
 * The app's rules read the clock directly (`Date.now()`, `new Date()`), so a caller's date can only reach them through the clock itself.
 * The worker handles one request at a time, so nothing outside the build sees the shifted clock.
 */
const RealDate = Date;

/** The container's real clock, for what must never take the caller's time: op timestamps. */
export const realNow = (): number => RealDate.now();

/** Runs `build` with the worker's clock reading `callerNow`, in step with the real clock, and puts the real clock back, after a throw too. */
export const withCallerClock = async <T>(
  callerNow: number | null,
  build: () => Promise<T>,
): Promise<T> => {
  if (callerNow === null) return build();
  const offset = callerNow - RealDate.now();
  const now = (): number => RealDate.now() + offset;
  // Only the no-argument forms read the clock; every other form names its moment and stays as it was.
  class CallerDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(now());
      else super(...(args as [string]));
    }

    static override now(): number {
      return now();
    }
  }
  globalThis.Date = CallerDate as DateConstructor;
  try {
    return await build();
  } finally {
    globalThis.Date = RealDate;
  }
};
