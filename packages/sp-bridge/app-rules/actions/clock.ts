/**
 * The caller's time for one action build (anex/app-actions).
 *
 * The app's rules read the clock directly (`Date.now()`, `new Date()`), so a caller's date can only reach them through the clock itself.
 * The worker handles one request at a time, so nothing outside the build sees the shifted clock.
 */
const RealDate = Date;

/** The container's real clock, for what must never take the caller's time: op timestamps. */
export const realNow = (): number => RealDate.now();

/** Runs `build` with the worker's clock reading `callerNow`, advancing in step with the real clock, and restores it afterwards, even after a throw. */
export const withCallerClock = async <T>(
  callerNow: number | null,
  build: () => Promise<T>,
): Promise<T> => {
  if (callerNow === null) return build();
  const offset = callerNow - RealDate.now();
  const now = (): number => RealDate.now() + offset;
  // Only the no-argument forms read the clock; every other form names its moment and stays as it was.
  const CallerDate = function (this: unknown, ...args: unknown[]): Date | string {
    if (!new.target) return new RealDate(now()).toString();
    return args.length === 0
      ? new RealDate(now())
      : new (RealDate as unknown as new (...a: unknown[]) => Date)(...args);
  } as unknown as DateConstructor;
  Object.setPrototypeOf(CallerDate, RealDate);
  Object.defineProperty(CallerDate, 'prototype', { value: RealDate.prototype });
  Object.defineProperty(CallerDate, 'now', { value: now });
  globalThis.Date = CallerDate;
  try {
    return await build();
  } finally {
    globalThis.Date = RealDate;
  }
};
