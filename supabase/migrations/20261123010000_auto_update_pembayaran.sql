-- Auto update pembayaran dari PO / invoice:
--  1. Termin otomatis TOP bila TOP (hari) diisi tapi termin kosong, di tagihan maupun PO
--     (sebelumnya TOP yang diisi diabaikan bila vendor/PO tercatat CBD).
--  2. Status tagihan ikut tanggal yang diisi:
--       tgl dibayar diisi          -> Dibayar
--       tgl diajukan diisi         -> Diajukan   (dari Dokumen belum lengkap / Siap diajukan, atau pengajuan ulang setelah Pending/Ditolak)
--       rencana bayar diisi        -> Dijadwalkan (bila sudah Diajukan)
--     Hanya saat tanggalnya baru diisi/diubah, jadi status yang diubah manual tidak dipaksa balik.
--  3. Termin & TOP PO <-> tagihan:
--       PO diubah   -> tagihan terbuka (belum dibayar/ditolak) yang masih mengikuti nilai lama PO ikut berubah
--       tagihan diisi -> termin/TOP PO yang masih kosong ikut terisi
--     pg_trigger_depth() mencegah saling memicu tanpa henti.

-- ---------- 1 & 2: tagihan ----------
create or replace function public.payment_requests_auto()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_ins boolean := tg_op = 'INSERT';
  v_bayar boolean; v_ajukan boolean; v_rencana boolean;
begin
  if new.termin is null and coalesce(new.top_hari, 0) > 0 then new.termin := 'TOP'; end if;

  v_bayar   := new.tgl_dibayar   is not null and (v_ins or new.tgl_dibayar   is distinct from old.tgl_dibayar);
  v_ajukan  := new.tgl_diajukan  is not null and (v_ins or new.tgl_diajukan  is distinct from old.tgl_diajukan);
  v_rencana := new.rencana_bayar is not null and (v_ins or new.rencana_bayar is distinct from old.rencana_bayar);

  if v_ajukan and (new.status in ('belum_lengkap', 'siap_diajukan')
      or (not v_ins and new.status in ('pending', 'ditolak') and new.status = old.status)) then
    new.status := 'diajukan';
  end if;
  if v_rencana and new.status = 'diajukan' then new.status := 'dijadwalkan'; end if;
  if v_bayar then new.status := 'dibayar'; end if;
  return new;
end; $$;

create trigger payment_requests_auto before insert or update on public.payment_requests
  for each row execute function public.payment_requests_auto();

-- ---------- 3a: tagihan -> PO (isi yang kosong saja) ----------
create or replace function public.payment_requests_sync_po()
returns trigger language plpgsql set search_path = '' as $$
begin
  if pg_trigger_depth() > 1 or new.po_id is null or (new.termin is null and new.top_hari is null) then return null; end if;
  update public.po_principal p set
    termin   = coalesce(p.termin, new.termin),
    top_hari = case when coalesce(p.termin, new.termin) = 'TOP' then coalesce(p.top_hari, new.top_hari) else p.top_hari end
  where p.id = new.po_id
    and ((p.termin is null and new.termin is not null)
      or (p.top_hari is null and new.top_hari is not null and coalesce(p.termin, new.termin) = 'TOP'));
  return null;
end; $$;

create trigger payment_requests_sync_po after insert or update of termin, top_hari, po_id on public.payment_requests
  for each row execute function public.payment_requests_sync_po();

-- ---------- 3b: PO -> tagihan terbuka ----------
create or replace function public.po_principal_defaults()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.internal is null then new.internal := public.is_internal_vendor(new.principal); end if;
  if new.internal and new.termin is null then new.termin := 'TOP'; end if;
  if new.internal and new.top_hari is null then new.top_hari := 30; end if;
  if new.termin is null and coalesce(new.top_hari, 0) > 0 then new.termin := 'TOP'; end if;
  return new;
end; $$;

create or replace function public.po_principal_sync_pays()
returns trigger language plpgsql set search_path = '' as $$
begin
  if pg_trigger_depth() > 1
     or (new.termin is not distinct from old.termin and new.top_hari is not distinct from old.top_hari) then
    return null;
  end if;
  update public.payment_requests r set
    termin   = case when r.termin   is not distinct from old.termin   then new.termin   else r.termin   end,
    top_hari = case when r.top_hari is not distinct from old.top_hari then new.top_hari else r.top_hari end
  where r.po_id = new.id
    and r.status not in ('dibayar', 'ditolak')
    and ((new.termin   is distinct from old.termin   and r.termin   is not distinct from old.termin)
      or (new.top_hari is distinct from old.top_hari and r.top_hari is not distinct from old.top_hari));
  return null;
end; $$;

create trigger po_principal_sync_pays after update of termin, top_hari on public.po_principal
  for each row execute function public.po_principal_sync_pays();

-- ---------- Rapikan data yang sudah ada ----------
update public.po_principal set termin = 'TOP' where termin is null and top_hari > 0;
update public.payment_requests set termin = 'TOP' where termin is null and top_hari > 0;  -- ikut mengisi termin/TOP PO yang kosong
update public.payment_requests set status = 'dibayar' where tgl_dibayar is not null and status <> 'dibayar';
