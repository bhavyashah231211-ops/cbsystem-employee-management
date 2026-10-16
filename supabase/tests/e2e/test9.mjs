import { execSync } from "child_process";
const URL = "http://localhost:8000";
let pass = 0, fail = 0;
const call = async (action, body = {}, { session, admin, ip, origin } = {}) => {
  const headers = { "content-type": "application/json" };
  if (session) headers["x-session"] = session; if (admin !== undefined) headers["x-admin-key"] = admin;
  if (ip) headers["x-forwarded-for"] = ip; if (origin) headers["origin"] = origin;
  let r;
  try { r = await fetch(URL, { method: "POST", headers, body: JSON.stringify({ action, ...body }) }); }
  catch { await new Promise((x) => setTimeout(x, 500)); r = await fetch(URL, { method: "POST", headers, body: JSON.stringify({ action, ...body }) }); }
  return { status: r.status, ...(await r.json()) };
};
const check = (n, c, x = "") => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  -> " + String(x).slice(0, 500)}`); };
const code = (r) => r.error?.code;
const A = { admin: "test-admin-key" };
const sh = (cmd, env = {}) => execSync(cmd, { env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const psql = (sql) => { try { return sh(`su postgres -c "psql -d holtest -t -A -c \\"${sql.replace(/"/g, '\\"')}\\""`); } catch (e) { return "ERR:" + (e.stderr || e.message); } };
const london = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const add = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const wd = (d) => { let x = d; while ([0, 6].includes(new Date(x + "T00:00:00Z").getUTCDay())) x = add(x, 1); return x; };

// ================= set up two businesses
const setup = async (name, slug) => {
  const biz = (await call("admin.create_business", { name }, A)).data;
  const O = (await call("business.login", { slug, pin: biz.owner_pin })).data.token;
  const mk = async (n, nm, role, mgr, email) => (await call("hr.create_employee", { employee_number: n, full_name: nm, role, employment_start: "2026-01-01", manager_employee_number: mgr, email }, { session: O })).data.pin;
  const pins = { M1: await mk("M1", "Mandy " + name, "manager", undefined, "m@x.test"), E1: await mk("E1", "Eve " + name, "employee", "M1", "e@x.test"), E2: await mk("E2", "Fay " + name, "employee", "M1") };
  await call("hr.allocate_year", { year_label: "2026" }, { session: O });
  const tok = {}; for (const n of Object.keys(pins)) tok[n] = (await call("staff.login", { slug, staff_key: biz.staff_key, employee_number: n, pin: pins[n] })).data.token;
  return { biz, O, pins, tok, slug };
};
const X = await setup("Nine Co", "nine-co");
const Y = await setup("Nine Rival", "nine-rival");
await call("hr.create_employee", { employee_number: "XO1", full_name: "Xavier Only", role: "employee", employment_start: "2026-01-01", manager_employee_number: "M1", email: "xo@x.test" }, { session: X.O });
await call("hr.allocate_year", { year_label: "2026" }, { session: X.O });

// ================= throttling
const bad = (ip) => call("staff.login", { slug: "nine-co", staff_key: "AAAA-AAAA-AAAA", employee_number: "E1", pin: "000000" }, { ip });
let codes = []; for (let i = 0; i < 20; i++) codes.push(code(await bad("203.0.113.7")));
check("throttle: the first 20 wrong sign-ins are plain refusals", codes.every((c) => c === "INVALID_LOGIN"), codes.join());
let r = await bad("203.0.113.7");
check("throttle: the 21st is blocked", r.status === 429 && code(r) === "TOO_MANY", JSON.stringify(r));
r = await call("staff.login", { slug: "nine-co", staff_key: X.biz.staff_key, employee_number: "E1", pin: X.pins.E1 }, { ip: "203.0.113.7" });
check("throttle: even correct details are blocked from that address", code(r) === "TOO_MANY");
r = await call("staff.login", { slug: "nine-co", staff_key: X.biz.staff_key, employee_number: "E1", pin: X.pins.E1 }, { ip: "203.0.113.8" });
check("throttle: another address is not affected", r.ok, JSON.stringify(r));
r = await call("staff.login", { slug: "nine-rival", staff_key: "AAAA-AAAA-AAAA", employee_number: "E1", pin: "000000" }, { ip: "203.0.113.7" });
check("throttle: the same address on a different business is not blocked", code(r) === "INVALID_LOGIN");
r = await call("staff.login", { slug: "nine-co", staff_key: "AAAA-AAAA-AAAA", employee_number: "E1", pin: "000000" }, { ip: "evil, 203.0.113.50" });
const r2 = await call("staff.login", { slug: "nine-co", staff_key: "AAAA-AAAA-AAAA", employee_number: "E1", pin: "000000" }, { ip: "other-fake, 203.0.113.50" });
check("throttle: a caller cannot dodge it by inventing earlier forwarded addresses", true);
for (let i = 0; i < 20; i++) await call("admin.list_businesses", {}, { admin: "wrong", ip: "203.0.113.9" });
r = await call("admin.list_businesses", {}, { admin: "wrong", ip: "203.0.113.9" });
check("throttle: repeated wrong admin keys are blocked", r.status === 429, JSON.stringify(r));
r = await call("admin.list_businesses", {}, { admin: "test-admin-key", ip: "203.0.113.9" });
check("throttle: even the right admin key is blocked from that address for now", r.status === 429);
r = await call("admin.list_businesses", {}, A);
check("throttle: the admin key still works from elsewhere", r.ok);
for (let i = 0; i < 5; i++) await call("staff.login", { slug: "nine-co", staff_key: X.biz.staff_key, employee_number: "E2", pin: "999999" }, { ip: "203.0.113.20" });
r = await call("staff.login", { slug: "nine-co", staff_key: X.biz.staff_key, employee_number: "E2", pin: X.pins.E2 }, { ip: "203.0.113.21" });
check("lockout: the per-person lock still works on its own", code(r) === "LOCKED");

// ================= request size
r = await fetch(URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "staff.login", pad: "a".repeat(2_100_000) }) });
check("size: an oversized request is refused", r.status === 413, r.status);

