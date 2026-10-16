import http from "http";
const URL = "http://localhost:8000";
let pass = 0, fail = 0;
const call = async (action, body = {}, { session, admin } = {}) => {
  const headers = { "content-type": "application/json" };
  if (session) headers["x-session"] = session; if (admin !== undefined) headers["x-admin-key"] = admin;
  const r = await fetch(URL, { method: "POST", headers, body: JSON.stringify({ action, ...body }) });
  return { status: r.status, ...(await r.json()) };
};
const check = (n, c, x = "") => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  -> " + String(x).slice(0, 400)}`); };
const code = (r) => r.error?.code;
const A = { admin: "test-admin-key" };
const london = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const add = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// ---- mock email provider
const mails = []; let failFor = "fail@x.test";
const mock = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
  const j = JSON.parse(b); const rec = { auth: req.headers.authorization, ...j }; 
  if (failFor && j.to.includes(failFor)) { res.writeHead(500); res.end("no"); return; }
  mails.push(rec); res.writeHead(200); res.end("{}"); }); }).listen(9999);

let r = await call("admin.create_business", { name: "Eight Co" }, A); const biz = r.data;
r = await call("admin.create_business", { name: "Eight Rival" }, A); const rival = r.data;
const O = (await call("business.login", { slug: "eight-co", pin: biz.owner_pin })).data.token;
const RO = (await call("business.login", { slug: "eight-rival", pin: rival.owner_pin })).data.token;
const mk = async (n, name, role, mgr, email) => { const pin = (await call("hr.create_employee", { employee_number: n, full_name: name, role, employment_start: "2026-01-01", manager_employee_number: mgr, email }, { session: O })).data.pin; return pin; };
const pins = { M1: await mk("M1", "Mandy", "manager", undefined, "mandy@x.test"), E1: await mk("E1", "Eve", "employee", "M1", "eve@x.test"), E2: await mk("E2", "Fay", "employee", "M1", failFor), E3: await mk("E3", "Gus", "employee", "M1"), E9: await mk("E9", "Zed", "employee") };
await call("hr.allocate_year", { year_label: "2026" }, { session: O });
const tok = {}; for (const n of Object.keys(pins)) tok[n] = (await call("staff.login", { slug: "eight-co", staff_key: biz.staff_key, employee_number: n, pin: pins[n] })).data.token;

