// Yearly entitlement for one employee. Pure function, tested in entitlement.test.ts.
//
// entitlement = policy days (full-time) x part-time fraction x share of the leave year employed,
// rounded UP to the nearest half day (rounding down could take a person below their statutory minimum).
//
// Known simplifications (see README): the weekly hours are taken from the schedule in force at the
// start of the employee's time in the year, so a mid-year schedule change is not pro-rated;
// irregular-hours and part-year-worker statutory accrual methods are not modelled.

export interface EntitlementInput {
  policyDays: number;          // entitlement for a full-time employee for a full year
  fullTimeHours: number;       // weekly hours that count as full time (e.g. 37.5)
  weeklyHours: number;         // this employee's scheduled weekly hours
  yearStart: string;           // YYYY-MM-DD
  yearEnd: string;
  employmentStart: string;
  employmentEnd: string | null;
}

const DAY_MS = 86_400_000;
const toMs = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));

export function calculateEntitlement(i: EntitlementInput): number {
  if (!(i.policyDays > 0) || !(i.fullTimeHours > 0) || !(i.weeklyHours > 0)) return 0;
  const from = Math.max(toMs(i.yearStart), toMs(i.employmentStart));
  const to = Math.min(toMs(i.yearEnd), i.employmentEnd ? toMs(i.employmentEnd) : Infinity);
  if (to < from) return 0;
  const employedDays = (to - from) / DAY_MS + 1;
  const yearDays = (toMs(i.yearEnd) - toMs(i.yearStart)) / DAY_MS + 1;
  const fraction = Math.min(1, i.weeklyHours / i.fullTimeHours);
  const raw = i.policyDays * fraction * (employedDays / yearDays);
  return Math.ceil(raw * 2 - 1e-9) / 2;
}

/** Sum of scheduled hours Monday to Sunday. */
export function weeklyHoursOf(p: { mon: number; tue: number; wed: number; thu: number; fri: number; sat: number; sun: number }): number {
  return p.mon + p.tue + p.wed + p.thu + p.fri + p.sat + p.sun;
}
