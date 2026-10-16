const URL = "http://localhost:8000";
let pass = 0, fail = 0;
const call = async (action, body = {}, { session, admin } = {}) => {
  const headers = { "content-type": "application/json" };
  if (session) headers["x-session"] = session; if (admin !== undefined) headers["x-admin-key"] = admin;
  const r = await fetch(URL, { method: "POST", headers, body: JSON.stringify({ action, ...body }) });
  return { status: r.status, ...(await r.json()) };
};
const check = (n, c, x = "") => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  -> " + x}`); };
const code = (r) => r.error?.code;
const A = { admin: "test-admin-key" };

let r = await call("admin.create_business", { name: "Setup Co" }, A); const biz = r.data;
r = await call("admin.create_business", { name: "Rival Co" }, A); const rival = r.data;
const O = (await call("business.login", { slug: "setup-co", pin: biz.owner_pin })).data.token;
const RO = (await call("business.login", { slug: "rival-co", pin: rival.owner_pin })).data.token;
const mk = async (n, name, role, mgr) => (await call("hr.create_employee", { employee_number: n, full_name: name, role, employment_start: "2026-01-01", manager_employee_number: mgr }, { session: O })).data?.pin;
const pM = await mk("M1", "Mandy", "manager"); const pE = await mk("E1", "Eve", "employee", "M1"); const pF = await mk("E2", "Fay", "employee", "M1");
const staff = async (n, pin) => (await call("staff.login", { slug: "setup-co", staff_key: biz.staff_key, employee_number: n, pin })).data?.token;
await call("hr.allocate_year", { year_label: "2026" }, { session: O });
const E1 = await staff("E1", pE), M1 = await staff("M1", pM);

// ---- overview and leave years
r = await call("setup.overview", {}, { session: O });
check("overview: year, policy, schedule, six leave types", r.ok && r.data.leave_years.length === 1 && r.data.policies.length === 1 && r.data.schedules.length === 1 && r.data.leave_types.length === 6, JSON.stringify(r).slice(0, 300));
check("overview: policy shows 3 employees assigned", r.data.policies[0].employees === 3 && r.data.schedules[0].employees === 3, JSON.stringify(r.data.policies[0]));
r = await call("setup.add_year", { label: "2027", starts_on: "2027-01-01", ends_on: "2027-12-31" }, { session: O });
check("add year 2027", r.ok, JSON.stringify(r));
r = await call("setup.add_year", { label: "2027b", starts_on: "2027-06-01", ends_on: "2028-05-31" }, { session: O });
check("overlapping leave year refused", code(r) === "OVERLAP", JSON.stringify(r));
r = await call("setup.add_year", { label: "2027", starts_on: "2029-01-01", ends_on: "2029-12-31" }, { session: O });
check("duplicate leave year name refused", code(r) === "ALREADY_EXISTS", JSON.stringify(r));
r = await call("setup.add_year", { label: "x", starts_on: "2029-02-01", ends_on: "2029-01-01" }, { session: O });
check("leave year end before start refused", code(r) === "VALIDATION");

