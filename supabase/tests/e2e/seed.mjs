const call = async (action, body = {}, h = {}) => (await (await fetch("http://localhost:8000", { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify({ action, ...body }) })).json());
const b = (await call("admin.create_business", { name: "Test Co" }, { "x-admin-key": "test-admin-key" })).data;
const o = (await call("business.login", { slug: "test-co", pin: b.owner_pin })).data.token;
const mk = async (n, name, role, mgr) => (await call("hr.create_employee", { employee_number: n, full_name: name, role, employment_start: "2026-01-01", department: "Ops", manager_employee_number: mgr }, { "x-session": o })).data.pin;
const pins = { M1: await mk("M1", "Mandy Manager", "manager"), E1: await mk("E1", "Eve Employee", "employee", "M1"), E3: await mk("E3", "Ed Colleague", "employee", "M1") };
await call("hr.allocate_year", { year_label: "2026" }, { "x-session": o });
console.log(JSON.stringify({ staff_key: b.staff_key, owner_pin: b.owner_pin, pins }));
