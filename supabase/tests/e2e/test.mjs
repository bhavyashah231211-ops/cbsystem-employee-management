const URL = "http://localhost:8000";
let pass = 0, fail = 0;
const call = async (action, body = {}, { session, admin } = {}) => {
  const headers = { "content-type": "application/json" };
  if (session) headers["x-session"] = session;
  if (admin !== undefined) headers["x-admin-key"] = admin;
  const r = await fetch(URL, { method: "POST", headers, body: JSON.stringify({ action, ...body }) });
  return { status: r.status, ...(await r.json()) };
};
const check = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + extra}`); };
const code = (r) => r.error?.code;
const ADMIN = "test-admin-key";

// ---- platform admin
let r = await call("admin.create_business", { name: "Test Co" }, { admin: "wrong" });
check("admin: wrong key rejected", r.status === 401);
r = await call("admin.create_business", { name: "Test Co" }, { admin: ADMIN });
check("admin: business created", r.ok, JSON.stringify(r));
const { staff_key, owner_pin, message, business } = r.data;
check("admin: message has business and staff blocks", message.includes("BUSINESS LOGIN") && message.includes("STAFF LOGIN") && message.includes("https://example.test/business/?b=test-co"));
r = await call("admin.create_business", { name: "Other Co" }, { admin: ADMIN });
const other = r.data;

// ---- logins are separate
const slug = "test-co";
r = await call("staff.login", { slug, staff_key, employee_number: "OWNER", pin: owner_pin });
check("staff login refuses the OWNER account", code(r) === "INVALID_LOGIN");
r = await call("business.login", { slug, employee_number: "", pin: owner_pin });
check("business login: owner (blank number means OWNER)", r.ok, JSON.stringify(r));
const OWNER = r.data.token;
r = await call("business.login", { slug, employee_number: "OWNER", pin: "000000" });
check("business login: wrong PIN rejected", code(r) === "INVALID_LOGIN");

// ---- HR sets up people
const mk = async (n, name, role, mgr) => (await call("hr.create_employee", { employee_number: n, full_name: name, role, employment_start: "2026-01-01", department: "Ops", manager_employee_number: mgr }, { session: OWNER }));
r = await mk("M1", "Mandy Manager", "manager"); check("hr: create manager", r.ok, JSON.stringify(r)); const pinM1 = r.data.pin;
r = await mk("E1", "Eve Employee", "employee", "M1"); check("hr: create employee under M1", r.ok, JSON.stringify(r)); const pinE1 = r.data.pin;
r = await mk("E2", "Eli Employee", "employee"); check("hr: create employee with no manager", r.ok); const pinE2 = r.data.pin;
r = await mk("E1", "Dup", "employee"); check("hr: duplicate number refused", code(r) === "EMPLOYEE_EXISTS");
r = await call("hr.allocate_year", { year_label: "2026" }, { session: OWNER });
check("hr: yearly allocation for 3 people", r.ok && r.data.allocated === 3, JSON.stringify(r));
r = await call("hr.allocate_year", { year_label: "2026" }, { session: OWNER });
check("hr: allocation repeat changes nothing", r.ok && r.data.allocated === 0 && r.data.already_allocated === 3, JSON.stringify(r));
r = await call("hr.balances", { employee_number: "E1" }, { session: OWNER });
check("hr: E1 has 28 days", r.ok && r.data.balances[0]?.available === 28, JSON.stringify(r));

// ---- staff logins
const login = async (n, pin) => (await call("staff.login", { slug, staff_key, employee_number: n, pin })).data?.token;
const E1 = await login("E1", pinE1), M1 = await login("M1", pinM1), E2 = await login("E2", pinE2);
check("staff: three logins worked", E1 && M1 && E2);
r = await call("staff.login", { slug, staff_key: "AAAA-AAAA-AAAA", employee_number: "E1", pin: pinE1 });
check("staff: wrong staff key rejected", code(r) === "INVALID_LOGIN");

// ---- preview and submit
const dec = { leave_type_code: "annual", start_date: "2026-12-21", end_date: "2026-12-31" };
r = await call("leave.preview", dec, { session: E1 });
check("preview: 7 days, 2 bank holidays skipped", r.ok && r.data.requested_units === 7 && r.data.skipped_days.filter((d) => d.reason === "bank_holiday").length === 2 && r.data.can_submit, JSON.stringify(r.data));
r = await call("leave.preview", { leave_type_code: "annual", start_date: "2026-11-02", end_date: "2026-12-18" }, { session: E1 });
check("preview: 35 days flagged as not enough balance", r.ok && r.data.can_submit === false && r.data.problems.length === 1, JSON.stringify(r.data));
r = await call("leave.submit", { ...dec, comment: "Christmas" }, { session: E1 });
check("submit: pending, 7 days", r.ok && r.data.status === "pending" && r.data.requested_units === 7, JSON.stringify(r));
const R1 = r.data.request_id;
r = await call("leave.submit", { ...dec }, { session: E1 });
check("submit: overlapping request refused", code(r) === "OVERLAP", JSON.stringify(r));
r = await call("leave.submit", { leave_type_code: "annual", start_date: "2026-11-02", end_date: "2026-12-18" }, { session: E1 });
check("submit: over-balance request refused", code(r) === "INSUFFICIENT_BALANCE", JSON.stringify(r));
r = await call("leave.balances", {}, { session: E1 });
const bal = r.data?.balances?.[0];
check("balances: 28 available, 7 pending", r.ok && bal.available === 28 && bal.pending === 7 && bal.available_after_pending === 21, JSON.stringify(bal));
r = await call("leave.submit", { leave_type_code: "annual", start_date: "2026-12-21", end_date: "2026-12-21", start_half: "am" }, { session: E1 });
check("submit: overlap also caught for a half day inside the range", code(r) === "OVERLAP");

// ---- approvals
r = await call("approvals.inbox", {}, { session: M1 });
check("inbox: manager sees the request", r.ok && r.data.items.length === 1 && r.data.items[0].employee === "Eve Employee", JSON.stringify(r));
r = await call("approvals.detail", { request_id: R1 }, { session: M1 });
check("detail: shows days and balance", r.ok && r.data.days.length === 7 && r.data.balances[0].available === 28, JSON.stringify(r).slice(0, 300));
r = await call("approvals.inbox", {}, { session: E1 });
check("security: an employee cannot use the approvals inbox", code(r) === "FORBIDDEN");
r = await call("approvals.decide", { request_id: R1, decision: "approved", expected_version: 1 }, { session: E2 });
check("security: a non-approver employee cannot decide", code(r) === "FORBIDDEN");
r = await call("approvals.decide", { request_id: R1, decision: "rejected", expected_version: 1 }, { session: M1 });
check("decide: rejecting needs a reason", code(r) === "VALIDATION");
r = await call("approvals.decide", { request_id: R1, decision: "approved", expected_version: 9 }, { session: M1 });
check("decide: stale version refused", code(r) === "STALE");
r = await call("approvals.decide", { request_id: R1, decision: "approved", expected_version: 1 }, { session: M1 });
check("decide: approved", r.ok && r.data.status === "approved", JSON.stringify(r));
r = await call("approvals.decide", { request_id: R1, decision: "approved", expected_version: 1 }, { session: M1 });
check("decide: second decision refused", code(r) === "STALE");
r = await call("leave.balances", {}, { session: E1 });
check("balances after approval: booked 7, available 21", r.data.balances[0].booked === 7 && r.data.balances[0].available === 21 && r.data.balances[0].pending === 0, JSON.stringify(r.data.balances[0]));
r = await call("notifications.list", {}, { session: E1 });
check("notifications: employee told it was approved", r.ok && r.data.notifications.some((n) => n.title === "Leave approved") && r.data.unread_count >= 1, JSON.stringify(r.data));
r = await call("notifications.mark_read", { all: true }, { session: E1 });
r = await call("notifications.list", { unread_only: true }, { session: E1 });
check("notifications: mark all read", r.ok && r.data.unread_count === 0);

// ---- cancelling approved leave
r = await call("leave.cancel", { request_id: R1, reason: "plans changed" }, { session: E1 });
check("cancel approved: becomes cancellation_pending", r.ok && r.data.status === "cancellation_pending", JSON.stringify(r));
r = await call("leave.balances", {}, { session: E1 });
check("cancel approved: balance unchanged until approved", r.data.balances[0].available === 21);
r = await call("approvals.inbox", {}, { session: M1 });
check("cancel approved: manager sees a cancellation", r.data.items[0]?.kind === "cancellation");
const ver = r.data.items[0].version;
r = await call("approvals.decide", { request_id: R1, decision: "approved", expected_version: ver }, { session: M1 });
check("cancel approved: cancellation approved", r.ok && r.data.status === "cancelled", JSON.stringify(r));
r = await call("leave.balances", {}, { session: E1 });
check("cancel approved: balance restored to 28", r.data.balances[0].available === 28 && r.data.balances[0].booked === 0, JSON.stringify(r.data.balances[0]));

// ---- employee with no manager goes to the owner (business portal)
r = await call("leave.submit", { leave_type_code: "annual", start_date: "2026-11-09", end_date: "2026-11-10" }, { session: E2 });
check("no-manager employee: request created", r.ok, JSON.stringify(r));
const R2 = r.data.request_id;
r = await call("approvals.inbox", {}, { session: OWNER });
check("owner: sees it in the business inbox", r.ok && r.data.items.some((i) => i.request_id === R2), JSON.stringify(r));
r = await call("approvals.decide", { request_id: R2, decision: "approved", expected_version: 1 }, { session: M1 });
check("security: another manager cannot decide it", code(r) === "FORBIDDEN");
r = await call("approvals.decide", { request_id: R2, decision: "approved", expected_version: 1 }, { session: OWNER });
check("owner: approves", r.ok && r.data.status === "approved");

// ---- delegation
r = await call("approvals.delegate", { to_employee_number: "M1", starts_on: "2026-10-01", ends_on: "2026-12-31" }, { session: OWNER });
check("delegation: owner delegates to M1", r.ok, JSON.stringify(r));
r = await call("leave.submit", { leave_type_code: "annual", start_date: "2026-11-16", end_date: "2026-11-16" }, { session: E2 });
const R3 = r.data.request_id;
r = await call("approvals.decide", { request_id: R3, decision: "approved", expected_version: 1 }, { session: M1 });
check("delegation: M1 can now decide for the owner", r.ok, JSON.stringify(r));
r = await call("approvals.delegations", {}, { session: M1 });
check("delegation: listed for the delegate", r.ok && r.data.delegations.length === 1 && r.data.delegations[0].direction === "received");

// ---- portal separation
r = await call("hr.list_employees", {}, { session: E1 }); check("security: staff session cannot list employees", code(r) === "FORBIDDEN");
r = await call("hr.allocate", { employee_number: "E1", quantity: 5, note: "x" }, { session: M1 }); check("security: manager cannot adjust balances", code(r) === "FORBIDDEN");
r = await call("leave.balances", {}, { session: OWNER }); check("security: business session cannot use staff leave actions", code(r) === "FORBIDDEN");
r = await call("hr.list_employees", {}, { session: OWNER }); check("hr: employee list returns people", r.ok && r.data.employees.length === 4, JSON.stringify(r).slice(0, 200));

// ---- manual adjustment
r = await call("hr.allocate", { employee_number: "E1", year_label: "2026", quantity: -3, note: "Unpaid day taken in error", request_key: "k1" }, { session: OWNER });
check("hr: adjustment posted", r.ok && r.data.posted === true, JSON.stringify(r));
r = await call("hr.allocate", { employee_number: "E1", year_label: "2026", quantity: -3, note: "Unpaid day taken in error", request_key: "k1" }, { session: OWNER });
check("hr: same adjustment key is not posted twice", r.ok && r.data.posted === false);
r = await call("hr.allocate", { employee_number: "E1", year_label: "2026", quantity: -3 }, { session: OWNER });
check("hr: adjustment needs a note", code(r) === "VALIDATION");
r = await call("hr.balances", { employee_number: "E1" }, { session: OWNER });
check("hr: balance now 25", r.data.balances[0].available === 25, JSON.stringify(r.data.balances[0]));

// ---- other business cannot see this business's data
r = await call("business.login", { slug: "other-co", employee_number: "OWNER", pin: other.owner_pin });
const OTHER = r.data.token;
r = await call("approvals.detail", { request_id: R2 }, { session: OTHER });
check("isolation: other business cannot read our request", code(r) === "NOT_FOUND", JSON.stringify(r));
r = await call("approvals.decide", { request_id: R2, decision: "rejected", comment: "x", expected_version: 2 }, { session: OTHER });
check("isolation: other business cannot decide our request", ["NOT_FOUND", "FORBIDDEN", "STALE"].includes(code(r)), JSON.stringify(r));
r = await call("hr.balances", { employee_number: "E1" }, { session: OTHER });
check("isolation: other business cannot read our balances", code(r) === "NOT_FOUND");
r = await call("hr.list_employees", {}, { session: OTHER });
check("isolation: other business sees only its own people", r.ok && r.data.employees.length === 1);
r = await call("staff.login", { slug: "other-co", staff_key, employee_number: "E1", pin: pinE1 });
check("isolation: our staff key and PIN do not work in the other business", code(r) === "INVALID_LOGIN");

// ---- lockout
for (let i = 0; i < 5; i++) await call("staff.login", { slug, staff_key, employee_number: "E2", pin: "999999" });
r = await call("staff.login", { slug, staff_key, employee_number: "E2", pin: pinE2 });
check("lockout: correct PIN refused after 5 wrong attempts", code(r) === "LOCKED", JSON.stringify(r));

// ---- PIN reset, suspension
r = await call("hr.reset_pin", { employee_number: "E2" }, { session: OWNER });
check("hr: PIN reset returns a new PIN", r.ok && /^\d{6}$/.test(r.data.pin));
r = await call("staff.login", { slug, staff_key, employee_number: "E2", pin: r.data.pin });
check("hr: reset clears the lockout and the new PIN works", r.ok);
r = await call("admin.set_status", { slug, status: "suspended" }, { admin: ADMIN });
r = await call("leave.balances", {}, { session: E1 });
check("admin: suspended business loses its sessions", !r.ok && ["SESSION_EXPIRED", "SUSPENDED", "NO_SESSION"].includes(code(r)), JSON.stringify(r));
r = await call("staff.login", { slug, staff_key, employee_number: "E1", pin: pinE1 });
check("admin: suspended business cannot sign in", code(r) === "INVALID_LOGIN");

console.log(`\n${pass} passed, ${fail} failed`);