// ---- policy
const pol0 = (await call("setup.overview", {}, { session: O })).data.policies[0];
r = await call("setup.save_policy", { id: pol0.id, name: pol0.name, entitlement: 25, carry_over_max: 3 }, { session: O });
check("edit policy: version goes up", r.ok && r.data.version === 2, JSON.stringify(r));
r = await call("setup.save_policy", { name: "Senior staff", entitlement: 30, full_time_hours: 40, allow_negative: true, assign_to_all: false }, { session: O });
check("new policy created", r.ok && r.data.version === 1, JSON.stringify(r)); const polSenior = r.data.id;
r = await call("setup.save_policy", { name: "Senior staff", entitlement: 30 }, { session: O });
check("duplicate policy name refused", code(r) === "ALREADY_EXISTS");
r = await call("setup.save_policy", { name: "Bad", entitlement: 500 }, { session: O });
check("policy entitlement out of range refused", code(r) === "VALIDATION");
r = await call("setup.assign_policy", { policy_id: polSenior, employee_numbers: ["E1"], effective_from: "2026-06-01" }, { session: O });
check("assign policy to E1 from June", r.ok && r.data.assigned === 1, JSON.stringify(r));
r = await call("setup.assign_policy", { policy_id: polSenior, employee_numbers: ["E1"], effective_from: "2026-03-01" }, { session: O });
check("a policy cannot be inserted before a later assignment", code(r) === "ASSIGNMENT_CONFLICT", JSON.stringify(r));
r = await call("setup.assign_policy", { policy_id: polSenior, employee_numbers: ["NOPE"], effective_from: "2026-06-01" }, { session: O });
check("assign: unknown employee refused", code(r) === "NOT_FOUND");
r = await call("setup.overview", {}, { session: O });
check("overview: assignment counts follow dates", r.data.policies.find((p) => p.id === polSenior).employees === 1 && r.data.policies.find((p) => p.id === pol0.id).employees === 2, JSON.stringify(r.data.policies.map((p) => [p.name, p.employees])));
r = await call("setup.assign_policy", { policy_id: pol0.id, all: true, effective_from: "2026-01-01" }, { session: O });
check("assign to all from an earlier date conflicts with the later one", code(r) === "ASSIGNMENT_CONFLICT");

// ---- schedules
r = await call("setup.save_schedule", { name: "Mon-Wed", week_pattern: { mon: 8, tue: 8, wed: 8, thu: 0, fri: 0, sat: 0, sun: 0 } }, { session: O });
check("new schedule", r.ok, JSON.stringify(r)); const schedMW = r.data.id;
r = await call("setup.save_schedule", { name: "Empty", week_pattern: { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0, sat: 0, sun: 0 } }, { session: O });
check("a schedule with no working days refused", code(r) === "VALIDATION");
r = await call("setup.save_schedule", { name: "Bad", week_pattern: { mon: 30, tue: 0, wed: 0, thu: 0, fri: 0, sat: 0, sun: 0 } }, { session: O });
check("a 30-hour day refused", r.ok === false);
r = await call("setup.assign_schedule", { schedule_id: schedMW, employee_numbers: ["E2"], effective_from: "2026-01-01" }, { session: O });
check("assign Mon-Wed schedule to Fay", r.ok && r.data.assigned === 1, JSON.stringify(r));
const E2 = await staff("E2", pF);
r = await call("leave.preview", { leave_type_code: "annual", start_date: "2026-11-09", end_date: "2026-11-13" }, { session: E2 });
check("preview follows the new schedule (3 days, not 5)", r.ok && r.data.requested_units === 3, JSON.stringify(r.data));

// ---- holiday overrides
r = await call("setup.add_override", { holiday_date: "2026-11-11", name: "Company shutdown", is_working_day: false }, { session: O });
check("add shutdown day", r.ok, JSON.stringify(r));
r = await call("leave.preview", { leave_type_code: "annual", start_date: "2026-11-09", end_date: "2026-11-13" }, { session: E1 });
check("shutdown day is not charged (4 days)", r.ok && r.data.requested_units === 4 && r.data.skipped_days.some((d) => d.date === "2026-11-11"), JSON.stringify(r.data));
r = await call("setup.add_override", { holiday_date: "2026-12-25", name: "We open", is_working_day: true }, { session: O });
r = await call("leave.preview", { leave_type_code: "annual", start_date: "2026-12-25", end_date: "2026-12-25" }, { session: E1 });
check("a bank holiday the business works is charged", r.ok && r.data.requested_units === 1, JSON.stringify(r));
await call("setup.remove_override", { holiday_date: "2026-11-11" }, { session: O });
r = await call("leave.preview", { leave_type_code: "annual", start_date: "2026-11-09", end_date: "2026-11-13" }, { session: E1 });
check("removing the shutdown day charges it again", r.data.requested_units === 5);

