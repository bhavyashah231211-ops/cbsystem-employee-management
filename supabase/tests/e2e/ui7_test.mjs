import { JSDOM } from "jsdom";
import fs from "fs";
const FN = "https://wviakiswsrkxhjkgmnbw.supabase.co/functions/v1/cbs-hol";
let pass = 0, fail = 0;
const check = (n, c, x = "") => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  -> " + String(x).slice(0, 400)}`); };
const api = async (action, body = {}, h = {}) => (await (await fetch("http://localhost:8000", { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify({ action, ...body }) })).json());
const blobs = [];
async function open(page, query) {
  const html = fs.readFileSync(`${process.env.APP_DIR ?? "/mnt/user-data/outputs/employee-management"}/site/${page}/index.html`, "utf8").replace(FN, "http://localhost:8000");
  const dom = new JSDOM(html, { url: `http://localhost/${page}/${query}`, runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(w) { w.fetch = fetch; w.confirm = () => true; w.prompt = () => "x"; w.URL.createObjectURL = (b) => { blobs.push({ b, w }); return "blob:x"; }; } });
  const errors = []; dom.window.addEventListener("error", (e) => errors.push(e.message)); dom.window.__errors = errors;
  dom.window.HTMLAnchorElement.prototype.click = function () { this.__clicked = true; };
  return dom.window;
}
const wait = async (fn, label, ms = 8000) => { const t = Date.now(); for (;;) { try { const r = fn(); if (r) return r; } catch {} if (Date.now() - t > ms) throw new Error("timeout waiting for: " + label); await new Promise((r) => setTimeout(r, 50)); } };
const $ = (w, s) => w.document.querySelector(s);
const view = (w) => $(w, "#view")?.textContent ?? "";
const click = (el) => el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent("click", { bubbles: true }));
const setVal = (el, v, ev = "change") => { el.value = v; el.dispatchEvent(new el.ownerDocument.defaultView.Event(ev, { bubbles: true })); };
const nav = (w, label) => click([...w.document.querySelectorAll("#nav button")].find((b) => b.textContent.startsWith(label)));
const btn = (w, t) => [...w.document.querySelectorAll("#view button")].find((b) => b.textContent.trim() === t);
const submit = (w, form) => form.dispatchEvent(new w.Event("submit", { cancelable: true, bubbles: true }));
const blobText = (item) => new Promise((res) => { const r = new item.w.FileReader(); r.onload = () => res(r.result); r.readAsText(item.b); });
const A = { "x-admin-key": "test-admin-key" };
const london = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const add = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const wk = (iso) => { let d = iso; while ([0, 6].includes(new Date(d + "T00:00:00Z").getUTCDay())) d = add(d, 1); return d; };

const b = (await api("admin.create_business", { name: "Ui Seven" }, A)).data;
const O = (await api("business.login", { slug: "ui-seven", pin: b.owner_pin })).data.token;
const mk = async (n, name, role, mgr, dept) => (await api("hr.create_employee", { employee_number: n, full_name: name, role, employment_start: "2026-01-01", manager_employee_number: mgr, department: dept }, { "x-session": O })).data.pin;
const pins = { M1: await mk("M1", "Mandy", "manager", undefined, "Ops"), E1: await mk("E1", "Eve", "employee", "M1", "Ops"), E2: await mk("E2", "Fay", "employee", "M1", "Sales") };
await api("hr.allocate_year", { year_label: "2026" }, { "x-session": O });
const tk = {}; for (const n of Object.keys(pins)) tk[n] = (await api("staff.login", { slug: "ui-seven", staff_key: b.staff_key, employee_number: n, pin: pins[n] })).data.token;
const d0 = wk(london), d1 = wk(add(london, 7));
const r1 = (await api("leave.submit", { leave_type_code: "annual", start_date: d0, end_date: d0 }, { "x-session": tk.E1 })).data.request_id;
await api("approvals.decide", { request_id: r1, decision: "approved", expected_version: 1, comment: "ok" }, { "x-session": tk.M1 });
const r2 = (await api("leave.submit", { leave_type_code: "annual", start_date: d1, end_date: d1 }, { "x-session": tk.E2 })).data.request_id;
await api("approvals.decide", { request_id: r2, decision: "approved", expected_version: 1, comment: "ok" }, { "x-session": tk.M1 });
await api("leave.submit", { leave_type_code: "annual", start_date: wk(add(london, 20)), end_date: wk(add(london, 20)) }, { "x-session": tk.E2 });

const w = await open("business", "?b=ui-seven");
setVal($(w, "#pin"), b.owner_pin, "input"); submit(w, $(w, "#loginForm"));
await wait(() => !$(w, "#app").classList.contains("hidden"), "app");

