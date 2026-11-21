# Tugas terjadwal: Email → Pembayaran Vendor (Supabase)

Buat tugas ini dari **Cowork di laptop** (agar bisa membaca folder `D:\Anes\EMAIL ANES`) dengan connector **Supabase**.

- Nama: `Update Pembayaran Vendor → Supabase`
- Jadwal: Senin–Jumat 10.05, 14.05, 17.05 WIB (`CRON_TZ=Asia/Jakarta 5 10,14,17 * * 1-5`)
- Folder: `D:\Anes\EMAIL ANES`
- Connector: Supabase

---

## Prompt (salin seluruhnya)

```
Tugas rutin: perbarui data PENGAJUAN PEMBAYARAN VENDOR di database Supabase dari log email Outlook milik Anes (Marketing Operations Supervisor, PT IndoVisual Presentatama / IVP). Tulis ringkasan dalam Bahasa Indonesia. Tugas ini HANYA menangani tagihan/pembayaran ke vendor; Selling PO, PO principal (status barang), dan retur ditangani tugas lain.

## Sumber data
- Folder laptop `D:\Anes\EMAIL ANES\log\` berisi file harian `log_email_YYYY-MM-DD.csv` (UTF-8 dengan BOM), termasuk Sabtu/Minggu/libur. Kolom: Tanggal (yyyy-mm-dd hh:nn:ss, WIB), Arah (Masuk/Terkirim), Pengirim, Email Pengirim, Kepada, CC, Subjek, Lampiran, Isi (isi lengkap, termasuk kutipan email sebelumnya).
- Abaikan file bertanggal 2025. Hilangkan duplikat berdasarkan (Tanggal, Arah, Subjek, Pengirim).
- Gunakan device_list_dir lalu device_stage_files untuk menyalin SEMUA file log dari tanggal (W dikurangi 6 jam) sampai hari ini. Baca dengan pandas (encoding 'utf-8-sig').

## Menentukan email yang diproses
1. Ambil W dari Supabase (project id `ojllwkcprvlskoyqzjsq`) dengan execute_sql:
   `select max(email_terakhir) at time zone 'Asia/Jakarta' as w from public.payment_sync_log where email_terakhir is not null;`
   Jika kosong (run pertama), pakai 1 Oktober 2026 00:00.
2. Baca semua email dengan Tanggal lebih baru dari (W dikurangi 6 jam). Email yang terbaca ulang aman: fungsi database tidak membuat data ganda.
3. Untuk mencocokkan nama vendor, ambil daftar vendor: `select nama, top_hari, dasar_top from public.vendors order by nama;` Pakai nama yang PERSIS sama dengan master bila vendornya sudah ada.

## Email yang relevan
- Pengajuan/request pembayaran tagihan vendor ke tim Finance IVP (mis. Fin13, admin-fp, tim finance lain), biasanya dengan lampiran invoice/faktur pajak/surat jalan, subjek seperti "Pengajuan pembayaran", "Request payment", "Mohon dibantu pembayaran", "Tagihan …", "Invoice …".
- Invoice/tagihan dari vendor ke Anes/tim admin (status awal, dokumen belum tentu fisik).
- Balasan finance: dijadwalkan ("akan dibayar Kamis …"), pending/ditolak (dokumen kurang, selisih, dll), atau sudah dibayar ("sudah ditransfer", bukti transfer, remittance).
- Abaikan notifikasi "[NOREPLY] Dynamics NAV Approval", newsletter, dan email yang tidak terkait pembayaran vendor.

## Data per tagihan (satu objek JSON per vendor + nomor invoice)
- vendor_nama (WAJIB), no_invoice (WAJIB, persis seperti tertulis), entitas (default "IVP"; isi lain hanya bila jelas, mis. ISP/MVI), no_po
- tgl_invoice, tgl_barang_diterima (tanggal barang diterima gudang bila disebut), format "20 Nov 2026"
- nominal (persis seperti tertulis bila jelas di isi email, mis. "Rp 25.000.000"), mata_uang ("IDR"/"USD")
- doc_invoice, doc_faktur, doc_sj, doc_po: true HANYA bila email menyatakan dokumen FISIK sudah diterima (lampiran PDF saja BUKAN fisik), no_faktur, no_sj, tgl_dokumen_lengkap (bila disebut)
- status: "diajukan" (email pengajuan dari tim admin ke finance), "dijadwalkan" (finance konfirmasi jadwal), "pending" / "ditolak" (finance menahan/menolak; isi alasan), "dibayar" (finance konfirmasi transfer). Kosongkan bila email hanya invoice dari vendor.
- tgl_diajukan (tanggal email pengajuan), no_pengajuan, pic_finance, rencana_bayar (bila finance menyebut tanggal), tgl_dibayar, no_bukti_transfer, alasan
- email_ref: "yyyy-mm-dd hh:nn:ss - <subjek>" dari email sumber
- Jangan menebak. Jika vendor atau nomor invoice tidak jelas, JANGAN kirim objeknya; masukkan ke daftar "Perlu cek" di ringkasan.
- no_po: tulis nomor PO NAV (IH-POTP-…/IH-PONP-…) bila disebut; database otomatis menautkan tagihan ke PO di tab 🧾 PO Pembelian & Bayar. Satu PO boleh punya beberapa tagihan (barang, freight, surveyor, bea cukai).
- Untuk vendor CBD/Exwork, Proforma Invoice (PI) yang diterima dicatat sebagai tagihan: no_invoice = nomor PI, tgl_invoice = tanggal PI diterima, doc_invoice = true. Dashboard menjadwalkan bayar Kamis minggu berikutnya; faktur/SJ tidak dipersyaratkan.

## Menulis ke Supabase
- Panggil SATU kali dengan semua tagihan (bagi beberapa panggilan bila JSON > 1,5 MB):
  `select public.ingest_payment_requests($ingest$<ARRAY_JSON>$ingest$::jsonb, 'Email pembayaran', '<TANGGAL EMAIL TERBARU yyyy-mm-dd hh:mm:ss>+07', '<ringkasan singkat: file log yang dibaca, jumlah email baru/dilewati>');`
  Pastikan teks `$ingest$` tidak muncul di data. Tetap panggil walau tidak ada tagihan (pakai '[]') supaya W tercatat maju.
- Fungsi ini hanya menambah tagihan baru, mengisi kolom kosong, dan menaikkan status (tidak pernah mundur). Isian admin di dashboard tidak ditimpa.
- JANGAN menjalankan insert/update/delete langsung ke tabel.

## Penutup
- Kirim ringkasan singkat ke Anes bila ada tagihan baru, perubahan status, atau item "Perlu cek".
- Pada run hari RABU pukul 14.05, selalu kirim daftar untuk dicek bersama finance:
  `select vendor_nama, no_invoice, status, tgl_diajukan, rencana_bayar, tgl_barang_diterima, top_hari from public.payment_requests where status not in ('dibayar','ditolak') order by coalesce(rencana_bayar, tgl_barang_diterima);`
  (sebutkan bahwa rencana bayar & jatuh tempo lengkap ada di dashboard https://wmadmin.vercel.app → Pembayaran Vendor).
- Jika laptop tidak bisa dijangkau atau connector Supabase gagal, jangan menulis apa pun; laporkan bahwa proses dilewati.
```
