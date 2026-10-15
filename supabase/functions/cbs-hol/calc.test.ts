// Run with Deno:   deno test supabase/functions/cbs-hol/calc.test.ts
// Run with Node:   npx esbuild calc.test.ts --bundle --platform=node --outfile=/tmp/t.js && node --test /tmp/t.js
import test from "node:test";
import assert from "node:assert/strict";
import { buildHolidaySet, calculateLeave, CalcError, type CalcInput, type WeekPattern } from "./calc.ts";
import { parseGovUkBankHolidays } from "./holidays.ts";

const MON_FRI: WeekPattern = { mon: 7.5, tue: 7.5, wed: 7.5, thu: 7.5, fri: 7.5, sat: 0, sun: 0 };
const YEARS = [
  { id: "y2027", label: "2027", startsOn: "2027-01-01", endsOn: "2027-12-31" },
  { id: "y2028", label: "2028", startsOn: "2028-01-01", endsOn: "2028-12-31" },
];
const base = (over: Partial<CalcInput>): CalcInput => ({
  startDate: "2027-05-10", endDate: "2027-05-14", unit: "days",
  schedules: [{ from: "2020-01-01", to: null, pattern: MON_FRI }],
  holidays: [], leaveYears: YEARS, ...over,
});
const fails = (input: CalcInput, code: string) =>
  assert.throws(() => calculateLeave(input), (e: unknown) => e instanceof CalcError && e.code === code);

test("full Monday to Friday week is five days", () => {
  const r = calculateLeave(base({}));
  assert.equal(r.requestedUnits, 5);
  assert.equal(r.chargedDays.length, 5);
  assert.deepEqual(r.warnings, []);
});

test("a bank holiday inside the range is not charged and is reported", () => {
  const r = calculateLeave(base({ startDate: "2027-05-31", endDate: "2027-06-04", holidays: ["2027-05-31"] }));
  assert.equal(r.requestedUnits, 4);
  assert.deepEqual(r.skippedDays, [{ date: "2027-05-31", reason: "bank_holiday" }]);
  assert.equal(r.warnings.length, 1);
});

test("a range across a weekend charges working days only", () => {
  const r = calculateLeave(base({ startDate: "2027-05-14", endDate: "2027-05-18" })); // Fri to Tue
  assert.equal(r.requestedUnits, 3);
  assert.equal(r.skippedDays.filter((s) => s.reason === "non_working_day").length, 2);
});

test("part-time Tuesday to Thursday employee requesting a full week is charged three days", () => {
  const pt: WeekPattern = { mon: 0, tue: 7.5, wed: 7.5, thu: 7.5, fri: 0, sat: 0, sun: 0 };
  const r = calculateLeave(base({ schedules: [{ from: "2020-01-01", to: null, pattern: pt }] }));
  assert.equal(r.requestedUnits, 3);
});

test("single half day, morning or afternoon", () => {
  assert.equal(calculateLeave(base({ startDate: "2027-05-11", endDate: "2027-05-11", startHalf: "am" })).requestedUnits, 0.5);
  assert.equal(calculateLeave(base({ startDate: "2027-05-11", endDate: "2027-05-11", startHalf: "pm" })).requestedUnits, 0.5);
  assert.equal(calculateLeave(base({ startDate: "2027-05-11", endDate: "2027-05-11", startHalf: "am", unit: "hours" })).requestedUnits, 3.75);
});

test("multi-day request starting after lunch and ending at lunchtime", () => {
  const r = calculateLeave(base({ startHalf: "pm", endHalf: "am" }));
  assert.equal(r.requestedUnits, 4);
});

test("unit hours charges scheduled hours; unit days charges one per working day", () => {
  const uneven: WeekPattern = { mon: 0, tue: 4, wed: 8, thu: 0, fri: 0, sat: 0, sun: 0 };
  const sch = [{ from: "2020-01-01", to: null, pattern: uneven }];
  const dates = { startDate: "2027-05-11", endDate: "2027-05-12" };
  assert.equal(calculateLeave(base({ ...dates, schedules: sch, unit: "hours" })).requestedUnits, 12);
  assert.equal(calculateLeave(base({ ...dates, schedules: sch, unit: "days" })).requestedUnits, 2);
});

