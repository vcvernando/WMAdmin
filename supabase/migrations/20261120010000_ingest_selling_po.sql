-- Penerima data PO dari otomatisasi email (Outlook -> log -> tugas terjadwal).
-- Supabase = data utama. Fungsi ini HANYA:
--   * menambah PO baru, dan
--   * mengisi kolom yang masih kosong di PO yang sudah ada.
-- Tidak pernah menimpa isian dari dashboard, tidak mengubah Ceklis Selesai / target kirim / alasan,
-- tidak menghapus, dan tidak memasukkan lagi PO yang sudah dihapus admin.

-- Catatan PO yang dihapus dari dashboard (agar tidak diimpor ulang)
create table public.selling_po_deleted (
  id bigint generated always as identity primary key,
  po_id bigint,
  sheet_row integer,
  no_po text,
  customer text,
  deleted_at timestamptz not null default now(),
  deleted_by uuid default auth.uid()
);
alter table public.selling_po_deleted enable row level security;
revoke all on public.selling_po_deleted from anon, authenticated;
create policy "selling_po_deleted: admin baca" on public.selling_po_deleted
  for select to authenticated using ((select public.is_admin()));
grant select on public.selling_po_deleted to authenticated;

create or replace function public.log_selling_po_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.selling_po_deleted (po_id, sheet_row, no_po, customer)
  values (old.id, old.sheet_row, old.no_po, old.customer);
  return old;
end; $$;
revoke execute on function public.log_selling_po_delete() from public, anon, authenticated;

create trigger selling_po_log_delete
after delete on public.selling_po
for each row execute function public.log_selling_po_delete();

-- No PO yang bisa dipakai untuk mencocokkan ("-", "belum ada", dll. tidak dihitung)
create or replace function public.po_key(t text)
returns text language sql immutable set search_path = '' as $$
  select case
    when t is null then null
    when upper(regexp_replace(t, '\s+', '', 'g')) in ('', '-', '--', 'BELUMADA', 'TBA', 'N/A', 'NA') then null
    else upper(regexp_replace(t, '\s+', '', 'g'))
  end;
$$;

-- rows: array objek {"sheet_row", "request_date" (teks seperti di sheet), "request_by", "no_po", "customer",
--        "project", "details", "cos", "posting_cos", "no_gp", "progres", "notes", "selesai" (true/false)}
create or replace function public.ingest_selling_po(rows jsonb, p_source text default 'Email otomatis')
returns jsonb language plpgsql set search_path = '' as $$
declare
  s record; t public.selling_po; v_key text;
  v_ins int := 0; v_upd int := 0; v_skip_del int := 0; v_conflict int := 0; v_total int := 0;
  v_conflicts jsonb := '[]'::jsonb; v_inserted jsonb := '[]'::jsonb; v_updated jsonb := '[]'::jsonb;
