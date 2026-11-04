// Edge Function "api" ของระบบพนักงาน (Supabase project แยกจากแอปเช็คสต็อก)
// ตอนนี้มีแค่ปฏิทินตารางงาน ระบบตอกบัตรจะเพิ่มเป็น action ใหม่ในไฟล์นี้
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
// Schedule calendar: holidays / big clean / stock check / toilet duty.
// Supabase is the source of truth; every save is also mirrored into the SCHEDULE tab of the
// payroll sheet so anything still reading that sheet keeps working.
// ============================================================

const SCHEDULE_TAB = "SCHEDULE";
const SCHEDULE_TEXT_TAB = "SCHEDULE_TEXT";

type ScheduleRow = {
  date: string;
  is_holiday: boolean;
  is_big_clean: boolean;
  is_stock_check: boolean;
  toilet_duty: string | null;
};

// Public read: anyone with the calendar link can see the month.
async function handleScheduleMonth(p: Record<string, unknown>) {
  const month = String(p.month ?? "");
  if (!/^\d{4}-\d{2}$/.test(month)) return json({ ok: false, error: "bad_month" });
  const [y, m] = month.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  const { data, error } = await supabase.from("schedule_days")
    .select("date, is_holiday, is_big_clean, is_stock_check, toilet_duty")
    .gte("date", `${month}-01`).lt("date", next).order("date");
  if (error) return json({ ok: false, error: error.message });
  return json({ ok: true, rows: data ?? [] });
}

// Today's (or `date`) schedule plus the matching SCHEDULE_TEXT messages, for a daily notifier.
async function handleScheduleToday(p: Record<string, unknown>) {
  const date = String(p.date ?? "") || bangkokToday();
  const { data: day } = await supabase.from("schedule_days").select("*").eq("date", date).maybeSingle();
  if (!day) return json({ ok: true, date, day: null, texts: [] });
  const types: string[] = [];
  if (day.is_holiday) types.push("holiday");
  if (day.is_big_clean) types.push("big_clean");
  if (day.is_stock_check) types.push("stock_check");
  if (day.toilet_duty) types.push(`toilet_duty_${day.toilet_duty}`);
  const { data: texts } = types.length
    ? await supabase.from("schedule_texts").select("type, text_th, text_mm, text_lo").in("type", types)
    : { data: [] };
  const ordered = types.map((t) => (texts ?? []).find((x) => x.type === t)).filter(Boolean);
  return json({ ok: true, date, day, texts: ordered });
}

async function handleSaveScheduleDay(p: Record<string, unknown>) {
  if (!(await checkAdminPin(String(p.admin_pin ?? "")))) return json({ ok: false, error: "wrong_admin_pin" });
  const date = String(p.date ?? "").trim();
  if (!isIsoDate(date)) return json({ ok: false, error: "bad_date" });
  const row: ScheduleRow = {
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
  if (sheetId) {
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

// Copies SCHEDULE, SCHEDULE_TEXT and the calendar admin PIN from the sheet into Supabase.
// Safe to re-run; sheet values overwrite Supabase for the same date/type.
// Auth: the admin_pin currently stored in APP_STATE1 of the sheet (the calendar's existing PIN).
async function handleImportScheduleFromSheet(p: Record<string, unknown>) {
  const sheetId = scheduleSheetId();
  if (!sheetId) return json({ ok: false, error: "SCHEDULE_SHEET_ID not configured" });
  try {
    const [[stateJson] = []] = await sheetsGetValues(sheetId, "APP_STATE1!A2");
    const sheetPin = String(JSON.parse(stateJson ?? "{}").admin_pin ?? "").trim();
    if (!sheetPin || String(p.admin_pin ?? "").trim() !== sheetPin) return json({ ok: false, error: "wrong_admin_pin" });

    const days = new Map<string, Record<string, unknown>>();
    for (const r of await sheetsGetValues(sheetId, `${SCHEDULE_TAB}!A:E`)) {
      const date = parseSheetDate(String(r[0] ?? ""));
      if (!date || !isIsoDate(date)) continue; // header and blank rows
      days.set(date, {
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

    await setSetting(ADMIN_PIN_KEY, await hashPassword(sheetPin));
    await logAdmin("import_schedule_from_sheet", { days: days.size, texts: texts.length });
    return json({ ok: true, days: days.size, texts: texts.length });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message ?? e) });
  }
}

async function handleChangeAdminPin(p: Record<string, unknown>) {
  if (!(await checkAdminPin(String(p.admin_pin ?? "")))) return json({ ok: false, error: "wrong_admin_pin" });
  const next = String(p.new_pin ?? "").trim();
  if (next.length < 4) return json({ ok: false, error: "pin_too_short" });
  await setSetting(ADMIN_PIN_KEY, await hashPassword(next));
  await logAdmin("change_admin_pin");
  return json({ ok: true });
}

// ============================================================
// Dispatch
// ============================================================

const ACTIONS: Record<string, (p: Record<string, unknown>) => Promise<Response>> = {
  schedule_month: handleScheduleMonth,
  schedule_today: handleScheduleToday,
  save_schedule_day: handleSaveScheduleDay,
  import_schedule_from_sheet: handleImportScheduleFromSheet,
  change_admin_pin: handleChangeAdminPin,
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
