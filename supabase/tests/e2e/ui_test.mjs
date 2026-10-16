import { JSDOM } from "jsdom";
import fs from "fs";
const seed = JSON.parse(fs.readFileSync("seed.json", "utf8"));
const FN = "https://wviakiswsrkxhjkgmnbw.supabase.co/functions/v1/cbs-hol";
let pass = 0, fail = 0;
const check = (n, c, x = "") => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  -> " + x}`); };
const api = async (action, body = {}, h = {}) => (await (await fetch("http://localhost:8000", { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify({ action, ...body }) })).json());

async function open(page, query) {
  const html = fs.readFileSync(`/mnt/user-data/outputs/holiday/${page}/index.html`, "utf8").replace(FN, "http://localhost:8000");
  const dom = new JSDOM(html, { url: `http://localhost/${page}/${query}`, runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(w) { w.fetch = fetch; w.confirm = () => true; w.prompt = () => "plans changed"; } });
  const errors = []; dom.window.addEventListener("error", (e) => errors.push(e.message));
  dom.window.__errors = errors; return dom.window;
}
const wait = async (fn, label, ms = 8000) => { const t = Date.now(); for (;;) { try { const r = fn(); if (r) return r; } catch {} if (Date.now() - t > ms) throw new Error("timeout waiting for: " + label); await new Promise((r) => setTimeout(r, 50)); } };
const $ = (w, s) => w.document.querySelector(s);
const txt = (w, s) => $(w, s)?.textContent ?? "";
const click = (el) => el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent("click", { bubbles: true }));
const setVal = (el, v, ev = "change") => { el.value = v; el.dispatchEvent(new el.ownerDocument.defaultView.Event(ev, { bubbles: true })); };
const nav = (w, label) => click([...w.document.querySelectorAll("#nav button")].find((b) => b.textContent.startsWith(label)));
const navLabels = (w) => [...w.document.querySelectorAll("#nav button")].map((b) => b.textContent);
const button = (w, t) => [...w.document.querySelectorAll("button")].find((b) => b.textContent.trim() === t);
const submitForm = (w, id) => $(w, "#" + id).dispatchEvent(new w.Event("submit", { cancelable: true, bubbles: true }));

async function staffLogin(num, pin) {
  const w = await open("staff", "?b=test-co");
  setVal($(w, "#staffKey"), seed.staff_key, "input"); setVal($(w, "#empNo"), num, "input"); setVal($(w, "#pin"), pin, "input");
  submitForm(w, "loginForm");
  await wait(() => !$(w, "#app").classList.contains("hidden"), "app to show");
  return w;
}

// ---------------- Eve (employee): dashboard, request, preview
let e1 = await staffLogin("E1", seed.pins.E1);
check("staff page: signed in as Eve", txt(e1, "#whoName") === "Eve Employee");
check("staff page: employee has no Approvals tab", !navLabels(e1).some((l) => l.startsWith("Approvals")), navLabels(e1).join(","));
await wait(() => txt(e1, ".stat .big") === "28", "dashboard shows 28");
check("dashboard: 28 days left to book", true);

nav(e1, "Request leave");
await wait(() => e1.document.querySelectorAll("select option").length >= 1, "leave types loaded");
const sel = e1.document.querySelectorAll("input[type=date]");
setVal(sel[0], "2026-11-02"); setVal(sel[1], "2026-12-18");
await wait(() => txt(e1, ".preview").includes("Not enough leave"), "over-balance warning");
check("request: too many days is flagged and cannot be sent", button(e1, "Send request").disabled === true);
setVal(sel[0], "2026-12-21"); setVal(sel[1], "2026-12-31");
await wait(() => txt(e1, ".preview").includes("7 days will be used once approved"), "7 day preview");
check("request: live preview says 7 days", true);
check("request: bank holidays shown as skipped", txt(e1, ".preview").includes("25/12/2026 bank holiday") && txt(e1, ".preview").includes("28/12/2026 bank holiday"));
check("request: send enabled when it fits", button(e1, "Send request").disabled === false);
// a colleague asks for overlapping days so the manager sees a team overlap
const e3tok = (await api("staff.login", { slug: "test-co", staff_key: seed.staff_key, employee_number: "E3", pin: seed.pins.E3 })).data.token;
const sub3 = await api("leave.submit", { leave_type_code: "annual", start_date: "2026-12-29", end_date: "2026-12-30" }, { "x-session": e3tok });
check("setup: colleague request created", sub3.ok, JSON.stringify(sub3));
$(e1, "textarea").value = "Christmas";
click(button(e1, "Send request"));
await wait(() => txt(e1, "#toast").includes("sent to your approver"), "submit toast");
await wait(() => txt(e1, ".rowcard").includes("Pending"), "request listed as pending");
check("my requests: new request shows as Pending, 7 days", txt(e1, ".rowcard").includes("7 days") && txt(e1, ".rowcard").includes("Christmas"));
nav(e1, "Home");
await wait(() => txt(e1, ".stat .big") === "21", "21 after pending");
check("dashboard: 21 left after a pending request", txt(e1, ".stat .sub").length > 0 && txt(e1, ".stats").includes("Awaiting approval 7"));