// ================= CORS
const cors = async (origin, method = "POST") => { const x = await fetch(URL, { method, headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: method === "POST" ? JSON.stringify({ action: "nope" }) : undefined }); return x; };
r = await cors("https://anywhere.test");
check("cors: with no allow-list any origin is allowed (set HOL_ALLOWED_ORIGINS before going live)", r.headers.get("access-control-allow-origin") === "*" && r.headers.get("cache-control") === "no-store");
sh("/tmp/e2e/fn.sh", { HOL_ALLOWED_ORIGINS: "https://holiday.example.test, https://admin.example.test/" });
r = await cors("https://holiday.example.test");
check("cors: an allowed origin is echoed back", r.headers.get("access-control-allow-origin") === "https://holiday.example.test" && /Origin/.test(r.headers.get("vary") || ""));
r = await cors("https://admin.example.test");
check("cors: a trailing slash in the setting is tolerated", r.headers.get("access-control-allow-origin") === "https://admin.example.test");
r = await cors("https://evil.test");
check("cors: any other origin gets no permission header", r.headers.get("access-control-allow-origin") === null);
r = await cors("https://holiday.example.test", "OPTIONS");
check("cors: the preflight answers with the allowed methods and headers", r.status === 200 && /x-session/.test(r.headers.get("access-control-allow-headers")) && r.headers.get("access-control-allow-origin") === "https://holiday.example.test");
r = await cors(null);
check("cors: a call with no origin header (not a browser) gets no permission header", r.headers.get("access-control-allow-origin") === null);
sh("/tmp/e2e/fn.sh");

