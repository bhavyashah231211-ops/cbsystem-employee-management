// =====================================================================
// CBSystem - Employee Management - Edge Function `cbs-hol`   (Step 1, Part 2 of 2)
// Deploy with Verify JWT OFF. Secrets: ADMIN_KEY (already set).
// Optional secrets: HOL_STAFF_URL (.../staff/) and HOL_BUSINESS_URL (.../business/)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.
//
// Every call is POST JSON: { "action": "...", ... }
//   Platform admin  (header x-admin-key):
//     admin.create_business, admin.list_businesses, admin.set_status,
//     admin.reset_owner_pin, admin.rotate_staff_key, admin.seed_bank_holidays
//   Logins (no session needed), kept separate:
//     staff.login    staff key + employee number + PIN  (employee, manager, hr)
//     business.login owner / HR only, no staff key       (owner, hr)
//   Any session (header x-session): staff.me, staff.logout
//   Staff portal sessions: leave.types, leave.preview, leave.submit, leave.cancel, leave.my_requests, leave.balances
//   Managers, HR, owner (either portal): approvals.inbox, approvals.detail, approvals.decide, approvals.delegate,
//     approvals.delegations, approvals.remove_delegation.  Everyone signed in: staff.change_pin, notifications.list, notifications.mark_read
//   Business portal sessions only (owner, hr): hr.allocate_year, hr.allocate, hr.balances,
//     hr.create_employee, hr.reset_pin, hr.list_employees
// Requests, approvals and balances are added in later steps.
// =====================================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import { parseGovUkBankHolidays } from "./holidays.ts";
import { buildHolidaySet, calculateLeave, CalcError, type CalcResult, type ScheduleAssignment, type WeekPattern } from "./calc.ts";
import { calculateEntitlement, weeklyHoursOf } from "./entitlement.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ADMIN_KEY = Deno.env.get("ADMIN_KEY") ?? "";
const STAFF_BASE_URL = Deno.env.get("HOL_STAFF_URL") ?? "https://YOUR-STAFF-URL/staff/";
const BUSINESS_BASE_URL = Deno.env.get("HOL_BUSINESS_URL") ?? "https://YOUR-BUSINESS-URL/business/";

const SESSION_HOURS = 12;
const MAX_PIN_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const PBKDF2_ITERATIONS = 100_000;

