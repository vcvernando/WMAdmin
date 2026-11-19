-- Selling PO: migrasi dari Google Sheet "Update Penjualan COS : Daily" (tab Selling PO)
create table public.selling_po (
  id bigint generated always as identity primary key,
  sheet_row integer,              -- nomor baris asal di Google Sheet
  request_date date,
  request_by text,
  no_po text,
  customer text,
  project text,
  details text,
  cos text,
  posting_cos text,               -- "Nomor Posting COS"
  no_gp text,
  progres text,                   -- kolom "Unit indent" / progres
  notes text,
  selesai boolean not null default false,  -- "Selesai (Admin)"
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index selling_po_request_date_idx on public.selling_po (request_date desc);
create index selling_po_request_by_idx on public.selling_po (request_by);

-- Parser tanggal format sheet: "11 Jul 2025", "1 Agu 2026", "7 Mei 2026"
create or replace function public.parse_id_date(t text)
returns date language plpgsql immutable set search_path = '' as $$
declare parts text[]; m int;
begin
  if t is null or btrim(t) = '' then return null; end if;
  parts := regexp_split_to_array(btrim(t), '\s+');
  if array_length(parts, 1) <> 3 then return null; end if;
  m := case lower(left(parts[2], 3))
    when 'jan' then 1 when 'feb' then 2 when 'mar' then 3 when 'apr' then 4
    when 'mei' then 5 when 'may' then 5 when 'jun' then 6 when 'jul' then 7
    when 'agu' then 8 when 'aug' then 8 when 'sep' then 9 when 'okt' then 10
    when 'oct' then 10 when 'nov' then 11 when 'des' then 12 when 'dec' then 12
    else null end;
  if m is null then return null; end if;
  return make_date(parts[3]::int, m, parts[1]::int);
exception when others then return null;
end; $$;

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end; $$;

create trigger selling_po_set_updated_at
before update on public.selling_po
for each row execute function public.set_updated_at();

alter table public.selling_po enable row level security;

-- Preview: hanya baca. Belum ada policy insert/update/delete.
create policy "Selling PO readable" on public.selling_po
  for select to anon, authenticated using (true);

revoke insert, update, delete, truncate on public.selling_po from anon, authenticated;
grant select on public.selling_po to anon, authenticated;
