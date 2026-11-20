-- Reminder kirim: target otomatis = Request date + 5 hari kerja (dihitung di dashboard).
-- target_kirim diisi hanya bila dimundurkan karena alasan khusus; alasannya disimpan di sini.
alter table public.selling_po add column alasan_tunda text;
comment on column public.selling_po.target_kirim is 'Target kirim manual. Kosong = otomatis Request date + 5 hari kerja.';
comment on column public.selling_po.alasan_tunda is 'Alasan khusus barang belum bisa dikirim (wajib bila target melewati 5 hari kerja).';