const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Browsers may only call the API from the addresses in HOL_ALLOWED_ORIGINS (comma separated).
// If the secret is not set, any origin is allowed (set it before going live).
const ALLOWED_ORIGINS = (Deno.env.get("HOL_ALLOWED_ORIGINS") ?? "").split(",").map((o) => o.trim().replace(/\/$/, "")).filter(Boolean);
function corsFor(req: Request): Record<string, string> {
  const h: Record<string, string> = {
    "Access-Control-Allow-Headers": "content-type, x-admin-key, x-session, authorization, apikey",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
    "Cache-Control": "no-store",
  };
  const origin = req.headers.get("origin");
  if (ALLOWED_ORIGINS.length === 0) h["Access-Control-Allow-Origin"] = "*";
  else if (origin && ALLOWED_ORIGINS.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

// ---------------------------------------------------------------- helpers
class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const ok = (data: unknown = {}) => reply(200, { ok: true, data });

const enc = new TextEncoder();
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function pbkdf2(secret: string, salt: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return new Uint8Array(bits);
}

async function hashSecret(secret: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2(secret, salt);
  return `v1$${b64(salt)}$${b64(bits)}`;
}

async function verifySecret(secret: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const bits = await pbkdf2(secret, unb64(parts[1]));
  return safeEqual(bits, unb64(parts[2]));
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const STAFF_KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 chars, no 0/O/1/I

function makeStaffKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const chars = [...bytes].map((x) => STAFF_KEY_ALPHABET[x & 31]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}
const normaliseStaffKey = (k: string) => k.toUpperCase().replace(/[^A-Z0-9]/g, "");

function makePin(len = 6): string {
  let out = "";
  while (out.length < len) {
    const [b] = crypto.getRandomValues(new Uint8Array(1));
    if (b < 250) out += String(b % 10); // rejection sampling, no modulo bias
  }
  return out;
}

function makeToken(): string {
  return b64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, (c) =>
    c === "+" ? "-" : c === "/" ? "_" : ""
  );
}

function clean(v: unknown, max: number, field = "value"): string {
  const s = String(v ?? "").trim();
  if (!s) throw new HttpError(400, "VALIDATION", `${field} is required`);
  if (s.length > max) throw new HttpError(400, "VALIDATION", `${field} is too long`);
  return s;
}

function cleanId(v: unknown, field: string): string {
  const s = clean(v, 20, field).toUpperCase();
  if (!/^[A-Z0-9_-]+$/.test(s)) throw new HttpError(400, "VALIDATION", `${field} may only use letters, numbers, - and _`);
  return s;
}

function isDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "business";

const today = () => new Date().toISOString().slice(0, 10);

function must<T>(res: { data: T | null; error: { message: string; code?: string } | null }, what: string): T {
  if (res.error) {
    console.error(what, res.error);
    throw new HttpError(500, "DB_ERROR", `Database error while ${what}`);
  }
  return res.data as T;
}

async function audit(
  businessId: string,
  actorId: string | null,
  actorLabel: string | null,
  action: string,
  entityType: string,
  entityId: string | null,
  changes: Record<string, unknown> = {},
) {
  const { error } = await db.from("hol_audit_log").insert({
    business_id: businessId,
    actor_id: actorId,
    actor_label: actorLabel,
    action,
    entity_type: entityType,
    entity_id: entityId,
    changes,
  });
  if (error) console.error("audit failed", error);
}

// ---------------------------------------------------------------- admin
function requireAdmin(req: Request) {
  if (!ADMIN_KEY) throw new HttpError(500, "NOT_CONFIGURED", "ADMIN_KEY secret is not set");
  const given = req.headers.get("x-admin-key") ?? "";
  if (!safeEqual(enc.encode(given), enc.encode(ADMIN_KEY))) {
    throw new HttpError(401, "UNAUTHORISED", "Invalid admin key");
  }
}

async function findBusiness(b: any) {
  const slug = clean(b.slug, 60, "slug");
  const biz = must(
    await db.from("hol_businesses").select("*").eq("slug", slug).maybeSingle(),
    "loading business",
  );
  if (!biz) throw new HttpError(404, "NOT_FOUND", "Business not found");
  return biz as any;
}

function readyMessage(name: string, slug: string, staffKey: string, ownerPin: string) {
  const withSlug = (base: string) => `${base}${base.includes("?") ? "&" : "?"}b=${encodeURIComponent(slug)}`;
  return [
    `Hello, your CBSystem - Employee Management account for ${name} is ready.`,
    ``,
    `BUSINESS LOGIN (owner and HR)`,
    `Link: ${withSlug(BUSINESS_BASE_URL)}`,
    `Employee number: OWNER`,
    `PIN: ${ownerPin}`,
    ``,
    `STAFF LOGIN (give this to your employees)`,
    `Link: ${withSlug(STAFF_BASE_URL)}`,
    `Staff key: ${staffKey}`,
    `Each employee also needs their own employee number and personal PIN, which you create in the business portal.`,
    ``,
    `Please keep the PIN and staff key safe.`,
  ].join("\n");
}

async function adminCreateBusiness(b: any) {
  const name = clean(b.name, 80, "name");
  const region = b.region ? String(b.region) : "ENG-WLS";
  if (!["ENG-WLS", "SCT", "NIR"].includes(region)) throw new HttpError(400, "VALIDATION", "Invalid region");

  const staffKey = makeStaffKey();
  const ownerPin = makePin(6);
  const staffKeyHash = await hashSecret(normaliseStaffKey(staffKey));
  const ownerPinHash = await hashSecret(ownerPin);

  let biz: any = null;
  const base = b.slug ? slugify(String(b.slug)) : slugify(name);
  for (let attempt = 0; attempt < 5 && !biz; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${makePin(4)}`;
    const res = await db.from("hol_businesses").insert({
      slug, name, region,
      staff_key_hash: staffKeyHash,
      owner_pin_hash: ownerPinHash,
    }).select("*").single();
    if (res.error) {
      if (res.error.code === "23505") continue; // slug taken, retry with suffix
      console.error("create business", res.error);
      throw new HttpError(500, "DB_ERROR", "Could not create business");
    }
    biz = res.data;
  }
  if (!biz) throw new HttpError(409, "SLUG_TAKEN", "Could not find a free business slug");

  try {
    must(await db.rpc("hol_seed_business", { p_business: biz.id }), "seeding defaults");
    must(
      await db.from("hol_employees").insert({
        business_id: biz.id,
        employee_number: "OWNER",
        full_name: "Owner",
        role: "owner",
        employment_start: today(),
        pin_hash: ownerPinHash,
      }).select("id").single(),
      "creating owner",
    );
  } catch (e) {
    // Do not leave a half-built tenant usable
    await db.from("hol_businesses").update({ status: "closed" }).eq("id", biz.id);
    throw e;
  }

  await audit(biz.id, null, "admin-console", "business.created", "business", biz.id, { name, region });

  return ok({
    business: { id: biz.id, slug: biz.slug, name: biz.name, region: biz.region },
    staff_key: staffKey,   // shown once
    owner_pin: ownerPin,   // shown once
    message: readyMessage(name, biz.slug, staffKey, ownerPin),
  });
}

async function adminListBusinesses() {
  const rows = must(
    await db.from("hol_businesses")
      .select("id,slug,name,status,plan,region,created_at")
      .order("created_at", { ascending: false }),
    "listing businesses",
  );
  return ok({ businesses: rows });
}

async function adminSetStatus(b: any) {
  const biz = await findBusiness(b);
  const status = String(b.status ?? "");
  if (!["active", "suspended", "closed"].includes(status)) throw new HttpError(400, "VALIDATION", "Invalid status");
  must(await db.from("hol_businesses").update({ status }).eq("id", biz.id), "updating status");
  if (status !== "active") {
    must(await db.from("hol_sessions").delete().eq("business_id", biz.id), "ending sessions");
  }
  await audit(biz.id, null, "admin-console", "business.status_changed", "business", biz.id, { from: biz.status, to: status });
  return ok({ slug: biz.slug, status });
}

async function adminResetOwnerPin(b: any) {
  const biz = await findBusiness(b);
  const pin = makePin(6);
  const hash = await hashSecret(pin);
  must(await db.from("hol_businesses").update({ owner_pin_hash: hash }).eq("id", biz.id), "updating owner pin");
  must(
    await db.from("hol_employees")
      .update({ pin_hash: hash, pin_attempts: 0, locked_until: null })
      .eq("business_id", biz.id).eq("employee_number", "OWNER"),
    "updating owner employee",
  );
  must(await db.from("hol_sessions").delete().eq("business_id", biz.id), "ending sessions");
  await audit(biz.id, null, "admin-console", "owner.pin_reset", "business", biz.id);
  return ok({ slug: biz.slug, owner_pin: pin }); // shown once
}

async function adminRotateStaffKey(b: any) {
  const biz = await findBusiness(b);
  const key = makeStaffKey();
  const hash = await hashSecret(normaliseStaffKey(key));
  must(await db.from("hol_businesses").update({ staff_key_hash: hash }).eq("id", biz.id), "updating staff key");
  await audit(biz.id, null, "admin-console", "staff_key.rotated", "business", biz.id);
  return ok({
    slug: biz.slug,
    staff_key: key, // shown once
    message: `Your CBSystem - Employee Management staff key has changed.\nNew staff key: ${key}\nPlease share it with your staff.`,
  });
}

async function adminSeedBankHolidays() {
  const res = await fetch("https://www.gov.uk/bank-holidays.json", { headers: { Accept: "application/json" } });
  if (!res.ok) throw new HttpError(502, "FEED_UNAVAILABLE", `The GOV.UK feed returned status ${res.status}`);
  let rows;
  try {
    rows = parseGovUkBankHolidays(await res.json());
  } catch (e) {
    throw new HttpError(502, "FEED_INVALID", (e as Error).message);
  }
  for (let i = 0; i < rows.length; i += 500) {
    must(
      await db.from("hol_bank_holidays").upsert(rows.slice(i, i + 500), { onConflict: "calendar_code,holiday_date" }),
      "saving bank holidays",
    );
  }
  const dates = rows.map((r) => r.holiday_date).sort();
  return ok({ count: rows.length, from: dates[0], to: dates[dates.length - 1] });
}

async function adminRoute(action: string, b: any, req: Request) {
  requireAdmin(req);
  switch (action) {
    case "admin.create_business": return await adminCreateBusiness(b);
    case "admin.list_businesses": return await adminListBusinesses();
    case "admin.run_jobs": return await adminRunJobs(b);
    case "admin.reconcile": return await adminReconcile(b);
    case "admin.seed_bank_holidays": return await adminSeedBankHolidays();
    case "admin.set_status": return await adminSetStatus(b);
    case "admin.reset_owner_pin": return await adminResetOwnerPin(b);
    case "admin.rotate_staff_key": return await adminRotateStaffKey(b);
  }
  throw new HttpError(404, "UNKNOWN_ACTION", `Unknown action ${action}`);
}

// ---------------------------------------------------------------- staff auth
const GENERIC_LOGIN_ERROR = new HttpError(401, "INVALID_LOGIN", "Invalid sign-in details");

function publicEmployee(e: any) {
  return {
    id: e.id,
    employee_number: e.employee_number,
    full_name: e.full_name,
    role: e.role,
  };
}

async function login(b: any, portal: "staff" | "business") {
  const slug = String(b.slug ?? "").trim();
  const staffKey = normaliseStaffKey(String(b.staff_key ?? ""));
  const number = (String(b.employee_number ?? "").trim() || (portal === "business" ? "OWNER" : "")).toUpperCase();
  const pin = String(b.pin ?? "");
  if (!slug || !number || !pin || (portal === "staff" && !staffKey)) throw GENERIC_LOGIN_ERROR;

  const biz: any = must(
    await db.from("hol_businesses").select("*").eq("slug", slug).maybeSingle(),
    "loading business",
  );
  if (!biz || biz.status !== "active") throw GENERIC_LOGIN_ERROR;
  if (portal === "staff" && !(await verifySecret(staffKey, biz.staff_key_hash))) throw GENERIC_LOGIN_ERROR;

  const emp: any = must(
    await db.from("hol_employees").select("*")
      .eq("business_id", biz.id).eq("employee_number", number).maybeSingle(),
    "loading employee",
  );
  if (!emp || emp.status !== "active" || !emp.pin_hash) throw GENERIC_LOGIN_ERROR;
  // The OWNER account is the business login only; HR people are also employees, so they may use both.
  const allowed = portal === "business" ? ["owner", "hr"] : ["employee", "manager", "hr"];
  if (!allowed.includes(emp.role)) throw GENERIC_LOGIN_ERROR;

  if (emp.locked_until && new Date(emp.locked_until) > new Date()) {
    throw new HttpError(429, "LOCKED", "Too many attempts. Please try again later.");
  }

  if (!(await verifySecret(pin, emp.pin_hash))) {
    const attempts = emp.pin_attempts + 1;
    const patch: Record<string, unknown> = { pin_attempts: attempts };
    if (attempts >= MAX_PIN_ATTEMPTS) {
      patch.pin_attempts = 0;
      patch.locked_until = new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString();
    }
    await db.from("hol_employees").update(patch).eq("id", emp.id);
    throw GENERIC_LOGIN_ERROR;
  }

  if (emp.pin_attempts !== 0 || emp.locked_until) {
    await db.from("hol_employees").update({ pin_attempts: 0, locked_until: null }).eq("id", emp.id);
  }

  const token = makeToken();
  const expires = new Date(Date.now() + SESSION_HOURS * 3_600_000).toISOString();
  must(
    await db.from("hol_sessions").insert({
      business_id: biz.id,
      employee_id: emp.id,
      portal,
      token_hash: await sha256Hex(token),
      expires_at: expires,
    }),
    "creating session",
  );
  await db.from("hol_sessions").delete().lt("expires_at", new Date().toISOString()); // tidy expired

  await audit(biz.id, emp.id, null, "session.login", "employee", emp.id, { portal });

  return ok({
    token,
    portal,
    expires_at: expires,
    employee: publicEmployee(emp),
    business: { name: biz.name, slug: biz.slug, region: biz.region, timezone: biz.timezone },
  });
}

interface Ctx {
  sessionId: string;
  portal: "staff" | "business";
  business: any;
  employee: any;
}

async function authenticate(req: Request): Promise<Ctx> {
  const token = req.headers.get("x-session") ?? "";
  if (!token) throw new HttpError(401, "NO_SESSION", "Please sign in");
  const sess: any = must(
    await db.from("hol_sessions").select("id,business_id,employee_id,portal,expires_at")
      .eq("token_hash", await sha256Hex(token)).maybeSingle(),
    "loading session",
  );
  if (!sess || new Date(sess.expires_at) <= new Date()) {
    throw new HttpError(401, "SESSION_EXPIRED", "Your session has expired. Please sign in again.");
  }
  const [bizRes, empRes] = await Promise.all([
    db.from("hol_businesses").select("*").eq("id", sess.business_id).maybeSingle(),
    db.from("hol_employees").select("*").eq("business_id", sess.business_id).eq("id", sess.employee_id).maybeSingle(),
  ]);
  const business: any = must(bizRes, "loading business");
  const employee: any = must(empRes, "loading employee");
  if (!business || business.status !== "active") throw new HttpError(403, "SUSPENDED", "This account is not active");
  if (!employee || employee.status !== "active") throw new HttpError(403, "INACTIVE", "This employee is not active");
  return { sessionId: sess.id, portal: sess.portal, business, employee };
}

function requireRole(ctx: Ctx, roles: string[]) {
  if (!roles.includes(ctx.employee.role)) {
    throw new HttpError(403, "FORBIDDEN", "You do not have permission to do this");
  }
}

function requireBusiness(ctx: Ctx) {
  if (ctx.portal !== "business") throw new HttpError(403, "FORBIDDEN", "Please use the business login");
  requireRole(ctx, ["hr", "owner"]);
}

// ---------------------------------------------------------------- staff actions
function staffMe(ctx: Ctx) {
  return ok({
    portal: ctx.portal,
    employee: publicEmployee(ctx.employee),
    business: { name: ctx.business.name, slug: ctx.business.slug, region: ctx.business.region, timezone: ctx.business.timezone },
  });
}

async function staffLogout(ctx: Ctx) {
  must(await db.from("hol_sessions").delete().eq("id", ctx.sessionId), "ending session");
  return ok();
}

// ---------------------------------------------------------------- HR actions
async function hrCreateEmployee(ctx: Ctx, b: any) {
  requireBusiness(ctx);
  const bid = ctx.business.id;

  const number = cleanId(b.employee_number, "employee_number");
  if (number === "OWNER") throw new HttpError(400, "VALIDATION", "OWNER is reserved");
  const fullName = clean(b.full_name, 100, "full_name");
  const email = b.email ? clean(b.email, 200, "email") : null;
  const role = String(b.role ?? "employee");
  if (!["employee", "manager", "hr"].includes(role)) throw new HttpError(400, "VALIDATION", "Invalid role");
  if (role === "hr" && ctx.employee.role !== "owner") {
    throw new HttpError(403, "FORBIDDEN", "Only the owner can create HR users");
  }
  if (!isDate(b.employment_start)) throw new HttpError(400, "VALIDATION", "employment_start must be YYYY-MM-DD");

  let departmentId: string | null = null;
  if (b.department) {
    const dep: any = must(
      await db.from("hol_departments")
        .upsert({ business_id: bid, name: clean(b.department, 80, "department") }, { onConflict: "business_id,name" })
        .select("id").single(),
      "saving department",
    );
    departmentId = dep.id;
  }

  let managerId: string | null = null;
  if (b.manager_employee_number) {
    const mgr: any = must(
      await db.from("hol_employees").select("id")
        .eq("business_id", bid).eq("employee_number", cleanId(b.manager_employee_number, "manager_employee_number")).maybeSingle(),
      "finding manager",
    );
    if (!mgr) throw new HttpError(404, "MANAGER_NOT_FOUND", "Manager not found");
    managerId = mgr.id;
  }

  const pin = makePin(6);
  const ins = await db.from("hol_employees").insert({
    business_id: bid,
    employee_number: number,
    full_name: fullName,
    email,
    role,
    department_id: departmentId,
    manager_id: managerId,
    employment_start: b.employment_start,
    pin_hash: await hashSecret(pin),
  }).select("*").single();
  if (ins.error) {
    if (ins.error.code === "23505") throw new HttpError(409, "EMPLOYEE_EXISTS", "That employee number already exists");
    console.error("create employee", ins.error);
    throw new HttpError(500, "DB_ERROR", "Could not create employee");
  }
  const emp: any = ins.data;

  // Default schedule and active policy so the employee is ready for leave requests
  const sched: any = must(
    await db.from("hol_work_schedules").select("id")
      .eq("business_id", bid).eq("name", "Standard Mon-Fri").maybeSingle(),
    "finding schedule",
  );
  if (sched) {
    await db.from("hol_schedule_assignments").insert({
      business_id: bid, employee_id: emp.id, schedule_id: sched.id, effective_from: b.employment_start,
    });
  }
  const pol: any = must(
    await db.from("hol_policies").select("id")
      .eq("business_id", bid).eq("status", "active")
      .order("version", { ascending: false }).limit(1).maybeSingle(),
    "finding policy",
  );
  if (pol) {
    await db.from("hol_policy_assignments").insert({
      business_id: bid, employee_id: emp.id, policy_id: pol.id, effective_from: b.employment_start,
    });
  }

  await audit(bid, ctx.employee.id, null, "employee.created", "employee", emp.id, { employee_number: number, role });
  return ok({ employee: publicEmployee(emp), pin }); // PIN shown once
}

async function hrResetPin(ctx: Ctx, b: any) {
  requireBusiness(ctx);
  const bid = ctx.business.id;
  const number = cleanId(b.employee_number, "employee_number");
  const emp: any = must(
    await db.from("hol_employees").select("id,role")
      .eq("business_id", bid).eq("employee_number", number).maybeSingle(),
    "finding employee",
  );
  if (!emp) throw new HttpError(404, "NOT_FOUND", "Employee not found");
  if ((emp.role === "owner" || emp.role === "hr") && ctx.employee.role !== "owner") {
    throw new HttpError(403, "FORBIDDEN", "Only the owner can reset this PIN");
  }
  const pin = makePin(6);
  must(
    await db.from("hol_employees")
      .update({ pin_hash: await hashSecret(pin), pin_attempts: 0, locked_until: null })
      .eq("business_id", bid).eq("id", emp.id),
    "resetting pin",
  );
  must(await db.from("hol_sessions").delete().eq("business_id", bid).eq("employee_id", emp.id), "ending sessions");
  await audit(bid, ctx.employee.id, null, "employee.pin_reset", "employee", emp.id);
  return ok({ employee_number: number, pin }); // shown once
}

async function hrListEmployees(ctx: Ctx) {
  requireBusiness(ctx);
  const rows = await fetchAll<any>((a, z) => db.from("hol_employees")
    .select("id,employee_number,full_name,email,role,status,employment_start,employment_end,department_id,manager_id,anonymised_at")
    .eq("business_id", ctx.business.id)
    .order("employee_number").range(a, z), "listing employees");
  const departments = must(
    await db.from("hol_departments").select("id,name")
      .eq("business_id", ctx.business.id).order("name"),
    "listing departments",
  );
  return ok({ employees: rows, departments });
}

// ---------------------------------------------------------------- paging helper
// PostgREST returns at most 1000 rows per request, so larger lists are fetched in pages.
async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  what: string,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const rows = must(await build(from, from + 999) as any, what) as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

function requireStaff(ctx: Ctx) {
  if (ctx.portal !== "staff" || ctx.employee.role === "owner") {
    throw new HttpError(403, "FORBIDDEN", "Please use the staff login");
  }
}

function toPattern(p: any): WeekPattern {
  const out: any = {};
  for (const k of ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]) {
    const v = Number(p?.[k]);
    if (!Number.isFinite(v) || v < 0 || v > 24) {
      throw new HttpError(500, "BAD_SCHEDULE", "A work schedule is invalid. Please contact HR.");
    }
    out[k] = v;
  }
  return out as WeekPattern;
}

function mapRpcError(err: { code?: string; message?: string }): never {
  const msg = String(err.message ?? "");
  if (err.code === "23P01") throw new HttpError(409, "OVERLAP", "You already have a request covering some of these dates");
  if (msg.startsWith("INSUFFICIENT_BALANCE")) {
    const [, avail, need] = msg.split("|");
    throw new HttpError(409, "INSUFFICIENT_BALANCE", `Not enough leave remaining (${avail} available, ${need} requested)`);
  }
  if (msg.startsWith("NOT_CANCELLABLE")) throw new HttpError(409, "NOT_CANCELLABLE", "This request can no longer be cancelled here");
  if (msg.startsWith("NO_APPROVER")) throw new HttpError(409, "NO_APPROVER", "No approver is available. Please contact HR.");
  if (msg.startsWith("NO_LEAVE_YEAR")) throw new HttpError(409, "NO_LEAVE_YEAR", "That leave year is not set up");
  if (msg.startsWith("STALE")) throw new HttpError(409, "STALE", "This request has changed. Please refresh and try again.");
  if (msg.startsWith("FORBIDDEN")) throw new HttpError(403, "FORBIDDEN", "You are not allowed to decide this request");
  if (msg.startsWith("SELF_APPROVAL")) throw new HttpError(403, "SELF_APPROVAL", "You cannot decide your own request");
  if (msg.startsWith("INVALID_DECISION")) throw new HttpError(400, "INVALID_DECISION", "That decision is not valid for this request");
  if (msg.startsWith("NOT_LEFT")) throw new HttpError(409, "NOT_LEFT", "Only people who have left can be anonymised");
  if (msg.startsWith("ALREADY_DONE")) throw new HttpError(409, "ALREADY_DONE", "This person has already been anonymised");
  if (msg.startsWith("EMPLOYEE_INACTIVE")) throw new HttpError(409, "EMPLOYEE_INACTIVE", "This employee is no longer active");
  if (msg.startsWith("NOT_FOUND")) throw new HttpError(404, "NOT_FOUND", "Request not found");
  console.error("rpc error", err);
  throw new HttpError(500, "DB_ERROR", "Database error");
}

// Gathers everything the calculator needs for one employee and one date range.
async function loadLeaveContext(ctx: Ctx, b: any) {
  const bid = ctx.business.id;
  const emp = ctx.employee;
  const startDate = b.start_date;
  const endDate = b.end_date;
  if (!isDate(startDate) || !isDate(endDate)) {
    throw new HttpError(400, "VALIDATION", "start_date and end_date must be YYYY-MM-DD");
  }

  let q: any = db.from("hol_leave_types").select("*").eq("business_id", bid).eq("active", true);
  q = b.leave_type_id ? q.eq("id", String(b.leave_type_id)) : q.eq("code", String(b.leave_type_code ?? "annual"));
  const leaveType: any = must(await q.maybeSingle(), "loading leave type");
  if (!leaveType) throw new HttpError(404, "LEAVE_TYPE_NOT_FOUND", "Leave type not found");
  if (leaveType.is_sickness) {
    throw new HttpError(400, "SICKNESS_NOT_HERE", "Sickness is reported through absence recording, not a leave request");
  }

  const assigns: any[] = must(
    await db.from("hol_schedule_assignments").select("schedule_id,effective_from,effective_to")
      .eq("business_id", bid).eq("employee_id", emp.id),
    "loading work schedule",
  );
  const schedIds = [...new Set(assigns.map((a) => a.schedule_id))];
  const scheds: any[] = schedIds.length
    ? must(await db.from("hol_work_schedules").select("id,week_pattern").eq("business_id", bid).in("id", schedIds), "loading work schedule")
    : [];
  const patterns = new Map(scheds.map((s) => [s.id, s.week_pattern]));
  const schedules: ScheduleAssignment[] = assigns.map((a) => ({
    from: a.effective_from, to: a.effective_to, pattern: toPattern(patterns.get(a.schedule_id)),
  }));

  // Bank holidays: refuse to calculate if none are loaded, because bank holidays would be charged wrongly.
  const calendar = emp.calendar_code ?? ctx.business.region;
  const latest: any = must(
    await db.from("hol_bank_holidays").select("holiday_date").eq("calendar_code", calendar)
      .order("holiday_date", { ascending: false }).limit(1).maybeSingle(),
    "loading bank holidays",
  );
  if (!latest) throw new HttpError(503, "BANK_HOLIDAYS_MISSING", "Bank holidays have not been loaded yet. Please contact your administrator.");
  const bh: any[] = must(
    await db.from("hol_bank_holidays").select("holiday_date").eq("calendar_code", calendar)
      .gte("holiday_date", startDate).lte("holiday_date", endDate),
    "loading bank holidays",
  );
  const ov: any[] = must(
    await db.from("hol_holiday_overrides").select("holiday_date,is_working_day")
      .eq("business_id", bid).eq("calendar_code", calendar)
      .gte("holiday_date", startDate).lte("holiday_date", endDate),
    "loading holiday overrides",
  );
  const holidays = buildHolidaySet(
    bh.map((r) => r.holiday_date),
    ov.map((r) => ({ date: r.holiday_date, isWorkingDay: r.is_working_day })),
  );

  const years: any[] = must(
    await db.from("hol_leave_years").select("id,label,starts_on,ends_on")
      .eq("business_id", bid).lte("starts_on", endDate).gte("ends_on", startDate),
    "loading leave years",
  );
  const leaveYears = years.map((y) => ({ id: y.id, label: y.label, startsOn: y.starts_on, endsOn: y.ends_on }));

  let policy: any = null;
  if (leaveType.balance_tracked) {
    const pas: any[] = must(
      await db.from("hol_policy_assignments").select("policy_id,effective_from,effective_to")
        .eq("business_id", bid).eq("employee_id", emp.id).lte("effective_from", startDate),
      "loading policy",
    );
    const pick = pas.filter((a) => a.effective_to === null || a.effective_to >= startDate)
      .sort((x, y) => y.effective_from.localeCompare(x.effective_from))[0];
    if (!pick) throw new HttpError(409, "NO_POLICY", "No leave policy is assigned to you. Please contact HR.");
    policy = must(await db.from("hol_policies").select("*").eq("business_id", bid).eq("id", pick.policy_id).maybeSingle(), "loading policy");
  }

  const backdate = Number(policy?.rules?.backdate_days ?? 0);
  const earliest = addDays(todayIn(ctx.business.timezone), -(Number.isFinite(backdate) && backdate > 0 ? backdate : 0));
  if (startDate < earliest) {
    throw new HttpError(400, "PAST_DATE", backdate > 0
      ? `Requests can start up to ${backdate} days in the past`
      : "Requests cannot start in the past. Please contact HR if you need to record past leave.");
  }

  let hours: number | null = null;
  if (b.hours !== undefined && b.hours !== null && b.hours !== "") hours = Number(b.hours);

  let result: CalcResult;
  try {
    result = calculateLeave({
      startDate, endDate,
      startHalf: b.start_half ?? null, endHalf: b.end_half ?? null, hours,
      unit: leaveType.unit, schedules, holidays, leaveYears,
      employment: { start: emp.employment_start, end: emp.employment_end },
    });
  } catch (e) {
    if (e instanceof CalcError) throw new HttpError(400, e.code, e.message);
    throw e;
  }
  if (endDate > latest.holiday_date) {
    result.warnings.push(`Bank holidays after ${latest.holiday_date} are not loaded yet, so they may be charged`);
  }

  const rules = policy?.rules ?? {};
  return { leaveType, policy, result, leaveYears, allowNegative: rules.allow_negative === true, startDate, endDate, hours, b };
}

async function balanceFor(bid: string, empId: string, typeId: string, yearId: string, excludeRequestId?: string | null) {
  const available = Number(must(
    await db.rpc("hol_available", { p_business: bid, p_employee: empId, p_type: typeId, p_year: yearId }),
    "reading balance",
  ));
  let prq: any = db.from("hol_requests").select("id").eq("business_id", bid).eq("employee_id", empId)
    .eq("leave_type_id", typeId).eq("status", "pending");
  if (excludeRequestId) prq = prq.neq("id", excludeRequestId);
  const pr: any[] = must(await prq, "reading pending requests");
  let pending = 0;
  if (pr.length) {
    const days: any[] = must(
      await db.from("hol_request_days").select("units").eq("business_id", bid)
        .eq("leave_year_id", yearId).in("request_id", pr.map((r) => r.id)),
      "reading pending days",
    );
    pending = days.reduce((a, d) => a + Number(d.units), 0);
  }
  return { available: r4(available), pending: r4(pending) };
}

async function findApprover(ctx: Ctx): Promise<string> {
  const bid = ctx.business.id;
  const self = ctx.employee.id;
  const mid = ctx.employee.manager_id;
  if (mid && mid !== self) {
    const m: any = must(
      await db.from("hol_employees").select("id,status").eq("business_id", bid).eq("id", mid).maybeSingle(),
      "finding manager",
    );
    if (m && m.status === "active") return m.id;
  }
  for (const role of ["hr", "owner"]) {
    const r: any = must(
      await db.from("hol_employees").select("id").eq("business_id", bid).eq("role", role)
        .eq("status", "active").neq("id", self).order("employee_number").limit(1).maybeSingle(),
      "finding approver",
    );
    if (r) return r.id;
  }
  throw new HttpError(409, "NO_APPROVER", "No approver is available. Please contact HR.");
}

// ---------------------------------------------------------------- leave actions (staff portal)
async function leaveTypes(ctx: Ctx) {
  requireStaff(ctx);
  const rows = must(
    await db.from("hol_leave_types").select("id,code,name,unit,balance_tracked,requires_approval")
      .eq("business_id", ctx.business.id).eq("active", true).eq("is_sickness", false).order("name"),
    "listing leave types",
  );
  return ok({ leave_types: rows });
}

async function leavePreview(ctx: Ctx, b: any) {
  requireStaff(ctx);
  const L = await loadLeaveContext(ctx, b);
  const replaces = b.replaces_request_id ? uuidOf(b.replaces_request_id, "replaces_request_id") : null;
  const staffing = await staffingCheck(ctx.business.id, ctx.employee, L.result.chargedDays.map((d) => d.date));
  const teamWarnings = staffing.breaches.length ? [staffingMessage(staffing) + " Your approver may decline."] : [];
  const labels = new Map(L.leaveYears.map((y) => [y.id, y.label]));
  const years: any[] = [];
  const problems: string[] = [];
  if (L.leaveType.balance_tracked) {
    for (const [yid, needed] of Object.entries(L.result.perLeaveYear)) {
      const bal = await balanceFor(ctx.business.id, ctx.employee.id, L.leaveType.id, yid, replaces);
      const remaining = r4(bal.available - bal.pending - needed);
      if (remaining < 0 && !L.allowNegative) {
        problems.push(`Not enough leave in ${labels.get(yid)}: ${r4(bal.available - bal.pending)} available, ${needed} requested`);
      }
      years.push({ leave_year: labels.get(yid), needed, available: bal.available, pending: bal.pending, remaining });
    }
  }
  return ok({
    leave_type: { id: L.leaveType.id, code: L.leaveType.code, name: L.leaveType.name, unit: L.leaveType.unit },
    requested_units: L.result.requestedUnits,
    charged_days: L.result.chargedDays.map((d) => ({ date: d.date, units: d.units })),
    skipped_days: L.result.skippedDays,
    balances: years,
    requires_approval: L.leaveType.requires_approval,
    warnings: [...L.result.warnings, ...teamWarnings],
    can_submit: problems.length === 0,
    problems,
  });
}

async function leaveSubmit(ctx: Ctx, b: any) {
  requireStaff(ctx);
  const L = await loadLeaveContext(ctx, b);
  const comment = b.comment ? clean(b.comment, 500, "comment") : null;
  const approverId = L.leaveType.requires_approval ? await findApprover(ctx) : null;
  const res = await db.rpc("hol_submit_request", {
    p_business: ctx.business.id,
    p_employee: ctx.employee.id,
    p_type: L.leaveType.id,
    p_policy: L.policy?.id ?? null,
    p_start: L.startDate,
    p_end: L.endDate,
    p_start_half: b.start_half ?? null,
    p_end_half: b.end_half ?? null,
    p_units: L.result.requestedUnits,
    p_comment: comment,
    p_snapshot: L.policy ? { policy_id: L.policy.id, name: L.policy.name, version: L.policy.version, rules: L.policy.rules } : {},
    p_days: L.result.chargedDays.map((d) => ({ date: d.date, units: d.units, leave_year_id: d.leaveYearId })),
    p_requires_approval: L.leaveType.requires_approval,
    p_tracked: L.leaveType.balance_tracked,
    p_allow_negative: L.allowNegative,
    p_approver: approverId,
    p_replaces: b.replaces_request_id ? uuidOf(b.replaces_request_id, "replaces_request_id") : null,
  });
  if (res.error) mapRpcError(res.error);
  return ok({ ...(res.data as object), requested_units: L.result.requestedUnits, warnings: L.result.warnings });
}

// Pending or draft requests are withdrawn straight away. Approved leave goes to the approver as a cancellation request.
async function leaveCancel(ctx: Ctx, b: any) {
  requireStaff(ctx);
  const bid = ctx.business.id;
  const requestId = uuidOf(b.request_id, "request_id");
  const req: any = must(
    await db.from("hol_requests").select("id,status,leave_type_id").eq("business_id", bid)
      .eq("id", requestId).eq("employee_id", ctx.employee.id).maybeSingle(),
    "loading request",
  );
  if (!req) throw new HttpError(404, "NOT_FOUND", "Request not found");

  if (req.status === "approved") {
    const type: any = must(
      await db.from("hol_leave_types").select("requires_approval").eq("business_id", bid).eq("id", req.leave_type_id).maybeSingle(),
      "loading leave type",
    );
    const approver = type?.requires_approval ? await findApprover(ctx) : null;
    const res = await db.rpc("hol_cancel_approved", {
      p_business: bid, p_request: requestId, p_actor: ctx.employee.id, p_approver: approver,
      p_reason: b.reason ? clean(b.reason, 300, "reason") : null,
    });
    if (res.error) mapRpcError(res.error);
    return ok(res.data);
  }
  const res = await db.rpc("hol_cancel_request", { p_business: bid, p_request: requestId, p_actor: ctx.employee.id });
  if (res.error) mapRpcError(res.error);
  return ok(res.data);
}

async function leaveMyRequests(ctx: Ctx, b: any) {
  requireStaff(ctx);
  const limit = Math.min(Math.max(Number(b.limit) || 50, 1), 100);
  const offset = Math.max(Number(b.offset) || 0, 0);
  const rows: any[] = must(
    await db.from("hol_requests")
      .select("id,leave_type_id,status,start_date,end_date,start_half,end_half,requested_units,comment,submitted_at,decided_at,version")
      .eq("business_id", ctx.business.id).eq("employee_id", ctx.employee.id)
      .order("start_date", { ascending: false }).range(offset, offset + limit - 1),
    "listing requests",
  );
  const types: any[] = must(
    await db.from("hol_leave_types").select("id,name,unit").eq("business_id", ctx.business.id),
    "listing leave types",
  );
  const byId = new Map(types.map((t) => [t.id, t]));
  return ok({
    requests: rows.map((r) => ({ ...r, leave_type: byId.get(r.leave_type_id)?.name ?? "", unit: byId.get(r.leave_type_id)?.unit ?? "days" })),
  });
}

// Balance summary per leave type and leave year, straight from the ledger.
async function balanceSummary(bid: string, employeeId: string, yearId?: string) {
  const entries = await fetchAll<any>(
    (a, z) => {
      let q: any = db.from("hol_ledger").select("leave_type_id,leave_year_id,entry_type,quantity")
        .eq("business_id", bid).eq("employee_id", employeeId);
      if (yearId) q = q.eq("leave_year_id", yearId);
      return q.range(a, z);
    },
    "reading ledger",
  );
  const rows = new Map<string, any>();
  const row = (t: string, y: string) => {
    const k = `${t}|${y}`;
    if (!rows.has(k)) rows.set(k, { t, y, entitlement: 0, booked: 0, taken: 0, expired: 0, pending: 0, available: 0 });
    return rows.get(k);
  };
  for (const e of entries) {
    const r = row(e.leave_type_id, e.leave_year_id);
    const q = Number(e.quantity);
    r.available += q;
    if (["allocation", "accrual", "carry_over", "adjustment"].includes(e.entry_type)) r.entitlement += q;
    else if (e.entry_type === "booking" || e.entry_type === "release") r.booked -= q;
    else if (e.entry_type === "taken") r.taken -= q;
    else if (e.entry_type === "expiry") r.expired -= q;
  }
  const pr: any[] = must(
    await db.from("hol_requests").select("id,leave_type_id").eq("business_id", bid)
      .eq("employee_id", employeeId).eq("status", "pending"),
    "reading pending requests",
  );
  if (pr.length) {
    const typeOf = new Map(pr.map((p) => [p.id, p.leave_type_id]));
    let dq: any = db.from("hol_request_days").select("request_id,leave_year_id,units")
      .eq("business_id", bid).in("request_id", pr.map((p) => p.id));
    if (yearId) dq = dq.eq("leave_year_id", yearId);
    const days: any[] = must(await dq, "reading pending days");
    for (const d of days) row(typeOf.get(d.request_id), d.leave_year_id).pending += Number(d.units);
  }
  const types: any[] = must(await db.from("hol_leave_types").select("id,code,name,unit").eq("business_id", bid), "loading leave types");
  const years: any[] = must(await db.from("hol_leave_years").select("id,label,starts_on,ends_on").eq("business_id", bid), "loading leave years");
  const tById = new Map(types.map((t) => [t.id, t]));
  const yById = new Map(years.map((y) => [y.id, y]));
  return [...rows.values()].map((r) => ({
    leave_type: tById.get(r.t)?.name ?? "", code: tById.get(r.t)?.code ?? "", unit: tById.get(r.t)?.unit ?? "days",
    leave_year: yById.get(r.y)?.label ?? "", starts_on: yById.get(r.y)?.starts_on, ends_on: yById.get(r.y)?.ends_on,
    entitlement: r4(r.entitlement), booked: r4(r.booked), taken: r4(r.taken), expired: r4(r.expired),
    pending: r4(r.pending), available: r4(r.available), available_after_pending: r4(r.available - r.pending),
  })).sort((a, z) => (z.starts_on ?? "").localeCompare(a.starts_on ?? "") || a.leave_type.localeCompare(z.leave_type));
}

async function leaveBalances(ctx: Ctx) {
  requireStaff(ctx);
  return ok({ balances: await balanceSummary(ctx.business.id, ctx.employee.id) });
}

// ---------------------------------------------------------------- balance actions (business portal)
async function hrBalances(ctx: Ctx, b: any) {
  requireBusiness(ctx);
  const bid = ctx.business.id;
  const emp: any = must(
    await db.from("hol_employees").select("id,employee_number,full_name")
      .eq("business_id", bid).eq("employee_number", cleanId(b.employee_number, "employee_number")).maybeSingle(),
    "finding employee",
  );
  if (!emp) throw new HttpError(404, "NOT_FOUND", "Employee not found");
  return ok({ employee: { employee_number: emp.employee_number, full_name: emp.full_name }, balances: await balanceSummary(bid, emp.id) });
}

// Manual correction by HR. Always an audited ledger entry, never an edit.
async function hrAllocate(ctx: Ctx, b: any) {
  requireBusiness(ctx);
  const bid = ctx.business.id;
  const quantity = Number(b.quantity);
  if (!Number.isFinite(quantity) || quantity === 0) throw new HttpError(400, "VALIDATION", "quantity must be a non-zero number");
  const note = clean(b.note, 200, "note");
  const emp: any = must(
    await db.from("hol_employees").select("id").eq("business_id", bid)
      .eq("employee_number", cleanId(b.employee_number, "employee_number")).maybeSingle(),
    "finding employee",
  );
  if (!emp) throw new HttpError(404, "NOT_FOUND", "Employee not found");
  const type: any = must(
    await db.from("hol_leave_types").select("id").eq("business_id", bid).eq("code", clean(b.leave_type_code ?? "annual", 40, "leave_type_code")).maybeSingle(),
    "finding leave type",
  );
  if (!type) throw new HttpError(404, "LEAVE_TYPE_NOT_FOUND", "Leave type not found");
  const year: any = must(
    await db.from("hol_leave_years").select("id").eq("business_id", bid).eq("label", clean(b.year_label, 20, "year_label")).maybeSingle(),
    "finding leave year",
  );
  if (!year) throw new HttpError(404, "NOT_FOUND", "Leave year not found");

  const key = b.request_key ? `adj:${clean(b.request_key, 64, "request_key")}` : `adj:${crypto.randomUUID()}`;
  const res = await db.rpc("hol_post_entry", {
    p_business: bid, p_employee: emp.id, p_type: type.id, p_year: year.id,
    p_entry_type: "adjustment", p_quantity: quantity, p_key: key, p_by: ctx.employee.id, p_note: note,
  });
  if (res.error) mapRpcError(res.error);
  await audit(bid, ctx.employee.id, null, "balance.adjusted", "employee", emp.id, { quantity, note, leave_type: b.leave_type_code ?? "annual", year: b.year_label });
  return ok({ posted: res.data === true });
}

// Allocates the year's entitlement to every active employee from their policy and schedule. Safe to repeat.
async function hrAllocateYear(ctx: Ctx, b: any) {
  requireBusiness(ctx);
  const bid = ctx.business.id;
  const year: any = must(
    await db.from("hol_leave_years").select("*").eq("business_id", bid).eq("label", clean(b.year_label, 20, "year_label")).maybeSingle(),
    "finding leave year",
  );
  if (!year) throw new HttpError(404, "NOT_FOUND", "Leave year not found");

  const employees = await fetchAll<any>((a, z) => db.from("hol_employees")
    .select("id,employee_number,role,employment_start,employment_end")
    .eq("business_id", bid).eq("status", "active").order("employee_number").range(a, z), "listing employees");
  const pAssign = await fetchAll<any>((a, z) => db.from("hol_policy_assignments")
    .select("employee_id,policy_id,effective_from,effective_to").eq("business_id", bid).order("id").range(a, z), "loading policy assignments");
  const sAssign = await fetchAll<any>((a, z) => db.from("hol_schedule_assignments")
    .select("employee_id,schedule_id,effective_from,effective_to").eq("business_id", bid).order("id").range(a, z), "loading schedule assignments");
  const policies: any[] = must(await db.from("hol_policies").select("*").eq("business_id", bid), "loading policies");
  const schedules: any[] = must(await db.from("hol_work_schedules").select("id,week_pattern").eq("business_id", bid), "loading schedules");
  const types: any[] = must(await db.from("hol_leave_types").select("id,code,unit").eq("business_id", bid), "loading leave types");
  const policyById = new Map(policies.map((p) => [p.id, p]));
  const patternById = new Map(schedules.map((s) => [s.id, s.week_pattern]));
  const typeByCode = new Map(types.map((t) => [t.code, t]));

  const pickAt = (list: any[], empId: string, date: string) =>
    list.filter((a) => a.employee_id === empId && a.effective_from <= date && (a.effective_to === null || a.effective_to >= date))
      .sort((x, y) => y.effective_from.localeCompare(x.effective_from))[0];

  const skipped: { employee_number: string; reason: string }[] = [];
  const jobs: { empId: string; typeId: string; days: number }[] = [];

  for (const e of employees) {
    if (e.role === "owner") continue;
    if (e.employment_start > year.ends_on || (e.employment_end && e.employment_end < year.starts_on)) continue;
    const at = e.employment_start > year.starts_on ? e.employment_start : year.starts_on;
    const pa = pickAt(pAssign, e.id, at);
    const policy = pa ? policyById.get(pa.policy_id) : null;
    if (!policy) { skipped.push({ employee_number: e.employee_number, reason: "no leave policy assigned" }); continue; }
    const rules = policy.rules ?? {};
    const type = typeByCode.get(String(rules.leave_type ?? "annual"));
    const policyDays = Number(rules.entitlement);
    if (!type || !(policyDays > 0)) { skipped.push({ employee_number: e.employee_number, reason: "policy has no entitlement" }); continue; }
    if (type.unit !== "days") { skipped.push({ employee_number: e.employee_number, reason: "hours-based leave is allocated manually" }); continue; }
    const sa = pickAt(sAssign, e.id, at);
    if (!sa) { skipped.push({ employee_number: e.employee_number, reason: "no work schedule assigned" }); continue; }
    const days = calculateEntitlement({
      policyDays, fullTimeHours: Number(rules.full_time_hours) > 0 ? Number(rules.full_time_hours) : 37.5,
      weeklyHours: weeklyHoursOf(toPattern(patternById.get(sa.schedule_id))),
      yearStart: year.starts_on, yearEnd: year.ends_on,
      employmentStart: e.employment_start, employmentEnd: e.employment_end,
    });
    if (days <= 0) { skipped.push({ employee_number: e.employee_number, reason: "no entitlement for this year" }); continue; }
    jobs.push({ empId: e.id, typeId: type.id, days });
  }

  let allocated = 0, alreadyDone = 0, failed = 0;
  for (let i = 0; i < jobs.length; i += 20) {
    await Promise.all(jobs.slice(i, i + 20).map(async (j) => {
      const res = await db.rpc("hol_post_entry", {
        p_business: bid, p_employee: j.empId, p_type: j.typeId, p_year: year.id,
        p_entry_type: "allocation", p_quantity: j.days,
        p_key: `alloc:${j.empId}:${year.id}:${j.typeId}`, p_by: ctx.employee.id, p_note: "Yearly allocation",
      });
      if (res.error) { console.error("allocate", res.error); failed++; }
      else if (res.data === true) allocated++;
      else alreadyDone++;
    }));
  }
  await audit(bid, ctx.employee.id, null, "balance.year_allocated", "leave_year", year.id, { allocated, alreadyDone, skipped: skipped.length, failed });
  return ok({ allocated, already_allocated: alreadyDone, failed, skipped: skipped.slice(0, 50), skipped_count: skipped.length });
}

// ---------------------------------------------------------------- approvals
const isUuid = (s: unknown): s is string =>
  typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

function uuidOf(v: unknown, field: string): string {
  if (!isUuid(v)) throw new HttpError(400, "VALIDATION", `${field} is not valid`);
  return v;
}

function requireApprover(ctx: Ctx) {
  if (!["manager", "hr", "owner"].includes(ctx.employee.role)) {
    throw new HttpError(403, "FORBIDDEN", "You do not approve leave requests");
  }
}

// Employee ids whose approvals this person may decide: themselves plus anyone who has delegated to them today.
async function actingFor(ctx: Ctx): Promise<string[]> {
  const t = today();
  const rows: any[] = must(
    await db.from("hol_delegations").select("from_id").eq("business_id", ctx.business.id)
      .eq("to_id", ctx.employee.id).lte("starts_on", t).gte("ends_on", t),
    "loading delegations",
  );
  return [ctx.employee.id, ...rows.map((r) => r.from_id)];
}

async function approvalsInbox(ctx: Ctx, b: any) {
  requireApprover(ctx);
  const bid = ctx.business.id;
  const everything = ctx.portal === "business" && b.scope === "all";
  let q: any = db.from("hol_approval_steps").select("id,request_id,step_number,approver_id")
    .eq("business_id", bid).eq("status", "pending").limit(100);
  if (!everything) q = q.in("approver_id", await actingFor(ctx));
  const steps: any[] = must(await q, "loading approvals");
  if (steps.length === 0) return ok({ items: [] });

  const reqs: any[] = must(
    await db.from("hol_requests")
      .select("id,employee_id,leave_type_id,status,start_date,end_date,start_half,end_half,requested_units,comment,submitted_at,version")
      .eq("business_id", bid).in("id", steps.map((s) => s.request_id)).in("status", ["pending", "cancellation_pending"]),
    "loading requests",
  );
  const emps: any[] = reqs.length ? must(
    await db.from("hol_employees").select("id,employee_number,full_name").eq("business_id", bid).in("id", [...new Set(reqs.map((r) => r.employee_id))]),
    "loading employees",
  ) : [];
  const types: any[] = must(await db.from("hol_leave_types").select("id,name,unit").eq("business_id", bid), "loading leave types");
  const eById = new Map(emps.map((e) => [e.id, e]));
  const tById = new Map(types.map((t) => [t.id, t]));
  const items = reqs
    .sort((a, z) => String(a.submitted_at).localeCompare(String(z.submitted_at)))
    .map((r) => ({
      request_id: r.id, kind: r.status === "cancellation_pending" ? "cancellation" : "request", version: r.version,
      employee_number: eById.get(r.employee_id)?.employee_number, employee: eById.get(r.employee_id)?.full_name,
      leave_type: tById.get(r.leave_type_id)?.name, unit: tById.get(r.leave_type_id)?.unit ?? "days",
      start_date: r.start_date, end_date: r.end_date, start_half: r.start_half, end_half: r.end_half,
      requested_units: Number(r.requested_units), comment: r.comment, submitted_at: r.submitted_at,
    }));
  return ok({ items });
}

async function assertCanView(ctx: Ctx, requestId: string) {
  if (ctx.portal === "business") return; // owner / HR
  const steps: any[] = must(
    await db.from("hol_approval_steps").select("approver_id").eq("business_id", ctx.business.id).eq("request_id", requestId),
    "checking access",
  );
  const mine = new Set(await actingFor(ctx));
  if (!steps.some((s) => mine.has(s.approver_id))) throw new HttpError(403, "FORBIDDEN", "You cannot view this request");
}

async function approvalsDetail(ctx: Ctx, b: any) {
  requireApprover(ctx);
  const bid = ctx.business.id;
  const requestId = uuidOf(b.request_id, "request_id");
  await assertCanView(ctx, requestId);

  const req: any = must(await db.from("hol_requests").select("*").eq("business_id", bid).eq("id", requestId).maybeSingle(), "loading request");
  if (!req) throw new HttpError(404, "NOT_FOUND", "Request not found");
  const emp: any = must(
    await db.from("hol_employees").select("id,employee_number,full_name,manager_id,department_id").eq("business_id", bid).eq("id", req.employee_id).maybeSingle(),
    "loading employee",
  );
  const type: any = must(await db.from("hol_leave_types").select("id,name,unit,balance_tracked").eq("business_id", bid).eq("id", req.leave_type_id).maybeSingle(), "loading leave type");
  const days: any[] = must(
    await db.from("hol_request_days").select("leave_date,units,leave_year_id").eq("business_id", bid).eq("request_id", requestId).order("leave_date"),
    "loading days",
  );
  const years: any[] = must(await db.from("hol_leave_years").select("id,label").eq("business_id", bid), "loading leave years");
  const yLabel = new Map(years.map((y) => [y.id, y.label]));

  const balances: any[] = [];
  if (type?.balance_tracked) {
    const needed = new Map<string, number>();
    for (const d of days) needed.set(d.leave_year_id, (needed.get(d.leave_year_id) ?? 0) + Number(d.units));
    for (const [yid, n] of needed) {
      const bal = await balanceFor(bid, req.employee_id, req.leave_type_id, yid);
      // pending includes this request itself, so remove it to show what is left for the others
      balances.push({ leave_year: yLabel.get(yid), requested: r4(n), available: bal.available, other_pending: r4(bal.pending - (req.status === "pending" ? n : 0)) });
    }
  }

  // Who else in the same team is away on those dates
  let teammates: any[] = [];
  if (emp?.manager_id) {
    teammates = must(await db.from("hol_employees").select("id,employee_number,full_name").eq("business_id", bid).eq("manager_id", emp.manager_id).neq("id", emp.id).limit(200), "loading team");
  } else if (emp?.department_id) {
    teammates = must(await db.from("hol_employees").select("id,employee_number,full_name").eq("business_id", bid).eq("department_id", emp.department_id).neq("id", emp.id).limit(200), "loading team");
  }
  let overlaps: any[] = [];
  if (teammates.length) {
    const others: any[] = must(
      await db.from("hol_requests").select("employee_id,start_date,end_date,status")
        .eq("business_id", bid).in("employee_id", teammates.map((t) => t.id))
        .in("status", ["pending", "approved", "cancellation_pending"])
        .lte("start_date", req.end_date).gte("end_date", req.start_date).limit(100),
      "loading team leave",
    );
    const nameOf = new Map(teammates.map((t) => [t.id, t.full_name]));
    overlaps = others.map((o) => ({ employee: nameOf.get(o.employee_id), start_date: o.start_date, end_date: o.end_date, status: o.status === "approved" ? "approved" : "pending" }));
  }

  const steps: any[] = must(await db.from("hol_approval_steps").select("id,step_number,status").eq("business_id", bid).eq("request_id", requestId), "loading steps");
  const decisions: any[] = steps.length ? must(
    await db.from("hol_approval_decisions").select("step_id,actor_id,decision,comment,created_at").eq("business_id", bid).in("step_id", steps.map((s) => s.id)).order("created_at"),
    "loading decisions",
  ) : [];
  const actors: any[] = decisions.length ? must(await db.from("hol_employees").select("id,full_name").eq("business_id", bid).in("id", [...new Set(decisions.map((d) => d.actor_id))]), "loading actors") : [];
  const aName = new Map(actors.map((a) => [a.id, a.full_name]));

  const staffing = req.status === "pending" && emp ? await staffingCheck(bid, emp, days.map((d) => d.leave_date)) : { limit: null, breaches: [] };
  return ok({
    staffing: { limit: staffing.limit, breaches: staffing.breaches, message: staffing.breaches.length ? staffingMessage(staffing) : null },
    request: {
      id: req.id, status: req.status, version: req.version, start_date: req.start_date, end_date: req.end_date,
      start_half: req.start_half, end_half: req.end_half, requested_units: Number(req.requested_units),
      comment: req.comment, submitted_at: req.submitted_at,
    },
    employee: { employee_number: emp?.employee_number, full_name: emp?.full_name },
    leave_type: { name: type?.name, unit: type?.unit },
    days: days.map((d) => ({ date: d.leave_date, units: Number(d.units), leave_year: yLabel.get(d.leave_year_id) })),
    balances, team_overlaps: overlaps,
    history: decisions.map((d) => ({ by: aName.get(d.actor_id), decision: d.decision, comment: d.comment, at: d.created_at })),
  });
}

async function approvalsDecide(ctx: Ctx, b: any) {
  requireApprover(ctx);
  const decision = String(b.decision ?? "");
  if (!["approved", "rejected", "changes_requested"].includes(decision)) {
    throw new HttpError(400, "VALIDATION", "decision must be approved, rejected or changes_requested");
  }
  const comment = b.comment ? clean(b.comment, 500, "comment") : null;
  if (decision !== "approved" && !comment) throw new HttpError(400, "VALIDATION", "Please give a reason");
  const version = Number(b.expected_version);
  if (!Number.isInteger(version) || version < 1) throw new HttpError(400, "VALIDATION", "expected_version is required");

  if (decision === "approved" && b.override_staffing !== true) {
    const rq: any = must(await db.from("hol_requests").select("employee_id,status").eq("business_id", ctx.business.id).eq("id", uuidOf(b.request_id, "request_id")).maybeSingle(), "loading request");
    if (rq && rq.status === "pending") {
      const who: any = must(await db.from("hol_employees").select("id,department_id").eq("business_id", ctx.business.id).eq("id", rq.employee_id).maybeSingle(), "loading employee");
      const dd: any[] = must(await db.from("hol_request_days").select("leave_date").eq("business_id", ctx.business.id).eq("request_id", uuidOf(b.request_id, "request_id")), "loading days");
      const staffing = await staffingCheck(ctx.business.id, who, dd.map((d) => d.leave_date));
      if (staffing.breaches.length) throw new HttpError(409, "STAFFING_LIMIT", staffingMessage(staffing));
    }
  }
  const res = await db.rpc("hol_decide_request", {
    p_business: ctx.business.id,
    p_request: uuidOf(b.request_id, "request_id"),
    p_actor: ctx.employee.id,
    p_decision: decision,
    p_comment: comment,
    p_expected_version: version,
    p_override: ctx.portal === "business", // HR / owner may decide any request
  });
  if (res.error) mapRpcError(res.error);
  return ok(res.data);
}

async function approvalsDelegate(ctx: Ctx, b: any) {
  requireApprover(ctx);
  const bid = ctx.business.id;
  if (!isDate(b.starts_on) || !isDate(b.ends_on) || b.ends_on < b.starts_on) {
    throw new HttpError(400, "VALIDATION", "starts_on and ends_on must be valid dates, and the end must not be before the start");
  }
  const to: any = must(
    await db.from("hol_employees").select("id,role,status").eq("business_id", bid)
      .eq("employee_number", cleanId(b.to_employee_number, "to_employee_number")).maybeSingle(),
    "finding delegate",
  );
  if (!to || to.status !== "active") throw new HttpError(404, "NOT_FOUND", "Delegate not found");
  if (to.id === ctx.employee.id) throw new HttpError(400, "VALIDATION", "You cannot delegate to yourself");
  if (!["manager", "hr", "owner"].includes(to.role)) throw new HttpError(400, "VALIDATION", "A delegate must be a manager, HR or the owner");
  const row: any = must(
    await db.from("hol_delegations").insert({ business_id: bid, from_id: ctx.employee.id, to_id: to.id, starts_on: b.starts_on, ends_on: b.ends_on }).select("id").single(),
    "saving delegation",
  );
  await audit(bid, ctx.employee.id, null, "delegation.created", "delegation", row.id, { to: b.to_employee_number, starts_on: b.starts_on, ends_on: b.ends_on });
  return ok({ id: row.id });
}

async function approvalsDelegations(ctx: Ctx) {
  requireApprover(ctx);
  const bid = ctx.business.id;
  const rows: any[] = must(
    await db.from("hol_delegations").select("id,from_id,to_id,starts_on,ends_on").eq("business_id", bid)
      .or(`from_id.eq.${ctx.employee.id},to_id.eq.${ctx.employee.id}`).order("starts_on", { ascending: false }).limit(100),
    "listing delegations",
  );
  const ids = [...new Set(rows.flatMap((r) => [r.from_id, r.to_id]))];
  const emps: any[] = ids.length ? must(await db.from("hol_employees").select("id,employee_number,full_name").eq("business_id", bid).in("id", ids), "loading names") : [];
  const byId = new Map(emps.map((e) => [e.id, e]));
  return ok({
    delegations: rows.map((r) => ({
      id: r.id, direction: r.from_id === ctx.employee.id ? "given" : "received",
      from: byId.get(r.from_id)?.full_name, to: byId.get(r.to_id)?.full_name,
      to_employee_number: byId.get(r.to_id)?.employee_number, starts_on: r.starts_on, ends_on: r.ends_on,
    })),
  });
}

async function approvalsRemoveDelegation(ctx: Ctx, b: any) {
  requireApprover(ctx);
  const id = uuidOf(b.id, "id");
  const gone: any[] = must(
    await db.from("hol_delegations").delete().eq("business_id", ctx.business.id).eq("id", id).eq("from_id", ctx.employee.id).select("id"),
    "removing delegation",
  );
  if (gone.length === 0) throw new HttpError(404, "NOT_FOUND", "Delegation not found");
  await audit(ctx.business.id, ctx.employee.id, null, "delegation.removed", "delegation", id);
  return ok();
}

// ---------------------------------------------------------------- business setup (business portal)
const bool = (v: unknown, fallback = false) => (typeof v === "boolean" ? v : fallback);

function numIn(v: unknown, field: string, min: number, max: number): number {
  const n = Number(v);
  if (v === "" || v === null || !Number.isFinite(n) || n < min || n > max) {
    throw new HttpError(400, "VALIDATION", `${field} must be a number from ${min} to ${max}`);
  }
  return n;
}

function dbConflict(err: { code?: string }, what: string): never {
  if (err.code === "23505") throw new HttpError(409, "ALREADY_EXISTS", `${what} already exists`);
  if (err.code === "23P01") throw new HttpError(409, "OVERLAP", `${what} overlaps an existing one`);
  console.error("db", err);
  throw new HttpError(500, "DB_ERROR", "Database error");
}

async function setupOverview(ctx: Ctx) {
  requireBusiness(ctx);
  const bid = ctx.business.id;
  const t = today();
  const years = must(await db.from("hol_leave_years").select("id,label,starts_on,ends_on").eq("business_id", bid).order("starts_on"), "loading leave years");
  const policies: any[] = must(await db.from("hol_policies").select("id,name,version,status,effective_from,rules").eq("business_id", bid).order("name"), "loading policies");
  const schedules: any[] = must(await db.from("hol_work_schedules").select("id,name,week_pattern").eq("business_id", bid).order("name"), "loading schedules");
  const types = must(await db.from("hol_leave_types").select("id,code,name,unit,balance_tracked,requires_approval,is_sickness,active").eq("business_id", bid).order("name"), "loading leave types");
  const overrides = must(await db.from("hol_holiday_overrides").select("calendar_code,holiday_date,name,is_working_day").eq("business_id", bid).order("holiday_date"), "loading overrides");
  const departments = must(await db.from("hol_departments").select("id,name,max_concurrent_absent").eq("business_id", bid).order("name"), "loading departments");
  const pAssign = await fetchAll<any>((a, z) => db.from("hol_policy_assignments").select("policy_id,effective_from,effective_to").eq("business_id", bid).lte("effective_from", t).order("id").range(a, z), "loading assignments");
  const sAssign = await fetchAll<any>((a, z) => db.from("hol_schedule_assignments").select("schedule_id,effective_from,effective_to").eq("business_id", bid).lte("effective_from", t).order("id").range(a, z), "loading assignments");
  const live = (a: any) => a.effective_to === null || a.effective_to >= t;
  const count = (list: any[], key: string, id: string) => list.filter((a) => a[key] === id && live(a)).length;
  return ok({
    business: { name: ctx.business.name, region: ctx.business.region, timezone: ctx.business.timezone, settings: ctx.business.settings ?? {} },
    leave_years: years,
    policies: policies.map((p) => ({ ...p, employees: count(pAssign, "policy_id", p.id) })),
    schedules: schedules.map((s) => ({ ...s, employees: count(sAssign, "schedule_id", s.id) })),
    leave_types: types, overrides, departments,
  });
}

async function setupAddYear(ctx: Ctx, b: any) {
  requireBusiness(ctx);
  const label = clean(b.label, 20, "label");
  if (!isDate(b.starts_on) || !isDate(b.ends_on) || b.ends_on <= b.starts_on) {
    throw new HttpError(400, "VALIDATION", "starts_on and ends_on must be dates, with the end after the start");
  }
  const res = await db.from("hol_leave_years").insert({ business_id: ctx.business.id, label, starts_on: b.starts_on, ends_on: b.ends_on }).select("id").single();
  if (res.error) dbConflict(res.error, "A leave year with that name or those dates");
  await audit(ctx.business.id, ctx.employee.id, null, "leave_year.created", "leave_year", (res.data as any).id, { label, starts_on: b.starts_on, ends_on: b.ends_on });
  return ok({ id: (res.data as any).id });
}

async function setupSavePolicy(ctx: Ctx, b: any) {
  requireBusiness(ctx);
  const bid = ctx.business.id;
  const name = clean(b.name, 80, "name");
  const code = String(b.leave_type ?? "annual");
  const lt: any = must(await db.from("hol_leave_types").select("id").eq("business_id", bid).eq("code", code).maybeSingle(), "finding leave type");
  if (!lt) throw new HttpError(400, "VALIDATION", "That leave type does not exist");
  const expiry = String(b.carry_over_expiry ?? "03-31");
  if (!/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(expiry)) throw new HttpError(400, "VALIDATION", "carry_over_expiry must look like 03-31");
  const incoming = {
    leave_type: code,
    entitlement: numIn(b.entitlement, "entitlement", 0.5, 100),
    full_time_hours: numIn(b.full_time_hours ?? 37.5, "full_time_hours", 1, 80),
    allow_negative: bool(b.allow_negative),
    carry_over_max: numIn(b.carry_over_max ?? 0, "carry_over_max", 0, 60),
    carry_over_expiry: expiry,
    backdate_days: numIn(b.backdate_days ?? 0, "backdate_days", 0, 365),
  };

  if (b.id) {
    const old: any = must(await db.from("hol_policies").select("*").eq("business_id", bid).eq("id", uuidOf(b.id, "id")).maybeSingle(), "loading policy");
    if (!old) throw new HttpError(404, "NOT_FOUND", "Policy not found");
    const rules = { ...(old.rules ?? {}), ...incoming };
    const res = await db.from("hol_policies").update({ name, rules, version: old.version + 1 }).eq("business_id", bid).eq("id", old.id);
    if (res.error) dbConflict(res.error, "A policy with that name");
    await audit(bid, ctx.employee.id, null, "policy.updated", "policy", old.id, { name, version: old.version + 1, from: old.rules, to: rules });
    return ok({ id: old.id, version: old.version + 1 });
  }

  const from = isDate(b.effective_from) ? b.effective_from : `${new Date().getUTCFullYear()}-01-01`;
  const res = await db.from("hol_policies").insert({ business_id: bid, name, version: 1, status: "active", effective_from: from, rules: incoming }).select("id").single();
  if (res.error) dbConflict(res.error, "A policy with that name");
  const id = (res.data as any).id;
  let assigned = 0;
  if (b.assign_to_all === true) {
    const ids = await resolveEmployeeIds(bid, { all: true });
    if (ids.length) assigned = await assignVia("hol_assign_policy", { p_business: bid, p_policy: id, p_employees: ids, p_from: from });
  }
  await audit(bid, ctx.employee.id, null, "policy.created", "policy", id, { name, rules: incoming, assigned });
  return ok({ id, version: 1, assigned });
}

async function resolveEmployeeIds(bid: string, b: any): Promise<string[]> {
  if (b.all === true) {
    const rows = await fetchAll<any>((a, z) => db.from("hol_employees").select("id").eq("business_id", bid).eq("status", "active").neq("role", "owner").order("employee_number").range(a, z), "listing employees");
    return rows.map((r) => r.id);
  }
  const numbers: string[] = Array.isArray(b.employee_numbers) ? b.employee_numbers.slice(0, 1000).map((n: unknown) => cleanId(n, "employee_numbers")) : [];
  if (numbers.length === 0) throw new HttpError(400, "VALIDATION", "Choose employees or all:true");
  const ids: string[] = [];
  const found = new Set<string>();
  for (let i = 0; i < numbers.length; i += 100) {
    const rows: any[] = must(await db.from("hol_employees").select("id,employee_number").eq("business_id", bid).in("employee_number", numbers.slice(i, i + 100)), "finding employees");
    rows.forEach((r) => { ids.push(r.id); found.add(r.employee_number); });
  }
  const missing = numbers.filter((n) => !found.has(n));
  if (missing.length) throw new HttpError(404, "NOT_FOUND", `Employee not found: ${missing.slice(0, 5).join(", ")}`);
  return ids;
}

async function assignVia(fn: string, args: Record<string, unknown>): Promise<number> {
  const res = await db.rpc(fn, args);
  if (res.error) {
    if (String(res.error.message).startsWith("ASSIGNMENT_CONFLICT")) throw new HttpError(409, "ASSIGNMENT_CONFLICT", "An employee already has a later assignment. Choose a later start date.");
    if (String(res.error.message).startsWith("NOT_FOUND")) throw new HttpError(404, "NOT_FOUND", "Not found");
    mapRpcError(res.error);
  }
  return Number(res.data);
}

async function setupAssignPolicy(ctx: Ctx, b: any) {
  requireBusiness(ctx);
  const bid = ctx.business.id;
  if (!isDate(b.effective_from)) throw new HttpError(400, "VALIDATION", "effective_from must be a date");
  const known = must(await db.from("hol_policies").select("id").eq("business_id", bid).eq("id", uuidOf(b.policy_id, "policy_id")).maybeSingle(), "finding policy");
  if (!known) throw new HttpError(404, "NOT_FOUND", "Policy not found");
  const ids = await resolveEmployeeIds(bid, b);
  const n = ids.length ? await assignVia("hol_assign_policy", { p_business: bid, p_policy: uuidOf(b.policy_id, "policy_id"), p_employees: ids, p_from: b.effective_from }) : 0;
  await audit(bid, ctx.employee.id, null, "policy.assigned", "policy", b.policy_id, { employees: n, from: b.effective_from });
  return ok({ assigned: n });
}

async function setupSaveSchedule(ctx: Ctx, b: any) {
  requireBusiness(ctx);
  const bid = ctx.business.id;
  const name = clean(b.name, 80, "name");
  const pattern = toPattern(b.week_pattern);
  if (Object.values(pattern).reduce((a, z) => a + z, 0) <= 0) throw new HttpError(400, "VALIDATION", "A schedule needs at least one working day");
  if (b.id) {
    const id = uuidOf(b.id, "id");
    const res = await db.from("hol_work_schedules").update({ name, week_pattern: pattern }).eq("business_id", bid).eq("id", id).select("id");
    if (res.error) dbConflict(res.error, "A schedule with that name");
    if (!(res.data as any[]).length) throw new HttpError(404, "NOT_FOUND", "Schedule not found");
    await audit(bid, ctx.employee.id, null, "schedule.updated", "schedule", id, { name, pattern });
    return ok({ id });
  }
  const res = await db.from("hol_work_schedules").insert({ business_id: bid, name, week_pattern: pattern }).select("id").single();
  if (res.error) dbConflict(res.error, "A schedule with that name");
  await audit(bid, ctx.employee.id, null, "schedule.created", "schedule", (res.data as any).id, { name, pattern });
  return ok({ id: (res.data as any).id });
}

async function setupAssignSchedule(ctx: Ctx, b: any) {
  requireBusiness(ctx);
  const bid = ctx.business.id;
  if (!isDate(b.effective_from)) throw new HttpError(400, "VALIDATION", "effective_from must be a date");
  const known = must(await db.from("hol_work_schedules").select("id").eq("business_id", bid).eq("id", uuidOf(b.schedule_id, "schedule_id")).maybeSingle(), "finding schedule");
  if (!known) throw new HttpError(404, "NOT_FOUND", "Schedule not found");
  const ids = await resolveEmployeeIds(bid, b);
  const n = ids.length ? await assignVia("hol_assign_schedule", { p_business: bid, p_schedule: uuidOf(b.schedule_id, "schedule_id"), p_employees: ids, p_from: b.effective_from }) : 0;
  await audit(bid, ctx.employee.id, null, "schedule.assigned", "schedule", b.schedule_id, { employees: n, from: b.effective_from });
  return ok({ assigned: n });
}

async function setupSaveLeaveType(ctx: Ctx, b: any) {
  requireBusiness(ctx);
  const bid = ctx.business.id;
  const name = clean(b.name, 60, "name");
  const unit = b.unit === "hours" ? "hours" : "days";
  const fields = {
    name, unit,
    balance_tracked: bool(b.balance_tracked, true),
    requires_approval: bool(b.requires_approval, true),
    is_sickness: bool(b.is_sickness),
    active: bool(b.active, true),
  };
  if (b.id) {
    const id = uuidOf(b.id, "id");
    const res = await db.from("hol_leave_types").update(fields).eq("business_id", bid).eq("id", id).select("id");
    if (res.error) dbConflict(res.error, "A leave type with that name");
    if (!(res.data as any[]).length) throw new HttpError(404, "NOT_FOUND", "Leave type not found");
    await audit(bid, ctx.employee.id, null, "leave_type.updated", "leave_type", id, fields);
    return ok({ id });
  }
  const code = String(b.code ?? "").trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,30}$/.test(code)) throw new HttpError(400, "VALIDATION", "code may only use lower-case letters, numbers, - and _");
  const res = await db.from("hol_leave_types").insert({ business_id: bid, code, ...fields }).select("id").single();
  if (res.error) dbConflict(res.error, "A leave type with that code");
  await audit(bid, ctx.employee.id, null, "leave_type.created", "leave_type", (res.data as any).id, { code, ...fields });
  return ok({ id: (res.data as any).id });
}

async function setupAddOverride(ctx: Ctx, b: any) {
  requireBusiness(ctx);
  const calendar = String(b.calendar_code ?? ctx.business.region);
  if (!["ENG-WLS", "SCT", "NIR"].includes(calendar)) throw new HttpError(400, "VALIDATION", "Invalid calendar");
  if (!isDate(b.holiday_date)) throw new HttpError(400, "VALIDATION", "holiday_date must be a date");
  const row = { business_id: ctx.business.id, calendar_code: calendar, holiday_date: b.holiday_date, name: clean(b.name, 80, "name"), is_working_day: bool(b.is_working_day) };
  must(await db.from("hol_holiday_overrides").upsert(row, { onConflict: "business_id,calendar_code,holiday_date" }), "saving override");
  await audit(ctx.business.id, ctx.employee.id, null, "holiday_override.saved", "business", ctx.business.id, row);
  return ok();
}

async function setupRemoveOverride(ctx: Ctx, b: any) {
  requireBusiness(ctx);
  if (!isDate(b.holiday_date)) throw new HttpError(400, "VALIDATION", "holiday_date must be a date");
  must(await db.from("hol_holiday_overrides").delete().eq("business_id", ctx.business.id).eq("calendar_code", String(b.calendar_code ?? ctx.business.region)).eq("holiday_date", b.holiday_date), "removing override");
  await audit(ctx.business.id, ctx.employee.id, null, "holiday_override.removed", "business", ctx.business.id, { date: b.holiday_date });
  return ok();
}

// ---------------------------------------------------------------- employee changes (business portal)
async function hrUpdateEmployee(ctx: Ctx, b: any) {
  requireBusiness(ctx);
  const bid = ctx.business.id;
  const number = cleanId(b.employee_number, "employee_number");
  const emp: any = must(await db.from("hol_employees").select("*").eq("business_id", bid).eq("employee_number", number).maybeSingle(), "finding employee");
  if (!emp) throw new HttpError(404, "NOT_FOUND", "Employee not found");
  if (emp.role === "owner" && ctx.employee.role !== "owner") throw new HttpError(403, "FORBIDDEN", "Only the owner can change the owner account");

  const patch: Record<string, unknown> = {};
  if (b.full_name !== undefined) patch.full_name = clean(b.full_name, 100, "full_name");
  if (b.email !== undefined) patch.email = b.email ? clean(b.email, 200, "email") : null;
  if (b.role !== undefined) {
    if (emp.role === "owner") throw new HttpError(400, "VALIDATION", "The owner role cannot be changed");
    if (!["employee", "manager", "hr"].includes(b.role)) throw new HttpError(400, "VALIDATION", "Invalid role");
    if ((b.role === "hr" || emp.role === "hr") && ctx.employee.role !== "owner") throw new HttpError(403, "FORBIDDEN", "Only the owner can change HR roles");
    patch.role = b.role;
  }
  if (b.department !== undefined) {
    if (b.department) {
      const dep: any = must(await db.from("hol_departments").upsert({ business_id: bid, name: clean(b.department, 80, "department") }, { onConflict: "business_id,name" }).select("id").single(), "saving department");
      patch.department_id = dep.id;
    } else patch.department_id = null;
  }
  if (b.calendar_code !== undefined) {
    if (b.calendar_code && !["ENG-WLS", "SCT", "NIR"].includes(b.calendar_code)) throw new HttpError(400, "VALIDATION", "Invalid calendar");
    patch.calendar_code = b.calendar_code || null;
  }
  if (b.manager_employee_number !== undefined) {
    if (!b.manager_employee_number) patch.manager_id = null;
    else {
      const mgr: any = must(await db.from("hol_employees").select("id,manager_id").eq("business_id", bid).eq("employee_number", cleanId(b.manager_employee_number, "manager_employee_number")).maybeSingle(), "finding manager");
      if (!mgr) throw new HttpError(404, "MANAGER_NOT_FOUND", "Manager not found");
      if (mgr.id === emp.id) throw new HttpError(400, "VALIDATION", "Someone cannot manage themselves");
      // no loops: walk up from the new manager and make sure we never reach this employee
      let cursor: string | null = mgr.manager_id;
      for (let i = 0; cursor && i < 50; i++) {
        if (cursor === emp.id) throw new HttpError(400, "VALIDATION", "That would create a management loop");
        const up: any = must(await db.from("hol_employees").select("manager_id").eq("business_id", bid).eq("id", cursor).maybeSingle(), "checking managers");
        cursor = up?.manager_id ?? null;
      }
      patch.manager_id = mgr.id;
    }
  }
  if (Object.keys(patch).length === 0) throw new HttpError(400, "VALIDATION", "Nothing to change");
  must(await db.from("hol_employees").update(patch).eq("business_id", bid).eq("id", emp.id), "updating employee");
  await audit(bid, ctx.employee.id, null, "employee.updated", "employee", emp.id, { fields: Object.keys(patch) });
  return ok({ updated: Object.keys(patch) });
}

async function hrTerminateEmployee(ctx: Ctx, b: any) {
  requireBusiness(ctx);
  const bid = ctx.business.id;
  const number = cleanId(b.employee_number, "employee_number");
  if (!isDate(b.employment_end)) throw new HttpError(400, "VALIDATION", "employment_end must be a date");
  const emp: any = must(await db.from("hol_employees").select("id,role,employment_start,status").eq("business_id", bid).eq("employee_number", number).maybeSingle(), "finding employee");
  if (!emp) throw new HttpError(404, "NOT_FOUND", "Employee not found");
  if (emp.role === "owner") throw new HttpError(400, "VALIDATION", "The owner account cannot be ended");
  if (emp.id === ctx.employee.id) throw new HttpError(400, "VALIDATION", "You cannot end your own employment");
  if (emp.role === "hr" && ctx.employee.role !== "owner") throw new HttpError(403, "FORBIDDEN", "Only the owner can end an HR user");
  if (emp.status === "terminated") throw new HttpError(409, "ALREADY_ENDED", "This employee has already left");
  if (b.employment_end < emp.employment_start) throw new HttpError(400, "VALIDATION", "The last day cannot be before the start date");
  const res = await db.rpc("hol_terminate_employee", { p_business: bid, p_employee: emp.id, p_end: b.employment_end, p_actor: ctx.employee.id });
  if (res.error) mapRpcError(res.error);
  return ok(res.data);
}

// ---------------------------------------------------------------- CSV import (validate everything, then create in small batches)
const IMPORT_ROLES = ["employee", "manager", "hr"];

function readImportRow(raw: any, ownerCreating: boolean): { row?: any; errors: { field: string; message: string }[] } {
  const errors: { field: string; message: string }[] = [];
  const number = String(raw?.employee_number ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9_-]{1,20}$/.test(number)) errors.push({ field: "employee_number", message: "Use 1 to 20 letters, numbers, - or _" });
  if (number === "OWNER") errors.push({ field: "employee_number", message: "OWNER is reserved" });
  const full = String(raw?.full_name ?? "").trim();
  if (!full || full.length > 100) errors.push({ field: "full_name", message: "Name is required (up to 100 characters)" });
  const email = String(raw?.email ?? "").trim();
  if (email && (!email.includes("@") || email.length > 200)) errors.push({ field: "email", message: "Email looks wrong" });
  const role = String(raw?.role ?? "").trim().toLowerCase() || "employee";
  if (!IMPORT_ROLES.includes(role)) errors.push({ field: "role", message: "Role must be employee, manager or hr" });
  else if (role === "hr" && !ownerCreating) errors.push({ field: "role", message: "Only the owner can create HR users" });
  const start = String(raw?.employment_start ?? "").trim();
  if (!isDate(start)) errors.push({ field: "employment_start", message: "Use YYYY-MM-DD" });
  const dept = String(raw?.department ?? "").trim();
  if (dept.length > 80) errors.push({ field: "department", message: "Department name is too long" });
  const mgr = String(raw?.manager_employee_number ?? "").trim().toUpperCase();
  if (errors.length) return { errors };
  return { errors, row: { employee_number: number, full_name: full, email: email || null, role, employment_start: start, department: dept || null, manager_employee_number: mgr || null } };
}

async function hrImportValidate(ctx: Ctx, b: any) {
  requireBusiness(ctx);
  const rows = Array.isArray(b.rows) ? b.rows : null;
  if (!rows || rows.length === 0 || rows.length > 1000) throw new HttpError(400, "VALIDATION", "Send between 1 and 1000 rows");
  const existing = new Set((await fetchAll<any>((a, z) => db.from("hol_employees").select("employee_number").eq("business_id", ctx.business.id).order("employee_number").range(a, z), "listing employees")).map((e) => e.employee_number));
  const errors: { row: number; field: string; message: string }[] = [];
  const inFile = new Map<string, string | null>();
  const parsed: any[] = [];
  rows.forEach((raw: any, i: number) => {
    const r = readImportRow(raw, ctx.employee.role === "owner");
    r.errors.forEach((e) => errors.push({ row: i + 1, ...e }));
    if (!r.row) return;
    if (existing.has(r.row.employee_number)) errors.push({ row: i + 1, field: "employee_number", message: "Already exists" });
    else if (inFile.has(r.row.employee_number)) errors.push({ row: i + 1, field: "employee_number", message: "Appears twice in the file" });
    inFile.set(r.row.employee_number, r.row.manager_employee_number);
    parsed.push({ i: i + 1, row: r.row });
  });
  for (const p of parsed) {
    const m = p.row.manager_employee_number;
    if (!m) continue;
    if (m === p.row.employee_number) errors.push({ row: p.i, field: "manager_employee_number", message: "Cannot manage themselves" });
    else if (!existing.has(m) && !inFile.has(m)) errors.push({ row: p.i, field: "manager_employee_number", message: `Manager ${m} not found` });
  }
  // loops inside the file
  for (const p of parsed) {
    let cur: string | null | undefined = p.row.manager_employee_number;
    for (let hops = 0; cur && hops < 50; hops++) {
      if (cur === p.row.employee_number) { errors.push({ row: p.i, field: "manager_employee_number", message: "Management loop" }); break; }
      cur = inFile.get(cur) ?? null;
    }
  }
  return ok({ valid: errors.length === 0, count: rows.length, error_count: errors.length, errors: errors.slice(0, 100) });
}

async function hrImportCreate(ctx: Ctx, b: any) {
  requireBusiness(ctx);
  const bid = ctx.business.id;
  const rows = Array.isArray(b.rows) ? b.rows : null;
  if (!rows || rows.length === 0 || rows.length > 50) throw new HttpError(400, "VALIDATION", "Send between 1 and 50 rows at a time");
  const sched: any = must(await db.from("hol_work_schedules").select("id").eq("business_id", bid).eq("name", "Standard Mon-Fri").maybeSingle(), "finding schedule");
  const pol: any = must(await db.from("hol_policies").select("id").eq("business_id", bid).eq("status", "active").order("version", { ascending: false }).limit(1).maybeSingle(), "finding policy");
  const depIds = new Map<string, string>();
  const created: any[] = [];
  const failed: any[] = [];
  for (const raw of rows) {
    const r = readImportRow(raw, ctx.employee.role === "owner");
    if (!r.row) { failed.push({ employee_number: String(raw?.employee_number ?? ""), message: r.errors[0].message }); continue; }
    const row = r.row;
    let departmentId: string | null = null;
    if (row.department) {
      if (!depIds.has(row.department)) {
        const dep: any = must(await db.from("hol_departments").upsert({ business_id: bid, name: row.department }, { onConflict: "business_id,name" }).select("id").single(), "saving department");
        depIds.set(row.department, dep.id);
      }
      departmentId = depIds.get(row.department)!;
    }
    const pin = makePin(6);
    const ins = await db.from("hol_employees").insert({
      business_id: bid, employee_number: row.employee_number, full_name: row.full_name, email: row.email, role: row.role,
      department_id: departmentId, employment_start: row.employment_start, pin_hash: await hashSecret(pin),
    }).select("id").single();
    if (ins.error) { failed.push({ employee_number: row.employee_number, message: ins.error.code === "23505" ? "Already exists" : "Could not save" }); continue; }
    const id = (ins.data as any).id;
    if (sched) await db.from("hol_schedule_assignments").insert({ business_id: bid, employee_id: id, schedule_id: sched.id, effective_from: row.employment_start });
    if (pol) await db.from("hol_policy_assignments").insert({ business_id: bid, employee_id: id, policy_id: pol.id, effective_from: row.employment_start });
    created.push({ employee_number: row.employee_number, full_name: row.full_name, pin });
  }
  await audit(bid, ctx.employee.id, null, "employee.imported", "business", bid, { created: created.length, failed: failed.length });
  return ok({ created, failed });
}

async function hrImportManagers(ctx: Ctx, b: any) {
  requireBusiness(ctx);
  const bid = ctx.business.id;
  const pairs = Array.isArray(b.pairs) ? b.pairs.slice(0, 200) : [];
  let set = 0;
  const failed: any[] = [];
  for (const p of pairs) {
    const n = cleanId(p.employee_number, "employee_number");
    const m = cleanId(p.manager_employee_number, "manager_employee_number");
    const rows: any[] = must(await db.from("hol_employees").select("id,employee_number").eq("business_id", bid).in("employee_number", [n, m]), "finding employees");
    const e = rows.find((r) => r.employee_number === n), g = rows.find((r) => r.employee_number === m);
    if (!e || !g || e.id === g.id) { failed.push({ employee_number: n, message: "Manager not found" }); continue; }
    must(await db.from("hol_employees").update({ manager_id: g.id }).eq("business_id", bid).eq("id", e.id), "setting manager");
    set++;
  }
  return ok({ set, failed });
}

// ---------------------------------------------------------------- dates, team limits, calendar (Step 6)
function todayIn(tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch { return today(); }
}
function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const fmtD = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
function chunks<T>(list: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

// How many people of the same department are already away on each of these dates, against the department's limit.
async function staffingCheck(bid: string, emp: any, dates: string[]) {
  const none = { limit: null as number | null, breaches: [] as { date: string; away: number }[] };
  if (!emp?.department_id || dates.length === 0) return none;
  const dep: any = must(await db.from("hol_departments").select("max_concurrent_absent").eq("business_id", bid).eq("id", emp.department_id).maybeSingle(), "loading team limit");
  const limit: number | null = dep?.max_concurrent_absent ?? null;
  if (!limit) return none;
  const mates = await fetchAll<any>((a, z) => db.from("hol_employees").select("id").eq("business_id", bid).eq("department_id", emp.department_id).eq("status", "active").neq("id", emp.id).order("id").range(a, z), "loading team");
  if (mates.length === 0) return { limit, breaches: [] };
  const sorted = [...dates].sort();
  const first = sorted[0], last = sorted[sorted.length - 1];
  const away = new Map<string, Set<string>>();
  for (const group of chunks(mates.map((m) => m.id), 100)) {
    const reqs: any[] = must(
      await db.from("hol_requests").select("id,employee_id").eq("business_id", bid).in("employee_id", group)
        .in("status", ["approved", "cancellation_pending"]).lte("start_date", last).gte("end_date", first),
      "loading team leave",
    );
    const owner = new Map(reqs.map((r) => [r.id, r.employee_id]));
    for (const ids of chunks(reqs.map((r) => r.id), 100)) {
      const days: any[] = must(await db.from("hol_request_days").select("request_id,leave_date").eq("business_id", bid).in("request_id", ids).gte("leave_date", first).lte("leave_date", last), "loading team days");
      for (const d of days) {
        if (!away.has(d.leave_date)) away.set(d.leave_date, new Set());
        away.get(d.leave_date)!.add(owner.get(d.request_id)!);
      }
    }
  }
  const breaches = sorted.filter((d) => (away.get(d)?.size ?? 0) + 1 > limit).map((d) => ({ date: d, away: away.get(d)?.size ?? 0 }));
  return { limit, breaches };
}
function staffingMessage(s: { limit: number | null; breaches: { date: string }[] }): string {
  const shown = s.breaches.slice(0, 3).map((b) => fmtD(b.date)).join(", ") + (s.breaches.length > 3 ? ` and ${s.breaches.length - 3} more` : "");
  return `The team limit of ${s.limit} ${s.limit === 1 ? "person" : "people"} away at once would be exceeded on ${shown}.`;
}

async function setupSaveDepartment(ctx: Ctx, b: any) {
  requireBusiness(ctx);
  const bid = ctx.business.id;
  const name = clean(b.name, 80, "name");
  let limit: number | null = null;
  if (b.max_concurrent_absent !== null && b.max_concurrent_absent !== undefined && b.max_concurrent_absent !== "") {
    limit = Math.floor(numIn(b.max_concurrent_absent, "max_concurrent_absent", 1, 1000));
  }
  const row: any = must(await db.from("hol_departments").upsert({ business_id: bid, name, max_concurrent_absent: limit }, { onConflict: "business_id,name" }).select("id").single(), "saving team");
  await audit(bid, ctx.employee.id, null, "department.saved", "department", row.id, { name, max_concurrent_absent: limit });
  return ok({ id: row.id });
}

async function calendarTeam(ctx: Ctx, b: any) {
  const bid = ctx.business.id;
  const me = ctx.employee;
  if (!isDate(b.from) || !isDate(b.to) || b.to < b.from) throw new HttpError(400, "VALIDATION", "from and to must be dates, with to not before from");
  const span = (Date.parse(b.to) - Date.parse(b.from)) / 86_400_000 + 1;
  if (span > 62) throw new HttpError(400, "VALIDATION", "The calendar can show up to 62 days at a time");
  const cols = "id,employee_number,full_name,manager_id,department_id,role";

  let people: any[];
  if (ctx.portal === "business") {
    people = await fetchAll<any>((a, z) => db.from("hol_employees").select(cols).eq("business_id", bid).eq("status", "active").neq("role", "owner").order("full_name").range(a, z), "loading people");
  } else if (me.role === "manager") {
    people = must(await db.from("hol_employees").select(cols).eq("business_id", bid).eq("status", "active").eq("manager_id", me.id).limit(300), "loading team");
  } else if (me.manager_id) {
    people = must(await db.from("hol_employees").select(cols).eq("business_id", bid).eq("status", "active").eq("manager_id", me.manager_id).limit(300), "loading team");
  } else if (me.department_id) {
    people = must(await db.from("hol_employees").select(cols).eq("business_id", bid).eq("status", "active").eq("department_id", me.department_id).limit(300), "loading team");
  } else people = [];
  if (ctx.portal !== "business" && !people.some((p) => p.id === me.id)) people.push({ id: me.id, employee_number: me.employee_number, full_name: me.full_name, manager_id: me.manager_id, department_id: me.department_id, role: me.role });
  people.sort((a, z) => String(a.full_name).localeCompare(String(z.full_name)));

  const byId = new Map(people.map((p) => [p.id, p]));
  const cells = new Map<string, { date: string; status: string; half: boolean }[]>();
  for (const group of chunks(people.map((p) => p.id), 100)) {
    const reqs: any[] = must(
      await db.from("hol_requests").select("id,employee_id,status").eq("business_id", bid).in("employee_id", group)
        .in("status", ["approved", "cancellation_pending", "pending"]).lte("start_date", b.to).gte("end_date", b.from),
      "loading leave",
    );
    // pending requests are private: only the person, their manager and the business portal see them
    const visible = reqs.filter((r) => r.status !== "pending" || ctx.portal === "business" || r.employee_id === me.id || byId.get(r.employee_id)?.manager_id === me.id);
    const info = new Map(visible.map((r) => [r.id, r]));
    for (const ids of chunks(visible.map((r) => r.id), 100)) {
      const days: any[] = must(await db.from("hol_request_days").select("request_id,leave_date,units").eq("business_id", bid).in("request_id", ids).gte("leave_date", b.from).lte("leave_date", b.to), "loading leave days");
      for (const d of days) {
        const r = info.get(d.request_id)!;
        if (!cells.has(r.employee_id)) cells.set(r.employee_id, []);
        cells.get(r.employee_id)!.push({ date: d.leave_date, status: r.status === "pending" ? "pending" : "approved", half: Number(d.units) < 1 });
      }
    }
  }

  const today = todayIn(ctx.business.timezone);
  for (const group of chunks(people.map((p) => p.id), 100)) {
    const sick: any[] = must(
      await db.from("hol_absence_records").select("employee_id,starts_on,ends_on").eq("business_id", bid).in("employee_id", group)
        .lte("starts_on", b.to).or(`ends_on.is.null,ends_on.gte.${b.from}`),
      "loading absences",
    );
    for (const r of sick) {
      const from = r.starts_on > b.from ? r.starts_on : b.from;
      const endRaw = r.ends_on ?? today;
      const to = endRaw < b.to ? endRaw : b.to;
      const seesReason = ctx.portal === "business" || r.employee_id === me.id || byId.get(r.employee_id)?.manager_id === me.id;
      for (let d = from; d <= to; d = addDays(d, 1)) {
        if (!isWeekday(d)) continue;
        if (!cells.has(r.employee_id)) cells.set(r.employee_id, []);
        cells.get(r.employee_id)!.push({ date: d, status: seesReason ? "sick" : "approved", half: false });
      }
    }
  }

  const calendar = me.calendar_code ?? ctx.business.region;
  const bh: any[] = must(await db.from("hol_bank_holidays").select("holiday_date").eq("calendar_code", calendar).gte("holiday_date", b.from).lte("holiday_date", b.to), "loading bank holidays");
  const ov: any[] = must(await db.from("hol_holiday_overrides").select("holiday_date,is_working_day").eq("business_id", bid).eq("calendar_code", calendar).gte("holiday_date", b.from).lte("holiday_date", b.to), "loading overrides");
  const holidays = [...buildHolidaySet(bh.map((r) => r.holiday_date), ov.map((r) => ({ date: r.holiday_date, isWorkingDay: r.is_working_day })))].sort();

  const days: string[] = [];
  for (let d = b.from; d <= b.to; d = addDays(d, 1)) days.push(d);
  return ok({
    from: b.from, to: b.to, days, holidays,
    people: people.map((p) => ({ employee_number: p.employee_number, full_name: p.full_name, is_me: p.id === me.id, cells: cells.get(p.id) ?? [] })),
  });
}

// ---------------------------------------------------------------- reports and audit (Step 7, business portal)
async function employeeDirectory(bid: string) {
  const emps = await fetchAll<any>((a, z) => db.from("hol_employees").select("id,employee_number,full_name,department_id,status").eq("business_id", bid).order("employee_number").range(a, z), "listing employees");
  const deps: any[] = must(await db.from("hol_departments").select("id,name").eq("business_id", bid), "loading departments");
  const depName = new Map(deps.map((d) => [d.id, d.name]));
  return new Map(emps.map((e) => [e.id, { number: e.employee_number, name: e.full_name, department: depName.get(e.department_id) ?? "", status: e.status }]));
}

async function reportsSummary(ctx: Ctx) {
  requireBusiness(ctx);
  const bid = ctx.business.id;
  const t = todayIn(ctx.business.timezone);
  const dir = await employeeDirectory(bid);

  const pendingReq = await db.from("hol_requests").select("id", { count: "exact", head: true }).eq("business_id", bid).eq("status", "pending");
  const pendingCancel = await db.from("hol_requests").select("id", { count: "exact", head: true }).eq("business_id", bid).eq("status", "cancellation_pending");

  const today: any[] = must(await db.from("hol_request_days").select("request_id,units").eq("business_id", bid).eq("leave_date", t).limit(1000), "loading today's leave");
  const away: { employee: string; number: string; part_day: boolean }[] = [];
  for (const ids of chunks(today.map((d) => d.request_id), 100)) {
    const reqs: any[] = must(await db.from("hol_requests").select("id,employee_id").eq("business_id", bid).in("id", ids).in("status", ["approved", "cancellation_pending", "completed"]), "loading today's requests");
    for (const r of reqs) {
      const e = dir.get(r.employee_id);
      const units = Number(today.find((d) => d.request_id === r.id)?.units ?? 1);
      if (e) away.push({ employee: e.name, number: e.number, part_day: units < 1 });
    }
  }
  const sickNow: any[] = must(await db.from("hol_absence_records").select("employee_id").eq("business_id", bid).lte("starts_on", t).or(`ends_on.is.null,ends_on.gte.${t}`).limit(1000), "loading absences");
  for (const s of sickNow) { const e = dir.get(s.employee_id); if (e && !away.some((a) => a.number === e.number)) away.push({ employee: e.name, number: e.number, part_day: false, sick: true } as any); }
  away.sort((a, z) => a.employee.localeCompare(z.employee));

  const upcomingRows: any[] = must(
    await db.from("hol_requests").select("employee_id,start_date,end_date,requested_units")
      .eq("business_id", bid).in("status", ["approved", "cancellation_pending"]).gt("start_date", t).lte("start_date", addDays(t, 14))
      .order("start_date").limit(50),
    "loading upcoming leave",
  );
  const upcoming = upcomingRows.map((r) => ({ employee: dir.get(r.employee_id)?.name ?? "", start_date: r.start_date, end_date: r.end_date, units: Number(r.requested_units) }));
  const active = [...dir.values()].filter((e) => e.status === "active").length;
  return ok({ today: t, headcount: active, pending_requests: pendingReq.count ?? 0, pending_cancellations: pendingCancel.count ?? 0, away_today: away, upcoming });
}

async function reportsBalances(ctx: Ctx, b: any) {
  requireBusiness(ctx);
  const bid = ctx.business.id;
  const year: any = must(await db.from("hol_leave_years").select("id,label").eq("business_id", bid).eq("label", clean(b.year_label, 20, "year_label")).maybeSingle(), "finding leave year");
  if (!year) throw new HttpError(404, "NOT_FOUND", "Leave year not found");
  const rows = await fetchAll<any>((a, z) => (db.rpc("hol_balance_report", { p_business: bid, p_year: year.id }) as any).range(a, z), "building balance report");
  const dir = await employeeDirectory(bid);
  const types: any[] = must(await db.from("hol_leave_types").select("id,name,unit").eq("business_id", bid), "loading leave types");
  const tById = new Map(types.map((t) => [t.id, t]));
  const dept = b.department ? String(b.department) : "";
  const out = rows.map((r) => ({ e: dir.get(r.emp_id), t: tById.get(r.type_id), r }))
    .filter((x) => x.e && x.t && (!dept || x.e.department === dept))
    .map((x) => ({
      employee_number: x.e!.number, full_name: x.e!.name, department: x.e!.department, status: x.e!.status,
      leave_type: x.t!.name, unit: x.t!.unit, leave_year: year.label,
      entitlement: r4(Number(x.r.entitlement)), booked: r4(Number(x.r.booked)), taken: r4(Number(x.r.taken)), expired: r4(Number(x.r.expired)),
      pending: r4(Number(x.r.pending)), available: r4(Number(x.r.available)),
    }))
    .sort((a, z) => a.employee_number.localeCompare(z.employee_number) || a.leave_type.localeCompare(z.leave_type));
  return ok({ rows: out });
}

async function reportsAbsence(ctx: Ctx, b: any) {
  requireBusiness(ctx);
  const bid = ctx.business.id;
  if (!isDate(b.from) || !isDate(b.to) || b.to < b.from) throw new HttpError(400, "VALIDATION", "from and to must be dates, with to not before from");
  if ((Date.parse(b.to) - Date.parse(b.from)) / 86_400_000 > 366) throw new HttpError(400, "VALIDATION", "Choose a range of up to a year");
  const allowed = ["pending", "approved", "completed", "cancellation_pending", "rejected", "cancelled"];
  const statuses: string[] = Array.isArray(b.statuses) && b.statuses.length ? b.statuses.filter((s: string) => allowed.includes(s)) : ["approved", "completed", "cancellation_pending"];
  const reqs = await fetchAll<any>((a, z) => db.from("hol_requests")
    .select("id,employee_id,leave_type_id,status,start_date,end_date,start_half,end_half,requested_units,submitted_at,decided_at")
    .eq("business_id", bid).in("status", statuses).lte("start_date", b.to).gte("end_date", b.from).order("start_date").order("id").range(a, z), "loading requests");
  const dir = await employeeDirectory(bid);
  const types: any[] = must(await db.from("hol_leave_types").select("id,name,unit").eq("business_id", bid), "loading leave types");
  const tById = new Map(types.map((t) => [t.id, t]));
  const dept = b.department ? String(b.department) : "";
  const rows = reqs.map((r) => ({ r, e: dir.get(r.employee_id), t: tById.get(r.leave_type_id) }))
    .filter((x) => x.e && (!dept || x.e.department === dept))
    .map((x) => ({
      employee_number: x.e!.number, full_name: x.e!.name, department: x.e!.department, leave_type: x.t?.name ?? "", unit: x.t?.unit ?? "days",
      status: x.r.status, start_date: x.r.start_date, end_date: x.r.end_date, start_half: x.r.start_half, end_half: x.r.end_half,
      units: Number(x.r.requested_units), submitted_at: x.r.submitted_at, decided_at: x.r.decided_at,
    }));
  return ok({ rows });
}

async function auditList(ctx: Ctx, b: any) {
  requireBusiness(ctx);
  const bid = ctx.business.id;
  const limit = Math.min(Math.max(Number(b.limit) || 50, 1), 100);
  const offset = Math.max(Number(b.offset) || 0, 0);
  let q: any = db.from("hol_audit_log").select("id,actor_id,actor_label,action,entity_type,entity_id,changes,created_at", { count: "exact" }).eq("business_id", bid);
  if (b.action_prefix) {
    const a = String(b.action_prefix);
    if (!/^[a-z_.]{1,60}$/.test(a)) throw new HttpError(400, "VALIDATION", "action_prefix may only use lower-case letters, . and _");
    q = q.like("action", a + "%");
  }
  if (b.entity_type) {
    const t = String(b.entity_type);
    if (!/^[a-z_]{1,40}$/.test(t)) throw new HttpError(400, "VALIDATION", "entity_type is not valid");
    q = q.eq("entity_type", t);
  }
  if (b.actor_employee_number) {
    const who: any = must(await db.from("hol_employees").select("id").eq("business_id", bid).eq("employee_number", cleanId(b.actor_employee_number, "actor_employee_number")).maybeSingle(), "finding employee");
    if (!who) return ok({ rows: [], total: 0 });
    q = q.eq("actor_id", who.id);
  }
  if (b.from) { if (!isDate(b.from)) throw new HttpError(400, "VALIDATION", "from must be a date"); q = q.gte("created_at", b.from + "T00:00:00Z"); }
  if (b.to) { if (!isDate(b.to)) throw new HttpError(400, "VALIDATION", "to must be a date"); q = q.lt("created_at", addDays(b.to, 1) + "T00:00:00Z"); }
  const res = await q.order("created_at", { ascending: false }).order("id").range(offset, offset + limit - 1);
  if (res.error) { console.error("audit", res.error); throw new HttpError(500, "DB_ERROR", "Database error while reading the audit log"); }
  const rows: any[] = res.data ?? [];
  const actorIds = [...new Set(rows.map((r) => r.actor_id).filter(Boolean))];
  const names = new Map<string, string>();
  for (const ids of chunks(actorIds, 100)) {
    const es: any[] = must(await db.from("hol_employees").select("id,full_name,employee_number").eq("business_id", bid).in("id", ids), "loading names");
    es.forEach((e) => names.set(e.id, `${e.full_name} (${e.employee_number})`));
  }
  return ok({
    total: res.count ?? rows.length,
    rows: rows.map((r) => ({ id: r.id, at: r.created_at, actor: r.actor_id ? (names.get(r.actor_id) ?? "Former user") : (r.actor_label ?? "System"), action: r.action, entity_type: r.entity_type, entity_id: r.entity_id, changes: r.changes })),
  });
}

// ---------------------------------------------------------------- sickness, carry-over, email, jobs (Step 8)
const SICK_REASONS = ["illness", "injury", "appointment", "other"];

const isWeekday = (iso: string) => { const d = new Date(iso + "T00:00:00Z").getUTCDay(); return d !== 0 && d !== 6; };
function weekdaysBetween(from: string, to: string): number {
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (isWeekday(d)) n++;
  return n;
}

async function insertSickness(ctx: Ctx, employee: any, starts: string, ends: string | null, reason: string | null, details: string | null) {
  const bid = ctx.business.id;
  const res = await db.from("hol_absence_records").insert({
    business_id: bid, employee_id: employee.id, starts_on: starts, ends_on: ends, reason_code: reason, details, recorded_by: ctx.employee.id,
  }).select("id").single();
  if (res.error) {
    if (res.error.code === "23P01") throw new HttpError(409, "OVERLAP", "There is already a sickness record covering these dates");
    console.error("sickness", res.error);
    throw new HttpError(500, "DB_ERROR", "Database error");
  }
  const id = (res.data as any).id;
  // the audit log and notifications deliberately carry no reason or details
  await audit(bid, ctx.employee.id, null, "sickness.recorded", "employee", employee.id, { starts_on: starts, ends_on: ends });
  if (employee.manager_id) {
    await db.from("hol_notifications").insert({
      business_id: bid, employee_id: employee.manager_id, title: "Absence reported",
      body: `${employee.full_name} has reported an absence from ${fmtD(starts)}`,
    });
  }
  return id as string;
}

async function sicknessReport(ctx: Ctx, b: any) {
  requireStaff(ctx);
  const t = todayIn(ctx.business.timezone);
  const starts = b.starts_on ? b.starts_on : t;
  const ends = b.ends_on ? b.ends_on : null;
  if (!isDate(starts) || (ends !== null && !isDate(ends))) throw new HttpError(400, "VALIDATION", "Dates must be YYYY-MM-DD");
  if (starts > t) throw new HttpError(400, "VALIDATION", "An absence cannot start in the future");
  if (ends !== null && (ends < starts || ends > t)) throw new HttpError(400, "VALIDATION", "The last day must be between the first day and today");
  const id = await insertSickness(ctx, ctx.employee, starts, ends, null, null);
  return ok({ id });
}

async function sicknessRecord(ctx: Ctx, b: any) {
  requireBusiness(ctx);
  const bid = ctx.business.id;
  const emp: any = must(await db.from("hol_employees").select("id,full_name,manager_id").eq("business_id", bid).eq("employee_number", cleanId(b.employee_number, "employee_number")).maybeSingle(), "finding employee");
  if (!emp) throw new HttpError(404, "NOT_FOUND", "Employee not found");
  if (!isDate(b.starts_on) || (b.ends_on && !isDate(b.ends_on)) || (b.ends_on && b.ends_on < b.starts_on)) throw new HttpError(400, "VALIDATION", "Dates must be valid, with the last day not before the first");
  const reason = b.reason_code ? String(b.reason_code) : null;
  if (reason && !SICK_REASONS.includes(reason)) throw new HttpError(400, "VALIDATION", "Unknown reason");
  const details = b.details ? clean(b.details, 500, "details") : null;
  const id = await insertSickness(ctx, emp, b.starts_on, b.ends_on || null, reason, details);
  return ok({ id });
}

async function sicknessClose(ctx: Ctx, b: any) {
  const bid = ctx.business.id;
  const id = uuidOf(b.id, "id");
  const rec: any = must(await db.from("hol_absence_records").select("id,employee_id,starts_on,ends_on").eq("business_id", bid).eq("id", id).maybeSingle(), "loading record");
  if (!rec || (ctx.portal === "staff" && rec.employee_id !== ctx.employee.id)) throw new HttpError(404, "NOT_FOUND", "Record not found");
  if (ctx.portal === "business") requireBusiness(ctx); else requireStaff(ctx);
  if (rec.ends_on) throw new HttpError(409, "ALREADY_CLOSED", "This absence has already ended");
  const t = todayIn(ctx.business.timezone);
  const ends = b.ends_on ? b.ends_on : t;
  if (!isDate(ends) || ends < rec.starts_on || ends > t) throw new HttpError(400, "VALIDATION", "The last day must be between the first day and today");
  must(await db.from("hol_absence_records").update({ ends_on: ends }).eq("business_id", bid).eq("id", id), "closing absence");
  await audit(bid, ctx.employee.id, null, "sickness.ended", "employee", rec.employee_id, { ends_on: ends });
  return ok();
}

// Business portal: everything. A manager: their team's dates only. An employee: their own record.
async function sicknessList(ctx: Ctx, b: any) {
  const bid = ctx.business.id;
  const limit = Math.min(Math.max(Number(b.limit) || 50, 1), 200);
  const offset = Math.max(Number(b.offset) || 0, 0);
  const cols = "id,employee_id,starts_on,ends_on,reason_code,details";
  let q: any = db.from("hol_absence_records").select(cols).eq("business_id", bid).order("starts_on", { ascending: false }).order("id").range(offset, offset + limit - 1);
  let full = false;
  if (ctx.portal === "business") {
    requireBusiness(ctx);
    full = true;
    if (b.employee_number) {
      const e: any = must(await db.from("hol_employees").select("id").eq("business_id", bid).eq("employee_number", cleanId(b.employee_number, "employee_number")).maybeSingle(), "finding employee");
      if (!e) return ok({ rows: [] });
      q = q.eq("employee_id", e.id);
    }
    if (b.open_only === true) q = q.is("ends_on", null);
  } else if (ctx.employee.role === "manager") {
    const team: any[] = must(await db.from("hol_employees").select("id").eq("business_id", bid).eq("manager_id", ctx.employee.id).limit(500), "loading team");
    const ids = [...team.map((t) => t.id), ctx.employee.id];
    q = q.in("employee_id", ids.slice(0, 200));
  } else {
    full = true;
    q = q.eq("employee_id", ctx.employee.id);
  }
  const recs: any[] = must(await q, "listing absences");
  const emps: any[] = recs.length ? must(await db.from("hol_employees").select("id,employee_number,full_name").eq("business_id", bid).in("id", [...new Set(recs.map((r) => r.employee_id))].slice(0, 200)), "loading names") : [];
  const nm = new Map(emps.map((e) => [e.id, e]));
  return ok({
    rows: recs.map((r) => {
      const showAll = full || r.employee_id === ctx.employee.id;
      return {
        id: r.id, employee_number: nm.get(r.employee_id)?.employee_number, employee: nm.get(r.employee_id)?.full_name,
        starts_on: r.starts_on, ends_on: r.ends_on, own: r.employee_id === ctx.employee.id,
        reason_code: showAll ? r.reason_code : null, details: showAll ? r.details : null,
      };
    }),
  });
}

async function reportsSickness(ctx: Ctx, b: any) {
  requireBusiness(ctx);
  const bid = ctx.business.id;
  if (!isDate(b.from) || !isDate(b.to) || b.to < b.from) throw new HttpError(400, "VALIDATION", "from and to must be dates, with to not before from");
  if ((Date.parse(b.to) - Date.parse(b.from)) / 86_400_000 > 366) throw new HttpError(400, "VALIDATION", "Choose a range of up to a year");
  const recs = await fetchAll<any>((a, z) => db.from("hol_absence_records").select("id,employee_id,starts_on,ends_on,reason_code")
    .eq("business_id", bid).lte("starts_on", b.to).or(`ends_on.is.null,ends_on.gte.${b.from}`).order("starts_on").order("id").range(a, z), "loading absences");
  const dir = await employeeDirectory(bid);
  const dept = b.department ? String(b.department) : "";
  const t = todayIn(ctx.business.timezone);
  const rows = recs.map((r) => ({ r, e: dir.get(r.employee_id) })).filter((x) => x.e && (!dept || x.e.department === dept)).map((x) => {
    const from = x.r.starts_on > b.from ? x.r.starts_on : b.from;
    const endRaw = x.r.ends_on ?? t;
    const to = endRaw < b.to ? endRaw : b.to;
    return {
      employee_number: x.e!.number, full_name: x.e!.name, department: x.e!.department, starts_on: x.r.starts_on, ends_on: x.r.ends_on,
      reason_code: x.r.reason_code, weekdays_in_range: to >= from ? weekdaysBetween(from, to) : 0, ongoing: x.r.ends_on === null,
    };
  });
  return ok({ rows });
}

async function hrCarryOver(ctx: Ctx, b: any) {
  requireBusiness(ctx);
  const bid = ctx.business.id;
  const find = async (label: unknown) => {
    const y: any = must(await db.from("hol_leave_years").select("id").eq("business_id", bid).eq("label", clean(label, 20, "year")).maybeSingle(), "finding leave year");
    if (!y) throw new HttpError(404, "NOT_FOUND", "Leave year not found");
    return y.id as string;
  };
  const from = await find(b.from_year_label), to = await find(b.to_year_label);
  if (from === to) throw new HttpError(400, "VALIDATION", "Choose two different leave years");
  const res = await db.rpc("hol_carry_over", { p_business: bid, p_from: from, p_to: to, p_actor: ctx.employee.id });
  if (res.error) mapRpcError(res.error);
  return ok(res.data);
}

async function setupSaveBusiness(ctx: Ctx, b: any) {
  requireBusiness(ctx);
  const settings = { ...(ctx.business.settings ?? {}) };
  let changed = false;
  if (typeof b.email_notifications === "boolean") { settings.email_enabled = b.email_notifications; changed = true; }
  if (b.retention_years !== undefined) {
    const n = b.retention_years === null || b.retention_years === "" ? 0 : numIn(b.retention_years, "retention_years", 0, 15);
    if (n > 0) settings.retention_years = n; else delete settings.retention_years;
    changed = true;
  }
  if (!changed) throw new HttpError(400, "VALIDATION", "Nothing to change");
  must(await db.from("hol_businesses").update({ settings }).eq("id", ctx.business.id), "saving settings");
  await audit(ctx.business.id, ctx.employee.id, null, "business.settings_changed", "business", ctx.business.id, { email_enabled: settings.email_enabled, retention_years: settings.retention_years ?? null });
  return ok({ email_enabled: settings.email_enabled, retention_years: settings.retention_years ?? null });
}

// ---- email: every in-app notification is also emailed when the business has switched email on
const EMAIL_API_KEY = Deno.env.get("EMAIL_API_KEY") ?? "";
const EMAIL_FROM = Deno.env.get("EMAIL_FROM") ?? "";
const EMAIL_API_URL = Deno.env.get("EMAIL_API_URL") ?? "https://api.resend.com/emails";

async function processEmails() {
  if (!EMAIL_API_KEY || !EMAIL_FROM) return { configured: false, sent: 0, failed: 0, skipped: 0 };
  const businesses: any[] = must(
    await db.from("hol_businesses").select("id,name,slug").eq("status", "active").eq("settings->>email_enabled", "true"),
    "loading businesses",
  );
  let sent = 0, failed = 0, skipped = 0;
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  for (const biz of businesses) {
    const notes: any[] = must(
      await db.from("hol_notifications").select("id,employee_id,title,body").eq("business_id", biz.id).is("emailed_at", null).gte("created_at", since).order("created_at").limit(100),
      "loading notifications",
    );
    if (!notes.length) continue;
    const emps: any[] = must(await db.from("hol_employees").select("id,email,role,status").eq("business_id", biz.id).in("id", [...new Set(notes.map((n) => n.employee_id))]), "loading recipients");
    const byId = new Map(emps.map((e) => [e.id, e]));
    for (const n of notes) {
      const e = byId.get(n.employee_id);
      if (!e || !e.email || e.status !== "active") {
        await db.from("hol_notifications").update({ emailed_at: new Date().toISOString() }).eq("id", n.id);
        skipped++;
        continue;
      }
      const base = e.role === "hr" || e.role === "owner" ? BUSINESS_BASE_URL : STAFF_BASE_URL;
      const link = `${base}${base.includes("?") ? "&" : "?"}b=${encodeURIComponent(biz.slug)}`;
      try {
        const res = await fetch(EMAIL_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${EMAIL_API_KEY}` },
          body: JSON.stringify({ from: EMAIL_FROM, to: [e.email], subject: n.title, text: `${n.body ?? ""}\n\nOpen CBSystem - Employee Management: ${link}` }),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          await db.from("hol_notifications").update({ emailed_at: new Date().toISOString() }).eq("id", n.id);
          sent++;
        } else { failed++; console.error("email status", res.status); }
      } catch (err) { failed++; console.error("email error", String(err)); }
    }
  }
  return { configured: true, sent, failed, skipped };
}

