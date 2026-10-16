import { JSDOM } from "jsdom";
import fs from "fs";
const FN = "https://wviakiswsrkxhjkgmnbw.supabase.co/functions/v1/cbs-hol";
let pass = 0, fail = 0;
const check = (n, c, x = "") => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  -> " + String(x).slice(0, 400)}`); };
const api = async (action, body = {}, h = {}) => (await (await fetch("http://localhost:8000", { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify({ action, ...body }) })).json());
async function open(page, query) {
  const html = fs.readFileSync(`${process.env.APP_DIR ?? "/mnt/user-data/outputs/employee-management"}/site/${page}/index.html`, "utf8").replace(FN, "http://localhost:8000");
  const dom = new JSDOM(html, { url: `http://localhost/${page}/${query}`, runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(w) { w.fetch = fetch; w.confirm = () => true; w.prompt = () => "2026-11-30"; w.URL.createObjectURL = () => "blob:x"; } });
  const errors = []; dom.window.addEventListener("error", (e) => errors.push(e.message)); dom.window.__errors = errors; return dom.window;
}
const wait = async (fn, label, ms = 8000) => { const t = Date.now(); for (;;) { try { const r = fn(); if (r) return r; } catch {} if (Date.now() - t > ms) throw new Error("timeout waiting for: " + label); await new Promise((r) => setTimeout(r, 50)); } };
const $ = (w, s) => w.document.querySelector(s);
const view = (w) => $(w, "#view")?.textContent ?? "";
const toastTxt = (w) => $(w, "#toast")?.textContent ?? "";
const click = (el) => el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent("click", { bubbles: true }));
const setVal = (el, v, ev = "change") => { el.value = v; el.dispatchEvent(new el.ownerDocument.defaultView.Event(ev, { bubbles: true })); };
const nav = (w, label) => click([...w.document.querySelectorAll("#nav button")].find((b) => b.textContent.startsWith(label)));
const btn = (w, t, root) => [...(root || w.document).querySelectorAll("button")].find((b) => b.textContent.trim() === t);
const byPh = (w, ph, root) => [...(root || w.document).querySelectorAll("input,textarea")].find((i) => i.placeholder === ph);
const submit = (w, form) => form.dispatchEvent(new w.Event("submit", { cancelable: true, bubbles: true }));
const cardOf = (w, title) => [...w.document.querySelectorAll("#view section.card")].find((c) => c.querySelector("h2")?.textContent === title);

const b = (await api("admin.create_business", { name: "Ui Five" }, { "x-admin-key": "test-admin-key" })).data;
const w = await open("business", "?b=ui-five");
setVal($(w, "#pin"), b.owner_pin, "input"); submit(w, $(w, "#loginForm"));
await wait(() => !$(w, "#app").classList.contains("hidden"), "app");

// ---- setup
nav(w, "Setup");
await wait(() => view(w).includes("Standard annual leave (version 1)"), "setup loaded");
check("setup: shows the seeded year, policy, schedule and types", view(w).includes("28 days") && view(w).includes("Standard Mon-Fri") && view(w).includes("Annual leave") && view(w).includes("Mon 7.5, Tue 7.5"), view(w).slice(0, 300));
let c = cardOf(w, "Leave years");
let f = c.querySelector("form"); const ins = f.querySelectorAll("input");
setVal(ins[0], "2027"); setVal(ins[1], "2027-01-01"); setVal(ins[2], "2027-12-31"); submit(w, f);
await wait(() => view(w).includes("2027: 01/01/2027 to 31/12/2027"), "year added");
check("setup: a leave year can be added", true);
f = cardOf(w, "Leave years").querySelector("form"); const bad = f.querySelectorAll("input");
setVal(bad[0], "dup"); setVal(bad[1], "2027-06-01"); setVal(bad[2], "2028-05-31"); submit(w, f);
await wait(() => toastTxt(w).includes("overlaps"), "overlap message");
check("setup: an overlapping year is explained", true);

// edit policy
c = cardOf(w, "Leave policies"); click(btn(w, "Edit", c));
await wait(() => c.querySelector("h3")?.textContent.startsWith("Edit"), "policy form");
const pf = [...c.querySelectorAll("form")].find((x) => x.querySelector("h3")?.textContent.startsWith("Edit"));
setVal(pf.querySelectorAll("input")[1], "25"); submit(w, pf);
await wait(() => view(w).includes("version 2") && view(w).includes("25 days"), "policy v2");
check("setup: editing a policy makes version 2 with 25 days", true);

// new schedule
c = cardOf(w, "Work schedules"); click(btn(w, "New schedule", c));
const sf = [...c.querySelectorAll("form")].find((x) => x.querySelector("h3")?.textContent === "New schedule");
const si = sf.querySelectorAll("input"); setVal(si[0], "Mon-Wed"); setVal(si[4], "0"); setVal(si[5], "0"); submit(w, sf);
await wait(() => view(w).includes("Mon-Wed") && view(w).includes("Mon 7.5, Tue 7.5, Wed 7.5 - 0 employees"), "schedule listed");
check("setup: a new schedule is created and described", true);