// ---- home
await wait(() => view(w).includes("people employed"), "home summary");
check("home: headcount, waiting and away today", view(w).includes("4") && view(w).includes("waiting for a decision") && view(w).includes("Eve (E1)"), view(w).slice(0, 300));
check("home: coming up lists Fay", view(w).includes("Fay") && view(w).includes(d1.slice(8) + "/" + d1.slice(5, 7)), view(w).slice(0, 400));
click($(w, ".stat[style*='cursor']"));
await wait(() => view(w).includes("Waiting for your decision"), "clicking the waiting count opens approvals");
await wait(() => view(w).includes("Fay"), "inbox loaded");
check("home: the waiting count opens the approvals", view(w).includes("Fay"));

// ---- balances report
nav(w, "Reports");
await wait(() => $(w, "#view select option"), "reports loaded");
click(btn(w, "Run report"));
await wait(() => view(w).includes("rows"), "balance rows");
check("reports: balance table shows the three people with 28 entitlement", ["Eve", "Fay", "Mandy"].every((n) => view(w).includes(n)) && view(w).includes("28"), view(w).slice(0, 400));
click([...w.document.querySelectorAll("#view button")].find((x) => x.textContent === "Download CSV"));
const csv1 = await blobText(blobs[blobs.length - 1]);
check("reports: balance CSV has a header and one line per person", csv1.split("\r\n")[0].startsWith("employee_number,full_name") && csv1.split("\r\n").length === 4, csv1);
const deptSel = w.document.querySelectorAll("#view select")[1];
setVal(deptSel, "Sales");
click(btn(w, "Run report"));
await wait(() => view(w).includes("1 rows"), "filtered");
check("reports: the department filter narrows the balance report", view(w).includes("Fay") && !view(w).includes("Eve"), view(w).slice(0, 300));

// ---- absence report
const aCard = [...w.document.querySelectorAll("#view section.card")].find((c) => c.querySelector("h2")?.textContent === "Absence report");
const runAbs = [...aCard.querySelectorAll("button")].find((x) => x.textContent === "Run report");
click(runAbs);
await wait(() => aCard.textContent.includes("requests"), "absence rows");
check("reports: absence shows the approved leave in the next 30 days", aCard.textContent.includes("Eve") && aCard.textContent.includes("Fay") && aCard.textContent.includes("Approved"), aCard.textContent.slice(0, 300));
const pendingBox = [...aCard.querySelectorAll("input[type=checkbox]")][1]; pendingBox.checked = true;
click(runAbs);
await wait(() => aCard.textContent.includes("3 requests"), "with pending");
check("reports: ticking Waiting adds the pending request", aCard.textContent.includes("Waiting"));
click([...aCard.querySelectorAll("button")].find((x) => x.textContent === "Download CSV"));
const csv2 = await blobText(blobs[blobs.length - 1]);
check("reports: absence CSV has all three rows", csv2.split("\r\n").length === 4 && csv2.includes("Eve"), csv2);

// ---- audit log (add enough activity for a second page)
for (let i = 0; i < 45; i++) await api("setup.add_override", { holiday_date: add("2026-11-01", i), name: "Test day " + i, is_working_day: false }, { "x-session": O });
nav(w, "Audit log");
await wait(() => view(w).includes("employee.created") || view(w).includes("holiday_override.saved"), "audit rows");
check("audit: shows entries with who and what", view(w).includes("holiday_override.saved") && view(w).includes("Owner"), view(w).slice(0, 300));
const total = Number(/of (\d+)/.exec(view(w))?.[1] ?? 0);
check("audit: reports the total and starts on the first page", /1 to 50 of \d+/.test(view(w)) && total > 50, view(w).slice(-200));
check("audit: Newer is disabled on the first page and Older is available", btn(w, "Newer").disabled && !btn(w, "Older").disabled);
click(btn(w, "Older"));
await wait(() => /51 to \d+ of/.test(view(w)), "page 2");
check("audit: the next page loads", !btn(w, "Newer").disabled);
click(btn(w, "Newer"));
await wait(() => /1 to 50 of/.test(view(w)), "back to page 1");
setVal(w.document.querySelector("#view select"), "leave.request.");
click(btn(w, "Show"));
await wait(() => !view(w).includes("holiday_override.saved") && view(w).includes("leave.request."), "filtered audit");
check("audit: filtering by leave requests shows only those", view(w).includes("leave.request.approved") || view(w).includes("leave.request.submitted"));
click([...w.document.querySelectorAll("#view button")].find((x) => x.textContent.startsWith("Download these rows")));
const csv3 = await blobText(blobs[blobs.length - 1]);
check("audit: CSV of the shown rows", csv3.split("\r\n")[0] === "when,who,action,record_type,record_id,details" && csv3.includes("leave.request."));
check("no script errors", w.__errors.length === 0, w.__errors.join("|"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