async function adminRunJobs(b: any) {
  const today = b.today && isDate(b.today) ? b.today : null;
  const res = await db.rpc("hol_run_daily_jobs", { p_today: today });
  if (res.error) { console.error("jobs", res.error); throw new HttpError(500, "DB_ERROR", "The daily jobs failed"); }
  return ok({ jobs: res.data, email: await processEmails() });
}

// ---------------------------------------------------------------- hardening (Step 9)
const THROTTLE_WINDOW = 900; // 15 minutes

// The address of the nearest proxy's client: the last entry, because a caller can add earlier ones themselves.
function clientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return "unknown";
}
async function throttleBlocked(key: string, limit: number): Promise<boolean> {
  const r = await db.rpc("hol_throttle_blocked", { p_key: key, p_limit: limit, p_secs: THROTTLE_WINDOW });
  if (r.error) { console.error("throttle check", r.error); return false; } // never lock everyone out because of a fault here
  return r.data === true;
}
async function throttleFail(key: string) {
  const r = await db.rpc("hol_throttle_fail", { p_key: key, p_secs: THROTTLE_WINDOW });
  if (r.error) console.error("throttle record", r.error);
}

async function hrExportEmployee(ctx: Ctx, b: any) {
  requireBusiness(ctx);
  const bid = ctx.business.id;
  const emp: any = must(
    await db.from("hol_employees").select("id,employee_number,full_name,email,role,status,department_id,manager_id,calendar_code,employment_start,employment_end,anonymised_at,created_at").eq("business_id", bid).eq("employee_number", cleanId(b.employee_number, "employee_number")).maybeSingle(),
    "finding employee",
  );
  if (!emp) throw new HttpError(404, "NOT_FOUND", "Employee not found");
  const requests = await fetchAll<any>((a, z) => db.from("hol_requests").select("id,leave_type_id,status,start_date,end_date,start_half,end_half,requested_units,comment,submitted_at,decided_at").eq("business_id", bid).eq("employee_id", emp.id).order("start_date").order("id").range(a, z), "loading requests");
  const days: any[] = [];
  for (const ids of chunks(requests.map((r) => r.id), 100)) {
    days.push(...must(await db.from("hol_request_days").select("request_id,leave_date,units").eq("business_id", bid).in("request_id", ids), "loading days") as any[]);
  }
  const ledger = await fetchAll<any>((a, z) => db.from("hol_ledger").select("leave_type_id,leave_year_id,request_id,entry_type,quantity,effective_date,note,created_at").eq("business_id", bid).eq("employee_id", emp.id).order("created_at").order("id").range(a, z), "loading ledger");
  const absences = must(await db.from("hol_absence_records").select("starts_on,ends_on,reason_code,details,created_at").eq("business_id", bid).eq("employee_id", emp.id).order("starts_on"), "loading absences") as any[];
  const notifications = must(await db.from("hol_notifications").select("title,body,created_at,read_at").eq("business_id", bid).eq("employee_id", emp.id).order("created_at").limit(2000), "loading notifications") as any[];
  const about = must(await db.from("hol_audit_log").select("action,entity_type,changes,created_at,actor_label").eq("business_id", bid).eq("entity_id", emp.id).order("created_at").limit(2000), "loading audit") as any[];
  const by = must(await db.from("hol_audit_log").select("action,entity_type,entity_id,changes,created_at").eq("business_id", bid).eq("actor_id", emp.id).order("created_at").limit(2000), "loading audit") as any[];
  const decisions = must(await db.from("hol_approval_decisions").select("step_id,decision,comment,created_at").eq("business_id", bid).eq("actor_id", emp.id).order("created_at").limit(2000), "loading decisions") as any[];
  await audit(bid, ctx.employee.id, null, "employee.exported", "employee", emp.id);
  return ok({
    exported_at: new Date().toISOString(),
    employee: emp,
    leave_requests: requests.map((r) => ({ ...r, days: days.filter((d) => d.request_id === r.id).map((d) => ({ date: d.leave_date, units: Number(d.units) })) })),
    ledger, absences, notifications, audit_entries_about_them: about, audit_entries_by_them: by, approval_decisions: decisions,
  });
}

