-- Kolom dari laporan Excel Selling PO (26 Nov 2026): BAST, estimasi biaya kirim, rencana/status kirim, terkirim.
alter table public.selling_po
  add column bast text,
  add column estimasi_biaya_kirim numeric(18,2) check (estimasi_biaya_kirim is null or estimasi_biaya_kirim >= 0),
  add column rencana_kirim text,
  add column terkirim boolean not null default false;
comment on column public.selling_po.bast is 'Rencana / tanggal BAST (tanggal atau teks minggu, mis. W1 Des)';
comment on column public.selling_po.estimasi_biaya_kirim is 'Estimasi biaya kirim (Rp)';
comment on column public.selling_po.rencana_kirim is 'Rencana / status kirim teks bebas, mis. PICKUP W1 Des, W2/W3 Des';
comment on column public.selling_po.terkirim is 'Barang sudah terkirim / jasa selesai (reminder kirim berhenti; Ceklis Selesai tetap untuk dokumen lengkap)';