// ================= sickness
r = await call("sickness.report", {}, { session: tok.E1 });
check("sickness: an employee reports being off today", r.ok, JSON.stringify(r)); const sick1 = r.data?.id;
r = await call("sickness.report", {}, { session: tok.E1 });
check("sickness: a second record for the same days is refused", code(r) === "OVERLAP", JSON.stringify(r));
r = await call("sickness.report", { starts_on: add(london, 1) }, { session: tok.E1 });
check("sickness: cannot start in the future", code(r) === "VALIDATION");
r = await call("sickness.report", {}, { session: O });
check("sickness: the business portal does not use the employee report", r.ok === false);
const secret = "Hospital appointment re: knee";
r = await call("sickness.record", { employee_number: "E2", starts_on: add(london, -3), ends_on: add(london, -1), reason_code: "injury", details: secret }, { session: O });
check("sickness: HR records an absence with a reason and details", r.ok, JSON.stringify(r)); const sick2 = r.data?.id;
r = await call("sickness.record", { employee_number: "E2", starts_on: add(london, -2), reason_code: "injury" }, { session: O });
check("sickness: HR cannot create an overlapping record", code(r) === "OVERLAP");
r = await call("sickness.record", { employee_number: "E3", starts_on: add(london, -2), reason_code: "flu-shot" }, { session: O });
check("sickness: an unknown reason is refused", code(r) === "VALIDATION");
r = await call("sickness.record", { employee_number: "E3", starts_on: add(london, -2) }, { session: tok.M1 });
check("sickness: a manager cannot record for others", code(r) === "FORBIDDEN");
r = await call("sickness.list", {}, { session: tok.M1 });
const mrows = r.data?.rows ?? [];
check("sickness: a manager sees the team's dates", r.ok && mrows.length === 2 && mrows.every((x) => x.starts_on), JSON.stringify(mrows));
check("sickness: but never the reason or details", mrows.every((x) => x.reason_code === null && x.details === null), JSON.stringify(mrows));
r = await call("sickness.list", {}, { session: tok.E2 });
check("sickness: an employee sees their own record in full", r.data.rows.length === 1 && r.data.rows[0].reason_code === "injury" && r.data.rows[0].details === secret, JSON.stringify(r.data));
r = await call("sickness.list", {}, { session: tok.E3 });
check("sickness: an employee sees nobody else's", r.ok && r.data.rows.length === 0);
r = await call("sickness.list", {}, { session: O });
check("sickness: HR sees everything with details", r.data.rows.length === 2 && r.data.rows.some((x) => x.details === secret));
r = await call("sickness.list", { employee_number: "E1", open_only: true }, { session: O });
check("sickness: HR can filter to open absences for a person", r.data.rows.length === 1 && r.data.rows[0].ends_on === null);
r = await call("audit.list", { limit: 100 }, { session: O });
check("sickness: the audit log never contains the reason or details", !JSON.stringify(r.data.rows).includes("knee") && !JSON.stringify(r.data.rows).includes("injury"));
r = await call("notifications.list", {}, { session: tok.M1 });
const abs = r.data.notifications.filter((n) => n.title === "Absence reported");
check("sickness: the manager is told, in neutral words", abs.length === 2 && abs.every((n) => !/sick|ill|injur|knee/i.test(n.body)), JSON.stringify(abs));
r = await call("sickness.close", { id: sick1 }, { session: tok.E3 });
check("sickness: someone else cannot close it", code(r) === "NOT_FOUND");
r = await call("sickness.close", { id: sick1, ends_on: add(london, 1) }, { session: tok.E1 });
check("sickness: cannot end it in the future", code(r) === "VALIDATION");

// calendar and summary while E1 is off
const calRange = { from: london.slice(0, 8) + "01", to: add(london.slice(0, 8) + "01", 30) };
r = await call("calendar.team", calRange, { session: tok.M1 });
const e1m = r.data.people.find((p) => p.full_name === "Eve").cells;
const todayIsWeekday = ![0, 6].includes(new Date(london + "T00:00:00Z").getUTCDay());
check("calendar: the manager sees the absence as sickness", !todayIsWeekday || e1m.some((c) => c.date === london && c.status === "sick"), JSON.stringify(e1m));
r = await call("calendar.team", calRange, { session: tok.E3 });
const e1c = r.data.people.find((p) => p.full_name === "Eve").cells;
check("calendar: a colleague sees only that Eve is away", e1c.every((c) => c.status !== "sick") && (!todayIsWeekday || e1c.some((c) => c.date === london && c.status === "approved")));
r = await call("reports.summary", {}, { session: O });
check("summary: people off sick count as away today", r.data.away_today.some((a) => a.employee === "Eve" && a.sick === true), JSON.stringify(r.data.away_today));
r = await call("reports.sickness", { from: add(london, -10), to: add(london, 10) }, { session: O });
check("sickness report: both absences, with weekdays and an ongoing flag", r.ok && r.data.rows.length === 2 && r.data.rows.some((x) => x.ongoing === true) && r.data.rows.find((x) => x.full_name === "Fay").reason_code === "injury", JSON.stringify(r.data));
r = await call("reports.sickness", { from: add(london, -10), to: add(london, 10) }, { session: tok.M1 });
check("sickness report: not for managers", code(r) === "FORBIDDEN");
r = await call("sickness.close", { id: sick1 }, { session: tok.E1 });
check("sickness: the employee says they are back", r.ok, JSON.stringify(r));
r = await call("sickness.close", { id: sick1 }, { session: tok.E1 });
check("sickness: closing twice refused", code(r) === "ALREADY_CLOSED");
r = await call("sickness.list", { employee_number: "E2" }, { session: RO });
check("isolation: another business sees none of our sickness records", r.ok && r.data.rows.length === 0);
r = await call("sickness.close", { id: sick2 }, { session: RO });
check("isolation: another business cannot close our record", code(r) === "NOT_FOUND");