async function hrAnonymiseEmployee(ctx: Ctx, b: any) {
  requireBusiness(ctx);
  const bid = ctx.business.id;
  const emp: any = must(await db.from("hol_employees").select("id").eq("business_id", bid).eq("employee_number", cleanId(b.employee_number, "employee_number")).maybeSingle(), "finding employee");
  if (!emp) throw new HttpError(404, "NOT_FOUND", "Employee not found");
  const res = await db.rpc("hol_anonymise_employee", { p_business: bid, p_employee: emp.id, p_actor: ctx.employee.id });
  if (res.error) mapRpcError(res.error);
  return ok(res.data);
}

async function adminReconcile(b: any) {
  const res = await db.rpc("hol_reconcile_balances", { p_business: null });
  if (res.error) { console.error("reconcile", res.error); throw new HttpError(500, "DB_ERROR", "Reconciliation failed"); }
  const rows: any[] = res.data ?? [];
  let fixed = 0;
  if (b.fix === true) {
    for (const r of rows) {
      const f = await db.rpc("hol_refresh_balance", { p_business: r.business_id, p_employee: r.employee_id, p_type: r.leave_type_id, p_year: r.leave_year_id });
      if (!f.error) fixed++;
    }
  }
  return ok({ mismatches: rows.length, fixed, examples: rows.slice(0, 20) });
}

