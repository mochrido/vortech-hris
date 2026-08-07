const MS_PER_MINUTE = 60000;

/** Whole minutes past the grace period; 0 when check-in is on time or within grace. */
export function lateMinutes(checkIn: Date, scheduledStart: Date, graceMinutes: number): number {
  const graceEnd = new Date(scheduledStart.getTime() + graceMinutes * MS_PER_MINUTE);
  if (checkIn.getTime() <= graceEnd.getTime()) {
    return 0;
  }
  return Math.floor((checkIn.getTime() - graceEnd.getTime()) / MS_PER_MINUTE);
}

/** Whole minutes worked between check-in and check-out minus break; never negative. */
export function workedMinutes(checkIn: Date, checkOut: Date, breakMinutes: number): number {
  const elapsed = Math.floor((checkOut.getTime() - checkIn.getTime()) / MS_PER_MINUTE);
  return Math.max(0, elapsed - breakMinutes);
}
