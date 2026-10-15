import { JSDOM } from "jsdom";
import fs from "fs";
const FN = "https://wpfqxxnqksbkyzmcipft.supabase.co/functions/v1/cbs-hol";
let pass = 0, fail = 0;
const check = (n, c, x = "") => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  -> " + String(x).slice(0, 400)}`); };
const api = async (action, body = {}, h = {}) => (await (await fetch("http://localhost:8000", { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify({ action, ...body }) })).json());
const confirms = [];
async function open(page, query) {
  const html = fs.readFileSync(`${process.env.APP_DIR ?? "/mnt/user-data/outputs/employee-management"}/site/${page}/index.html`, "utf8").replace(FN, "http://localhost:8000");
  const dom = new JSDOM(html, { url: `http://localhost/${page}/${query}`, runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(w) { w.fetch = fetch; w.confirm = (m) => { confirms.push(m); return true; }; w.prompt = () => "x"; } });
  const errors = []; dom.window.addEventListener("error", (e) => errors.push(e.message)); dom.window.__errors = errors; return dom.window;
}
const wait = async (fn, label, ms = 8000) => { const t = Date.now(); for (;;) { try { const r = fn(); if (r) return r; } catch {} if (Date.now() - t > ms) throw new Error("timeout waiting for: " + label); await new Promise((r) => setTimeout(r, 50)); } };
const $ = (w, s) => w.document.querySelector(s);
const view = (w) => $(w, "#view")?.textContent ?? "";
const toastTxt = (w) => $(w, "#toast")?.textContent ?? "";
const click = (el) => el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent("click", { bubbles: true }));
const setVal = (el, v, ev = "change") => { el.value = v; el.dispatchEvent(new el.ownerDocument.defaultView.Event(ev, { bubbles: true })); };
const nav = (w, label) => click([...w.document.querySelectorAll("#nav button")].find((b) => b.textContent.startsWith(label)));
const btn = (w, t) => [...w.document.querySelectorAll("button")].find((b) => b.textContent.trim() === t);
const submit = (w, form) => form.dispatchEvent(new w.Event("submit", { cancelable: true, bubbles: true }));
const A = { "x-admin-key": "test-admin-key" };

const b = (await api("admin.create_business", { name: "Ui Six" }, A)).data;
const O = (await api("business.login", { slug: "ui-six", pin: b.owner_pin })).data.token;
const mk = async (n, name, role, mgr) => (await api("hr.create_employee", { employee_number: n, full_name: name, role, employment_start: "2026-01-01", manager_employee_number: mgr, department: "Ops" }, { "x-session": O })).data.pin;
const pins = { M1: await mk("M1", "Mandy", "manager"), E1: await mk("E1", "Eve", "employee", "M1"), E2: await mk("E2", "Fay", "employee", "M1") };
await api("hr.allocate_year", { year_label: "2026" }, { "x-session": O });
await api("setup.save_department", { name: "Ops", max_concurrent_absent: 1 }, { "x-session": O });
const t2 = (await api("staff.login", { slug: "ui-six", staff_key: b.staff_key, employee_number: "E2", pin: pins.E2 })).data.token;
const tm = (await api("staff.login", { slug: "ui-six", staff_key: b.staff_key, employee_number: "M1", pin: pins.M1 })).data.token;
const fay = (await api("leave.submit", { leave_type_code: "annual", start_date: "2026-12-14", end_date: "2026-12-15" }, { "x-session": t2 })).data.request_id;
await api("approvals.decide", { request_id: fay, decision: "approved", expected_version: 1 }, { "x-session": tm });

async function staffLogin(n) {
  const w = await open("staff", "?b=ui-six");
  setVal($(w, "#staffKey"), b.staff_key, "input"); setVal($(w, "#empNo"), n, "input"); setVal($(w, "#pin"), pins[n], "input");
  submit(w, $(w, "#loginForm")); await wait(() => !$(w, "#app").classList.contains("hidden"), "app"); return w;
}
const dates = (w) => [...w.document.querySelectorAll("#view input[type=date]")];

// ---- Eve: request into a full team, warned
let e1 = await staffLogin("E1");
check("staff: the Team calendar tab exists", [...e1.document.querySelectorAll("#nav button")].some((x) => x.textContent === "Team calendar"));
nav(e1, "Request leave");
await wait(() => e1.document.querySelectorAll("select option").length >= 1, "types");
setVal(dates(e1)[0], "2026-12-14"); setVal(dates(e1)[1], "2026-12-15");
await wait(() => view(e1).includes("team limit of 1"), "team warning");
check("request: the team limit warning is shown in the preview", view(e1).includes("Your approver may decline"));
click(btn(e1, "Send request"));
await wait(() => toastTxt(e1).includes("sent to your approver"), "sent");