test("hourly leave on one date", () => {
  const d = { startDate: "2027-05-11", endDate: "2027-05-11", hours: 2 };
  assert.equal(calculateLeave(base({ ...d, unit: "hours" })).requestedUnits, 2);
  assert.equal(calculateLeave(base({ ...d, unit: "days" })).requestedUnits, 0.2667);
  fails(base({ ...d, hours: 9, unit: "hours" }), "HOURS_EXCEED_DAY");
  fails(base({ ...d, endDate: "2027-05-12", unit: "hours" }), "INVALID_DURATION");
  fails(base({ ...d, startHalf: "am" }), "INVALID_DURATION");
});

test("request spanning two leave years is split per year", () => {
  const r = calculateLeave(base({ startDate: "2027-12-29", endDate: "2028-01-04" }));
  assert.equal(r.requestedUnits, 5);
  assert.equal(r.perLeaveYear["y2027"], 3);
  assert.equal(r.perLeaveYear["y2028"], 2);
  assert.ok(r.warnings.some((w) => w.includes("more than one leave year")));
});

test("schedule change in the middle of a request is respected", () => {
  const mon_wed: WeekPattern = { mon: 7.5, tue: 7.5, wed: 7.5, thu: 0, fri: 0, sat: 0, sun: 0 };
  const r = calculateLeave(base({
    startDate: "2027-05-10", endDate: "2027-05-19",
    schedules: [
      { from: "2020-01-01", to: "2027-05-14", pattern: MON_FRI },
      { from: "2027-05-15", to: null, pattern: mon_wed },
    ],
  }));
  assert.equal(r.requestedUnits, 8); // 5 + Mon, Tue, Wed
});

test("leap day is handled", () => {
  const r = calculateLeave(base({ startDate: "2028-02-28", endDate: "2028-03-01" }));
  assert.equal(r.requestedUnits, 3);
});

test("validation errors", () => {
  fails(base({ startDate: "2027-02-30" }), "INVALID_DATE");
  fails(base({ startDate: "10/05/2027" }), "INVALID_DATE");
  fails(base({ startDate: "2027-05-14", endDate: "2027-05-10" }), "END_BEFORE_START");
  fails(base({ startDate: "2027-01-01", endDate: "2028-12-31" }), "RANGE_TOO_LONG");
  fails(base({ startHalf: "am" }), "INVALID_HALF");
  fails(base({ endHalf: "pm" }), "INVALID_HALF");
  fails(base({ startDate: "2027-05-11", endDate: "2027-05-11", startHalf: "am", endHalf: "am" }), "INVALID_HALF");
});

test("no chargeable days, no schedule, no leave year, outside employment", () => {
  fails(base({ startDate: "2027-05-15", endDate: "2027-05-16" }), "NO_WORKING_DAYS"); // weekend
  fails(base({ startDate: "2027-05-31", endDate: "2027-05-31", holidays: ["2027-05-31"] }), "NO_WORKING_DAYS");
  fails(base({ schedules: [] }), "NO_SCHEDULE");
  fails(base({ startDate: "2029-01-04", endDate: "2029-01-05" }), "NO_LEAVE_YEAR");
  fails(base({ employment: { start: "2027-05-12", end: null } }), "OUTSIDE_EMPLOYMENT");
  fails(base({ employment: { start: "2020-01-01", end: "2027-05-12" } }), "OUTSIDE_EMPLOYMENT");
});

test("holiday set honours business overrides", () => {
  const set = buildHolidaySet(["2027-05-03", "2027-05-31"], [
    { date: "2027-05-31", isWorkingDay: true },   // business works this bank holiday
    { date: "2027-07-02", isWorkingDay: false },  // company shutdown day
  ]);
  assert.equal(set.has("2027-05-03"), true);
  assert.equal(set.has("2027-05-31"), false);
  assert.equal(set.has("2027-07-02"), true);
});

test("GOV.UK feed parser maps the three calendars and skips bad rows", () => {
  const feed = {
    "england-and-wales": { division: "england-and-wales", events: [{ title: "New Year's Day", date: "2027-01-01" }, { title: "", date: "2027-02-01" }] },
    "scotland": { division: "scotland", events: [{ title: "2nd January", date: "2027-01-04" }] },
    "northern-ireland": { division: "northern-ireland", events: [{ title: "St Patrick's Day", date: "2027-03-17" }, { title: "Bad", date: "17/03/2027" }] },
  };
  const rows = parseGovUkBankHolidays(feed);
  assert.deepEqual(rows.map((r) => r.calendar_code), ["ENG-WLS", "SCT", "NIR"]);
  assert.throws(() => parseGovUkBankHolidays({}));
  assert.throws(() => parseGovUkBankHolidays(null));
});