// ---------------------------------------------------------------- own PIN (any signed-in person)
async function changePin(ctx: Ctx, b: any) {
  const current = String(b.current_pin ?? "");
  const next = String(b.new_pin ?? "");
  if (!/^\d{6}$/.test(next)) throw new HttpError(400, "VALIDATION", "The new PIN must be 6 digits");
  if (/^(\d)\1{5}$/.test(next) || next === "123456" || next === "654321") {
    throw new HttpError(400, "VALIDATION", "Please choose a less obvious PIN");
  }
  if (next === current) throw new HttpError(400, "VALIDATION", "The new PIN must be different from the current one");

  const emp: any = must(
    await db.from("hol_employees").select("id,employee_number,pin_hash,pin_attempts,locked_until")
      .eq("business_id", ctx.business.id).eq("id", ctx.employee.id).maybeSingle(),
    "loading employee",
  );
  if (!emp) throw new HttpError(404, "NOT_FOUND", "Employee not found");
  if (emp.locked_until && new Date(emp.locked_until) > new Date()) {
    throw new HttpError(429, "LOCKED", "Too many attempts. Please try again later.");
  }
  if (!(await verifySecret(current, emp.pin_hash))) {
    const attempts = emp.pin_attempts + 1;
    const patch: Record<string, unknown> = { pin_attempts: attempts };
    if (attempts >= MAX_PIN_ATTEMPTS) {
      patch.pin_attempts = 0;
      patch.locked_until = new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString();
    }
    await db.from("hol_employees").update(patch).eq("id", emp.id);
    throw new HttpError(401, "INVALID_PIN", "Your current PIN is not correct");
  }

  const hash = await hashSecret(next);
  must(await db.from("hol_employees").update({ pin_hash: hash, pin_attempts: 0, locked_until: null }).eq("business_id", ctx.business.id).eq("id", emp.id), "saving PIN");
  if (emp.employee_number === "OWNER") {
    must(await db.from("hol_businesses").update({ owner_pin_hash: hash }).eq("id", ctx.business.id), "saving owner PIN");
  }
  // sign out every other session of this person
  must(await db.from("hol_sessions").delete().eq("business_id", ctx.business.id).eq("employee_id", emp.id).neq("id", ctx.sessionId), "ending other sessions");
  await audit(ctx.business.id, emp.id, null, "employee.pin_changed", "employee", emp.id);
  return ok();
}

