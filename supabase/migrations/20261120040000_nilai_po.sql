-- Kolom Nilai PO (Rupiah). Diisi dari dashboard atau otomatis dari email (bila nominal tertulis).
alter table public.selling_po add column nilai_po numeric(18,2) check (nilai_po is null or nilai_po >= 0);
comment on column public.selling_po.nilai_po is 'Total nilai PO dalam Rupiah (sesuai yang tertulis di PO).';

-- Parser nominal: "Rp 12.500.000", "12,500,000.00", "12.500.000,50", "12500000", "12,5 jt", "1,2 M"
create or replace function public.parse_nilai(t text)
returns numeric language plpgsql immutable set search_path = '' as $$
declare s text; mult numeric := 1; lastdot int; lastcom int;
begin
  if t is null then return null; end if;
  s := lower(btrim(t));
  if s = '' then return null; end if;
  s := regexp_replace(s, '^(rp\.?|idr)\s*', '');
  if s ~ '(jt|juta)\s*$' then mult := 1000000; s := regexp_replace(s, '\s*(jt|juta)\s*$', '');
  elsif s ~ '(m|miliar|milyar)\s*$' then mult := 1000000000; s := regexp_replace(s, '\s*(m|miliar|milyar)\s*$', '');
  end if;
  s := regexp_replace(s, '[^0-9.,]', '', 'g');
  if s = '' then return null; end if;
  lastdot := length(s) - position('.' in reverse(s)) + 1;
  lastcom := length(s) - position(',' in reverse(s)) + 1;
  if position('.' in s) = 0 then lastdot := 0; end if;
  if position(',' in s) = 0 then lastcom := 0; end if;
  if lastdot > 0 and lastcom > 0 then
    if lastcom > lastdot then s := replace(replace(s, '.', ''), ',', '.');   -- 12.500.000,50
    else s := replace(s, ',', '');                                           -- 12,500,000.50
    end if;
  elsif lastcom > 0 then
    -- hanya koma: desimal bila 1-2 digit di belakang (12,5 jt), selain itu pemisah ribuan
    if s ~ ',[0-9]{1,2}$' and s !~ ',.*,' then s := replace(s, ',', '.'); else s := replace(s, ',', ''); end if;
  elsif lastdot > 0 then
    if s ~ '\.[0-9]{1,2}$' and s !~ '\..*\.' then null; else s := replace(s, '.', ''); end if;
  end if;
  return round(s::numeric * mult, 2);
exception when others then return null;
end; $$;

-- ingest_selling_po: ikut menerima "nilai_po" (hanya mengisi bila masih kosong)
create or replace function public.ingest_selling_po(
  rows jsonb,
  p_source text default 'Email otomatis',
  p_email_terakhir timestamptz default null,
  p_catatan text default null
)
returns jsonb language plpgsql set search_path = '' as $$
declare
  s record; t public.selling_po; v_key text;
  v_ins int := 0; v_upd int := 0; v_skip_del int := 0; v_conflict int := 0; v_total int := 0; v_nokey int := 0;
  v_conflicts jsonb := '[]'::jsonb; v_inserted jsonb := '[]'::jsonb; v_updated jsonb := '[]'::jsonb; v_nokeys jsonb := '[]'::jsonb;