// ---- Eve: a second request, then change it
nav(e1, "Request leave");
await wait(() => e1.document.querySelectorAll("select option").length >= 1, "types again");
setVal(dates(e1)[0], "2026-12-21"); setVal(dates(e1)[1], "2026-12-21");
await wait(() => view(e1).includes("1 day will be used"), "preview 1 day");
click(btn(e1, "Send request"));
const row21 = () => [...e1.document.querySelectorAll("#view .rowcard")].find((r) => r.textContent.includes("21/12/2026"));
await wait(() => row21(), "listed");
click([...row21().querySelectorAll("button")].find((x) => x.textContent === "Change"));
await wait(() => view(e1).includes("Change your request") && dates(e1)[0]?.value === "2026-12-21", "edit form prefilled");
check("change: the form opens with the request's dates filled in", dates(e1)[1].value === "2026-12-21");
setVal(dates(e1)[0], "2026-12-22"); setVal(dates(e1)[1], "2026-12-22");
await wait(() => view(e1).includes("1 day will be used"), "preview after change");
click(btn(e1, "Send request"));
await wait(() => toastTxt(e1).includes("sent to your approver"), "resent");
await wait(() => [...e1.document.querySelectorAll("#view .rowcard")].some((r) => r.textContent.includes("22/12/2026") && r.textContent.includes("Pending")), "new date listed");
check("change: the old request shows as Cancelled and the new one as Pending",
  view(e1).includes("Cancelled") && [...e1.document.querySelectorAll("#view .rowcard")].some((r) => r.textContent.includes("22/12/2026") && r.textContent.includes("Pending")), view(e1));
check("change: only one pending request remains for that week", [...e1.document.querySelectorAll("#view .rowcard")].filter((r) => r.textContent.includes("Pending") && /2[12]\/12\/2026/.test(r.textContent)).length === 1);

// ---- Eve: calendar
nav(e1, "Team calendar");
await wait(() => $(e1, "table.cal"), "calendar table");
check("calendar: shows the month and the team", view(e1).includes("Fay") && view(e1).includes("Eve (you)") && !view(e1).includes("Mandy"), view(e1).slice(0, 200));
click(btn(e1, "Next")); click(btn(e1, "Next"));
await wait(() => view(e1).includes("December 2026") && $(e1, "td.cal-approved"), "december");
const fayRow = [...e1.document.querySelectorAll("table.cal tr")].find((r) => r.textContent.startsWith("Fay"));
check("calendar: Fay's approved days are marked (14 and 15 December)", fayRow.querySelectorAll("td.cal-approved").length === 2);
const eveRow = [...e1.document.querySelectorAll("table.cal tr")].find((r) => r.textContent.startsWith("Eve"));
check("calendar: your own pending requests are amber", eveRow.querySelectorAll("td.cal-pending").length >= 1);
const heads = [...e1.document.querySelectorAll("table.cal th")];
check("calendar: bank holidays (25 and 28 December) are shaded", heads.filter((h) => h.classList.contains("bh")).map((h) => h.textContent).join() === "25,28", heads.map((h) => h.className).join());

// ---- Mandy: sees the breach, must confirm, approves
const m1 = await staffLogin("M1");
nav(m1, "Approvals");
await wait(() => view(m1).includes("Eve"), "inbox");
click([...m1.document.querySelectorAll("#view .rowcard")].find((r) => r.textContent.includes("14/12/2026")).querySelector("button"));
await wait(() => view(m1).includes("Also away on these dates"), "detail");
check("approver: the team-limit warning is shown on the request", view(m1).includes("limit of 1 person away at once would be exceeded on 14/12/2026, 15/12/2026"), view(m1).slice(0, 500));
confirms.length = 0;
click(btn(m1, "Approve"));
await wait(() => toastTxt(m1) === "Done", "approved after confirm");
check("approver: approving over the limit asks to confirm first", confirms.some((m) => m.includes("Approve anyway?")), confirms.join("|"));

// ---- business page: teams card and calendar
const bw = await open("business", "?b=ui-six");
setVal($(bw, "#pin"), b.owner_pin, "input"); submit(bw, $(bw, "#loginForm")); await wait(() => !$(bw, "#app").classList.contains("hidden"), "app");
nav(bw, "Setup");
await wait(() => view(bw).includes("Teams and cover limits") && view(bw).includes("Ops"), "teams card");
const teamsCard = [...bw.document.querySelectorAll("#view section.card")].find((c) => c.querySelector("h2")?.textContent === "Teams and cover limits");
check("setup: the Ops limit is shown", teamsCard.querySelector("input").value === "1");
setVal(teamsCard.querySelector("input"), "2", "input");
click([...teamsCard.querySelectorAll("button")].find((x) => x.textContent === "Save"));
await wait(() => toastTxt(bw) === "Saved", "limit saved");
const ov = await api("setup.overview", {}, { "x-session": O });
check("setup: the new limit is stored", ov.data.departments.find((d) => d.name === "Ops").max_concurrent_absent === 2);
nav(bw, "Calendar");
await wait(() => $(bw, "table.cal"), "business calendar");
check("business calendar: shows everyone", ["Eve", "Fay", "Mandy"].every((n) => view(bw).includes(n)));
check("no script errors", [...e1.__errors, ...m1.__errors, ...bw.__errors].length === 0, [...e1.__errors, ...m1.__errors, ...bw.__errors].join("|"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
