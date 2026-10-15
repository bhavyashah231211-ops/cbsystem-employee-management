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
const todayISO = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const add = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const nextWeekday = (iso) => { let d = iso; while ([0, 6].includes(new Date(d + "T00:00:00Z").getUTCDay())) d = add(d, 1); return d; };

let r = await call("admin.create_business", { name: "Seven Co" }, A); const biz = r.data;
r = await call("admin.create_business", { name: "Seven Rival" }, A); const rival = r.data;
const O = (await call("business.login", { slug: "seven-co", pin: biz.owner_pin })).data.token;
const RO = (await call("business.login", { slug: "seven-rival", pin: rival.owner_pin })).data.token;
const mk = async (n, name, role, mgr, dept) => (await call("hr.create_employee", { employee_number: n, full_name: name, role, employment_start: "2026-01-01", manager_employee_number: mgr, department: dept }, { session: O })).data.pin;
const pins = { M1: await mk("M1", "Mandy", "manager", undefined, "Ops"), E1: await mk("E1", "Eve", "employee", "M1", "Ops"), E2: await mk("E2", "Fay", "employee", "M1", "Sales"), E3: await mk("E3", "Gus", "employee", "M1", "Sales") };
await call("hr.allocate_year", { year_label: "2026" }, { session: O });
const tok = {}; for (const n of Object.keys(pins)) tok[n] = (await call("staff.login", { slug: "seven-co", staff_key: biz.staff_key, employee_number: n, pin: pins[n] })).data.token;
const sub = (who, s, e, x = {}) => call("leave.submit", { leave_type_code: "annual", start_date: s, end_date: e, ...x }, { session: tok[who] });
const dec = (rid, d, ver = 1) => call("approvals.decide", { request_id: rid, decision: d, comment: "ok", expected_version: ver }, { session: tok.M1 });

// leave today (approved), leave in 5 days (approved), a pending one, a rejected one, a cancelled one
const day0 = nextWeekday(todayISO);   // a working day on or after today
r = await sub("E1", day0, day0); const eveToday = r.data?.request_id; await dec(eveToday, "approved");
const soon = nextWeekday(add(todayISO, 5)); r = await sub("E2", soon, soon); await dec(r.data.request_id, "approved");
const pend = nextWeekday(add(todayISO, 30)); r = await sub("E3", pend, pend);
const rej = nextWeekday(add(todayISO, 45)); r = await sub("E3", rej, rej); await dec(r.data.request_id, "rejected");
const can = nextWeekday(add(todayISO, 60)); r = await sub("E1", can, can); await call("leave.cancel", { request_id: r.data.request_id }, { session: tok.E1 });

// ---- summary
r = await call("reports.summary", {}, { session: O });
check("summary: ok", r.ok, JSON.stringify(r));
check("summary: headcount counts active employees (owner included)", r.data.headcount === 5, r.data.headcount);
check("summary: one request waiting", r.data.pending_requests === 1 && r.data.pending_cancellations === 0, JSON.stringify(r.data));
check("summary: Eve is away today", r.data.away_today.some((a) => a.employee === "Eve"), JSON.stringify(r.data.away_today));
check("summary: Fay appears in the next 14 days", r.data.upcoming.some((u) => u.employee === "Fay" && u.start_date === soon), JSON.stringify(r.data.upcoming));

// ---- balance report
r = await call("reports.balances", { year_label: "2026" }, { session: O });
const rows = r.data?.rows ?? [];
check("balances: one row per person with leave (4 people)", r.ok && rows.length === 4, JSON.stringify(rows.length));
const eve = rows.find((x) => x.employee_number === "E1");
check("balances: Eve has 28 entitlement, 1 booked, 27 available", eve.entitlement === 28 && eve.booked === 1 && eve.available === 27, JSON.stringify(eve));
const gus = rows.find((x) => x.employee_number === "E3");
check("balances: Gus has 1 day pending", gus.pending === 1 && gus.booked === 0, JSON.stringify(gus));
const hr1 = await call("hr.balances", { employee_number: "E1" }, { session: O });
check("balances: the report agrees with the single-person view", hr1.data.balances[0].available === eve.available && hr1.data.balances[0].booked === eve.booked);
r = await call("reports.balances", { year_label: "2026", department: "Sales" }, { session: O });
check("balances: department filter", r.data.rows.length === 2 && r.data.rows.every((x) => x.department === "Sales"), JSON.stringify(r.data.rows.map((x) => x.department)));
r = await call("reports.balances", { year_label: "1999" }, { session: O });
check("balances: unknown year refused", code(r) === "NOT_FOUND");

