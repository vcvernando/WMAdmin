-- Supabase menjadi data utama Selling PO:
--  * login (Supabase Auth) + tabel profiles dengan persetujuan admin
--  * data hanya untuk akun yang sudah disetujui (anon tidak bisa membaca lagi)
--  * Tambah/Edit untuk akun disetujui, Hapus hanya admin
--  * kolom target_kirim untuk reminder pengiriman
--  * sync dari Google Sheet dimatikan

-- ---------- Profil pengguna ----------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  nama text not null,
  email text not null,
  -- Username untuk login tanpa email (mis. "admin"). Akun username memakai email
  -- sintetis <username>@wmadmin.local (lihat USERNAME_DOMAIN di public/config.js).
  username text unique check (username ~ '^[a-z0-9._-]{3,32}$'),
  telepon text,
  role text not null default 'user' check (role in ('admin', 'user')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by uuid references auth.users (id) on delete set null
);
alter table public.profiles enable row level security;

-- Profil dibuat otomatis saat register (nama & telepon dari metadata sign up). Selalu pending.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, nama, email, telepon, username)
  values (
    new.id,
    coalesce(nullif(btrim(new.raw_user_meta_data ->> 'nama'), ''), split_part(new.email, '@', 1)),
    new.email,
    nullif(btrim(new.raw_user_meta_data ->> 'telepon'), ''),
    case when new.email like '%@wmadmin.local' then lower(split_part(new.email, '@', 1)) end
  );
  return new;
end; $$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.is_approved()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = (select auth.uid()) and status = 'approved');
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = (select auth.uid()) and status = 'approved' and role = 'admin');
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.is_approved() from public, anon;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_approved() to authenticated;
grant execute on function public.is_admin() to authenticated;

-- Pengguna melihat profilnya sendiri; admin melihat & mengubah semua (persetujuan, peran).
create policy "profiles: lihat sendiri atau admin" on public.profiles
  for select to authenticated using (id = (select auth.uid()) or (select public.is_admin()));
create policy "profiles: admin ubah" on public.profiles
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (nama, telepon, role, status, approved_at, approved_by) on public.profiles to authenticated;

-- ---------- Selling PO ----------
alter table public.selling_po
  add column target_kirim date,
  add column created_by uuid default auth.uid() references auth.users (id) on delete set null,
  add column updated_by uuid references auth.users (id) on delete set null;

create index selling_po_target_kirim_idx on public.selling_po (target_kirim) where not selesai;

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); new.updated_by := auth.uid(); return new; end; $$;

drop policy "Selling PO readable" on public.selling_po;
revoke all on public.selling_po from anon, authenticated;

create policy "selling_po: baca (disetujui)" on public.selling_po
  for select to authenticated using ((select public.is_approved()));
create policy "selling_po: tambah (disetujui)" on public.selling_po
  for insert to authenticated with check ((select public.is_approved()));
create policy "selling_po: ubah (disetujui)" on public.selling_po
  for update to authenticated using ((select public.is_approved())) with check ((select public.is_approved()));
create policy "selling_po: hapus (admin)" on public.selling_po
  for delete to authenticated using ((select public.is_admin()));

grant select, insert, update, delete on public.selling_po to authenticated;

-- ---------- Log sync lama: hanya untuk akun disetujui ----------
drop policy "sync_log readable" on public.sync_log;
revoke all on public.sync_log from anon, authenticated;
create policy "sync_log: baca (disetujui)" on public.sync_log
  for select to authenticated using ((select public.is_approved()));
grant select on public.sync_log to authenticated;

-- ---------- Sync Google Sheet dimatikan ----------
-- Supabase sekarang sumber utama. Job sync lama akan gagal dengan pesan jelas, bukan menimpa data.
create or replace function public.sync_selling_po(rows jsonb, first_row int default 3)
returns jsonb language plpgsql set search_path = '' as $$
begin
  raise exception 'Sync Google Sheet -> selling_po sudah dinonaktifkan: Supabase sekarang data utama. Ubah data lewat dashboard.';
end; $$;
revoke execute on function public.sync_selling_po(jsonb, int) from public, anon, authenticated;
