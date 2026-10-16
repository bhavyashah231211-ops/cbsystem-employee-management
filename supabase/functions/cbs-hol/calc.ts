// =====================================================================
// CBSystem - Employee Management - leave calculator (Step 3, Part 1)
// Pure functions: no database, no network, no clock. Everything the answer
// depends on is passed in, so the same input always gives the same result.
//
// Rules implemented:
//  - Only scheduled working days are charged. Weekends and the employee's
//    non-working days are never charged. Bank holidays are never charged
//    (whether entitlement is stated including bank holidays is decided when
//    allocations are posted, not here).
//  - The schedule is looked up per date, so a schedule change in the middle of
//    a request is handled.
//  - Half days: a single day uses startHalf ("am" or "pm" = the half taken).
//    A multi-day request may start in the afternoon (startHalf "pm") and/or
//    end at lunchtime (endHalf "am").
//  - Hourly leave: single date, a stated number of hours.
//  - Each charged day is assigned to the leave year containing it.
//  - unit "days": a working day charges 1 (0.5 for a half day), whatever the
//    length of that day. unit "hours": a working day charges its scheduled hours.
// =====================================================================

export type Half = "am" | "pm";

export interface WeekPattern {
  mon: number; tue: number; wed: number; thu: number; fri: number; sat: number; sun: number;
}

export interface ScheduleAssignment {
  from: string;          // YYYY-MM-DD
  to: string | null;     // inclusive, null = open ended
  pattern: WeekPattern;  // scheduled hours per weekday
}

export interface LeaveYear {
  id: string;
  label: string;
  startsOn: string;
  endsOn: string;
}

export interface CalcInput {
  startDate: string;
  endDate: string;
  startHalf?: Half | null;
  endHalf?: Half | null;
  hours?: number | null;
  unit: "days" | "hours";
  schedules: ScheduleAssignment[];
  holidays: ReadonlySet<string> | readonly string[];
  leaveYears: LeaveYear[];
  employment?: { start: string; end: string | null };
  maxRangeDays?: number;
}

export interface ChargedDay { date: string; units: number; leaveYearId: string }
export interface SkippedDay { date: string; reason: "non_working_day" | "bank_holiday" }

export interface CalcResult {
  unit: "days" | "hours";
  requestedUnits: number;
  chargedDays: ChargedDay[];
  skippedDays: SkippedDay[];
  perLeaveYear: Record<string, number>;
  warnings: string[];
}

export type CalcErrorCode =
  | "INVALID_DATE" | "END_BEFORE_START" | "RANGE_TOO_LONG"
  | "INVALID_HALF" | "INVALID_DURATION" | "HOURS_EXCEED_DAY"
  | "OUTSIDE_EMPLOYMENT" | "NO_SCHEDULE" | "NO_LEAVE_YEAR" | "NO_WORKING_DAYS";