// ---- leave types
r = await call("setup.save_leave_type", { code: "study", name: "Study leave", unit: "days", balance_tracked: false, requires_approval: true }, { session: O });
check("new leave type", r.ok, JSON.stringify(r));
r = await call("setup.save_leave_type", { code: "study", name: "Study 2" }, { session: O });
check("duplicate leave type code refused", code(r) === "ALREADY_EXISTS");
r = await call("setup.save_leave_type", { code: "Bad Code!", name: "x" }, { session: O });
check("leave type code format enforced", code(r) === "VALIDATION");
r = await call("leave.types", {}, { session: E1 });
check("staff see the new leave type", r.data.leave_types.some((t) => t.code === "study"));

// ---- employee changes
r = await call("hr.update_employee", { employee_number: "E1", department: "Sales", role: "manager" }, { session: O });
check("update employee: department and role", r.ok && r.data.updated.includes("role"), JSON.stringify(r));
r = await call("hr.update_employee", { employee_number: "M1", manager_employee_number: "E1" }, { session: O });
check("management loop refused", code(r) === "VALIDATION" && /loop/.test(r.error.message), JSON.stringify(r));
r = await call("hr.update_employee", { employee_number: "E1", manager_employee_number: "E1" }, { session: O });
check("self-management refused", code(r) === "VALIDATION");
r = await call("hr.update_employee", { employee_number: "OWNER", role: "employee" }, { session: O });
check("owner role cannot change", code(r) === "VALIDATION");
r = await call("hr.update_employee", { employee_number: "E2", role: "employee" }, { session: E1 });
check("staff session cannot update employees", code(r) === "FORBIDDEN");
r = await call("hr.update_employee", { employee_number: "E1", role: "employee" }, { session: O });

// ---- terminate with pending and future approved leave
r = await call("leave.submit", { leave_type_code: "annual", start_date: "2026-12-14", end_date: "2026-12-15" }, { session: E1 }); const rApproved = r.data.request_id;
await call("approvals.decide", { request_id: rApproved, decision: "approved", expected_version: 1 }, { session: M1 });
r = await call("leave.submit", { leave_type_code: "annual", start_date: "2027-01-12", end_date: "2027-01-12" }, { session: E1 });
check("setup: one approved and one pending request", r.ok);
r = await call("hr.balances", { employee_number: "E1" }, { session: O });
const before = r.data.balances.find((b) => b.leave_year === "2026");
check("balance before leaving: 2 booked", before.booked === 2, JSON.stringify(before));
r = await call("hr.terminate_employee", { employee_number: "E1", employment_end: "2026-11-30" }, { session: O });
check("terminate: pending withdrawn, future approved cancelled", r.ok && r.data.cancelled === 1, JSON.stringify(r));
r = await call("hr.balances", { employee_number: "E1" }, { session: O });
const after = r.data.balances.find((b) => b.leave_year === "2026");
check("terminate: booked days released", after.booked === 0, JSON.stringify(after));
r = await call("staff.login", { slug: "setup-co", staff_key: biz.staff_key, employee_number: "E1", pin: pE });
check("a leaver cannot sign in", code(r) === "INVALID_LOGIN");
r = await call("leave.balances", {}, { session: E1 });
check("a leaver's session ends", r.ok === false);
r = await call("hr.terminate_employee", { employee_number: "E1", employment_end: "2026-11-30" }, { session: O });
check("terminating twice refused", code(r) === "ALREADY_ENDED");
r = await call("hr.terminate_employee", { employee_number: "OWNER", employment_end: "2026-11-30" }, { session: O });
check("owner cannot be ended", code(r) === "VALIDATION");
r = await call("hr.allocate_year", { year_label: "2026" }, { session: O });
check("a leaver gets no new allocation", r.ok && r.data.allocated === 0, JSON.stringify(r));

