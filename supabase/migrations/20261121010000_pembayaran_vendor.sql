-- Pemantauan pengajuan pembayaran vendor ke Finance (sebagian besar entitas IVP).
-- Sumber: input manual tim admin + otomatis dari log email (request pembayaran ke finance / konfirmasi transfer).

-- ---------- Master vendor ----------
create table public.vendors (
  id bigint generated always as identity primary key,
  nama text not null,
  kode text,
  npwp text,
  top_hari integer not null default 30 check (top_hari between 0 and 365),
  dasar_top text not null default 'barang_diterima' check (dasar_top in ('barang_diterima', 'invoice', 'dokumen_lengkap')),
  mata_uang text not null default 'IDR',
  bank text, no_rekening text, atas_nama text,
  pic text, kontak text, catatan text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid() references auth.users (id) on delete set null
);
create unique index vendors_nama_key on public.vendors (lower(btrim(nama)));

-- ---------- Pengajuan pembayaran ----------
create table public.payment_requests (
  id bigint generated always as identity primary key,
  entitas text not null default 'IVP',
  vendor_id bigint references public.vendors (id) on delete set null,
  vendor_nama text not null,
  no_po text,
  no_invoice text,
  tgl_invoice date,
  tgl_barang_diterima date,
  top_hari integer check (top_hari is null or top_hari between 0 and 365),
  dasar_top text check (dasar_top is null or dasar_top in ('barang_diterima', 'invoice', 'dokumen_lengkap')),
  nominal numeric(18, 2) check (nominal is null or nominal >= 0),
  mata_uang text not null default 'IDR',
  -- dokumen fisik (harus lengkap sebelum payment diproses)
  doc_invoice boolean not null default false,
  doc_faktur boolean not null default false,
  doc_sj boolean not null default false,
  doc_po boolean not null default false,
  no_faktur text,
  no_sj text,
  tgl_dokumen_lengkap date,
  dokumen_cocok boolean,               -- PO = surat jalan = invoice (qty/harga/total)
  catatan_dokumen text,
  -- proses finance
  status text not null default 'belum_lengkap'
    check (status in ('belum_lengkap', 'siap_diajukan', 'diajukan', 'dijadwalkan', 'dibayar', 'pending', 'ditolak')),
  tgl_diajukan date,
  no_pengajuan text,
  pic_finance text,
  rencana_bayar date,                  -- isi manual bila finance memberi tanggal; kosong = dihitung otomatis
  tgl_dibayar date,
  no_bukti_transfer text,
  alasan text,                         -- alasan pending / ditolak
  catatan text,
  sumber text not null default 'manual' check (sumber in ('manual', 'email')),
  email_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null
);
create index payment_requests_vendor_idx on public.payment_requests (vendor_id);
create index payment_requests_status_idx on public.payment_requests (status) where status <> 'dibayar';
create unique index payment_requests_invoice_key on public.payment_requests (lower(btrim(vendor_nama)), upper(regexp_replace(no_invoice, '\s+', '', 'g')))
  where no_invoice is not null and btrim(no_invoice) <> '';

create or replace function public.set_updated_generic()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); new.updated_by := auth.uid(); return new; end; $$;

create trigger vendors_set_updated before update on public.vendors
for each row execute function public.set_updated_generic();
create trigger payment_requests_set_updated before update on public.payment_requests
for each row execute function public.set_updated_generic();

-- ---------- Hak akses: sama dengan Selling PO ----------
alter table public.vendors enable row level security;
alter table public.payment_requests enable row level security;
revoke all on public.vendors, public.payment_requests from anon, authenticated;

create policy "vendors: baca (disetujui)" on public.vendors for select to authenticated using ((select public.is_approved()));
create policy "vendors: tambah (disetujui)" on public.vendors for insert to authenticated with check ((select public.is_approved()));
create policy "vendors: ubah (disetujui)" on public.vendors for update to authenticated using ((select public.is_approved())) with check ((select public.is_approved()));
create policy "vendors: hapus (admin)" on public.vendors for delete to authenticated using ((select public.is_admin()));