// ---------------------------------------------------------------- notifications (any signed-in person)
async function notificationsList(ctx: Ctx, b: any) {
  const limit = Math.min(Math.max(Number(b.limit) || 30, 1), 100);
  let q: any = db.from("hol_notifications").select("id,title,body,request_id,read_at,created_at")
    .eq("business_id", ctx.business.id).eq("employee_id", ctx.employee.id)
    .order("created_at", { ascending: false }).limit(limit);
  if (b.unread_only === true) q = q.is("read_at", null);
  const rows: any[] = must(await q, "listing notifications");
  const cnt = await db.from("hol_notifications").select("id", { count: "exact", head: true })
    .eq("business_id", ctx.business.id).eq("employee_id", ctx.employee.id).is("read_at", null);
  if (cnt.error) { console.error("count notifications", cnt.error); throw new HttpError(500, "DB_ERROR", "Database error while counting notifications"); }
  return ok({ notifications: rows, unread_count: cnt.count ?? 0 });
}

async function notificationsMarkRead(ctx: Ctx, b: any) {
  let q: any = db.from("hol_notifications").update({ read_at: new Date().toISOString() })
    .eq("business_id", ctx.business.id).eq("employee_id", ctx.employee.id).is("read_at", null);
  if (b.all !== true) {
    const ids = Array.isArray(b.ids) ? b.ids.slice(0, 100).map((i: unknown) => uuidOf(i, "ids")) : [];
    if (ids.length === 0) throw new HttpError(400, "VALIDATION", "Give ids or all:true");
    q = q.in("id", ids);
  }
  must(await q, "marking notifications");
  return ok();
}

