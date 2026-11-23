-- Gabung PO Principal + Pembayaran Vendor:
--  * tagihan (payment_requests) ditautkan ke PO (po_id), satu PO bisa punya beberapa tagihan (barang, freight, bea cukai, dll)
--  * PO internal (potong-potongan antar company: KIM, ABCD, ISI, Servisindo/ISS) ditandai & disembunyikan default, TOP 30
--  * termin: TOP (bayar setelah barang diterima), CBD / Exwork (bayar sebelum barang dikirim / diambil), DP

-- ---------- Kolom baru ----------
alter table public.vendors
  add column internal boolean not null default false,
  add column termin text not null default 'TOP' check (termin in ('TOP', 'CBD', 'Exwork', 'DP'));

alter table public.po_principal
  add column internal boolean,
  add column termin text check (termin is null or termin in ('TOP', 'CBD', 'Exwork', 'DP')),
  add column top_hari integer check (top_hari is null or top_hari between 0 and 365);

alter table public.payment_requests
  add column po_id bigint references public.po_principal (id) on delete set null,
  add column termin text check (termin is null or termin in ('TOP', 'CBD', 'Exwork', 'DP'));
create index payment_requests_po_id_idx on public.payment_requests (po_id);

-- ---------- Vendor internal ----------
create or replace function public.is_internal_vendor(p_nama text)
returns boolean language sql stable set search_path = '' as $$
  select coalesce(p_nama ~* '(\mKIM\M|kreasi internusa|internusa mandiri|\mABCD\M|indovisual sistem integrasi|\mISI\M|servisindo|\mISS\M)', false)
    or exists (select 1 from public.vendors v where v.internal and lower(btrim(v.nama)) = lower(btrim(p_nama)));
$$;

create or replace function public.po_principal_defaults()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.internal is null then new.internal := public.is_internal_vendor(new.principal); end if;
  if new.internal and new.termin is null then new.termin := 'TOP'; end if;
  if new.internal and new.top_hari is null then new.top_hari := 30; end if;
  return new;
end; $$;
create trigger po_principal_defaults before insert or update on public.po_principal
  for each row execute function public.po_principal_defaults();

-- ---------- Tautkan tagihan ke PO ----------
-- Cocokkan No PO tagihan dengan tracker PO: nomor NAV (IH-...) dulu, lalu nomor lain (ISP/IVP-OPLN...), lalu teks persis.
-- Hanya ditautkan bila hasilnya tepat satu PO.
create or replace function public.find_po_id(p_no_po text)
returns bigint language plpgsql stable set search_path = '' as $$
declare v_tokens text[]; v_tok text; v_ids bigint[];
begin
  if p_no_po is null or btrim(p_no_po) = '' then return null; end if;
  select array_agg(distinct m[1] order by m[1]) into v_tokens
    from regexp_matches(upper(p_no_po), '([A-Z]{2,4}-[A-Z]{4}-[0-9]{4}-[0-9]{4})', 'g') m;
  if v_tokens is not null then
    foreach v_tok in array (select array_agg(t order by (t like 'IH-%') desc) from unnest(v_tokens) t) loop
      select array_agg(distinct p.id) into v_ids from public.po_principal p where strpos(upper(p.no_po), v_tok) > 0;
      if array_length(v_ids, 1) = 1 then return v_ids[1]; end if;
    end loop;
  end if;
  select array_agg(p.id) into v_ids from public.po_principal p
    where upper(regexp_replace(p.no_po, '\s+', '', 'g')) = upper(regexp_replace(p_no_po, '\s+', '', 'g'));
  return case when array_length(v_ids, 1) = 1 then v_ids[1] end;
end; $$;

create or replace function public.payment_link_po()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.po_id is null and new.no_po is not null
     and (tg_op = 'INSERT' or new.no_po is distinct from old.no_po or old.po_id is null) then
    new.po_id := public.find_po_id(new.no_po);
  end if;
  return new;
end; $$;
create trigger payment_requests_link_po before insert or update on public.payment_requests
  for each row execute function public.payment_link_po();

revoke execute on function public.find_po_id(text) from public, anon;
revoke execute on function public.is_internal_vendor(text) from public, anon;

-- ---------- Isi data yang sudah ada ----------
update public.po_principal set internal = null where internal is null;  -- memicu trigger default
update public.payment_requests set po_id = public.find_po_id(no_po) where po_id is null and no_po is not null;

-- ---------- Termin dari email (hanya mengisi yang masih kosong) ----------
-- rows: [{no_po, termin: TOP|CBD|Exwork|DP, top_hari}]
create or replace function public.set_po_termin(rows jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare s record; v_id bigint; v_n int := 0; v_skip jsonb := '[]'::jsonb;
begin
  for s in select nullif(btrim(e->>'no_po'), '') no_po, nullif(btrim(e->>'termin'), '') termin,
      nullif(btrim(e->>'top_hari'), '')::int top_hari from jsonb_array_elements(rows) e loop
    if s.termin is null or s.termin not in ('TOP', 'CBD', 'Exwork', 'DP') then
      v_skip := v_skip || jsonb_build_object('no_po', s.no_po, 'alasan', 'termin tidak valid'); continue;
    end if;
    v_id := public.find_po_id(s.no_po);
    if v_id is null then v_skip := v_skip || jsonb_build_object('no_po', s.no_po, 'alasan', 'PO tidak ditemukan'); continue; end if;
    update public.po_principal p set termin = s.termin, top_hari = coalesce(p.top_hari, s.top_hari)
      where p.id = v_id and p.termin is null;
    if found then v_n := v_n + 1; end if;
  end loop;
  return jsonb_build_object('diisi', v_n, 'dilewati', v_skip);
end; $$;
revoke execute on function public.set_po_termin(jsonb) from public, anon, authenticated;