// ---------------- Mandy (manager): inbox, detail, approve
let m1 = await staffLogin("M1", seed.pins.M1);
check("manager has an Approvals tab", navLabels(m1).some((l) => l.startsWith("Approvals")));
nav(m1, "Approvals");
await wait(() => m1.document.querySelectorAll(".rowcard").length >= 2, "two inbox rows");
check("inbox: shows both requests", txt(m1, "#view").includes("Eve Employee") && txt(m1, "#view").includes("Ed Colleague"));
const review = [...m1.document.querySelectorAll(".rowcard")].find((r) => r.textContent.includes("Eve Employee")).querySelector("button");
click(review);
await wait(() => txt(m1, "#view").includes("Also away on these dates"), "detail panel");
check("detail: shows the team overlap with Ed", txt(m1, "#view").split("Also away on these dates")[1]?.includes("Ed Colleague"), txt(m1, "#view").slice(0, 600));
check("detail: shows balance", txt(m1, "#view").includes("28 available, 7 requested"), txt(m1, "#view").slice(0, 600));
click(button(m1, "Reject"));
check("reject without a reason is blocked", txt(m1, "#toast").includes("give a reason"));
click(button(m1, "Approve"));
await wait(() => txt(m1, "#toast") === "Done", "approve toast");
await wait(() => m1.document.querySelectorAll(".rowcard").length === 1 || !txt(m1, "#view").includes("Eve Employee"), "inbox refreshed");
check("approve: request leaves the inbox", !txt(m1, "#view").includes("Eve Employee"));

// ---------------- Eve: notification, balance, cancellation
e1 = await staffLogin("E1", seed.pins.E1);
await wait(() => navLabels(e1).some((l) => l === "Notifications (1)"), "unread badge");
check("notifications: unread count shown on the tab", true);
nav(e1, "Notifications");
await wait(() => txt(e1, "#view").includes("Leave approved"), "approved notification");
check("notifications: employee is told it was approved", true);
click(button(e1, "Mark all as read"));
await wait(() => navLabels(e1).some((l) => l === "Notifications"), "badge cleared");
check("notifications: mark all read clears the count", true);
nav(e1, "Home");
await wait(() => txt(e1, ".stats").includes("Booked 7"), "booked 7");
check("dashboard: 7 booked, 21 left", txt(e1, ".stat .big") === "21");
nav(e1, "My requests");
await wait(() => button(e1, "Ask to cancel"), "cancel button");
click(button(e1, "Ask to cancel"));
await wait(() => txt(e1, ".rowcard").includes("Cancellation requested"), "cancellation requested");
check("cancel: approved leave becomes Cancellation requested", true);

m1 = await staffLogin("M1", seed.pins.M1);
nav(m1, "Approvals");
await wait(() => txt(m1, "#view").includes("Cancellation"), "cancellation in inbox");
click([...m1.document.querySelectorAll(".rowcard")].find((r) => r.textContent.includes("Eve Employee")).querySelector("button"));
await wait(() => button(m1, "Approve cancellation"), "approve cancellation button");
click(button(m1, "Approve cancellation"));
await wait(() => txt(m1, "#toast") === "Done", "cancellation approved");
e1 = await staffLogin("E1", seed.pins.E1);
await wait(() => txt(e1, ".stat .big") === "28", "balance back to 28");
check("cancel: days returned, 28 left again", true);

// ---------------- Eve: change PIN
nav(e1, "My PIN");
const pins = e1.document.querySelectorAll("#view input[type=password]");
setVal(pins[0], seed.pins.E1, "input"); setVal(pins[1], "482916", "input"); setVal(pins[2], "482917", "input");

const pinForm = $(e1, "#view form");
pinForm.dispatchEvent(new e1.Event("submit", { cancelable: true, bubbles: true }));
await wait(() => txt(e1, "#toast").includes("do not match"), "mismatch toast");
check("change PIN: mismatch refused", true);
setVal(pins[2], "482916", "input");
pinForm.dispatchEvent(new e1.Event("submit", { cancelable: true, bubbles: true }));
await wait(() => txt(e1, "#toast").includes("PIN changed"), "PIN changed toast");
check("change PIN: success", true);
let r = await api("staff.login", { slug: "test-co", staff_key: seed.staff_key, employee_number: "E1", pin: seed.pins.E1 });
check("change PIN: old PIN no longer works", r.ok === false);
r = await api("staff.login", { slug: "test-co", staff_key: seed.staff_key, employee_number: "E1", pin: "482916" });
check("change PIN: new PIN works", r.ok === true);

// ---------------- business portal
const bw = await open("business", "?b=test-co");
setVal($(bw, "#pin"), seed.owner_pin, "input");
submitForm(bw, "loginForm");
await wait(() => !$(bw, "#app").classList.contains("hidden"), "business app");
check("business page: owner signs in with no staff key", txt(bw, "#whoName") === "Owner");
check("business page: tabs", ["Home", "People", "Approvals", "Notifications", "My PIN"].every((t) => navLabels(bw).some((l) => l.startsWith(t))), navLabels(bw).join(","));
nav(bw, "People");
await wait(() => txt(bw, "table").includes("Mandy Manager"), "people list");
check("business page: people list loads", txt(bw, "table").includes("Eve Employee") && txt(bw, "table").includes("Ed Colleague"));
nav(bw, "Approvals");
await wait(() => txt(bw, "#view").includes("Ed Colleague") || txt(bw, "#view").includes("Nothing is waiting"), "business inbox");
check("business page: owner inbox shows every pending request", txt(bw, "#view").includes("Ed Colleague"));

// ---------------- text is never treated as HTML
await api("hr.create_employee", { employee_number: "X1", full_name: "<b>bold</b><img src=x onerror=alert(1)>", role: "employee", employment_start: "2026-01-01" }, { "x-session": (await api("business.login", { slug: "test-co", pin: seed.owner_pin })).data.token });
nav(bw, "People");
await wait(() => txt(bw, "table").includes("<b>bold</b>"), "hostile name shown as text");
check("safety: a name containing HTML is shown as plain text", !$(bw, "table b") && !$(bw, "table img"));

const errs = [...(e1.__errors || []), ...(bw.__errors || [])];
check("no script errors on either page", errs.length === 0, errs.join(" | "));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