// ---- CSV import
const rows = [
  { employee_number: "N1", full_name: "Nina Lead", role: "manager", employment_start: "2026-02-01", department: "Ops" },
  { employee_number: "N2", full_name: "Noel", employment_start: "2026-02-01", department: "Ops", manager_employee_number: "N1" },
  { employee_number: "N3", full_name: "Nia", employment_start: "2026-02-01", manager_employee_number: "M1" },
];
r = await call("hr.import_validate", { rows }, { session: O });
check("import: clean file validates", r.ok && r.data.valid === true, JSON.stringify(r));
r = await call("hr.import_validate", { rows: [...rows, { employee_number: "N1", full_name: "Dup", employment_start: "2026-02-01" }, { employee_number: "N4", full_name: "", employment_start: "bad" }, { employee_number: "N5", full_name: "X", employment_start: "2026-02-01", manager_employee_number: "GHOST" }, { employee_number: "N6", full_name: "A", employment_start: "2026-02-01", manager_employee_number: "N7" }, { employee_number: "N7", full_name: "B", employment_start: "2026-02-01", manager_employee_number: "N6" }, { employee_number: "M1", full_name: "Exists", employment_start: "2026-02-01" }] }, { session: O });
const msgs = (r.data?.errors ?? []).map((e) => e.message).join("|");
check("import: duplicates, bad rows, missing manager, loops and existing numbers all reported", r.ok && r.data.valid === false && /twice/.test(msgs) && /Name is required/.test(msgs) && /GHOST/.test(msgs) && /loop/i.test(msgs) && /Already exists/.test(msgs), msgs);
r = await call("hr.import_create", { rows }, { session: O });
check("import: created three with PINs", r.ok && r.data.created.length === 3 && r.data.created.every((c) => /^\d{6}$/.test(c.pin)), JSON.stringify(r));
const n2pin = r.data.created.find((c) => c.employee_number === "N2").pin;
r = await call("hr.import_managers", { pairs: [{ employee_number: "N2", manager_employee_number: "N1" }, { employee_number: "N3", manager_employee_number: "M1" }] }, { session: O });
check("import: managers set", r.ok && r.data.set === 2, JSON.stringify(r));
r = await call("hr.import_create", { rows: [rows[0]] }, { session: O });
check("import: creating an existing number is reported not fatal", r.ok && r.data.failed.length === 1 && r.data.created.length === 0, JSON.stringify(r));
r = await call("hr.allocate_year", { year_label: "2026" }, { session: O });
check("allocate: the three imported people get leave", r.ok && r.data.allocated === 3, JSON.stringify(r));
const N2 = await staff("N2", n2pin);
r = await call("leave.balances", {}, { session: N2 });
check("an imported employee can sign in and has a balance", r.ok && r.data.balances[0].available > 0, JSON.stringify(r));
r = await call("hr.import_validate", { rows: [] }, { session: O });
check("empty import refused", code(r) === "VALIDATION");

// ---- isolation and access
r = await call("setup.overview", {}, { session: E1 }); check("staff session cannot open setup", r.ok === false);
r = await call("setup.overview", {}, { session: M1 }); check("manager cannot open setup", code(r) === "FORBIDDEN");
r = await call("setup.assign_policy", { policy_id: polSenior, all: true, effective_from: "2026-06-01" }, { session: RO });
check("another business cannot use our policy", code(r) === "NOT_FOUND", JSON.stringify(r));
r = await call("setup.save_schedule", { id: schedMW, name: "hijack", week_pattern: { mon: 1, tue: 0, wed: 0, thu: 0, fri: 0, sat: 0, sun: 0 } }, { session: RO });
check("another business cannot edit our schedule", code(r) === "NOT_FOUND", JSON.stringify(r));
r = await call("setup.save_policy", { id: polSenior, name: "x", entitlement: 1 }, { session: RO });
check("another business cannot edit our policy", code(r) === "NOT_FOUND");
r = await call("hr.update_employee", { employee_number: "M1", full_name: "Hacked" }, { session: RO });
check("another business cannot edit our employee", code(r) === "NOT_FOUND");
r = await call("hr.terminate_employee", { employee_number: "M1", employment_end: "2026-11-30" }, { session: RO });
check("another business cannot end our employee", code(r) === "NOT_FOUND");
console.log(`\n${pass} passed, ${fail} failed`);
