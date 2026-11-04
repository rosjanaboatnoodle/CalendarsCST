# Supabase ของระบบพนักงาน

Supabase project นี้แยกจาก project ของแอปเช็คสต็อก ตอนนี้ใช้กับปฏิทินตารางงาน (แยกสาขาได้) ระบบตอกบัตรจะเพิ่มเข้ามาใน project นี้ทีหลัง และใช้ตาราง `staff` ร่วมกัน

## ตั้งค่าครั้งแรก

1. สร้าง project ใหม่ที่ supabase.com (ตั้ง Region เป็น Singapore จะเร็วสุด)
2. SQL Editor → วางไฟล์ `migrations/0001_schedule.sql` ทั้งไฟล์ → Run
3. Edge Functions → Create function ชื่อ `api` → วางไฟล์ `functions/api/index.ts` ทั้งไฟล์ → Deploy
4. Edge Functions → Secrets → เพิ่ม 2 ตัว
   - `SCHEDULE_SHEET_ID` = `1OCM5dVZYTRedlqWmVEooy7_fruLN_z65RMMnnPAjhKE` (ชีท "ระบบคิดเงินเดือนพนักงาน")
   - `GOOGLE_SERVICE_ACCOUNT_JSON` = เนื้อหาไฟล์ JSON ของ Google service account ทั้งไฟล์
     (ใช้ตัวเดียวกับที่ project แอปเช็คสต็อกใช้ได้)
5. เปิดชีท "ระบบคิดเงินเดือนพนักงาน" → Share → ใส่อีเมล `client_email` จากไฟล์ JSON ข้อ 4 → สิทธิ์ Editor
6. ดึงข้อมูลเดิมจากชีทเข้ามาเป็นสาขาแรก (ใช้รหัสแอดมินปฏิทินตัวเดิม) แทน `PROJECT_REF`, `KEY`, `รหัสแอดมินปฏิทิน` และตั้งชื่อสาขาตามต้องการ:

   ```bash
   curl -X POST https://PROJECT_REF.supabase.co/functions/v1/api -H "Content-Type: application/json" -H "apikey: KEY" -H "Authorization: Bearer KEY" -d '{"action":"import_schedule_from_sheet","admin_pin":"รหัสแอดมินปฏิทิน","branch_id":"main","branch_name":"รสจนา สาขาหลัก"}'
   ```

   ถ้าได้ `{"ok":true,...}` คือเรียบร้อย ระบบจะ
   - สร้างสาขา `main` และตั้งให้สาขานี้ซิงก์กับแท็บ SCHEDULE ในชีท
   - ดึงวันในปฏิทิน ข้อความแจ้งเตือน และรายชื่อคนเวร (Kla / Bank / Maylin / Hom) เข้ามา
   - ตั้งรหัสแอดมินกลาง = รหัสเดิมของปฏิทิน

   กดซ้ำได้ไม่เสียหาย
7. ใน `index.html` ใส่ `PROJECT_REF` กับ `SUPABASE_KEY` (Project Settings → API → publishable key)

## เพิ่มสาขา / พนักงาน

กดปุ่ม ⚙️ บนหน้าปฏิทิน → ใส่รหัสแอดมินกลาง

- **+ เพิ่มสาขา**: ใส่ชื่อสาขา และรหัสสาขาภาษาอังกฤษ (ใช้ในลิงก์ เช่น `?branch=branch2`)
- **รหัสแอดมินของสาขา** (ไม่บังคับ): ให้หัวหน้าสาขาแก้ปฏิทินได้แค่สาขาตัวเอง ส่วนรหัสกลางแก้ได้ทุกสาขา
- **พนักงาน**: ชื่อ (ใช้ในข้อความแจ้งเตือน) / ชื่อเต็ม (แสดงในตัวเลือก) / ชื่อสั้น (แสดงบนปฏิทิน)
  คนที่ลบออกจากรายชื่อ ข้อมูลเก่าในปฏิทินจะยังอยู่
- ส่งลิงก์ของแต่ละสาขาให้พนักงานสาขานั้น หน้าเว็บจะเปิดสาขานั้นให้เลย

ข้อความเวรห้องน้ำ: ถ้ามีแถว `toilet_duty_<ชื่อ>` ในตาราง `schedule_texts` จะใช้แถวนั้น
ถ้าไม่มี จะใช้แถว `toilet_duty` (ข้อความกลาง `{name}` = ชื่อคนเวร) คนใหม่จึงไม่ต้องเพิ่มข้อความเอง

## Actions ใน `api`

| action | ใครเรียกได้ | ทำอะไร |
| --- | --- | --- |
| `list_branches` | ทุกคน | สาขาทั้งหมด พร้อมรายชื่อพนักงาน |
| `schedule_month` | ทุกคน | ข้อมูลทั้งเดือนของสาขา (`branch`, `month`: `2026-11`) |
| `save_schedule_day` | รหัสกลาง หรือรหัสของสาขานั้น | บันทึกวัน (สาขาที่ซิงก์ชีทจะเขียนลงแท็บ SCHEDULE ด้วย) |
| `schedule_today` | ทุกคน | งานของวันนี้ทุกสาขา (หรือ `branch`) + ข้อความแจ้งเตือนไทย/พม่า |
| `save_branch` / `delete_branch` | รหัสกลาง | เพิ่ม/แก้/ลบสาขา |
| `save_staff` | รหัสกลาง | ตั้งรายชื่อพนักงานของสาขา |
| `check_admin_pin` / `change_admin_pin` | รหัสกลาง | เช็ค/เปลี่ยนรหัสแอดมินกลาง |
| `import_schedule_from_sheet` | `admin_pin` ตัวที่อยู่ใน APP_STATE1 ของชีท | ดึงข้อมูลเดิมจากชีทเข้าสาขา |