// ---- absence report
r = await call("reports.absence", { from: add(todayISO, -1), to: add(todayISO, 100) }, { session: O });
const abs = r.data?.rows ?? [];
check("absence: default is approved leave only (Eve and Fay)", r.ok && abs.length === 2 && abs.every((x) => x.status === "approved"), JSON.stringify(abs.map((x) => [x.full_name, x.status])));
r = await call("reports.absence", { from: add(todayISO, -1), to: add(todayISO, 100), statuses: ["pending", "rejected", "cancelled"] }, { session: O });
check("absence: other statuses on request", r.data.rows.length === 3 && ["pending", "rejected", "cancelled"].every((s) => r.data.rows.some((x) => x.status === s)), JSON.stringify(r.data.rows.map((x) => x.status)));
r = await call("reports.absence", { from: add(todayISO, -1), to: add(todayISO, 100), department: "Sales" }, { session: O });
check("absence: department filter", r.data.rows.length === 1 && r.data.rows[0].full_name === "Fay");
r = await call("reports.absence", { from: add(todayISO, 200), to: add(todayISO, 210) }, { session: O });
check("absence: empty range gives no rows", r.ok && r.data.rows.length === 0);
r = await call("reports.absence", { from: "2020-01-01", to: "2026-12-31" }, { session: O });
check("absence: range over a year refused", code(r) === "VALIDATION");
r = await call("reports.absence", { from: "bad", to: "2026-12-31" }, { session: O });
check("absence: bad date refused", code(r) === "VALIDATION");

// ---- audit log
r = await call("audit.list", { limit: 100 }, { session: O });
check("audit: has entries", r.ok && r.data.total > 10 && r.data.rows.length > 10, JSON.stringify(r).slice(0, 200));
check("audit: newest first", r.data.rows[0].at >= r.data.rows[r.data.rows.length - 1].at);
check("audit: shows who did it by name", r.data.rows.some((x) => x.actor === "Mandy (M1)") && r.data.rows.some((x) => x.actor.startsWith("Owner")), [...new Set(r.data.rows.map((x) => x.actor))].join());
check("audit: platform actions are labelled", r.data.rows.some((x) => x.actor === "admin-console"));
r = await call("audit.list", { action_prefix: "leave.request." }, { session: O });
check("audit: filter by action prefix", r.ok && r.data.rows.length > 0 && r.data.rows.every((x) => x.action.startsWith("leave.request.")), JSON.stringify(r.data.rows.map((x) => x.action)));
r = await call("audit.list", { actor_employee_number: "M1" }, { session: O });
check("audit: filter by person", r.data.rows.length > 0 && r.data.rows.every((x) => x.actor === "Mandy (M1)"));
r = await call("audit.list", { entity_type: "employee" }, { session: O });
check("audit: filter by kind of record", r.data.rows.length > 0 && r.data.rows.every((x) => x.entity_type === "employee"));
r = await call("audit.list", { from: add(todayISO, 1), to: add(todayISO, 2) }, { session: O });
check("audit: date filter", r.ok && r.data.rows.length === 0);
const p1 = await call("audit.list", { limit: 5, offset: 0 }, { session: O }); const p2 = await call("audit.list", { limit: 5, offset: 5 }, { session: O });
check("audit: paging gives different rows", p1.data.rows.length === 5 && p2.data.rows.length === 5 && !p1.data.rows.some((x) => p2.data.rows.some((y) => y.id === x.id)));
r = await call("audit.list", { action_prefix: "x; drop table" }, { session: O });
check("audit: an odd action filter is refused", code(r) === "VALIDATION");
r = await call("audit.list", { actor_employee_number: "NOPE" }, { session: O });
check("audit: unknown person gives an empty list", r.ok && r.data.rows.length === 0);

// ---- access and isolation
for (const a of ["reports.summary", "audit.list"]) { r = await call(a, {}, { session: tok.E1 }); check(`access: ${a} refused for staff`, code(r) === "FORBIDDEN"); }
r = await call("reports.balances", { year_label: "2026" }, { session: tok.M1 }); check("access: managers cannot run the balance report", code(r) === "FORBIDDEN");
r = await call("reports.absence", { from: todayISO, to: add(todayISO, 5) }, { session: tok.M1 }); check("access: managers cannot run the absence report", code(r) === "FORBIDDEN");
r = await call("reports.summary", {}, { session: RO });
check("isolation: another business sees none of our leave in its summary", r.ok && r.data.away_today.length === 0 && r.data.upcoming.length === 0 && r.data.headcount === 1, JSON.stringify(r.data));
r = await call("audit.list", { limit: 100 }, { session: RO });
check("isolation: another business sees only its own audit entries", r.ok && r.data.rows.every((x) => !["leave.request.submitted", "employee.created"].includes(x.action)), JSON.stringify(r.data.rows.map((x) => x.action)));
r = await call("reports.balances", { year_label: "2026" }, { session: RO });
check("isolation: another business's balance report has none of our people", r.ok && r.data.rows.length === 0, JSON.stringify(r.data?.rows?.length));
console.log(`\n${pass} passed, ${fail} failed`);