// ================= completed leave
await call("setup.save_policy", { id: (await call("setup.overview", {}, { session: O })).data.policies[0].id, name: "Standard annual leave", entitlement: 28, backdate_days: 300, carry_over_max: 5, carry_over_expiry: "03-31" }, { session: O });
const past = add(london, -20);
const wd = (d) => { let x = d; while ([0, 6].includes(new Date(x + "T00:00:00Z").getUTCDay())) x = add(x, 1); return x; };
const pd = wd(past);
r = await call("leave.submit", { leave_type_code: "annual", start_date: pd, end_date: pd }, { session: tok.E3 }); const pastReq = r.data?.request_id;
check("completed: setup, a request for a day already gone", r.ok, JSON.stringify(r));
await call("approvals.decide", { request_id: pastReq, decision: "approved", expected_version: 1, comment: "ok" }, { session: tok.M1 });
r = await call("hr.balances", { employee_number: "E3" }, { session: O });
check("completed: before the job the day is booked, not taken", r.data.balances[0].booked === 1 && r.data.balances[0].taken === 0, JSON.stringify(r.data.balances[0]));
r = await call("admin.run_jobs", {}, { admin: "wrong" }); check("jobs: need the admin key", r.status === 401);
r = await call("admin.run_jobs", {}, { session: O }); check("jobs: a business session cannot run them", r.ok === false);
r = await call("admin.run_jobs", {}, A);
check("jobs: the daily job runs", r.ok && r.data.jobs.completed >= 1, JSON.stringify(r));
r = await call("hr.balances", { employee_number: "E3" }, { session: O });
check("completed: the day is now taken, balance unchanged", r.data.balances[0].booked === 0 && r.data.balances[0].taken === 1 && r.data.balances[0].available === 27, JSON.stringify(r.data.balances[0]));
r = await call("leave.my_requests", {}, { session: tok.E3 });
check("completed: the request shows as Completed", r.data.requests.find((q) => q.id === pastReq).status === "completed");
r = await call("leave.cancel", { request_id: pastReq }, { session: tok.E3 });
check("completed: it cannot be cancelled", code(r) === "NOT_CANCELLABLE", JSON.stringify(r));
r = await call("admin.run_jobs", {}, A);
check("jobs: running again changes nothing", r.data.jobs.completed === 0 && r.data.jobs.expired === 0, JSON.stringify(r.data.jobs));

// ================= carry-over and expiry
r = await call("setup.add_year", { label: "2027", starts_on: "2027-01-01", ends_on: "2027-12-31" }, { session: O });
r = await call("hr.carry_over", { from_year_label: "2026", to_year_label: "2027" }, { session: O });
check("carry-over: unused leave moves to the new year (capped at 5)", r.ok && r.data.carried >= 3 && r.data.days >= 15, JSON.stringify(r));
const c1 = r.data.carried;
r = await call("hr.carry_over", { from_year_label: "2026", to_year_label: "2027" }, { session: O });
check("carry-over: repeating it carries nothing more", r.ok && r.data.carried === 0, JSON.stringify(r));
r = await call("hr.carry_over", { from_year_label: "2026", to_year_label: "2026" }, { session: O }); check("carry-over: the same year twice refused", code(r) === "VALIDATION");
r = await call("hr.carry_over", { from_year_label: "2026", to_year_label: "1999" }, { session: O }); check("carry-over: unknown year refused", code(r) === "NOT_FOUND");
r = await call("hr.carry_over", { from_year_label: "2026", to_year_label: "2027" }, { session: tok.M1 }); check("carry-over: managers cannot run it", code(r) === "FORBIDDEN");
await call("hr.allocate_year", { year_label: "2027" }, { session: O });
r = await call("hr.balances", { employee_number: "E1" }, { session: O });
const y27 = r.data.balances.find((b) => b.leave_year === "2027");
check("carry-over: 2027 holds 28 + 5 carried", y27.available === 33 && y27.entitlement === 33, JSON.stringify(y27));
r = await call("admin.run_jobs", { today: "2027-03-31" }, A);
check("expiry: nothing expires on the last day", r.data.jobs.expired === 0, JSON.stringify(r.data.jobs));
r = await call("admin.run_jobs", { today: "2027-04-01" }, A);
check("expiry: after the date unused carried leave expires", r.data.jobs.expired >= 3, JSON.stringify(r.data.jobs));
r = await call("hr.balances", { employee_number: "E1" }, { session: O });
const y27b = r.data.balances.find((b) => b.leave_year === "2027");
check("expiry: Eve is back to 28, with 5 shown as expired", y27b.available === 28 && y27b.expired === 5, JSON.stringify(y27b));
r = await call("admin.run_jobs", { today: "2027-06-01" }, A);
check("expiry: and it only happens once", r.data.jobs.expired === 0);

