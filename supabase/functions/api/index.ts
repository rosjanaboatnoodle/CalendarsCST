// Edge Function "api" ของระบบพนักงาน (Supabase project แยกจากแอปเช็คสต็อก)
// ตอนนี้มีปฏิทินตารางงาน (หลายสาขา) ระบบตอกบัตรจะเพิ่มเป็น action ใหม่ในไฟล์นี้
//
// Deploy: Supabase Dashboard -> Edge Functions -> create function named "api" ->
// paste this file's contents -> Deploy.
//
// Secrets (Dashboard -> Edge Functions -> Secrets):
//   SCHEDULE_SHEET_ID            id ของชีท "ระบบคิดเงินเดือนพนักงาน"
//   GOOGLE_SERVICE_ACCOUNT_JSON  key ของ Google service account (ทั้งไฟล์ JSON)
//                                ต้องแชร์ชีทให้อีเมล client_email ในไฟล์นี้เป็น Editor
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected by the platform.
//
// Every request is a POST with a JSON body: { action: "...", ...params }.
// Every response is JSON with at least an `ok` boolean.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// ============================================================
// Small helpers
// ============================================================

async function logAdmin(action: string, details: Record<string, unknown> = {}) {
  await supabase.from("admin_log").insert({ action, details });
}

async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const { data } = await supabase.from("app_settings").select("value").eq("key", key).maybeSingle();
  return (data?.value as T) ?? fallback;
}

async function setSetting(key: string, value: unknown) {
  await supabase.from("app_settings").upsert({ key, value, updated_at: new Date().toISOString() });
}

async function checkPassword(hash: string | null, plain: string): Promise<boolean> {
  if (!hash) return false;
  const { data, error } = await supabase.rpc("crypt_check", { plain, hash });
  if (error) { console.error("crypt_check error", error); return false; }
  return !!data;
}

async function hashPassword(plain: string): Promise<string> {
  const { data, error } = await supabase.rpc("crypt_hash", { plain });
  if (error) throw error;
  return data as string;
}

const ADMIN_PIN_KEY = "admin_pin_hash";

async function checkAdminPin(pin: string): Promise<boolean> {
  if (!pin) return false;
  return checkPassword(await getSetting<string | null>(ADMIN_PIN_KEY, null), pin);
}

function bangkokToday(): string {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
}

function sheetBool(v: unknown): boolean {
  const s = String(v ?? "").trim().toUpperCase();
  return s === "TRUE" || s === "1";
}

// Sheet dates show up as "2026-11-05" or D/M/YYYY ("5/11/2026"); returns ISO or null.
function parseSheetDate(s: string): string | null {
  const t = s.trim();
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:\s|$)/.exec(t);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s|$)/.exec(t);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  return null;
}

// ============================================================
// Google Sheets (REST + service-account JWT; the edge runtime has no googleapis SDK)
// ============================================================

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = 20000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw new Error(`request_timed_out_after_${timeoutMs}ms: ${url.split("?")[0]}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function base64url(bytes: Uint8Array | string): string {
  const arr = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let cachedGoogleToken: { token: string; exp: number } | null = null;

async function getGoogleAccessToken(): Promise<string> {
  if (cachedGoogleToken && cachedGoogleToken.exp > Date.now() / 1000 + 60) return cachedGoogleToken.token;
  const raw = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not configured");
  const sa = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const signInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const pemBody = String(sa.private_key)
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8", der.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signInput));
  const jwt = `${signInput}.${base64url(new Uint8Array(sig))}`;

  const res = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error_description || data?.error || `google_token_http_${res.status}`);
  cachedGoogleToken = { token: data.access_token, exp: now + (data.expires_in ?? 3600) };
  return data.access_token as string;
}

function scheduleSheetId(): string | null {
  return Deno.env.get("SCHEDULE_SHEET_ID") || null;
}

async function sheetsGetValues(spreadsheetId: string, range: string): Promise<string[][]> {
  const token = await getGoogleAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`;
  const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } }, 30000);
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `sheets_get_http_${res.status}`);
  return data.values ?? [];
}

async function sheetsSetRow(spreadsheetId: string, range: string, row: unknown[]): Promise<void> {
  const token = await getGoogleAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
  const res = await fetchWithTimeout(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [row] }),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data?.error?.message || `sheets_set_http_${res.status}`);
  }
}

