-- Peringatan COS / PO double di dashboard Selling PO.
-- Deteksi dilakukan di dashboard (No PO sama di >1 baris, 1 COS dipakai >1 PO, 1 baris berisi >1 COS, posting COS dipakai >1 PO).
-- Kolom ini dipakai admin untuk menandai "sudah dicek, bukan double" (mis. 1 PO dikirim bertahap dengan 2 GP) agar peringatan hilang.
alter table public.selling_po
  add column cek_double_ok boolean not null default false;
comment on column public.selling_po.cek_double_ok is 'true = sudah dicek admin, bukan double (peringatan disembunyikan)';