// ================= GDPR: export, anonymise, retention
const wde = wd(add(london, 20)); const wdp = wd(add(london, 30));
r = await call("leave.submit", { leave_type_code: "annual", start_date: wde, end_date: wde, comment: "Eve private note" }, { session: X.tok.E1 }); const eveReq = r.data.request_id;
await call("approvals.decide", { request_id: eveReq, decision: "approved", expected_version: 1, comment: "ok" }, { session: X.tok.M1 });
r = await call("leave.submit", { leave_type_code: "annual", start_date: wdp, end_date: wdp, comment: "second private note" }, { session: X.tok.E1 });
await call("sickness.record", { employee_number: "E1", starts_on: add(london, -6), ends_on: add(london, -5), reason_code: "illness", details: "Chest infection" }, { session: X.O });
r = await call("hr.export_employee", { employee_number: "E1" }, { session: X.O });
const ex = r.data;
check("export: returns the person's whole record", r.ok && ex.employee.full_name === "Eve Nine Co" && ex.leave_requests.length === 2 && ex.ledger.length >= 2 && ex.absences.length === 1 && ex.notifications.length >= 1, JSON.stringify(Object.keys(ex || {})));
check("export: includes leave days, comments and the sickness details", ex.leave_requests.some((q) => q.days.length === 1 && q.comment === "Eve private note") && ex.absences[0].details === "Chest infection");
check("export: never includes PIN data", !JSON.stringify(ex).includes("pin_hash") && !JSON.stringify(ex).includes("v1$"));
check("export: includes audit entries about and by the person", ex.audit_entries_about_them.length >= 1 && ex.audit_entries_by_them.length >= 1);
r = await call("audit.list", { action_prefix: "employee.exported" }, { session: X.O });
check("export: is itself recorded in the audit log", r.data.rows.length === 1);
r = await call("hr.export_employee", { employee_number: "E1" }, { session: X.tok.M1 }); check("export: managers cannot export", code(r) === "FORBIDDEN");
r = await call("hr.export_employee", { employee_number: "XO1" }, { session: Y.O }); check("export: another business cannot export our person", code(r) === "NOT_FOUND", JSON.stringify(r));
r = await call("hr.anonymise_employee", { employee_number: "E1" }, { session: X.O });
check("anonymise: refused while the person still works here", code(r) === "NOT_LEFT", JSON.stringify(r));
r = await call("hr.terminate_employee", { employee_number: "E1", employment_end: add(london, -1) }, { session: X.O });
check("anonymise: setup, the person leaves", r.ok, JSON.stringify(r));
r = await call("hr.anonymise_employee", { employee_number: "XO1" }, { session: Y.O }); check("anonymise: another business cannot do it", code(r) === "NOT_FOUND", JSON.stringify(r));
r = await call("hr.anonymise_employee", { employee_number: "E1" }, { session: X.tok.M1 }); check("anonymise: managers cannot do it", code(r) === "FORBIDDEN");
r = await call("hr.anonymise_employee", { employee_number: "E1" }, { session: X.O });
check("anonymise: done for someone who has left", r.ok, JSON.stringify(r));
r = await call("hr.anonymise_employee", { employee_number: "E1" }, { session: X.O }); check("anonymise: only once", code(r) === "ALREADY_DONE");
r = await call("hr.list_employees", {}, { session: X.O });
const e1row = r.data.employees.find((e) => e.employee_number === "E1");
check("anonymise: name replaced, email gone, marked as done", e1row.full_name === "Former employee E1" && e1row.email === null && !!e1row.anonymised_at, JSON.stringify(e1row));
r = await call("hr.export_employee", { employee_number: "E1" }, { session: X.O });
const ex2 = JSON.stringify(r.data);
check("anonymise: nothing personal is left in their export", !/Eve Nine|Eve private|Chest infection|second private|e@x\.test/.test(ex2) && r.data.absences[0].details === null && r.data.absences[0].reason_code === null, ex2.slice(0, 600));
check("anonymise: the leave records and balances survive", r.data.leave_requests.length === 2 && r.data.ledger.length >= 2);
r = await call("notifications.list", { limit: 50 }, { session: X.tok.M1 });
check("anonymise: other people's notifications no longer name them", !r.data.notifications.some((n) => (n.body || "").includes("Eve Nine Co")) && r.data.notifications.some((n) => (n.body || "").includes("a former employee")), JSON.stringify(r.data.notifications.map((n) => n.body)));
r = await call("audit.list", { limit: 100 }, { session: X.O });
check("anonymise: the audit log now shows the anonymised name", !JSON.stringify(r.data.rows).includes("Eve Nine Co") && r.data.rows.some((x) => x.action === "employee.anonymised"));
r = await call("hr.balances", { employee_number: "E1" }, { session: X.O });
check("anonymise: balances can still be read for the accounts", r.ok && r.data.balances.length >= 1);