// holiday override
c = cardOf(w, "Bank holiday changes"); f = c.querySelector("form"); const hi = f.querySelectorAll("input");
setVal(hi[0], "2026-08-31"); setVal(hi[1], "Summer shutdown"); submit(w, f);
await wait(() => view(w).includes("31/08/2026 - Summer shutdown"), "override listed");
check("setup: a shutdown day is added", view(w).includes("Closed day"));
click(btn(w, "Remove", cardOf(w, "Bank holiday changes")));
await wait(() => !view(w).includes("Summer shutdown"), "override removed");
check("setup: and can be removed", true);

// new leave type
c = cardOf(w, "Types of leave"); click(btn(w, "New type of leave", c));
const tf = [...c.querySelectorAll("form")].find((x) => x.querySelector("h3")?.textContent === "New type of leave");
const ti = tf.querySelectorAll("input"); setVal(ti[0], "study"); setVal(ti[1], "Study leave"); submit(w, tf);
await wait(() => view(w).includes("Study leave"), "type listed");
check("setup: a new type of leave is created", true);

// ---- people: import
nav(w, "People");
await wait(() => view(w).includes("Import from a spreadsheet"), "people loaded");
const csv = "employee_number,full_name,email,role,department,manager_employee_number,employment_start\nN1,\"Lead, Nina\",nina@example.com,manager,Ops,,2026-02-01\nN2,Noel,,employee,Ops,N1,2026-02-01\n";
const fileInput = $(w, "input[type=file]");
const pickFile = (text) => { Object.defineProperty(fileInput, "files", { value: [new w.File([text], "x.csv")], configurable: true }); fileInput.dispatchEvent(new w.Event("change", { bubbles: true })); };
pickFile("employee_number,full_name,employment_start\nN9,,notadate\n");
await wait(() => view(w).includes("problem"), "bad import reported");
check("import: a bad file lists the problems and creates nothing", view(w).includes("Row 2") && view(w).includes("Nothing was imported"), view(w).slice(-300));
pickFile(csv);
await wait(() => btn(w, "Import 2 people"), "import button");
check("import: a good file validates (quoted comma in a name handled)", view(w).includes("All 2 rows look good"));
click(btn(w, "Import 2 people"));
await wait(() => view(w).includes("2 people created"), "import done");
check("import: people created and PINs offered once", !!btn(w, "Download PINs (CSV)") && view(w).includes("shown once"));
await wait(() => view(w).includes("Lead, Nina"), "list refreshed");
check("import: the manager link was set", [...w.document.querySelectorAll("tbody tr")].some((r) => r.textContent.includes("Noel") && r.textContent.includes("N1")), view(w).slice(-400));

// ---- people: edit and leaver
const rowOf = (name) => [...w.document.querySelectorAll("tbody tr")].find((r) => r.textContent.includes(name));
click(btn(w, "Edit", rowOf("Noel")));
await wait(() => view(w).includes("Edit Noel"), "edit form");
const ef = [...w.document.querySelectorAll("#view form")].find((x) => x.querySelector("h2")?.textContent.startsWith("Edit"));
setVal(ef.querySelectorAll("input")[0], "Noel Renamed"); submit(w, ef);
await wait(() => view(w).includes("Noel Renamed"), "renamed");
check("people: editing an employee works", true);
click(btn(w, "Left", rowOf("Noel Renamed")));
await wait(() => rowOf("Noel Renamed")?.textContent.includes("Left 30/11/2026"), "marked as left");
check("people: marking someone as left shows the date and removes their actions", !btn(w, "Reset PIN", rowOf("Noel Renamed")));

// ---- allocation and balances
nav(w, "Setup");
await wait(() => btn(w, "Allocate leave"), "allocate button");
click(btn(w, "Allocate leave"));
await wait(() => view(w).includes("allocated,"), "allocation result");
check("setup: yearly allocation runs from the screen", /\d+ allocated/.test(view(w)), view(w).slice(-200));
nav(w, "Balances");
const lookup = [...w.document.querySelectorAll("#view form")][0];
setVal(byPh(w, "Employee number", lookup), "N1", "input"); submit(w, lookup);
await wait(() => view(w).includes("Adjust a balance"), "balance shown");
check("balances: shows the allocation", view(w).includes("Annual leave 2026"), view(w).slice(0, 300));
const adj = [...w.document.querySelectorAll("#view form")][1]; const ai = adj.querySelectorAll("input");
setVal(ai[2], "2"); submit(w, adj);
await wait(() => toastTxt(w).includes("enter the days and a reason") || toastTxt(w).includes("Enter the days"), "needs a reason");
check("balances: an adjustment without a reason is refused", true);
setVal(ai[3], "Bonus day"); submit(w, adj);
await wait(() => toastTxt(w).includes("Adjustment posted"), "posted");
check("balances: adjustment posted", true);
const before = view(w);
await wait(() => /available/.test(view(w)), "refreshed");

check("no script errors", w.__errors.length === 0, w.__errors.join("|"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
