# Supabase ของระบบพนักงาน

Supabase project นี้แยกจาก project ของแอปเช็คสต็อก ตอนนี้ใช้กับปฏิทินตารางงาน ระบบตอกบัตรจะเพิ่มเข้ามาใน project นี้ทีหลัง

## ตั้งค่าครั้งแรก

1. สร้าง project ใหม่ที่ supabase.com (ตั้ง Region เป็น Singapore จะเร็วสุด)
2. SQL Editor → วางไฟล์ `migrations/0001_schedule.sql` ทั้งไฟล์ → Run
3. Edge Functions → Create function ชื่อ `api` → วางไฟล์ `functions/api/index.ts` ทั้งไฟล์ → Deploy
4. Edge Functions → Secrets → เพิ่ม 2 ตัว
   - `SCHEDULE_SHEET_ID` = `1OCM5dVZYTRedlqWmVEooy7_fruLN_z65RMMnnPAjhKE` (ชีท "ระบบคิดเงินเดือนพนักงาน")
   - `GOOGLE_SERVICE_ACCOUNT_JSON` = เนื้อหาไฟล์ JSON ของ Google service account ทั้งไฟล์
     (ใช้ตัวเดียวกับที่ project แอปเช็คสต็อกใช้ได้)
5. เปิดชีท "ระบบคิดเงินเดือนพนักงาน" → Share → ใส่อีเมล `client_email` จากไฟล์ JSON ข้อ 4 → สิทธิ์ Editor
6. ดึงข้อมูลเดิมจากชีทเข้ามา (ใช้รหัสแอดมินปฏิทินตัวเดิม) แทน `PROJECT_REF`, `KEY` และ `รหัสแอดมินปฏิทิน`:

   ```bash
   curl -X POST https://PROJECT_REF.supabase.co/functions/v1/api -H "Content-Type: application/json" -H "apikey: KEY" -H "Authorization: Bearer KEY" -d '{"action":"import_schedule_from_sheet","admin_pin":"รหัสแอดมินปฏิทิน"}'
   ```

   ถ้าได้ `{"ok":true,"days":...,"texts":...}` คือเรียบร้อย กดซ้ำได้ไม่เสียหาย
7. ใน `index.html` ใส่ `PROJECT_REF` กับ `SUPABASE_KEY` (Project Settings → API → publishable key)

## Actions ใน `api`

| action | ใครเรียกได้ | ทำอะไร |
| --- | --- | --- |
| `schedule_month` | ทุกคน | ข้อมูลทั้งเดือน (`month`: `2026-11`) |
| `save_schedule_day` | ต้องมี `admin_pin` | บันทึกวัน และเขียนลงแท็บ SCHEDULE ในชีทให้ด้วย |
| `schedule_today` | ทุกคน | งานของวันนี้ + ข้อความแจ้งเตือนไทย/พม่าจาก SCHEDULE_TEXT |
| `import_schedule_from_sheet` | `admin_pin` ตัวที่อยู่ใน APP_STATE1 ของชีท | ดึง SCHEDULE / SCHEDULE_TEXT / รหัสแอดมิน จากชีท |
| `change_admin_pin` | ต้องมี `admin_pin` | เปลี่ยนรหัสแอดมิน (`new_pin`) |