async function sheetsAppendRow(spreadsheetId: string, range: string, row: unknown[]): Promise<void> {
  const token = await getGoogleAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [row] }),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data?.error?.message || `sheets_append_http_${res.status}`);
  }
}

// ============================================================
// Branches, staff and admin PINs
// The central admin PIN (app_settings.admin_pin_hash) can do everything. A branch may also have
// its own PIN, which can only save that branch's calendar days.
// ============================================================

type Branch = { id: string; name: string; sort: number; admin_pin_hash: string | null; sync_sheet: boolean };

async function getBranch(id: string): Promise<Branch | null> {
  if (!id) return null;
  const { data } = await supabase.from("branches").select("*").eq("id", id).maybeSingle();
  return (data as Branch) ?? null;
}

async function canEditBranch(branch: Branch, pin: string): Promise<boolean> {
  if (await checkAdminPin(pin)) return true;
  return !!pin && checkPassword(branch.admin_pin_hash, pin);
}

function cleanBranchId(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

// Public: branches with their active staff, for the calendar's branch picker and duty dropdown.
async function handleListBranches() {
  const { data: branches, error } = await supabase.from("branches")
    .select("id, name, sort, sync_sheet").order("sort").order("name");
  if (error) return json({ ok: false, error: error.message });
  const { data: staff } = await supabase.from("staff")
    .select("branch_id, name, label, short, sort").eq("active", true).order("sort").order("name");
  return json({
    ok: true,
    branches: (branches ?? []).map((b) => ({
      ...b,
      staff: (staff ?? []).filter((s) => s.branch_id === b.id)
        .map((s) => ({ name: s.name, label: s.label || s.name, short: s.short || s.name })),
    })),
  });
}

// Central admin only. Creates or updates a branch. `branch_pin`: "" leaves it, "-" clears it.
async function handleSaveBranch(p: Record<string, unknown>) {
  if (!(await checkAdminPin(String(p.admin_pin ?? "")))) return json({ ok: false, error: "wrong_admin_pin" });
  const name = String(p.name ?? "").trim();
  const id = cleanBranchId(String(p.id ?? "") || name);
  if (!name) return json({ ok: false, error: "missing_name" });
  if (!id) return json({ ok: false, error: "bad_branch_id" });
  const row: Record<string, unknown> = { id, name };
  if (p.sort !== undefined) row.sort = Number(p.sort) || 0;
  const pin = String(p.branch_pin ?? "").trim();
  if (pin === "-") row.admin_pin_hash = null;
  else if (pin) {
    if (pin.length < 4) return json({ ok: false, error: "pin_too_short" });
    row.admin_pin_hash = await hashPassword(pin);
  }
  const { error } = await supabase.from("branches").upsert(row);
  if (error) return json({ ok: false, error: error.message });
  await logAdmin("save_branch", { id, name, pin_changed: !!pin });
  return json({ ok: true, id });
}

// Central admin only. Deletes the branch and everything in it.
async function handleDeleteBranch(p: Record<string, unknown>) {
  if (!(await checkAdminPin(String(p.admin_pin ?? "")))) return json({ ok: false, error: "wrong_admin_pin" });
  const id = String(p.id ?? "");
  const { count } = await supabase.from("branches").select("id", { count: "exact", head: true });
  if ((count ?? 0) <= 1) return json({ ok: false, error: "last_branch" });
  const { error } = await supabase.from("branches").delete().eq("id", id);
  if (error) return json({ ok: false, error: error.message });
  await logAdmin("delete_branch", { id });
  return json({ ok: true });
}

// Central admin only. Replaces a branch's active staff list with `staff`: [{name, label, short}].
// People left out are set inactive (not deleted), so old calendar days keep their name.
async function handleSaveStaff(p: Record<string, unknown>) {
  if (!(await checkAdminPin(String(p.admin_pin ?? "")))) return json({ ok: false, error: "wrong_admin_pin" });
  const branch = await getBranch(String(p.branch_id ?? ""));
  if (!branch) return json({ ok: false, error: "unknown_branch" });
  const list = Array.isArray(p.staff) ? p.staff as Array<Record<string, unknown>> : [];
  const rows = list
    .map((s, i) => ({
      branch_id: branch.id,
      name: String(s.name ?? "").trim(),
      label: String(s.label ?? "").trim(),
      short: String(s.short ?? "").trim(),
      active: true,
      sort: i,
    }))
    .filter((s) => s.name);
  const names = rows.map((r) => r.name);
  if (new Set(names).size !== names.length) return json({ ok: false, error: "duplicate_name" });

  const { error: offErr } = await supabase.from("staff").update({ active: false }).eq("branch_id", branch.id);
  if (offErr) return json({ ok: false, error: offErr.message });
  if (rows.length) {
    const { error } = await supabase.from("staff").upsert(rows, { onConflict: "branch_id,name" });
    if (error) return json({ ok: false, error: error.message });
  }
  await logAdmin("save_staff", { branch_id: branch.id, names });
  return json({ ok: true });
}

async function handleChangeAdminPin(p: Record<string, unknown>) {
  if (!(await checkAdminPin(String(p.admin_pin ?? "")))) return json({ ok: false, error: "wrong_admin_pin" });
  const next = String(p.new_pin ?? "").trim();
  if (next.length < 4) return json({ ok: false, error: "pin_too_short" });
  await setSetting(ADMIN_PIN_KEY, await hashPassword(next));
  await logAdmin("change_admin_pin");
  return json({ ok: true });
}

// Lets the calendar check a PIN before showing the settings screen.
async function handleCheckAdminPin(p: Record<string, unknown>) {
  return json({ ok: await checkAdminPin(String(p.admin_pin ?? "")) });
}

// ============================================================
// Schedule calendar: holidays / big clean / stock check / toilet duty, per branch.
// Supabase is the source of truth; for the branch marked sync_sheet, every save is also
// mirrored into the SCHEDULE tab of the payroll sheet so anything reading it keeps working.
// ============================================================

const SCHEDULE_TAB = "SCHEDULE";
const SCHEDULE_TEXT_TAB = "SCHEDULE_TEXT";

type ScheduleRow = {
  branch_id: string;
  date: string;
  is_holiday: boolean;
  is_big_clean: boolean;
  is_stock_check: boolean;
  toilet_duty: string | null;
};

// Public read: anyone with the calendar link can see the month.
async function handleScheduleMonth(p: Record<string, unknown>) {
  const branchId = String(p.branch ?? "");
  const month = String(p.month ?? "");
  if (!branchId) return json({ ok: false, error: "missing_branch" });
  if (!/^\d{4}-\d{2}$/.test(month)) return json({ ok: false, error: "bad_month" });
  const [y, m] = month.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  const { data, error } = await supabase.from("schedule_days")
    .select("date, is_holiday, is_big_clean, is_stock_check, toilet_duty")
    .eq("branch_id", branchId).gte("date", `${month}-01`).lt("date", next).order("date");
  if (error) return json({ ok: false, error: error.message });
  return json({ ok: true, rows: data ?? [] });
}

// Today's (or `date`) schedule plus the matching messages, for a daily notifier.
// `branch` optional: without it, every branch that has something today is returned.
async function handleScheduleToday(p: Record<string, unknown>) {
  const date = String(p.date ?? "") || bangkokToday();
  let q = supabase.from("schedule_days").select("*").eq("date", date);
  if (p.branch) q = q.eq("branch_id", String(p.branch));
  const { data: days, error } = await q;
  if (error) return json({ ok: false, error: error.message });
  const { data: texts } = await supabase.from("schedule_texts").select("type, text_th, text_mm, text_lo");
  const textOf = (type: string) => (texts ?? []).find((t) => t.type === type);
  const { data: branches } = await supabase.from("branches").select("id, name");

  const result = (days ?? []).map((day) => {
    const out: Array<{ type: string; text_th: string; text_mm: string; text_lo: string }> = [];
    const push = (type: string) => { const t = textOf(type); if (t) out.push(t); };
    if (day.is_holiday) push("holiday");
    if (day.is_big_clean) push("big_clean");
    if (day.is_stock_check) push("stock_check");
    if (day.toilet_duty) {
      const own = textOf(`toilet_duty_${day.toilet_duty}`);
      const tpl = textOf("toilet_duty");
      if (own) out.push(own);
      else if (tpl) {
        const fill = (s: string) => s.replaceAll("{name}", day.toilet_duty);
        out.push({ type: "toilet_duty", text_th: fill(tpl.text_th), text_mm: fill(tpl.text_mm), text_lo: fill(tpl.text_lo) });
      }
    }
    const branch = (branches ?? []).find((b) => b.id === day.branch_id);
    return { branch_id: day.branch_id, branch_name: branch?.name ?? day.branch_id, day, texts: out };
  });
  return json({ ok: true, date, branches: result });
}

async function handleSaveScheduleDay(p: Record<string, unknown>) {
  const branch = await getBranch(String(p.branch ?? ""));
  if (!branch) return json({ ok: false, error: "unknown_branch" });
  if (!(await canEditBranch(branch, String(p.admin_pin ?? "")))) return json({ ok: false, error: "wrong_admin_pin" });
  const date = String(p.date ?? "").trim();
  if (!isIsoDate(date)) return json({ ok: false, error: "bad_date" });
  const row: ScheduleRow = {
    branch_id: branch.id,
    date,
    is_holiday: sheetBool(p.is_holiday),
    is_big_clean: sheetBool(p.is_big_clean),
    is_stock_check: sheetBool(p.is_stock_check),
    toilet_duty: String(p.toilet_duty ?? "").trim() || null,
  };
  const { error } = await supabase.from("schedule_days").upsert({ ...row, updated_at: new Date().toISOString() });
  if (error) return json({ ok: false, error: error.message });
  await logAdmin("save_schedule_day", row);

  // Best effort: a sheet problem must not undo a save that already worked.
  let sheet_synced = false;
  let sheet_error: string | undefined;
  const sheetId = scheduleSheetId();
  if (sheetId && branch.sync_sheet) {
    try {
      await mirrorScheduleDayToSheet(sheetId, row);
      sheet_synced = true;
    } catch (e) {
      sheet_error = String((e as Error)?.message ?? e);
      console.error("schedule sheet mirror failed", e);
    }
  }
  return json({ ok: true, sheet_synced, sheet_error });
}

async function mirrorScheduleDayToSheet(sheetId: string, row: ScheduleRow) {
  const values = await sheetsGetValues(sheetId, `${SCHEDULE_TAB}!A:E`);
  const headerIdx = values.findIndex((r) => String(r[0] ?? "").trim() === "date");
  if (headerIdx >= 0 && String(values[headerIdx][4] ?? "").trim() !== "toilet_duty") {
    await sheetsSetRow(sheetId, `${SCHEDULE_TAB}!E${headerIdx + 1}`, ["toilet_duty"]);
  }
  let target = -1; // last matching row wins, same as the old Apps Script read
  values.forEach((r, i) => { if (parseSheetDate(String(r[0] ?? "")) === row.date) target = i; });
  const out = [row.date, row.is_holiday, row.is_big_clean, row.is_stock_check, row.toilet_duty ?? ""];
  if (target >= 0) await sheetsSetRow(sheetId, `${SCHEDULE_TAB}!A${target + 1}:E${target + 1}`, out);
  else await sheetsAppendRow(sheetId, `${SCHEDULE_TAB}!A:E`, out);
}

// Copies SCHEDULE, SCHEDULE_TEXT and the admin PIN from the sheet into Supabase, into the branch
// `branch_id` (created if missing, name `branch_name`), and marks that branch to sync with the sheet.
// Staff are added from the toilet_duty_<name> rows of SCHEDULE_TEXT. Safe to re-run.
// Auth: the admin_pin currently stored in APP_STATE1 of the sheet (the calendar's existing PIN).
async function handleImportScheduleFromSheet(p: Record<string, unknown>) {
  const sheetId = scheduleSheetId();
  if (!sheetId) return json({ ok: false, error: "SCHEDULE_SHEET_ID not configured" });
  try {
    const [[stateJson] = []] = await sheetsGetValues(sheetId, "APP_STATE1!A2");
    const sheetPin = String(JSON.parse(stateJson ?? "{}").admin_pin ?? "").trim();
    if (!sheetPin || String(p.admin_pin ?? "").trim() !== sheetPin) return json({ ok: false, error: "wrong_admin_pin" });

    const branchId = cleanBranchId(String(p.branch_id ?? "main")) || "main";
    const existing = await getBranch(branchId);
    const branchName = String(p.branch_name ?? "").trim() || existing?.name || "สาขาหลัก";
    {
      const { error } = await supabase.from("branches").upsert({ id: branchId, name: branchName, sync_sheet: true });
      if (error) throw new Error(error.message);
    }

    const days = new Map<string, Record<string, unknown>>();
    for (const r of await sheetsGetValues(sheetId, `${SCHEDULE_TAB}!A:E`)) {
      const date = parseSheetDate(String(r[0] ?? ""));
      if (!date || !isIsoDate(date)) continue; // header and blank rows
      days.set(date, {
        branch_id: branchId,
        date,
        is_holiday: sheetBool(r[1]),
        is_big_clean: sheetBool(r[2]),
        is_stock_check: sheetBool(r[3]),
        toilet_duty: String(r[4] ?? "").trim() || null,
        updated_at: new Date().toISOString(),
      });
    }
    if (days.size) {
      const { error } = await supabase.from("schedule_days").upsert([...days.values()]);
      if (error) throw new Error(error.message);
    }

    const textRows = await sheetsGetValues(sheetId, `${SCHEDULE_TEXT_TAB}!A:D`);
    const head = (textRows.shift() ?? []).map((h) => String(h).trim());
    const col = (name: string) => head.indexOf(name);
    const texts = textRows
      .filter((r) => String(r[col("type")] ?? "").trim())
      .map((r) => ({
        type: String(r[col("type")]).trim(),
        text_th: String(r[col("text_th")] ?? ""),
        text_mm: String(r[col("text_mm")] ?? ""),
        text_lo: String(r[col("text_lo")] ?? ""),
        updated_at: new Date().toISOString(),
      }));
    if (texts.length) {
      const { error } = await supabase.from("schedule_texts").upsert(texts);
      if (error) throw new Error(error.message);
    }

    // Staff from toilet_duty_<name>, only adding people not already in this branch.
    const { data: haveStaff } = await supabase.from("staff").select("name").eq("branch_id", branchId);
    const have = new Set((haveStaff ?? []).map((s) => s.name));
    const newStaff = texts
      .filter((t) => t.type.startsWith("toilet_duty_"))
      .map((t, i) => ({ branch_id: branchId, name: t.type.slice("toilet_duty_".length), sort: have.size + i }))
      .filter((s) => s.name && !have.has(s.name));
    if (newStaff.length) {
      const { error } = await supabase.from("staff").insert(newStaff);
      if (error) throw new Error(error.message);
    }

    if (!(await getSetting<string | null>(ADMIN_PIN_KEY, null))) {
      await setSetting(ADMIN_PIN_KEY, await hashPassword(sheetPin));
    }
    await logAdmin("import_schedule_from_sheet", { branchId, days: days.size, texts: texts.length, staff: newStaff.length });
    return json({ ok: true, branch_id: branchId, days: days.size, texts: texts.length, staff_added: newStaff.length });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message ?? e) });
  }
}

// ============================================================
// Dispatch
// ============================================================

const ACTIONS: Record<string, (p: Record<string, unknown>) => Promise<Response>> = {
  list_branches: handleListBranches,
  schedule_month: handleScheduleMonth,
  schedule_today: handleScheduleToday,
  save_schedule_day: handleSaveScheduleDay,
  import_schedule_from_sheet: handleImportScheduleFromSheet,
  check_admin_pin: handleCheckAdminPin,
  change_admin_pin: handleChangeAdminPin,
  save_branch: handleSaveBranch,
  delete_branch: handleDeleteBranch,
  save_staff: handleSaveStaff,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  try {
    const params: Record<string, unknown> = req.method === "GET"
      ? Object.fromEntries(new URL(req.url).searchParams)
      : await req.json();
    const action = String(params.action ?? "");
    const handler = ACTIONS[action];
    if (!handler) return json({ ok: false, error: "unknown_action: " + action }, 404);
    return await handler(params);
  } catch (e) {
    console.error("dispatch error", e);
    return json({ ok: false, error: String(e) }, 500);
  }
});