begin
  for s in
    select (e->>'sheet_row')::int as sheet_row,
      public.parse_id_date(e->>'request_date') as request_date,
      nullif(btrim(e->>'request_by'), '') as request_by, nullif(btrim(e->>'no_po'), '') as no_po,
      nullif(btrim(e->>'customer'), '') as customer, nullif(btrim(e->>'project'), '') as project,
      nullif(btrim(e->>'details'), '') as details, nullif(btrim(e->>'cos'), '') as cos,
      nullif(btrim(e->>'posting_cos'), '') as posting_cos, nullif(btrim(e->>'no_gp'), '') as no_gp,
      nullif(btrim(e->>'progres'), '') as progres, nullif(btrim(e->>'notes'), '') as notes,
      coalesce(upper(e->>'selesai') = 'TRUE', false) as selesai
    from jsonb_array_elements(rows) e
  loop
    if s.no_po is null and s.customer is null then continue; end if;
    v_total := v_total + 1;
    v_key := public.po_key(s.no_po);
    t := null;

    -- 1) baris sheet yang sama, selama No PO-nya tidak bertentangan
    if s.sheet_row is not null then
      select * into t from public.selling_po p where p.sheet_row = s.sheet_row
        and (v_key is null or public.po_key(p.no_po) is null or public.po_key(p.no_po) = v_key)
      limit 1;
    end if;
    -- 2) No PO yang sama
    if t.id is null and v_key is not null then
      select * into t from public.selling_po p where public.po_key(p.no_po) = v_key order by p.id limit 1;
    end if;

    if t.id is null then
      -- baris sheet ini sudah dipakai PO lain -> jangan tebak, laporkan
      if s.sheet_row is not null and exists (select 1 from public.selling_po p where p.sheet_row = s.sheet_row) then
        v_conflict := v_conflict + 1;
        v_conflicts := v_conflicts || jsonb_build_object('sheet_row', s.sheet_row, 'no_po', s.no_po);
        continue;
      end if;
      -- sudah dihapus admin -> lewati
      if exists (select 1 from public.selling_po_deleted d
                 where (v_key is not null and public.po_key(d.no_po) = v_key)
                    or (s.sheet_row is not null and d.sheet_row = s.sheet_row and v_key is null)) then
        v_skip_del := v_skip_del + 1;
        continue;
      end if;
      insert into public.selling_po (sheet_row, request_date, request_by, no_po, customer, project, details,
                                     cos, posting_cos, no_gp, progres, notes, selesai)
      values (s.sheet_row, s.request_date, s.request_by, s.no_po, s.customer, s.project, s.details,
              s.cos, s.posting_cos, s.no_gp, s.progres, s.notes, s.selesai);
      v_ins := v_ins + 1;
      v_inserted := v_inserted || jsonb_build_object('sheet_row', s.sheet_row, 'no_po', s.no_po, 'customer', s.customer);
    else
      -- isi hanya kolom yang masih kosong
      update public.selling_po p set
        sheet_row    = coalesce(p.sheet_row, s.sheet_row),
        request_date = coalesce(p.request_date, s.request_date),
        request_by   = coalesce(nullif(btrim(p.request_by), ''), s.request_by),
        no_po        = coalesce(nullif(btrim(p.no_po), ''), s.no_po),
        customer     = coalesce(nullif(btrim(p.customer), ''), s.customer),
        project      = coalesce(nullif(btrim(p.project), ''), s.project),
        details      = coalesce(nullif(btrim(p.details), ''), s.details),
        cos          = coalesce(nullif(btrim(p.cos), ''), s.cos),
        posting_cos  = coalesce(nullif(btrim(p.posting_cos), ''), s.posting_cos),
        no_gp        = coalesce(nullif(btrim(p.no_gp), ''), s.no_gp),
        progres      = coalesce(nullif(btrim(p.progres), ''), s.progres),
        notes        = coalesce(nullif(btrim(p.notes), ''), s.notes)
      where p.id = t.id
        and (p.sheet_row, p.request_date, p.request_by, p.no_po, p.customer, p.project, p.details,
             p.cos, p.posting_cos, p.no_gp, p.progres, p.notes)
            is distinct from
            (coalesce(p.sheet_row, s.sheet_row), coalesce(p.request_date, s.request_date),
             coalesce(nullif(btrim(p.request_by), ''), s.request_by), coalesce(nullif(btrim(p.no_po), ''), s.no_po),
             coalesce(nullif(btrim(p.customer), ''), s.customer), coalesce(nullif(btrim(p.project), ''), s.project),
             coalesce(nullif(btrim(p.details), ''), s.details), coalesce(nullif(btrim(p.cos), ''), s.cos),
             coalesce(nullif(btrim(p.posting_cos), ''), s.posting_cos), coalesce(nullif(btrim(p.no_gp), ''), s.no_gp),
             coalesce(nullif(btrim(p.progres), ''), s.progres), coalesce(nullif(btrim(p.notes), ''), s.notes));
      if found then
        v_upd := v_upd + 1;
        v_updated := v_updated || jsonb_build_object('id', t.id, 'no_po', coalesce(t.no_po, s.no_po));
      end if;
    end if;
  end loop;

  insert into public.sync_log (source, rows_in_sheet, inserted, updated, deleted)
  values (p_source, v_total, v_ins, v_upd, 0);

  return jsonb_build_object('rows', v_total, 'inserted', v_ins, 'updated', v_upd,
    'skipped_deleted', v_skip_del, 'conflicts', v_conflict,
    'inserted_po', v_inserted, 'updated_po', v_updated, 'conflict_rows', v_conflicts);
end; $$;

-- Hanya dipanggil oleh otomatisasi (service role / koneksi Supabase), bukan dari browser.
revoke execute on function public.ingest_selling_po(jsonb, text) from public, anon, authenticated;
