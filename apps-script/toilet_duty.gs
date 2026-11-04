/**
 * เวรล้างห้องน้ำ — โค้ดสำหรับวางใน Google Apps Script ของชีท "ระบบคิดเงินเดือนพนักงาน"
 *
 * ขั้นตอน:
 * 1) ในแท็บ SCHEDULE ใส่หัวคอลัมน์ "toilet_duty" ที่คอลัมน์ E (แถวเดียวกับหัว date / is_holiday / ...)
 * 2) เปิด Extensions > Apps Script แล้วสร้างไฟล์ใหม่ วางโค้ดนี้ทั้งไฟล์
 * 3) ใน doGet(e) เดิม ให้เปลี่ยน 2 action นี้มาเรียกฟังก์ชันข้างล่าง:
 *
 *      if (action === "schedule_month")    return json_(scheduleMonth_(p.month));
 *      if (action === "save_schedule_day") {
 *        if (p.admin_pin !== getAdminPin_()) return json_({ ok: false, error: "wrong_admin_pin" });
 *        return json_(saveScheduleDay_(p));
 *      }
 *
 *    (p = e.parameter; ถ้าในโค้ดเดิมมี json_ / getAdminPin_ อยู่แล้ว ใช้ของเดิมได้เลย ลบของในไฟล์นี้ทิ้ง)
 * 4) Deploy > Manage deployments > แก้ deployment เดิม > Version: New version > Deploy
 *    (ต้องแก้ deployment เดิม ไม่งั้น URL จะเปลี่ยน แล้วหน้าเว็บจะเรียกไม่เจอ)
 */

var SCHEDULE_SHEET = "SCHEDULE";
var SCHEDULE_TEXT_SHEET = "SCHEDULE_TEXT";

function scheduleTz_() {
  return SpreadsheetApp.getActive().getSpreadsheetTimeZone();
}

function toDateKey_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, scheduleTz_(), "yyyy-MM-dd");
  return String(v || "").trim();
}

function toBool_(v) {
  return v === true || v === 1 || String(v).toUpperCase() === "TRUE" || String(v) === "1";
}

/** หาเลขคอลัมน์ (0-based) จากแถวหัวตาราง ถ้าไม่มีคอลัมน์ toilet_duty จะสร้างให้ */
function scheduleCols_(sheet) {
  var values = sheet.getDataRange().getValues();
  var headerRow = -1;
  for (var r = 0; r < values.length; r++) {
    if (String(values[r][0]).trim() === "date") { headerRow = r; break; }
  }
  var head = headerRow >= 0 ? values[headerRow].map(function (h) { return String(h).trim(); }) : [];
  function col(name, fallback) { var i = head.indexOf(name); return i >= 0 ? i : fallback; }
  var cols = {
    date: col("date", 0),
    holiday: col("is_holiday", 1),
    clean: col("is_big_clean", 2),
    stock: col("is_stock_check", 3),
    toilet: col("toilet_duty", -1)
  };
  if (cols.toilet < 0) {
    cols.toilet = Math.max(4, head.length);
    sheet.getRange((headerRow >= 0 ? headerRow : 0) + 1, cols.toilet + 1).setValue("toilet_duty");
  }
  return { cols: cols, values: sheet.getDataRange().getValues() };
}

/** action=schedule_month&month=2026-11 */
function scheduleMonth_(month) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(SCHEDULE_SHEET);
  var info = scheduleCols_(sheet);
  var c = info.cols;
  var byDate = {};
  info.values.forEach(function (row) {
    var d = toDateKey_(row[c.date]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d.indexOf(month) !== 0) return;
    // ถ้ามีวันซ้ำ แถวล่างสุดชนะ
    byDate[d] = {
      date: d,
      is_holiday: toBool_(row[c.holiday]),
      is_big_clean: toBool_(row[c.clean]),
      is_stock_check: toBool_(row[c.stock]),
      toilet_duty: String(row[c.toilet] || "").trim()
    };
  });
  return { ok: true, rows: Object.keys(byDate).sort().map(function (k) { return byDate[k]; }) };
}

/** action=save_schedule_day&date=...&is_holiday=1&is_big_clean=0&is_stock_check=0&toilet_duty=Kla */
function saveScheduleDay_(p) {
  var date = String(p.date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: "bad_date" };

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = SpreadsheetApp.getActive().getSheetByName(SCHEDULE_SHEET);
    var info = scheduleCols_(sheet);
    var c = info.cols;

    var rowIndex = -1; // แถวล่างสุดที่เป็นวันนี้
    info.values.forEach(function (row, i) { if (toDateKey_(row[c.date]) === date) rowIndex = i; });

    var width = Math.max(info.values[0].length, c.toilet + 1);
    var out = rowIndex >= 0 ? info.values[rowIndex].slice() : [];
    while (out.length < width) out.push("");
    out[c.date] = date;
    out[c.holiday] = p.is_holiday === "1";
    out[c.clean] = p.is_big_clean === "1";
    out[c.stock] = p.is_stock_check === "1";
    out[c.toilet] = String(p.toilet_duty || "").trim();

    if (rowIndex >= 0) {
      sheet.getRange(rowIndex + 1, 1, 1, width).setValues([out]);
    } else {
      sheet.appendRow(out);
    }
    // กันชีทแปลง "2026-11-05" เป็นวันที่ (จะได้อ่านกลับเป็นข้อความเดิม)
    var r = rowIndex >= 0 ? rowIndex + 1 : sheet.getLastRow();
    sheet.getRange(r, c.date + 1).setNumberFormat("@").setValue(date);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/**
 * ข้อความแจ้งเตือนของวันนี้ (ใช้กับระบบส่งข้อความที่อ่าน SCHEDULE_TEXT อยู่แล้ว)
 * คืนค่าเป็น [{ type, text_th, text_mm, text_lo }, ...]
 * เวรห้องน้ำจะไปหาแถว type = "toilet_duty_" + ชื่อ เช่น toilet_duty_Kla
 */
function getScheduleTextsForDate_(dateKey) {
  dateKey = dateKey || Utilities.formatDate(new Date(), scheduleTz_(), "yyyy-MM-dd");
  var day = (scheduleMonth_(dateKey.slice(0, 7)).rows || []).filter(function (r) { return r.date === dateKey; })[0];
  if (!day) return [];

  var types = [];
  if (day.is_holiday) types.push("holiday");
  if (day.is_big_clean) types.push("big_clean");
  if (day.is_stock_check) types.push("stock_check");
  if (day.toilet_duty) types.push("toilet_duty_" + day.toilet_duty);

  var rows = SpreadsheetApp.getActive().getSheetByName(SCHEDULE_TEXT_SHEET).getDataRange().getValues();
  var head = rows.shift().map(function (h) { return String(h).trim(); });
  var texts = {};
  rows.forEach(function (row) {
    var o = {};
    head.forEach(function (h, i) { o[h] = row[i]; });
    texts[String(o.type).trim()] = o;
  });
  return types.map(function (t) { return texts[t]; }).filter(function (t) { return t && t.text_th; });
}

/* ---- ตัวช่วย: ถ้าโค้ดเดิมมีอยู่แล้ว ลบส่วนนี้ทิ้ง ---- */

function getAdminPin_() {
  var v = SpreadsheetApp.getActive().getSheetByName("APP_STATE1").getRange("A2").getValue();
  try { return String(JSON.parse(v).admin_pin || ""); } catch (e) { return ""; }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