// ---------------------------------------------------------------- entry point
async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok");
  if (req.method !== "POST") return reply(405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Use POST" } });

  if (Number(req.headers.get("content-length") ?? 0) > 2_000_000) {
    return reply(413, { ok: false, error: { code: "TOO_LARGE", message: "That request is too large" } });
  }
  let body: any;
  try {
    body = await req.json();
  } catch {
    return reply(400, { ok: false, error: { code: "BAD_JSON", message: "Invalid JSON" } });
  }
  const action = String(body?.action ?? "");

  try {
    if (action.startsWith("admin.")) {
      const key = `admin:${clientIp(req)}`;
      if (await throttleBlocked(key, 20)) throw new HttpError(429, "TOO_MANY", "Too many failed attempts. Please wait 15 minutes.");
      try { return await adminRoute(action, body, req); }
      catch (e) { if (e instanceof HttpError && e.code === "UNAUTHORISED") await throttleFail(key); throw e; }
    }
    if (action === "staff.login" || action === "business.login") {
      const slug = String(body.slug ?? "").trim().slice(0, 60);
      const byAddress = `login:${slug}:${clientIp(req)}`, bySlug = `login-slug:${slug}`;
      if ((await throttleBlocked(byAddress, 20)) || (await throttleBlocked(bySlug, 300))) {
        throw new HttpError(429, "TOO_MANY", "Too many sign-in attempts. Please wait 15 minutes and try again.");
      }
      try { return await login(body, action === "staff.login" ? "staff" : "business"); }
      catch (e) { if (e instanceof HttpError && e.code === "INVALID_LOGIN") { await throttleFail(byAddress); await throttleFail(bySlug); } throw e; }
    }

    const ctx = await authenticate(req);
    switch (action) {
      case "staff.me": return staffMe(ctx);
      case "staff.logout": return await staffLogout(ctx);
      case "hr.create_employee": return await hrCreateEmployee(ctx, body);
      case "hr.reset_pin": return await hrResetPin(ctx, body);
      case "hr.list_employees": return await hrListEmployees(ctx);
      case "reports.summary": return await reportsSummary(ctx);
      case "reports.balances": return await reportsBalances(ctx, body);
      case "reports.absence": return await reportsAbsence(ctx, body);
      case "audit.list": return await auditList(ctx, body);
      case "setup.overview": return await setupOverview(ctx);
      case "setup.save_business": return await setupSaveBusiness(ctx, body);
      case "hr.carry_over": return await hrCarryOver(ctx, body);
      case "hr.export_employee": return await hrExportEmployee(ctx, body);
      case "hr.anonymise_employee": return await hrAnonymiseEmployee(ctx, body);
      case "sickness.report": return await sicknessReport(ctx, body);
      case "sickness.record": return await sicknessRecord(ctx, body);
      case "sickness.close": return await sicknessClose(ctx, body);
      case "sickness.list": return await sicknessList(ctx, body);
      case "reports.sickness": return await reportsSickness(ctx, body);
      case "setup.save_department": return await setupSaveDepartment(ctx, body);
      case "setup.add_year": return await setupAddYear(ctx, body);
      case "setup.save_policy": return await setupSavePolicy(ctx, body);
      case "setup.assign_policy": return await setupAssignPolicy(ctx, body);
      case "setup.save_schedule": return await setupSaveSchedule(ctx, body);
      case "setup.assign_schedule": return await setupAssignSchedule(ctx, body);
      case "setup.save_leave_type": return await setupSaveLeaveType(ctx, body);
      case "setup.add_override": return await setupAddOverride(ctx, body);
      case "setup.remove_override": return await setupRemoveOverride(ctx, body);
      case "hr.update_employee": return await hrUpdateEmployee(ctx, body);
      case "hr.terminate_employee": return await hrTerminateEmployee(ctx, body);
      case "hr.import_validate": return await hrImportValidate(ctx, body);
      case "hr.import_create": return await hrImportCreate(ctx, body);
      case "hr.import_managers": return await hrImportManagers(ctx, body);
      case "hr.allocate_year": return await hrAllocateYear(ctx, body);
      case "hr.allocate": return await hrAllocate(ctx, body);
      case "hr.balances": return await hrBalances(ctx, body);
      case "leave.types": return await leaveTypes(ctx);
      case "leave.preview": return await leavePreview(ctx, body);
      case "leave.submit": return await leaveSubmit(ctx, body);
      case "leave.cancel": return await leaveCancel(ctx, body);
      case "leave.my_requests": return await leaveMyRequests(ctx, body);
      case "leave.balances": return await leaveBalances(ctx);
      case "approvals.inbox": return await approvalsInbox(ctx, body);
      case "approvals.detail": return await approvalsDetail(ctx, body);
      case "approvals.decide": return await approvalsDecide(ctx, body);
      case "approvals.delegate": return await approvalsDelegate(ctx, body);
      case "approvals.delegations": return await approvalsDelegations(ctx);
      case "approvals.remove_delegation": return await approvalsRemoveDelegation(ctx, body);
      case "staff.change_pin": return await changePin(ctx, body);
      case "calendar.team": return await calendarTeam(ctx, body);
      case "notifications.list": return await notificationsList(ctx, body);
      case "notifications.mark_read": return await notificationsMarkRead(ctx, body);
    }
    throw new HttpError(404, "UNKNOWN_ACTION", `Unknown action ${action}`);
  } catch (e) {
    if (e instanceof HttpError) {
      return reply(e.status, { ok: false, error: { code: e.code, message: e.message } });
    }
    console.error("unhandled", e);
    return reply(500, { ok: false, error: { code: "INTERNAL", message: "Something went wrong" } });
  }
}

Deno.serve(async (req) => {
  const res = await handle(req);
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsFor(req))) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
});