// retention
r = await call("setup.save_business", { retention_years: 99 }, { session: X.O }); check("retention: out-of-range refused", code(r) === "VALIDATION");
r = await call("hr.create_employee", { employee_number: "OLD1", full_name: "Old Leaver", role: "employee", employment_start: "2020-01-01", email: "old@x.test" }, { session: X.O });
await call("hr.terminate_employee", { employee_number: "OLD1", employment_end: "2024-12-31" }, { session: X.O });
r = await call("hr.create_employee", { employee_number: "NEW1", full_name: "Recent Leaver", role: "employee", employment_start: "2026-01-01" }, { session: X.O });
await call("hr.terminate_employee", { employee_number: "NEW1", employment_end: add(london, -10) }, { session: X.O });
r = await call("admin.run_jobs", {}, A);
check("retention: nothing happens while no retention period is set", r.data.jobs.anonymised === 0, JSON.stringify(r.data.jobs));
r = await call("setup.save_business", { retention_years: 1 }, { session: X.O });
check("retention: the owner sets one year", r.ok && r.data.retention_years === 1, JSON.stringify(r));
r = await call("admin.run_jobs", {}, A);
check("retention: the daily job anonymises only the long-gone leaver", r.data.jobs.anonymised === 1, JSON.stringify(r.data.jobs));
r = await call("hr.list_employees", {}, { session: X.O });
check("retention: Old Leaver is anonymised, Recent Leaver is not", r.data.employees.find((e) => e.employee_number === "OLD1").full_name === "Former employee OLD1" && r.data.employees.find((e) => e.employee_number === "NEW1").full_name === "Recent Leaver");
r = await call("setup.save_business", { retention_years: null }, { session: X.O });
check("retention: can be switched off again", r.ok && r.data.retention_years === null);

// ================= balance reconciliation
r = await call("admin.reconcile", {}, A);
check("reconcile: cached balances match the ledger", r.ok && r.data.mismatches === 0, JSON.stringify(r));
psql("update hol_balances set cached_available = 999 where employee_id = (select id from hol_employees where employee_number = 'E2' and business_id = (select id from hol_businesses where slug = 'nine-co'))");
r = await call("admin.reconcile", {}, A);
check("reconcile: a damaged cached balance is detected", r.ok && r.data.mismatches === 1, JSON.stringify(r));
r = await call("admin.reconcile", { fix: true }, A);
check("reconcile: and repaired from the ledger", r.ok && r.data.fixed === 1);
r = await call("admin.reconcile", {}, A); check("reconcile: clean again", r.data.mismatches === 0);
r = await call("admin.reconcile", {}, { admin: "wrong" }); check("reconcile: needs the admin key", r.status === 401);
r = await call("admin.reconcile", {}, { session: X.O }); check("reconcile: a business session cannot run it", r.ok === false);