begin
  for s in
    select (e->>'sheet_row')::int as sheet_row,
      public.parse_id_date(e->>'request_date') as request_date,
      nullif(btrim(e->>'request_by'), '') as request_by, nullif(btrim(e->>'no_po'), '') as no_po,
      nullif(btrim(e->>'customer'), '') as customer, nullif(btrim(e->>'project'), '') as project,
      nullif(btrim(e->>'details'), '') as details, nullif(btrim(e->>'cos'), '') as cos,
      nullif(btrim(e->>'posting_cos'), '') as posting_cos, nullif(btrim(e->>'no_gp'), '') as no_gp,
      nullif(btrim(e->>'progres'), '') as progres, nullif(btrim(e->>'notes'), '') as notes,
      coalesce(upper(e->>'selesai') = 'TRUE', false) as selesai,
      public.parse_nilai(e->>'nilai_po') as nilai_po
    from jsonb_array_elements(rows) e
  loop
    if s.no_po is null and s.customer is null then continue; end if;
    v_total := v_total + 1;
    v_key := public.po_key(s.no_po);
    t := null;

    -- Data langsung dari email (tanpa nomor baris sheet) wajib punya No PO yang jelas,
    -- supaya pemrosesan ulang tidak membuat PO ganda.
    if s.sheet_row is null and v_key is null then
      v_nokey := v_nokey + 1;
      v_nokeys := v_nokeys || jsonb_build_object('no_po', s.no_po, 'customer', s.customer);
      continue;
    end if;

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
      if s.sheet_row is not null and exists (select 1 from public.selling_po p where p.sheet_row = s.sheet_row) then
        v_conflict := v_conflict + 1;
        v_conflicts := v_conflicts || jsonb_build_object('sheet_row', s.sheet_row, 'no_po', s.no_po);
        continue;
      end if;
      if exists (select 1 from public.selling_po_deleted d
                 where (v_key is not null and public.po_key(d.no_po) = v_key)
                    or (s.sheet_row is not null and d.sheet_row = s.sheet_row and v_key is null)) then
        v_skip_del := v_skip_del + 1;
        continue;
      end if;
      insert into public.selling_po (sheet_row, request_date, request_by, no_po, customer, project, details,
                                     cos, posting_cos, no_gp, progres, notes, selesai, nilai_po)
      values (s.sheet_row, s.request_date, s.request_by, s.no_po, s.customer, s.project, s.details,
              s.cos, s.posting_cos, s.no_gp, s.progres, s.notes, s.selesai, s.nilai_po);
      v_ins := v_ins + 1;
      v_inserted := v_inserted || jsonb_build_object('sheet_row', s.sheet_row, 'no_po', s.no_po, 'customer', s.customer);
    else
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
        notes        = coalesce(nullif(btrim(p.notes), ''), s.notes),
        nilai_po     = coalesce(p.nilai_po, s.nilai_po)
      where p.id = t.id
        and (p.sheet_row, p.request_date, p.request_by, p.no_po, p.customer, p.project, p.details,
             p.cos, p.posting_cos, p.no_gp, p.progres, p.notes, p.nilai_po)
            is distinct from
            (coalesce(p.sheet_row, s.sheet_row), coalesce(p.request_date, s.request_date),
             coalesce(nullif(btrim(p.request_by), ''), s.request_by), coalesce(nullif(btrim(p.no_po), ''), s.no_po),
             coalesce(nullif(btrim(p.customer), ''), s.customer), coalesce(nullif(btrim(p.project), ''), s.project),
             coalesce(nullif(btrim(p.details), ''), s.details), coalesce(nullif(btrim(p.cos), ''), s.cos),
             coalesce(nullif(btrim(p.posting_cos), ''), s.posting_cos), coalesce(nullif(btrim(p.no_gp), ''), s.no_gp),
             coalesce(nullif(btrim(p.progres), ''), s.progres), coalesce(nullif(btrim(p.notes), ''), s.notes),
             coalesce(p.nilai_po, s.nilai_po));
      if found then
        v_upd := v_upd + 1;
        v_updated := v_updated || jsonb_build_object('id', t.id, 'no_po', coalesce(t.no_po, s.no_po));
      end if;
    end if;
  end loop;

  insert into public.sync_log (source, rows_in_sheet, inserted, updated, deleted, email_terakhir, catatan)
  values (p_source, v_total, v_ins, v_upd, 0, p_email_terakhir, p_catatan);

  return jsonb_build_object('rows', v_total, 'inserted', v_ins, 'updated', v_upd,
    'skipped_deleted', v_skip_del, 'conflicts', v_conflict, 'tanpa_no_po', v_nokey,
    'inserted_po', v_inserted, 'updated_po', v_updated, 'conflict_rows', v_conflicts, 'tanpa_no_po_rows', v_nokeys);
end; $$;


revoke execute on function public.ingest_selling_po(jsonb, text, timestamptz, text) from public, anon, authenticated;
