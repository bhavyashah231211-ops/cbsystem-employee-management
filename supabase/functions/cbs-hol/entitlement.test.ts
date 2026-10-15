import test from "node:test";
import assert from "node:assert/strict";
import { calculateEntitlement, weeklyHoursOf } from "./entitlement.ts";

const base = { policyDays: 28, fullTimeHours: 37.5, weeklyHours: 37.5, yearStart: "2027-01-01", yearEnd: "2027-12-31", employmentStart: "2020-01-01", employmentEnd: null };

test("full-time, full year", () => assert.equal(calculateEntitlement(base), 28));
test("working more than full time is capped at the full entitlement", () => assert.equal(calculateEntitlement({ ...base, weeklyHours: 45 }), 28));
test("four days a week (30 of 37.5 hours) rounds up to a half day", () => assert.equal(calculateEntitlement({ ...base, weeklyHours: 30 }), 22.5));
test("joiner part way through the year", () => assert.equal(calculateEntitlement({ ...base, employmentStart: "2027-07-01" }), 14.5));
test("leaver part way through the year", () => assert.equal(calculateEntitlement({ ...base, employmentEnd: "2027-03-31" }), 7));
test("employment entirely outside the year gives nothing", () => {
  assert.equal(calculateEntitlement({ ...base, employmentStart: "2028-02-01" }), 0);
  assert.equal(calculateEntitlement({ ...base, employmentEnd: "2026-12-31" }), 0);
});
test("zero or missing inputs give nothing", () => {
  assert.equal(calculateEntitlement({ ...base, policyDays: 0 }), 0);
  assert.equal(calculateEntitlement({ ...base, weeklyHours: 0 }), 0);
});
test("weekly hours helper", () => assert.equal(weeklyHoursOf({ mon: 7.5, tue: 7.5, wed: 7.5, thu: 7.5, fri: 7.5, sat: 0, sun: 0 }), 37.5));