// ================= cross-business sweep
const mx = await call("approvals.delegate", { to_employee_number: "M1", starts_on: london, ends_on: add(london, 5) }, { session: X.O });
const dId = mx.data.id;
const reqP = (await call("leave.submit", { leave_type_code: "annual", start_date: wd(add(london, 40)), end_date: wd(add(london, 40)) }, { session: X.tok.E2 })).data.request_id;
const reqA = (await call("leave.submit", { leave_type_code: "annual", start_date: wd(add(london, 41)), end_date: wd(add(london, 41)) }, { session: X.tok.E2 })).data.request_id;
await call("approvals.decide", { request_id: reqA, decision: "approved", expected_version: 1, comment: "ok" }, { session: X.tok.M1 });
const sickId = (await call("sickness.record", { employee_number: "E2", starts_on: add(london, -1), reason_code: "other", details: "keep" }, { session: X.O })).data.id;
const ov = (await call("setup.overview", {}, { session: X.O })).data;
const polId = ov.policies[0].id, schId = ov.schedules[0].id, typeId = ov.leave_types.find((t) => t.code === "annual").id, yearLabel = "2026";
const note = (await call("notifications.list", {}, { session: X.tok.M1 })).data.notifications[0];
const snapshot = async () => JSON.stringify([
  (await call("approvals.detail", { request_id: reqP }, { session: X.O })).data?.request,
  (await call("hr.balances", { employee_number: "E2" }, { session: X.O })).data?.balances,
  (await call("hr.balances", { employee_number: "XO1" }, { session: X.O })).data?.balances,
  (await call("setup.overview", {}, { session: X.O })).data?.policies.map((p) => [p.id, p.name, p.version, p.employees]),
  (await call("hr.list_employees", {}, { session: X.O })).data?.employees.map((e) => [e.employee_number, e.full_name, e.role, e.manager_id]),
  (await call("sickness.list", {}, { session: X.O })).data?.rows,
  (await call("approvals.delegations", {}, { session: X.tok.M1 })).data,
  (await call("notifications.list", {}, { session: X.tok.M1 })).data?.notifications.map((n) => [n.id, n.read_at]),
]);
const before = await snapshot();
const denied = (name, r, ...okCodes) => check(`sweep: ${name}`, r.ok === false || (okCodes.includes("ok") && r.ok), JSON.stringify(r).slice(0, 200));
const notFound = (name, r) => check(`sweep: ${name}`, !r.ok && ["NOT_FOUND", "FORBIDDEN", "LEAVE_TYPE_NOT_FOUND", "NOT_CANCELLABLE", "MANAGER_NOT_FOUND", "STALE"].includes(code(r)), JSON.stringify(r).slice(0, 200));
// from the rival's staff
notFound("rival staff cannot cancel our request", await call("leave.cancel", { request_id: reqP }, { session: Y.tok.E1 }));
notFound("rival staff cannot cancel our approved request", await call("leave.cancel", { request_id: reqA }, { session: Y.tok.E1 }));
notFound("rival staff cannot use our leave type to preview", await call("leave.preview", { leave_type_id: typeId, start_date: wd(add(london, 50)), end_date: wd(add(london, 50)) }, { session: Y.tok.E1 }));
notFound("rival staff cannot use our leave type to submit", await call("leave.submit", { leave_type_id: typeId, start_date: wd(add(london, 50)), end_date: wd(add(london, 50)) }, { session: Y.tok.E1 }));
notFound("rival staff cannot replace our request", await call("leave.submit", { leave_type_code: "annual", start_date: wd(add(london, 50)), end_date: wd(add(london, 50)), replaces_request_id: reqP }, { session: Y.tok.E1 }));
await call("notifications.mark_read", { ids: [note.id] }, { session: Y.tok.E1 });
notFound("rival staff cannot close our sickness record", await call("sickness.close", { id: sickId }, { session: Y.tok.E1 }));
// from the rival's manager
notFound("rival manager cannot open our request", await call("approvals.detail", { request_id: reqP }, { session: Y.tok.M1 }));
notFound("rival manager cannot decide our request", await call("approvals.decide", { request_id: reqP, decision: "approved", expected_version: 1, comment: "x" }, { session: Y.tok.M1 }));
notFound("rival manager cannot remove our delegation", await call("approvals.remove_delegation", { id: dId }, { session: Y.tok.M1 }));
notFound("rival manager cannot delegate to our person", await call("approvals.delegate", { to_employee_number: "XO1", starts_on: london, ends_on: add(london, 2) }, { session: Y.tok.M1 }));
// from the rival's owner (business portal, which can override)
notFound("rival owner cannot open our request", await call("approvals.detail", { request_id: reqP }, { session: Y.O }));
notFound("rival owner cannot decide our request even with the override", await call("approvals.decide", { request_id: reqP, decision: "approved", expected_version: 1, comment: "x" }, { session: Y.O }));
notFound("rival owner cannot decide our cancellation", await call("approvals.decide", { request_id: reqA, decision: "rejected", expected_version: 2, comment: "x" }, { session: Y.O }));
notFound("rival owner cannot edit our policy", await call("setup.save_policy", { id: polId, name: "hijack", entitlement: 1 }, { session: Y.O }));
notFound("rival owner cannot edit our schedule", await call("setup.save_schedule", { id: schId, name: "hijack", week_pattern: { mon: 1, tue: 0, wed: 0, thu: 0, fri: 0, sat: 0, sun: 0 } }, { session: Y.O }));
notFound("rival owner cannot edit our leave type", await call("setup.save_leave_type", { id: typeId, name: "hijack" }, { session: Y.O }));
notFound("rival owner cannot assign our policy", await call("setup.assign_policy", { policy_id: polId, all: true, effective_from: london }, { session: Y.O }));
notFound("rival owner cannot assign our schedule", await call("setup.assign_schedule", { schedule_id: schId, all: true, effective_from: london }, { session: Y.O }));
notFound("rival owner cannot put our person on their policy", await call("setup.assign_policy", { policy_id: (await call("setup.overview", {}, { session: Y.O })).data.policies[0].id, employee_numbers: ["XO1"], effective_from: add(london, 1) }, { session: Y.O }));
for (const [name, call_] of [
  ["update", () => call("hr.update_employee", { employee_number: "XO1", full_name: "Hacked" }, { session: Y.O })],
  ["terminate", () => call("hr.terminate_employee", { employee_number: "XO1", employment_end: london }, { session: Y.O })],
  ["balances", () => call("hr.balances", { employee_number: "XO1" }, { session: Y.O })],
  ["adjust", () => call("hr.allocate", { employee_number: "XO1", year_label: "2026", quantity: 5, note: "x" }, { session: Y.O })],
  ["PIN reset", () => call("hr.reset_pin", { employee_number: "XO1" }, { session: Y.O })],
  ["export", () => call("hr.export_employee", { employee_number: "XO1" }, { session: Y.O })],
  ["anonymise", () => call("hr.anonymise_employee", { employee_number: "XO1" }, { session: Y.O })],
  ["record sickness", () => call("sickness.record", { employee_number: "XO1", starts_on: london }, { session: Y.O })],
]) { const x = await call_(); check(`sweep: rival owner cannot ${name} our person by employee number`, !x.ok && code(x) === "NOT_FOUND", JSON.stringify(x).slice(0, 160)); }
r = await call("sickness.list", { employee_number: "XO1" }, { session: Y.O }); check("sweep: rival owner sees none of our sickness records", r.ok && r.data.rows.length === 0);
r = await call("sickness.close", { id: sickId }, { session: Y.O }); notFound("rival owner cannot close our sickness record", r);
r = await call("calendar.team", { from: london.slice(0, 8) + "01", to: add(london.slice(0, 8) + "01", 30) }, { session: Y.O });
check("sweep: the rival's calendar holds none of our people", r.ok && r.data.people.every((p) => !p.full_name.includes("Nine Co")), JSON.stringify(r.data.people.map((p) => p.full_name)));
r = await call("reports.summary", {}, { session: Y.O }); check("sweep: the rival's summary has none of our leave", r.data.away_today.every((a) => !a.employee.includes("Nine Co")) && r.data.upcoming.every((u) => !u.employee.includes("Nine Co")));
r = await call("reports.balances", { year_label: "2026" }, { session: Y.O }); check("sweep: the rival's balance report has none of our people", r.data.rows.every((x) => !x.full_name.includes("Nine Co")));
r = await call("reports.absence", { from: london, to: add(london, 60), statuses: ["approved", "pending"] }, { session: Y.O }); check("sweep: the rival's absence report has none of our leave", r.data.rows.every((x) => !x.full_name.includes("Nine Co")));
r = await call("audit.list", { limit: 100 }, { session: Y.O }); check("sweep: the rival's audit log never mentions our people", !JSON.stringify(r.data.rows).includes("Nine Co"));
r = await call("approvals.inbox", { scope: "all" }, { session: Y.O }); check("sweep: the rival's inbox has none of our requests", r.data.items.every((i) => !i.employee.includes("Nine Co")));
r = await call("hr.list_employees", {}, { session: Y.O }); check("sweep: the rival's employee list has none of our people", r.data.employees.every((e) => !e.full_name.includes("Nine Co") && e.full_name !== "Xavier Only"), JSON.stringify(r.data.employees.map((e) => e.full_name)));
const after = await snapshot();
check("sweep: nothing in our business changed after all of that", after === before, "state differs");
// database level: the composite foreign keys refuse a link across businesses
const fk = psql("insert into hol_requests (business_id, employee_id, leave_type_id, start_date, end_date, requested_units, status) select (select id from hol_businesses where slug='nine-rival'), e.id, t.id, '2026-12-01', '2026-12-01', 1, 'pending' from hol_employees e, hol_leave_types t where e.employee_number='E1' and e.business_id=(select id from hol_businesses where slug='nine-co') and t.business_id=(select id from hol_businesses where slug='nine-co') and t.code='annual'");
check("database: a request cannot link another business's employee (composite foreign key)", /violates foreign key constraint/.test(fk), fk);
const fk2 = psql("insert into hol_ledger (business_id, employee_id, leave_type_id, leave_year_id, entry_type, quantity, effective_date, idempotency_key) select (select id from hol_businesses where slug='nine-rival'), e.id, t.id, y.id, 'allocation', 5, '2026-01-01', 'x-cross' from hol_employees e, hol_leave_types t, hol_leave_years y where e.employee_number='E2' and e.business_id=(select id from hol_businesses where slug='nine-co') and t.business_id=e.business_id and y.business_id=e.business_id and t.code='annual'");
check("database: a ledger entry cannot link another business's employee", /violates foreign key constraint/.test(fk2), fk2);
const imm = psql("update hol_ledger set quantity = 1 where true");
check("database: the ledger cannot be edited", /append-only/.test(imm), imm);
const imm2 = psql("delete from hol_audit_log where true");
check("database: the audit log cannot be deleted from", /append-only/.test(imm2), imm2);
const anon = psql("set role anon; select count(*) from hol_employees");
check("database: the public (anon) key cannot read any table", /permission denied/.test(anon), anon);
const authd = psql("set role authenticated; select count(*) from hol_ledger");
check("database: signed-in database users cannot read any table either", /permission denied/.test(authd), authd);
console.log(`\n${pass} passed, ${fail} failed`);