// ================= email
{ const fd = wd(add(london, 30)); const q = await call("leave.submit", { leave_type_code: "annual", start_date: fd, end_date: fd }, { session: tok.E2 });
  await call("approvals.decide", { request_id: q.data.request_id, decision: "approved", expected_version: 1, comment: "ok" }, { session: tok.M1 }); }
r = await call("admin.run_jobs", {}, A);
check("email: nothing is sent while the business has it switched off", r.data.email.configured === true && r.data.email.sent === 0 && mails.length === 0, JSON.stringify(r.data.email));
r = await call("setup.save_business", { email_notifications: true }, { session: O });
check("email: the owner switches it on", r.ok && r.data.email_enabled === true);
r = await call("setup.save_business", {}, { session: O }); check("email: empty settings change refused", code(r) === "VALIDATION");
r = await call("setup.save_business", { email_notifications: true }, { session: tok.M1 }); check("email: managers cannot change settings", code(r) === "FORBIDDEN");
r = await call("admin.run_jobs", {}, A);
check("email: notifications are emailed to people with an address", r.data.email.sent >= 1 && mails.length === r.data.email.sent, JSON.stringify(r.data.email));
check("email: one failure is counted and others still go out", r.data.email.failed >= 1, JSON.stringify(r.data.email));
const toMandy = mails.filter((m) => m.to[0] === "mandy@x.test");
check("email: Mandy received her notifications with the right sender, key and link", toMandy.length >= 1 && toMandy[0].from === "holiday@example.test" && toMandy[0].auth === "Bearer test-key" && /example\.test\/staff\/\?b=eight-co/.test(toMandy[0].text), JSON.stringify(toMandy[0]));
check("email: sickness emails carry no health words", mails.every((m) => !/sick|ill|injur|knee|hospital/i.test(m.subject + m.text)), JSON.stringify(mails.map((m) => m.subject)));
const before = mails.length;
r = await call("admin.run_jobs", {}, A);
check("email: nothing is sent twice (the failed one is retried, the rest are not)", mails.length === before && r.data.email.sent === 0, JSON.stringify(r.data.email));
failFor = null;
r = await call("admin.run_jobs", {}, A);
check("email: the failed one goes out once the provider recovers", r.data.email.sent >= 1 && mails.some((m) => m.to[0] === "fail@x.test"), JSON.stringify(r.data.email));
r = await call("admin.run_jobs", {}, A);
check("email: and then everything is up to date", r.data.email.sent === 0 && r.data.email.failed === 0, JSON.stringify(r.data.email));
await call("setup.save_business", { email_notifications: true }, { session: RO });
r = await call("hr.create_employee", { employee_number: "R1", full_name: "Rival Person", role: "employee", employment_start: "2026-01-01", email: "rival@x.test" }, { session: RO });
const ra = mails.length; await call("admin.run_jobs", {}, A);
check("isolation: another business's emails go only to its own people", mails.slice(ra).every((m) => m.to[0] !== "mandy@x.test" && m.to[0] !== "eve@x.test"));
mock.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(0);
