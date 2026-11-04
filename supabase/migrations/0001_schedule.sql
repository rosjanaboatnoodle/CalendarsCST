-- Supabase project ของระบบพนักงาน (ปฏิทินตารางงาน + ระบบตอกบัตรในอนาคต)
-- แยกจาก project ของแอปเช็คสต็อก
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

-- ค่าตั้งค่าทั่วไป (เช่น hash ของรหัสแอดมินปฏิทิน)
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

-- ปฏิทิน: หนึ่งแถวต่อหนึ่งวัน (เหมือนแท็บ SCHEDULE)
create table if not exists schedule_days (
  date            date primary key,
  is_holiday      boolean not null default false,
  is_big_clean    boolean not null default false,
  is_stock_check  boolean not null default false,
  toilet_duty     text,              -- Kla / Bank / Maylin / Hom (ตรงกับ type toilet_duty_<ชื่อ> ใน schedule_texts)
  updated_at      timestamptz not null default now()
);

-- ข้อความแจ้งเตือนแต่ละประเภท (เหมือนแท็บ SCHEDULE_TEXT)
-- type: holiday / big_clean / stock_check / toilet_duty_Kla / toilet_duty_Bank / ...
create table if not exists schedule_texts (
  type        text primary key,
  text_th     text not null default '',
  text_mm     text not null default '',
  text_lo     text not null default '',
  updated_at  timestamptz not null default now()
);

-- Row Level Security: deny-all for anon/authenticated (ไม่มี policy = ห้ามหมด)
-- เข้าถึงข้อมูลได้ทางเดียวคือผ่าน Edge Function "api" ที่ใช้ service-role key
alter table app_settings enable row level security;
alter table admin_log enable row level security;
alter table schedule_days enable row level security;
alter table schedule_texts enable row level security;