export class CalcError extends Error {
  readonly code: CalcErrorCode;
  constructor(code: CalcErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const DAY_MS = 86_400_000;
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

function parseDate(s: unknown, field: string): number {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new CalcError("INVALID_DATE", `${field} must be a date in YYYY-MM-DD format`);
  }
  const ms = Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  if (new Date(ms).toISOString().slice(0, 10) !== s) {
    throw new CalcError("INVALID_DATE", `${field} is not a real calendar date`);
  }
  return ms;
}

const formatDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function patternFor(date: string, schedules: ScheduleAssignment[]): WeekPattern | null {
  let best: ScheduleAssignment | null = null;
  for (const s of schedules) {
    if (s.from <= date && (s.to === null || date <= s.to)) {
      if (!best || s.from > best.from) best = s; // latest start wins if ever ambiguous
    }
  }
  return best ? best.pattern : null;
}

function leaveYearFor(date: string, years: LeaveYear[]): LeaveYear | null {
  return years.find((y) => y.startsOn <= date && date <= y.endsOn) ?? null;
}

/** Combine bank holidays with a business's overrides into the set of non-chargeable dates. */
export function buildHolidaySet(
  bankHolidays: readonly string[],
  overrides: ReadonlyArray<{ date: string; isWorkingDay: boolean }> = [],
): Set<string> {
  const set = new Set(bankHolidays);
  for (const o of overrides) {
    if (o.isWorkingDay) set.delete(o.date); // business works this bank holiday
    else set.add(o.date);                   // shutdown or extra closure day
  }
  return set;
}

export function calculateLeave(input: CalcInput): CalcResult {
  const startMs = parseDate(input.startDate, "startDate");
  const endMs = parseDate(input.endDate, "endDate");
  if (endMs < startMs) throw new CalcError("END_BEFORE_START", "The end date is before the start date");

  const span = (endMs - startMs) / DAY_MS + 1;
  if (span > (input.maxRangeDays ?? 366)) {
    throw new CalcError("RANGE_TOO_LONG", "A single request cannot cover more than a year");
  }

  const single = startMs === endMs;
  const startHalf = input.startHalf ?? null;
  const endHalf = input.endHalf ?? null;
  const hours = input.hours ?? null;

  for (const [name, h] of [["startHalf", startHalf], ["endHalf", endHalf]] as const) {
    if (h !== null && h !== "am" && h !== "pm") throw new CalcError("INVALID_HALF", `${name} must be am or pm`);
  }
  if (hours !== null) {
    if (!single) throw new CalcError("INVALID_DURATION", "Hourly leave must be on a single date");
    if (startHalf || endHalf) throw new CalcError("INVALID_DURATION", "Hours cannot be combined with a half day");
    if (!Number.isFinite(hours) || hours <= 0) throw new CalcError("INVALID_DURATION", "Hours must be greater than zero");
  }
  if (single) {
    if (endHalf !== null) throw new CalcError("INVALID_HALF", "For a single day use startHalf only");
  } else {
    if (startHalf === "am") throw new CalcError("INVALID_HALF", "A multi-day request can only start in the afternoon (pm)");
    if (endHalf === "pm") throw new CalcError("INVALID_HALF", "A multi-day request can only end at lunchtime (am)");
  }

  if (input.employment) {
    const { start, end } = input.employment;
    if (input.startDate < start || (end !== null && input.endDate > end)) {
      throw new CalcError("OUTSIDE_EMPLOYMENT", "The dates fall outside the employee's employment period");
    }
  }

  const holidays = input.holidays instanceof Set ? input.holidays : new Set(input.holidays);
  const charged: ChargedDay[] = [];
  const skipped: SkippedDay[] = [];

  for (let ms = startMs; ms <= endMs; ms += DAY_MS) {
    const date = formatDate(ms);
    const pattern = patternFor(date, input.schedules);
    if (!pattern) throw new CalcError("NO_SCHEDULE", `No work schedule applies on ${date}`);

    const scheduledHours = pattern[WEEKDAYS[new Date(ms).getUTCDay()]];
    if (!(scheduledHours > 0)) { skipped.push({ date, reason: "non_working_day" }); continue; }
    if (holidays.has(date)) { skipped.push({ date, reason: "bank_holiday" }); continue; }

    let units: number;
    if (hours !== null) {
      if (hours > scheduledHours + 1e-9) {
        throw new CalcError("HOURS_EXCEED_DAY", `Requested hours exceed the ${scheduledHours} hours scheduled on ${date}`);
      }
      units = input.unit === "hours" ? hours : hours / scheduledHours;
    } else {
      let fraction = 1;
      if (single) {
        if (startHalf) fraction = 0.5;
      } else {
        if (date === input.startDate && startHalf === "pm") fraction = 0.5;
        if (date === input.endDate && endHalf === "am") fraction = 0.5;
      }
      units = input.unit === "hours" ? fraction * scheduledHours : fraction;
    }

    const year = leaveYearFor(date, input.leaveYears);
    if (!year) throw new CalcError("NO_LEAVE_YEAR", `No leave year is set up for ${date}`);
    charged.push({ date, units: round4(units), leaveYearId: year.id });
  }

  if (charged.length === 0) {
    throw new CalcError("NO_WORKING_DAYS", "The selected dates contain no chargeable working days");
  }

  const perLeaveYear: Record<string, number> = {};
  for (const c of charged) perLeaveYear[c.leaveYearId] = round4((perLeaveYear[c.leaveYearId] ?? 0) + c.units);

  const warnings: string[] = [];
  const bh = skipped.filter((s) => s.reason === "bank_holiday").length;
  if (bh > 0) warnings.push(`${bh} bank holiday${bh > 1 ? "s" : ""} in this range ${bh > 1 ? "are" : "is"} not charged`);
  if (Object.keys(perLeaveYear).length > 1) warnings.push("This request spans more than one leave year");
  const skippedDates = new Set(skipped.map((s) => s.date));
  if (!single && startHalf && skippedDates.has(input.startDate)) warnings.push("The start half day was ignored because the start date is not a working day");
  if (!single && endHalf && skippedDates.has(input.endDate)) warnings.push("The end half day was ignored because the end date is not a working day");

  return {
    unit: input.unit,
    requestedUnits: round4(charged.reduce((a, c) => a + c.units, 0)),
    chargedDays: charged,
    skippedDays: skipped,
    perLeaveYear,
    warnings,
  };
}
