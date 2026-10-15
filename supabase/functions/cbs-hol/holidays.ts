// Parses https://www.gov.uk/bank-holidays.json into rows for hol_bank_holidays.
// Pure function so it can be tested without network access.

export type CalendarCode = "ENG-WLS" | "SCT" | "NIR";

export interface BankHolidayRow {
  calendar_code: CalendarCode;
  holiday_date: string;
  name: string;
}

const DIVISIONS: Record<string, CalendarCode> = {
  "england-and-wales": "ENG-WLS",
  "scotland": "SCT",
  "northern-ireland": "NIR",
};

export function parseGovUkBankHolidays(json: unknown): BankHolidayRow[] {
  if (!json || typeof json !== "object") throw new Error("Unexpected bank holiday feed");
  const rows: BankHolidayRow[] = [];
  for (const [key, code] of Object.entries(DIVISIONS)) {
    const division = (json as Record<string, any>)[key];
    if (!division || !Array.isArray(division.events)) throw new Error(`The feed is missing ${key}`);
    for (const ev of division.events) {
      if (typeof ev?.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(ev.date)) continue;
      if (typeof ev?.title !== "string" || !ev.title.trim()) continue;
      rows.push({ calendar_code: code, holiday_date: ev.date, name: ev.title.trim() });
    }
  }
  if (rows.length === 0) throw new Error("The feed contained no bank holidays");
  return rows;
}
