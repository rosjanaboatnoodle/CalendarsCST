-- Supabase project ของระบบพนักงาน (ปฏิทินตารางงาน + ระบบตอกบัตรในอนาคต)
-- แยกจาก project ของแอปเช็คสต็อก รองรับหลายสาขา
-- Run this once in the Supabase Dashboard -> SQL Editor (paste the whole file, click Run).

create extension if not exists pgcrypto;

-- รหัสผ่านเก็บเป็น hash เสมอ Edge Function เรียก 2 ฟังก์ชันนี้เพื่อสร้าง/เช็ค hash
create or replace function crypt_hash(plain text)
returns text language sql as $$
  select crypt(plain, gen_salt('bf'));
$$;

create or replace function crypt_check(plain text, hash text)
returns boolean language sql as $$
  select crypt(plain, hash) = hash;
$$;

-- ค่าตั้งค่าทั่วไป (เช่น hash ของรหัสแอดมินกลาง)
create table if not exists app_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

-- บันทึกว่าใครแก้อะไรเมื่อไหร่
create table if not exists admin_log (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  action      text not null,
  details     jsonb not null default '{}'
);

-- สาขา
create table if not exists branches (
  id              text primary key,          -- ใช้ในลิงก์ ?branch=<id> (ภาษาอังกฤษ/ตัวเลข)
  name            text not null,             -- ชื่อที่แสดง
  sort            int not null default 0,
  admin_pin_hash  text,                      -- รหัสแอดมินของสาขา (ไม่บังคับ) แก้ได้แค่สาขานี้
  sync_sheet      boolean not null default false, -- true = เขียนลงแท็บ SCHEDULE ใน Google Sheet ด้วย
  created_at      timestamptz not null default now()
);

-- พนักงานของแต่ละสาขา (ใช้กับเวรล้างห้องน้ำ และระบบตอกบัตรในอนาคต)
create table if not exists staff (
  id          bigserial primary key,
  branch_id   text not null references branches(id) on delete cascade,
  name        text not null,                 -- ชื่อที่ใช้ในข้อความ เช่น Kla
  label       text not null default '',      -- ชื่อเต็มที่แสดงในตัวเลือก เช่น กล้า Kla
  short       text not null default '',      -- ชื่อสั้นบนปฏิทิน (ว่าง = ใช้ name)
  active      boolean not null default true,
  sort        int not null default 0,
  created_at  timestamptz not null default now(),
  unique (branch_id, name)
);

-- ปฏิทิน: หนึ่งแถวต่อหนึ่งวันต่อหนึ่งสาขา (เหมือนแท็บ SCHEDULE)
create table if not exists schedule_days (
  branch_id       text not null references branches(id) on delete cascade,
  date            date not null,
  is_holiday      boolean not null default false,
  is_big_clean    boolean not null default false,
  is_stock_check  boolean not null default false,
  toilet_duty     text,              -- staff.name ของคนเวร
  updated_at      timestamptz not null default now(),
  primary key (branch_id, date)
);

-- ข้อความแจ้งเตือนแต่ละประเภท ใช้ร่วมกันทุกสาขา (เหมือนแท็บ SCHEDULE_TEXT)
-- type: holiday / big_clean / stock_check / toilet_duty_<ชื่อ>
-- หรือ toilet_duty (ข้อความกลาง ใส่ {name} แทนชื่อคนเวร) ใช้เมื่อไม่มีแถวเฉพาะของคนนั้น
create table if not exists schedule_texts (
  type        text primary key,
  text_th     text not null default '',
  text_mm     text not null default '',
  text_lo     text not null default '',
  updated_at  timestamptz not null default now()
);

insert into schedule_texts (type, text_th, text_mm)
values ('toilet_duty', 'วันนี้คือเวรล้างห้องน้ำของ "{name}"', 'ယနေ့ အိမ်သာဆေးဂျူတီမှာ "{name}"')
on conflict (type) do nothing;

-- Row Level Security: deny-all for anon/authenticated (ไม่มี policy = ห้ามหมด)
-- เข้าถึงข้อมูลได้ทางเดียวคือผ่าน Edge Function "api" ที่ใช้ service-role key
alter table app_settings enable row level security;
alter table admin_log enable row level security;
alter table branches enable row level security;
alter table staff enable row level security;
alter table schedule_days enable row level security;
alter table schedule_texts enable row level security;