create policy "payment: baca (disetujui)" on public.payment_requests for select to authenticated using ((select public.is_approved()));
create policy "payment: tambah (disetujui)" on public.payment_requests for insert to authenticated with check ((select public.is_approved()));
create policy "payment: ubah (disetujui)" on public.payment_requests for update to authenticated using ((select public.is_approved())) with check ((select public.is_approved()));
create policy "payment: hapus (admin)" on public.payment_requests for delete to authenticated using ((select public.is_admin()));

grant select, insert, update, delete on public.vendors, public.payment_requests to authenticated;

-- ---------- Log tarikan email pembayaran (terpisah dari sync_log Selling PO) ----------
create table public.payment_sync_log (
  id bigint generated always as identity primary key,
  source text not null,
  synced_at timestamptz not null default now(),
  rows_in int, inserted int, updated int,
  email_terakhir timestamptz,
  catatan text
);
alter table public.payment_sync_log enable row level security;
revoke all on public.payment_sync_log from anon, authenticated;
create policy "payment_sync_log: baca (disetujui)" on public.payment_sync_log for select to authenticated using ((select public.is_approved()));
grant select on public.payment_sync_log to authenticated;

-- ---------- Penerima data dari email ----------
-- rows: array objek {entitas, vendor_nama, no_po, no_invoice, tgl_invoice, tgl_barang_diterima, nominal, mata_uang,
--   doc_invoice, doc_faktur, doc_sj, doc_po, no_faktur, no_sj, tgl_dokumen_lengkap,
--   status ('diajukan' | 'dijadwalkan' | 'dibayar' | 'pending' | 'ditolak' | null), tgl_diajukan, no_pengajuan, pic_finance,
--   rencana_bayar, tgl_dibayar, no_bukti_transfer, alasan, email_ref}
-- Aturan: kunci = vendor + no invoice (wajib). Hanya menambah baru / mengisi kolom kosong / menaikkan status
-- (tidak pernah mundur, tidak menimpa isian admin, tidak mengubah 'dibayar' kecuali melengkapi).
create or replace function public.ingest_payment_requests(
  rows jsonb, p_source text default 'Email pembayaran', p_email_terakhir timestamptz default null, p_catatan text default null)
returns jsonb language plpgsql set search_path = '' as $$
declare
  s record; t public.payment_requests; v_vendor public.vendors; v_rank_old int; v_rank_new int;
  v_ins int := 0; v_upd int := 0; v_skip int := 0; v_total int := 0;
  v_inserted jsonb := '[]'::jsonb; v_updated jsonb := '[]'::jsonb; v_skipped jsonb := '[]'::jsonb;
