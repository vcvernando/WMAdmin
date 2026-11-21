-- Tracker PO Principal (PO pembelian ke principal/vendor) dan COS Retur pindah dari Google Sheet
-- "Tracker PO Principal & COS Retur" ke Supabase. Kolom mengikuti sheet.

create table public.po_principal (
  id bigint generated always as identity primary key,
  tgl_po date,
  no_po text not null,
  principal text,
  item text,
  qty text,
  no_aju text,
  status text not null default 'PO Dikirim' check (status in ('PO Dikirim', 'Konfirmasi Principal', 'Pembayaran', 'Shipping', 'Customs / AJU',
    'POFW Approved', 'Barang Masuk Gudang', 'Selesai', 'Pending', 'Cancelled', 'Perlu Cek')),
  update_terakhir text,
  tgl_update date,
  pic text,
  email_ref text,                      -- "Subjek Email Referensi"
  catatan text,
  tgl_email_pertama date,
  selesai boolean not null default false,   -- "Selesai (Admin)", hanya diubah admin
  sumber text not null default 'manual' check (sumber in ('manual', 'email', 'sheet')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null
);
create unique index po_principal_no_po_key on public.po_principal (upper(regexp_replace(no_po, '\s+', '', 'g')));

create table public.cos_retur (
  id bigint generated always as identity primary key,
  tgl_request date,
  no_cos_retur text,
  cos_asal text,
  customer text,
  tipe_unit text,
  serial_number text,
  qty text,
  alasan text,
  tindakan text check (tindakan is null or tindakan in ('Kirim ke SRV', 'Scrap', 'Masuk TLJ', 'PO Buyback', 'COS Replace',
    'Kembali ke Stock', 'Retur ke Principal', 'Belum Ditentukan')),
  no_replace text,                     -- "No COS Replace / PO Buyback"
  status text not null default 'Request' check (status in ('Request', 'COS Retur Dibuat', 'Unit Ditarik', 'Unit di Gudang', 'Di SRV',
    'Selesai', 'Pending', 'Cancelled', 'Perlu Cek')),
  update_terakhir text,
  tgl_update date,
  pic text,
  email_ref text,
  catatan text,
  selesai boolean not null default false,
  sumber text not null default 'manual' check (sumber in ('manual', 'email', 'sheet')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null
);
create index cos_retur_no_cos_idx on public.cos_retur (upper(regexp_replace(no_cos_retur, '\s+', '', 'g')));

create trigger po_principal_set_updated before update on public.po_principal
for each row execute function public.set_updated_generic();
create trigger cos_retur_set_updated before update on public.cos_retur
for each row execute function public.set_updated_generic();

alter table public.po_principal enable row level security;
alter table public.cos_retur enable row level security;
revoke all on public.po_principal, public.cos_retur from anon, authenticated;

create policy "po_principal: baca (disetujui)" on public.po_principal for select to authenticated using ((select public.is_approved()));
create policy "po_principal: tambah (disetujui)" on public.po_principal for insert to authenticated with check ((select public.is_approved()));
create policy "po_principal: ubah (disetujui)" on public.po_principal for update to authenticated using ((select public.is_approved())) with check ((select public.is_approved()));
create policy "po_principal: hapus (admin)" on public.po_principal for delete to authenticated using ((select public.is_admin()));
create policy "cos_retur: baca (disetujui)" on public.cos_retur for select to authenticated using ((select public.is_approved()));
create policy "cos_retur: tambah (disetujui)" on public.cos_retur for insert to authenticated with check ((select public.is_approved()));
create policy "cos_retur: ubah (disetujui)" on public.cos_retur for update to authenticated using ((select public.is_approved())) with check ((select public.is_approved()));
create policy "cos_retur: hapus (admin)" on public.cos_retur for delete to authenticated using ((select public.is_admin()));
grant select, insert, update, delete on public.po_principal, public.cos_retur to authenticated;

-- Log tarikan email per tracker (W = email terakhir diproses)
create table public.tracker_sync_log (
  id bigint generated always as identity primary key,
  tracker text not null check (tracker in ('po_principal', 'cos_retur')),
  source text not null,
  synced_at timestamptz not null default now(),
  rows_in int, inserted int, updated int,
  email_terakhir timestamptz,
  catatan text
);
alter table public.tracker_sync_log enable row level security;
revoke all on public.tracker_sync_log from anon, authenticated;
create policy "tracker_sync_log: baca (disetujui)" on public.tracker_sync_log for select to authenticated using ((select public.is_approved()));
grant select on public.tracker_sync_log to authenticated;

-- Gabung catatan tanpa duplikat
create or replace function public.append_note(old_note text, new_note text)
returns text language sql immutable set search_path = '' as $$
  select case
    when new_note is null or btrim(new_note) = '' then old_note
    when old_note is null or btrim(old_note) = '' then new_note
    when position(btrim(new_note) in old_note) > 0 then old_note
    else old_note || E'\n' || new_note
  end;
$$;

-- ---------- Penerima email: PO Principal ----------
-- rows: [{tgl_po, no_po*, principal, item, qty, no_aju, status, update_terakhir, tgl_update, pic, email_ref, catatan, tgl_email_pertama}]
-- Aturan (sama dengan tugas email lama): satu No PO = satu baris; kolom kosong diisi; Status/Update Terakhir/Tgl Update
-- hanya diganti bila tgl_update email >= yang tersimpan; catatan ditambahkan; Selesai (Admin) tidak pernah diubah.
create or replace function public.ingest_po_principal(rows jsonb, p_source text default 'Email PO Principal',
  p_email_terakhir timestamptz default null, p_catatan text default null)
returns jsonb language plpgsql set search_path = '' as $$
declare
  s record; t public.po_principal; v_tokens text[]; v_n int;
  v_ins int := 0; v_upd int := 0; v_skip int := 0; v_total int := 0;
  v_inserted jsonb := '[]'::jsonb; v_updated jsonb := '[]'::jsonb; v_skipped jsonb := '[]'::jsonb;
begin
  for s in
    select public.parse_id_date(e->>'tgl_po') as tgl_po, nullif(btrim(e->>'no_po'), '') as no_po,
      nullif(btrim(e->>'principal'), '') as principal, nullif(btrim(e->>'item'), '') as item, nullif(btrim(e->>'qty'), '') as qty,
      nullif(btrim(e->>'no_aju'), '') as no_aju, nullif(btrim(e->>'status'), '') as status,
      nullif(btrim(e->>'update_terakhir'), '') as update_terakhir, public.parse_id_date(e->>'tgl_update') as tgl_update,
      nullif(btrim(e->>'pic'), '') as pic, nullif(btrim(e->>'email_ref'), '') as email_ref, nullif(btrim(e->>'catatan'), '') as catatan,
      public.parse_id_date(e->>'tgl_email_pertama') as tgl_email_pertama,
      coalesce(nullif(btrim(e->>'sumber'), ''), 'email') as sumber
    from jsonb_array_elements(rows) e
  loop
    v_total := v_total + 1;
    if s.no_po is null then
      v_skip := v_skip + 1; v_skipped := v_skipped || jsonb_build_object('no_po', null, 'alasan', 'No PO kosong'); continue;
    end if;
    if s.status is not null and s.status not in ('PO Dikirim', 'Konfirmasi Principal', 'Pembayaran', 'Shipping', 'Customs / AJU',
      'POFW Approved', 'Barang Masuk Gudang', 'Selesai', 'Pending', 'Cancelled', 'Perlu Cek') then
      s.status := 'Perlu Cek';
    end if;
    t := null;
    select * into t from public.po_principal p
      where upper(regexp_replace(p.no_po, '\s+', '', 'g')) = upper(regexp_replace(s.no_po, '\s+', '', 'g'));
    if t.id is null then
      -- cocokkan nomor dokumen yang disebut (IH-PONP-..., ISP-OPLN-..., dll) dengan baris yang memuatnya
      select array_agg(distinct m[1]) into v_tokens
        from regexp_matches(upper(s.no_po), '([A-Z]{2,4}-[A-Z]{4}-[0-9]{4}-[0-9]{4})', 'g') m;
      -- nomor PO NAV (IH-...) unik per PO; nomor eksternal (ISP/IVP/MVI-OPLN...) bisa dipakai beberapa PO NAV
      if exists (select 1 from unnest(v_tokens) k where k like 'IH-%') then
        select array_agg(k) into v_tokens from unnest(v_tokens) k where k like 'IH-%';
      end if;
      if v_tokens is not null then
        select count(*) into v_n from public.po_principal p
          where exists (select 1 from unnest(v_tokens) k where position(k in upper(p.no_po)) > 0);
        if v_n = 1 then
          select * into t from public.po_principal p
            where exists (select 1 from unnest(v_tokens) k where position(k in upper(p.no_po)) > 0);
        elsif v_n > 1 then
          v_skip := v_skip + 1;
          v_skipped := v_skipped || jsonb_build_object('no_po', s.no_po, 'alasan', 'cocok ke lebih dari satu baris');
          continue;
        end if;
      end if;
    end if;

    if t.id is null then
      insert into public.po_principal (tgl_po, no_po, principal, item, qty, no_aju, status, update_terakhir, tgl_update, pic, email_ref,
        catatan, tgl_email_pertama, sumber)
      values (s.tgl_po, s.no_po, s.principal, s.item, s.qty, s.no_aju, coalesce(s.status, 'PO Dikirim'), s.update_terakhir,
        s.tgl_update, s.pic, s.email_ref, s.catatan, coalesce(s.tgl_email_pertama, s.tgl_update), s.sumber);
      v_ins := v_ins + 1; v_inserted := v_inserted || jsonb_build_object('no_po', s.no_po, 'status', coalesce(s.status, 'PO Dikirim'));
    else
      update public.po_principal p set
        tgl_po = coalesce(p.tgl_po, s.tgl_po),
        principal = coalesce(nullif(btrim(p.principal), ''), s.principal),
        item = coalesce(nullif(btrim(p.item), ''), s.item),
        qty = coalesce(nullif(btrim(p.qty), ''), s.qty),
        no_aju = coalesce(nullif(btrim(p.no_aju), ''), s.no_aju),
        pic = coalesce(nullif(btrim(p.pic), ''), s.pic),
        tgl_email_pertama = coalesce(p.tgl_email_pertama, s.tgl_email_pertama),
        status = case when s.status is not null and s.tgl_update is not null and (p.tgl_update is null or s.tgl_update >= p.tgl_update) then s.status else p.status end,
        update_terakhir = case when s.update_terakhir is not null and s.tgl_update is not null and (p.tgl_update is null or s.tgl_update >= p.tgl_update) then s.update_terakhir else p.update_terakhir end,
        email_ref = case when s.email_ref is not null and s.tgl_update is not null and (p.tgl_update is null or s.tgl_update >= p.tgl_update) then s.email_ref else coalesce(p.email_ref, s.email_ref) end,
        tgl_update = greatest(p.tgl_update, s.tgl_update),
        catatan = public.append_note(p.catatan, s.catatan)
      where p.id = t.id
        and (p.tgl_po, p.principal, p.item, p.qty, p.no_aju, p.pic, p.tgl_email_pertama, p.status, p.update_terakhir, p.email_ref, p.tgl_update, p.catatan)
          is distinct from
            (coalesce(p.tgl_po, s.tgl_po), coalesce(nullif(btrim(p.principal), ''), s.principal), coalesce(nullif(btrim(p.item), ''), s.item),
             coalesce(nullif(btrim(p.qty), ''), s.qty), coalesce(nullif(btrim(p.no_aju), ''), s.no_aju), coalesce(nullif(btrim(p.pic), ''), s.pic),
             coalesce(p.tgl_email_pertama, s.tgl_email_pertama),
             case when s.status is not null and s.tgl_update is not null and (p.tgl_update is null or s.tgl_update >= p.tgl_update) then s.status else p.status end,
             case when s.update_terakhir is not null and s.tgl_update is not null and (p.tgl_update is null or s.tgl_update >= p.tgl_update) then s.update_terakhir else p.update_terakhir end,
             case when s.email_ref is not null and s.tgl_update is not null and (p.tgl_update is null or s.tgl_update >= p.tgl_update) then s.email_ref else coalesce(p.email_ref, s.email_ref) end,
             greatest(p.tgl_update, s.tgl_update), public.append_note(p.catatan, s.catatan));
      if found then v_upd := v_upd + 1; v_updated := v_updated || jsonb_build_object('id', t.id, 'no_po', t.no_po); end if;
    end if;
  end loop;

  insert into public.tracker_sync_log (tracker, source, rows_in, inserted, updated, email_terakhir, catatan)
  values ('po_principal', p_source, v_total, v_ins, v_upd, p_email_terakhir, p_catatan);
  return jsonb_build_object('rows', v_total, 'inserted', v_ins, 'updated', v_upd, 'skipped', v_skip,
    'inserted_rows', v_inserted, 'updated_rows', v_updated, 'skipped_rows', v_skipped);
end; $$;

-- ---------- Penerima email: COS Retur ----------
-- rows: [{tgl_request, no_cos_retur, cos_asal, customer, tipe_unit, serial_number, qty, alasan, tindakan, no_replace,
--         status, update_terakhir, tgl_update, pic, email_ref, catatan}]
-- Kunci: No COS Retur, atau Customer + Tipe Unit + Serial Number bila No COS belum ada.
create or replace function public.ingest_cos_retur(rows jsonb, p_source text default 'Email COS Retur',
  p_email_terakhir timestamptz default null, p_catatan text default null)
returns jsonb language plpgsql set search_path = '' as $$
declare
  s record; t public.cos_retur; v_key text;
  v_ins int := 0; v_upd int := 0; v_skip int := 0; v_total int := 0;
  v_inserted jsonb := '[]'::jsonb; v_updated jsonb := '[]'::jsonb; v_skipped jsonb := '[]'::jsonb;
begin
  for s in
    select public.parse_id_date(e->>'tgl_request') as tgl_request, nullif(btrim(e->>'no_cos_retur'), '') as no_cos_retur,
      nullif(btrim(e->>'cos_asal'), '') as cos_asal, nullif(btrim(e->>'customer'), '') as customer,
      nullif(btrim(e->>'tipe_unit'), '') as tipe_unit, nullif(btrim(e->>'serial_number'), '') as serial_number,
      nullif(btrim(e->>'qty'), '') as qty, nullif(btrim(e->>'alasan'), '') as alasan, nullif(btrim(e->>'tindakan'), '') as tindakan,
      nullif(btrim(e->>'no_replace'), '') as no_replace, nullif(btrim(e->>'status'), '') as status,
      nullif(btrim(e->>'update_terakhir'), '') as update_terakhir, public.parse_id_date(e->>'tgl_update') as tgl_update,
      nullif(btrim(e->>'pic'), '') as pic, nullif(btrim(e->>'email_ref'), '') as email_ref, nullif(btrim(e->>'catatan'), '') as catatan,
      coalesce(nullif(btrim(e->>'sumber'), ''), 'email') as sumber
    from jsonb_array_elements(rows) e
  loop
    v_total := v_total + 1;
    if s.no_cos_retur is null and s.customer is null then
      v_skip := v_skip + 1; v_skipped := v_skipped || jsonb_build_object('alasan', 'No COS Retur & customer kosong'); continue;
    end if;
    if s.tindakan is not null and s.tindakan not in ('Kirim ke SRV', 'Scrap', 'Masuk TLJ', 'PO Buyback', 'COS Replace',
      'Kembali ke Stock', 'Retur ke Principal', 'Belum Ditentukan') then s.tindakan := 'Belum Ditentukan'; end if;
    if s.status is not null and s.status not in ('Request', 'COS Retur Dibuat', 'Unit Ditarik', 'Unit di Gudang', 'Di SRV',
      'Selesai', 'Pending', 'Cancelled', 'Perlu Cek') then s.status := 'Perlu Cek'; end if;
    t := null;
    if s.no_cos_retur is not null then
      v_key := upper(regexp_replace(s.no_cos_retur, '\s+', '', 'g'));
      select * into t from public.cos_retur p where upper(regexp_replace(p.no_cos_retur, '\s+', '', 'g')) = v_key limit 1;
    end if;
    if t.id is null and s.customer is not null then
      select * into t from public.cos_retur p
        where lower(btrim(p.customer)) = lower(s.customer)
          and coalesce(lower(btrim(p.tipe_unit)), '') = coalesce(lower(s.tipe_unit), '')
          and coalesce(lower(btrim(p.serial_number)), '') = coalesce(lower(s.serial_number), '')
          and (p.no_cos_retur is null or s.no_cos_retur is null)
        order by p.id limit 1;
    end if;

    if t.id is null then
      insert into public.cos_retur (tgl_request, no_cos_retur, cos_asal, customer, tipe_unit, serial_number, qty, alasan, tindakan, no_replace,
        status, update_terakhir, tgl_update, pic, email_ref, catatan, sumber)
      values (s.tgl_request, s.no_cos_retur, s.cos_asal, s.customer, s.tipe_unit, s.serial_number, s.qty, s.alasan,
        coalesce(s.tindakan, 'Belum Ditentukan'), s.no_replace, coalesce(s.status, 'Request'), s.update_terakhir, s.tgl_update, s.pic,
        s.email_ref, s.catatan, s.sumber);
      v_ins := v_ins + 1;
      v_inserted := v_inserted || jsonb_build_object('no_cos_retur', s.no_cos_retur, 'customer', s.customer, 'status', coalesce(s.status, 'Request'));
    else
      update public.cos_retur p set
        tgl_request = coalesce(p.tgl_request, s.tgl_request),
        no_cos_retur = coalesce(nullif(btrim(p.no_cos_retur), ''), s.no_cos_retur),
        cos_asal = coalesce(nullif(btrim(p.cos_asal), ''), s.cos_asal),
        customer = coalesce(nullif(btrim(p.customer), ''), s.customer),
        tipe_unit = coalesce(nullif(btrim(p.tipe_unit), ''), s.tipe_unit),
        serial_number = coalesce(nullif(btrim(p.serial_number), ''), s.serial_number),
        qty = coalesce(nullif(btrim(p.qty), ''), s.qty),
        alasan = coalesce(nullif(btrim(p.alasan), ''), s.alasan),
        tindakan = case when (p.tindakan is null or p.tindakan = 'Belum Ditentukan') and s.tindakan is not null then s.tindakan else p.tindakan end,
        no_replace = coalesce(nullif(btrim(p.no_replace), ''), s.no_replace),
        pic = coalesce(nullif(btrim(p.pic), ''), s.pic),
        status = case when s.status is not null and s.tgl_update is not null and (p.tgl_update is null or s.tgl_update >= p.tgl_update) then s.status else p.status end,
        update_terakhir = case when s.update_terakhir is not null and s.tgl_update is not null and (p.tgl_update is null or s.tgl_update >= p.tgl_update) then s.update_terakhir else p.update_terakhir end,
        email_ref = case when s.email_ref is not null and s.tgl_update is not null and (p.tgl_update is null or s.tgl_update >= p.tgl_update) then s.email_ref else coalesce(p.email_ref, s.email_ref) end,
        tgl_update = greatest(p.tgl_update, s.tgl_update),
        catatan = public.append_note(p.catatan, s.catatan)
      where p.id = t.id
        and (p.tgl_request, p.no_cos_retur, p.cos_asal, p.customer, p.tipe_unit, p.serial_number, p.qty, p.alasan, p.tindakan, p.no_replace, p.pic,
             p.status, p.update_terakhir, p.email_ref, p.tgl_update, p.catatan)
          is distinct from
            (coalesce(p.tgl_request, s.tgl_request), coalesce(nullif(btrim(p.no_cos_retur), ''), s.no_cos_retur), coalesce(nullif(btrim(p.cos_asal), ''), s.cos_asal),
             coalesce(nullif(btrim(p.customer), ''), s.customer), coalesce(nullif(btrim(p.tipe_unit), ''), s.tipe_unit),
             coalesce(nullif(btrim(p.serial_number), ''), s.serial_number), coalesce(nullif(btrim(p.qty), ''), s.qty), coalesce(nullif(btrim(p.alasan), ''), s.alasan),
             case when (p.tindakan is null or p.tindakan = 'Belum Ditentukan') and s.tindakan is not null then s.tindakan else p.tindakan end,
             coalesce(nullif(btrim(p.no_replace), ''), s.no_replace), coalesce(nullif(btrim(p.pic), ''), s.pic),
             case when s.status is not null and s.tgl_update is not null and (p.tgl_update is null or s.tgl_update >= p.tgl_update) then s.status else p.status end,
             case when s.update_terakhir is not null and s.tgl_update is not null and (p.tgl_update is null or s.tgl_update >= p.tgl_update) then s.update_terakhir else p.update_terakhir end,
             case when s.email_ref is not null and s.tgl_update is not null and (p.tgl_update is null or s.tgl_update >= p.tgl_update) then s.email_ref else coalesce(p.email_ref, s.email_ref) end,
             greatest(p.tgl_update, s.tgl_update), public.append_note(p.catatan, s.catatan));
      if found then v_upd := v_upd + 1; v_updated := v_updated || jsonb_build_object('id', t.id, 'no_cos_retur', coalesce(t.no_cos_retur, s.no_cos_retur), 'customer', t.customer); end if;
    end if;
  end loop;

  insert into public.tracker_sync_log (tracker, source, rows_in, inserted, updated, email_terakhir, catatan)
  values ('cos_retur', p_source, v_total, v_ins, v_upd, p_email_terakhir, p_catatan);
  return jsonb_build_object('rows', v_total, 'inserted', v_ins, 'updated', v_upd, 'skipped', v_skip,
    'inserted_rows', v_inserted, 'updated_rows', v_updated, 'skipped_rows', v_skipped);
end; $$;

revoke execute on function public.ingest_po_principal(jsonb, text, timestamptz, text) from public, anon, authenticated;
revoke execute on function public.ingest_cos_retur(jsonb, text, timestamptz, text) from public, anon, authenticated;
