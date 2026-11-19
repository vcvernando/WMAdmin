-- Sinkron Google Sheet (sumber utama, diisi otomatis dari email Outlook) -> Supabase
alter table public.selling_po add constraint selling_po_sheet_row_key unique (sheet_row);

create table public.sync_log (
  id bigint generated always as identity primary key,
  source text not null,
  synced_at timestamptz not null default now(),
  rows_in_sheet int, inserted int, updated int, deleted int
);
alter table public.sync_log enable row level security;
create policy "sync_log readable" on public.sync_log for select to anon, authenticated using (true);
revoke insert, update, delete, truncate on public.sync_log from anon, authenticated;
grant select on public.sync_log to anon, authenticated;

-- rows: array JSON hasil get_values 'Selling PO'!A3:L (elemen pertama = baris 3 sheet)
create or replace function public.sync_selling_po(rows jsonb, first_row int default 3)
returns jsonb language plpgsql set search_path = '' as $$
declare v_ins int := 0; v_upd int := 0; v_del int := 0; v_total int := 0;
begin
  create temp table _src on commit drop as
  select (e.ordinality - 1 + first_row)::int as sheet_row,
    public.parse_id_date(e.value->>0) as request_date,
    nullif(btrim(e.value->>1),'') as request_by, nullif(btrim(e.value->>2),'') as no_po,
    nullif(btrim(e.value->>3),'') as customer, nullif(btrim(e.value->>4),'') as project,
    nullif(btrim(e.value->>5),'') as details, nullif(btrim(e.value->>6),'') as cos,
    nullif(btrim(e.value->>7),'') as posting_cos, nullif(btrim(e.value->>8),'') as no_gp,
    nullif(btrim(e.value->>9),'') as progres, nullif(btrim(e.value->>10),'') as notes,
    coalesce(upper(e.value->>11) = 'TRUE', false) as selesai
  from jsonb_array_elements(rows) with ordinality e;

  delete from _src where no_po is null and customer is null;
  select count(*) into v_total from _src;

  with d as (delete from public.selling_po t where not exists (select 1 from _src s where s.sheet_row = t.sheet_row) returning 1)
  select count(*) into v_del from d;

  with u as (
    update public.selling_po t set request_date = s.request_date, request_by = s.request_by, no_po = s.no_po,
      customer = s.customer, project = s.project, details = s.details, cos = s.cos, posting_cos = s.posting_cos,
      no_gp = s.no_gp, progres = s.progres, notes = s.notes, selesai = s.selesai
    from _src s
    where s.sheet_row = t.sheet_row
      and (t.request_date, t.request_by, t.no_po, t.customer, t.project, t.details, t.cos, t.posting_cos, t.no_gp, t.progres, t.notes, t.selesai)
          is distinct from
          (s.request_date, s.request_by, s.no_po, s.customer, s.project, s.details, s.cos, s.posting_cos, s.no_gp, s.progres, s.notes, s.selesai)
    returning 1)
  select count(*) into v_upd from u;

  with i as (
    insert into public.selling_po (sheet_row, request_date, request_by, no_po, customer, project, details, cos, posting_cos, no_gp, progres, notes, selesai)
    select s.sheet_row, s.request_date, s.request_by, s.no_po, s.customer, s.project, s.details, s.cos, s.posting_cos, s.no_gp, s.progres, s.notes, s.selesai
    from _src s where not exists (select 1 from public.selling_po t where t.sheet_row = s.sheet_row)
    returning 1)
  select count(*) into v_ins from i;

  insert into public.sync_log (source, rows_in_sheet, inserted, updated, deleted)
  values ('Google Sheet: Selling PO', v_total, v_ins, v_upd, v_del);
  return jsonb_build_object('rows_in_sheet', v_total, 'inserted', v_ins, 'updated', v_upd, 'deleted', v_del);
end; $$;

revoke execute on function public.sync_selling_po(jsonb, int) from public, anon, authenticated;