begin
  for s in
    select
      coalesce(nullif(btrim(e->>'entitas'), ''), 'IVP') as entitas,
      nullif(btrim(e->>'vendor_nama'), '') as vendor_nama,
      nullif(btrim(e->>'no_po'), '') as no_po,
      nullif(btrim(e->>'no_invoice'), '') as no_invoice,
      public.parse_id_date(e->>'tgl_invoice') as tgl_invoice,
      public.parse_id_date(e->>'tgl_barang_diterima') as tgl_barang_diterima,
      public.parse_nilai(e->>'nominal') as nominal,
      coalesce(nullif(upper(btrim(e->>'mata_uang')), ''), 'IDR') as mata_uang,
      coalesce((e->>'doc_invoice')::boolean, false) as doc_invoice,
      coalesce((e->>'doc_faktur')::boolean, false) as doc_faktur,
      coalesce((e->>'doc_sj')::boolean, false) as doc_sj,
      coalesce((e->>'doc_po')::boolean, false) as doc_po,
      nullif(btrim(e->>'no_faktur'), '') as no_faktur,
      nullif(btrim(e->>'no_sj'), '') as no_sj,
      public.parse_id_date(e->>'tgl_dokumen_lengkap') as tgl_dokumen_lengkap,
      nullif(lower(btrim(e->>'status')), '') as status,
      public.parse_id_date(e->>'tgl_diajukan') as tgl_diajukan,
      nullif(btrim(e->>'no_pengajuan'), '') as no_pengajuan,
      nullif(btrim(e->>'pic_finance'), '') as pic_finance,
      public.parse_id_date(e->>'rencana_bayar') as rencana_bayar,
      public.parse_id_date(e->>'tgl_dibayar') as tgl_dibayar,
      nullif(btrim(e->>'no_bukti_transfer'), '') as no_bukti_transfer,
      nullif(btrim(e->>'alasan'), '') as alasan,
      nullif(btrim(e->>'email_ref'), '') as email_ref
    from jsonb_array_elements(rows) e
  loop
    v_total := v_total + 1;
    if s.vendor_nama is null or s.no_invoice is null then
      v_skip := v_skip + 1;
      v_skipped := v_skipped || jsonb_build_object('vendor', s.vendor_nama, 'no_invoice', s.no_invoice, 'alasan', 'vendor / no invoice tidak jelas');
      continue;
    end if;
    if s.status is not null and s.status not in ('diajukan', 'dijadwalkan', 'dibayar', 'pending', 'ditolak') then
      s.status := null;
    end if;

    select * into v_vendor from public.vendors v where lower(btrim(v.nama)) = lower(s.vendor_nama) limit 1;

    select * into t from public.payment_requests p
    where lower(btrim(p.vendor_nama)) = lower(s.vendor_nama)
      and upper(regexp_replace(p.no_invoice, '\s+', '', 'g')) = upper(regexp_replace(s.no_invoice, '\s+', '', 'g'))
    limit 1;

    if t.id is null then
      insert into public.payment_requests (entitas, vendor_id, vendor_nama, no_po, no_invoice, tgl_invoice, tgl_barang_diterima,
        top_hari, dasar_top, nominal, mata_uang, doc_invoice, doc_faktur, doc_sj, doc_po, no_faktur, no_sj, tgl_dokumen_lengkap,
        status, tgl_diajukan, no_pengajuan, pic_finance, rencana_bayar, tgl_dibayar, no_bukti_transfer, alasan, sumber, email_ref)
      values (s.entitas, v_vendor.id, coalesce(v_vendor.nama, s.vendor_nama), s.no_po, s.no_invoice, s.tgl_invoice, s.tgl_barang_diterima,
        v_vendor.top_hari, v_vendor.dasar_top, s.nominal, s.mata_uang, s.doc_invoice, s.doc_faktur, s.doc_sj, s.doc_po, s.no_faktur, s.no_sj,
        s.tgl_dokumen_lengkap,
        coalesce(s.status, case when s.doc_invoice and s.doc_faktur and s.doc_sj then 'siap_diajukan' else 'belum_lengkap' end),
        coalesce(s.tgl_diajukan, case when s.status = 'diajukan' then current_date end),
        s.no_pengajuan, s.pic_finance, s.rencana_bayar,
        coalesce(s.tgl_dibayar, case when s.status = 'dibayar' then current_date end),
        s.no_bukti_transfer, s.alasan, 'email', s.email_ref);
      v_ins := v_ins + 1;
      v_inserted := v_inserted || jsonb_build_object('vendor', s.vendor_nama, 'no_invoice', s.no_invoice, 'status', coalesce(s.status, 'baru'));
    else
      -- status hanya boleh naik (pending/ditolak dari finance boleh menggantikan diajukan/dijadwalkan)
      v_rank_old := case t.status when 'belum_lengkap' then 0 when 'siap_diajukan' then 1 when 'diajukan' then 2
                    when 'pending' then 3 when 'ditolak' then 3 when 'dijadwalkan' then 4 when 'dibayar' then 9 else 0 end;
      v_rank_new := case s.status when 'diajukan' then 2 when 'pending' then 3 when 'ditolak' then 3
                    when 'dijadwalkan' then 4 when 'dibayar' then 9 else -1 end;
      update public.payment_requests p set
        vendor_id           = coalesce(p.vendor_id, v_vendor.id),
        no_po               = coalesce(nullif(btrim(p.no_po), ''), s.no_po),
        tgl_invoice         = coalesce(p.tgl_invoice, s.tgl_invoice),
        tgl_barang_diterima = coalesce(p.tgl_barang_diterima, s.tgl_barang_diterima),
        nominal             = coalesce(p.nominal, s.nominal),
        doc_invoice         = p.doc_invoice or s.doc_invoice,
        doc_faktur          = p.doc_faktur or s.doc_faktur,
        doc_sj              = p.doc_sj or s.doc_sj,
        doc_po              = p.doc_po or s.doc_po,
        no_faktur           = coalesce(nullif(btrim(p.no_faktur), ''), s.no_faktur),
        no_sj               = coalesce(nullif(btrim(p.no_sj), ''), s.no_sj),
        tgl_dokumen_lengkap = coalesce(p.tgl_dokumen_lengkap, s.tgl_dokumen_lengkap),
        status              = case when v_rank_new > v_rank_old then s.status else p.status end,
        tgl_diajukan        = coalesce(p.tgl_diajukan, s.tgl_diajukan, case when s.status = 'diajukan' then current_date end),
        no_pengajuan        = coalesce(nullif(btrim(p.no_pengajuan), ''), s.no_pengajuan),
        pic_finance         = coalesce(nullif(btrim(p.pic_finance), ''), s.pic_finance),
        rencana_bayar       = coalesce(p.rencana_bayar, s.rencana_bayar),
        tgl_dibayar         = coalesce(p.tgl_dibayar, s.tgl_dibayar, case when s.status = 'dibayar' and v_rank_new > v_rank_old then current_date end),
        no_bukti_transfer   = coalesce(nullif(btrim(p.no_bukti_transfer), ''), s.no_bukti_transfer),
        alasan              = coalesce(nullif(btrim(p.alasan), ''), s.alasan),
        email_ref           = coalesce(p.email_ref, s.email_ref)
      where p.id = t.id
        and (p.vendor_id, p.no_po, p.tgl_invoice, p.tgl_barang_diterima, p.nominal, p.doc_invoice, p.doc_faktur, p.doc_sj, p.doc_po,
             p.no_faktur, p.no_sj, p.tgl_dokumen_lengkap, p.status, p.tgl_diajukan, p.no_pengajuan, p.pic_finance, p.rencana_bayar,
             p.tgl_dibayar, p.no_bukti_transfer, p.alasan)
          is distinct from
            (coalesce(p.vendor_id, v_vendor.id), coalesce(nullif(btrim(p.no_po), ''), s.no_po), coalesce(p.tgl_invoice, s.tgl_invoice),
             coalesce(p.tgl_barang_diterima, s.tgl_barang_diterima), coalesce(p.nominal, s.nominal),
             p.doc_invoice or s.doc_invoice, p.doc_faktur or s.doc_faktur, p.doc_sj or s.doc_sj, p.doc_po or s.doc_po,
             coalesce(nullif(btrim(p.no_faktur), ''), s.no_faktur), coalesce(nullif(btrim(p.no_sj), ''), s.no_sj),
             coalesce(p.tgl_dokumen_lengkap, s.tgl_dokumen_lengkap),
             case when v_rank_new > v_rank_old then s.status else p.status end,
             coalesce(p.tgl_diajukan, s.tgl_diajukan, case when s.status = 'diajukan' then current_date end),
             coalesce(nullif(btrim(p.no_pengajuan), ''), s.no_pengajuan), coalesce(nullif(btrim(p.pic_finance), ''), s.pic_finance),
             coalesce(p.rencana_bayar, s.rencana_bayar),
             coalesce(p.tgl_dibayar, s.tgl_dibayar, case when s.status = 'dibayar' and v_rank_new > v_rank_old then current_date end),
             coalesce(nullif(btrim(p.no_bukti_transfer), ''), s.no_bukti_transfer), coalesce(nullif(btrim(p.alasan), ''), s.alasan));
      if found then
        v_upd := v_upd + 1;
        v_updated := v_updated || jsonb_build_object('id', t.id, 'vendor', t.vendor_nama, 'no_invoice', t.no_invoice);
      end if;
    end if;
  end loop;

  insert into public.payment_sync_log (source, rows_in, inserted, updated, email_terakhir, catatan)
  values (p_source, v_total, v_ins, v_upd, p_email_terakhir, p_catatan);

  return jsonb_build_object('rows', v_total, 'inserted', v_ins, 'updated', v_upd, 'skipped', v_skip,
    'inserted_rows', v_inserted, 'updated_rows', v_updated, 'skipped_rows', v_skipped);
end; $$;

revoke execute on function public.ingest_payment_requests(jsonb, text, timestamptz, text) from public, anon, authenticated;
