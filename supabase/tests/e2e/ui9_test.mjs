import { JSDOM } from "jsdom";
import fs from "fs";
const FN = "https://wviakiswsrkxhjkgmnbw.supabase.co/functions/v1/cbs-hol";
let pass = 0, fail = 0;
const check = (n, c, x = "") => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  -> " + String(x).slice(0, 400)}`); };
const api = async (action, body = {}, h = {}) => (await (await fetch("http://localhost:8000", { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify({ action, ...body }) })).json());
const blobs = []; const confirms = [];
async function open(page, query) {
  const html = fs.readFileSync(`${process.env.APP_DIR ?? "/mnt/user-data/outputs/employee-management"}/site/${page}/index.html`, "utf8").replace(FN, "http://localhost:8000");
  const dom = new JSDOM(html, { url: `http://localhost/${page}/${query}`, runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(w) { w.fetch = fetch; w.confirm = (m) => { confirms.push(m); return true; }; w.prompt = () => "2026-09-30"; w.URL.createObjectURL = (b) => { blobs.push({ b, w }); return "blob:x"; }; } });
  const errors = []; dom.window.addEventListener("error", (e) => errors.push(e.message)); dom.window.__errors = errors;
  dom.window.HTMLAnchorElement.prototype.click = function () {}; return dom.window;
}
const wait = async (fn, label, ms = 8000) => { const t = Date.now(); for (;;) { try { const r = fn(); if (r) return r; } catch {} if (Date.now() - t > ms) throw new Error("timeout waiting for: " + label); await new Promise((r) => setTimeout(r, 50)); } };
const $ = (w, s) => w.document.querySelector(s);
const view = (w) => $(w, "#view")?.textContent ?? "";
const toastTxt = (w) => $(w, "#toast")?.textContent ?? "";
const click = (el) => el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent("click", { bubbles: true }));
const setVal = (el, v, ev = "change") => { el.value = v; el.dispatchEvent(new el.ownerDocument.defaultView.Event(ev, { bubbles: true })); };
const nav = (w, label) => click([...w.document.querySelectorAll("#nav button")].find((b) => b.textContent.startsWith(label)));
const submit = (w, form) => form.dispatchEvent(new w.Event("submit", { cancelable: true, bubbles: true }));
const rowOf = (w, text) => [...w.document.querySelectorAll("tbody tr")].find((r) => r.textContent.includes(text));
const rbtn = (row, t) => [...row.querySelectorAll("button")].find((b) => b.textContent.trim() === t);
const blobText = (item) => new Promise((res) => { const r = new item.w.FileReader(); r.onload = () => res(r.result); r.readAsText(item.b); });

const b = (await api("admin.create_business", { name: "Ui Nine" }, { "x-admin-key": "test-admin-key" })).data;
const O = (await api("business.login", { slug: "ui-nine", pin: b.owner_pin })).data.token;
await api("hr.create_employee", { employee_number: "E1", full_name: "Eve Example", role: "employee", employment_start: "2026-01-01", email: "eve@x.test" }, { "x-session": O });
await api("hr.create_employee", { employee_number: "E2", full_name: "Fay Stays", role: "employee", employment_start: "2026-01-01" }, { "x-session": O });
const w = await open("business", "?b=ui-nine");
setVal($(w, "#pin"), b.owner_pin, "input"); submit(w, $(w, "#loginForm")); await wait(() => !$(w, "#app").classList.contains("hidden"), "app");
nav(w, "People");
await wait(() => rowOf(w, "Eve Example"), "list");

// export
check("people: every row has an export button", !!rbtn(rowOf(w, "Fay Stays"), "Export data") && !rbtn(rowOf(w, "Fay Stays"), "Anonymise"));
click(rbtn(rowOf(w, "Eve Example"), "Export data"));
await wait(() => toastTxt(w) === "Exported", "exported");
const json = JSON.parse(await blobText(blobs[blobs.length - 1]));
check("people: the export downloads the person's data as JSON", json.employee.full_name === "Eve Example" && Array.isArray(json.ledger) && !JSON.stringify(json).includes("pin_hash"), Object.keys(json).join());

// leaver, then anonymise
click(rbtn(rowOf(w, "Eve Example"), "Left"));
await wait(() => rowOf(w, "Eve Example")?.textContent.includes("Left 30/09/2026"), "marked as left");
check("people: a leaver can now be anonymised", !!rbtn(rowOf(w, "Eve Example"), "Anonymise"));
confirms.length = 0;
click(rbtn(rowOf(w, "Eve Example"), "Anonymise"));
await wait(() => toastTxt(w) === "Anonymised", "anonymised");
check("people: anonymising warns that it cannot be undone", confirms.some((m) => /cannot be undone/.test(m) && /Export their data first/.test(m)), confirms.join("|"));
await wait(() => rowOf(w, "Former employee E1"), "renamed");
const row = rowOf(w, "Former employee E1");
check("people: the row shows the anonymised name and status, with no Anonymise button left", row.textContent.includes("Left, anonymised") && !rbtn(row, "Anonymise"));
check("people: nobody called Eve Example remains on screen", !view(w).includes("Eve Example") && !view(w).includes("eve@x.test"));

// retention
nav(w, "Setup");
await wait(() => [...w.document.querySelectorAll("#view section.card")].find((c) => c.querySelector("h2")?.textContent === "Data retention")?.querySelector("input"), "retention card");
const rc = [...w.document.querySelectorAll("#view section.card")].find((c) => c.querySelector("h2")?.textContent === "Data retention");
check("setup: retention starts at 0 (off)", rc.querySelector("input").value === "0");
setVal(rc.querySelector("input"), "7", "input");
click([...rc.querySelectorAll("button")].find((x) => x.textContent === "Save"));
await wait(() => toastTxt(w) === "Saved", "saved");
const ov = await api("setup.overview", {}, { "x-session": O });
check("setup: the retention period is stored", ov.data.business.settings.retention_years === 7);
check("no script errors", w.__errors.length === 0, w.__errors.join("|"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
