# Tugas terjadwal: Email → Supabase (Selling PO)

Buat tugas ini dari **Cowork di laptop** (agar bisa membaca folder `D:\Anes\EMAIL ANES`) dengan connector **Supabase**.

- Nama: `Update PO Penjualan → Supabase`
- Jadwal: Senin–Jumat 09.30, 13.30, 16.30 WIB (`CRON_TZ=Asia/Jakarta 30 9,13,16 * * 1-5`)
- Folder: `D:\Anes\EMAIL ANES`
- Connector: Supabase (Google Sheets tidak diperlukan)

Setelah tugas ini terbukti berjalan, matikan tugas lama **"Update PO Penjualan (Selling PO)"** dan **"Selling PO: email → Supabase"**.

---

## Prompt (salin seluruhnya)

```
Tugas rutin: perbarui data PO PENJUALAN (Selling PO) di database Supabase dari log email Outlook milik Anes (Marketing Operations Supervisor, PT IndoVisual Presentatama / IVP). Tulis ringkasan dalam Bahasa Indonesia. Tugas ini HANYA menangani Selling PO; PO pembelian ke principal dan barang retur ditangani tugas lain, jadi abaikan email yang hanya terkait keduanya. Google Sheet TIDAK dipakai lagi untuk Selling PO: jangan menulis ke sheet mana pun.

## Sumber data
- Di laptop Anes (komputer tertaut), folder `D:\Anes\EMAIL ANES\log\` berisi file harian `log_email_YYYY-MM-DD.csv` (UTF-8 dengan BOM), termasuk file Sabtu, Minggu, dan hari libur. Kolom: Tanggal (yyyy-mm-dd hh:nn:ss, WIB), Arah (Masuk/Terkirim), Pengirim, Email Pengirim, Kepada, CC, Subjek, Lampiran, Isi (isi email lengkap, termasuk kutipan email sebelumnya).
- File ditulis otomatis oleh macro Outlook. Abaikan file bertanggal 2025. Hilangkan duplikat berdasarkan (Tanggal, Arah, Subjek, Pengirim).
- Gunakan device_list_dir lalu device_stage_files untuk menyalin SEMUA file log mulai tanggal (W dikurangi 6 jam) sampai hari ini, termasuk Sabtu/Minggu/libur. Baca dengan pandas (encoding 'utf-8-sig'), gabungkan, saring berdasarkan kolom Tanggal.

## Menentukan email yang diproses
1. Ambil W (email terakhir yang sudah diproses) dari Supabase (project id `ojllwkcprvlskoyqzjsq`) dengan execute_sql:
   `select max(email_terakhir) at time zone 'Asia/Jakarta' as w from public.sync_log where email_terakhir is not null;`
2. Baca semua email dengan Tanggal lebih baru dari (W dikurangi 6 jam). Jendela 6 jam ini disengaja karena Outlook memakai POP dan email bisa tercatat terlambat. Setelah weekend/libur jumlahnya bisa banyak; tetap proses semuanya.
3. Email yang terbaca ulang aman: fungsi database di bawah tidak membuat data ganda dan tidak menimpa isian yang sudah ada.

## Data yang diambil per PO
- Sumber: email PO penjualan dari SBU/partner, terutama ke mailbox poivp.<sbu>@indovisual.co.id (poivp.sgp, poivp.vo, poivp.ivw, poivp.idc, poivp.ivb, poivp.sgm, poivp.sgj, poivp.ivd, poivp.smvpku, dll) atau langsung ke Anes. Contoh No PO: SGA-POTP-…, SGJ-POTP-…, SBY-POTP-…, IVW-POTP-…, IVB-POTP-…, IVD-POTP-…, IC-PONP-…, IOC-POTP-…, ENT-POTP-…, ISI-OPDN-…, OSS-OPDN-…, DK-POTP-… (PKU), nomor SMI berupa angka 455…, dan PO customer reguler dengan format bebas.
- Untuk setiap PO buat objek JSON dengan kunci:
  - request_date: tanggal PO/request, format "20 Nov 2026" (bulan Indonesia singkat: Jan Feb Mar Apr Mei Jun Jul Agu Sep Okt Nov Des)
  - request_by: kode SBU (SGP, SGJ, SGM, SBY, VO, IVW, IVB, IVD, IDC, IOC, ENT, OSS, PKU, SMI, AS, GDN, DEC, PVH, Regular, dll). Lihat pola data yang ada dengan: `select request_by, count(*) from public.selling_po group by 1 order by 2 desc;`
  - no_po (WAJIB, persis seperti tertulis), customer, project, details
  - cos (IH-SOTP-…/IH-SONP-…), posting_cos (IH-SITP-…), no_gp (GP-HS-2026-xxx), progres (status/unit indent), notes
  - Jangan isi selesai, target_kirim, atau alasan_tunda (diatur admin di dashboard).
- Satu No PO = satu objek. Jika beberapa email membahas PO yang sama, gabungkan informasinya (ambil yang paling lengkap).
- Jangan menebak. Jika No PO tidak jelas, JANGAN kirim objeknya; masukkan ke daftar "Perlu cek" di ringkasan. Informasi yang ragu-ragu tulis di notes dengan awalan "Perlu cek:".

## Menulis ke Supabase
- Panggil SATU kali dengan semua PO (bagi beberapa panggilan bila JSON > 1,5 MB):
  `select public.ingest_selling_po($ingest$<ARRAY_JSON>$ingest$::jsonb, 'Email langsung', '<TANGGAL EMAIL TERBARU yyyy-mm-dd hh:mm:ss>+07', '<ringkasan singkat: file log yang dibaca, jumlah email baru/dilewati>');`
  Pastikan teks `$ingest$` tidak muncul di data (jika ada, ganti tag dollar-quote).
- Argumen ke-3 = tanggal email TERBARU yang dibaca (bukan W dikurangi 6 jam). Tetap panggil fungsi walau tidak ada PO (pakai `'[]'`), supaya W tercatat maju.
- Fungsi ini hanya menambah PO baru dan mengisi kolom yang masih kosong. Tidak menimpa isian dashboard, tidak mengubah Ceklis Selesai/target kirim/alasan, tidak menghapus, dan tidak memasukkan lagi PO yang sudah dihapus admin.
- JANGAN menjalankan insert/update/delete langsung ke tabel. Jangan memanggil sync_selling_po.

## Penutup
- Hasil fungsi berisi: rows, inserted, updated, skipped_deleted, conflicts, tanpa_no_po, inserted_po, updated_po, conflict_rows, tanpa_no_po_rows.
- Jika ada PO baru/dilengkapi atau item "Perlu cek", kirim ringkasan singkat ke Anes: No PO baru (+ customer), PO yang dilengkapi, dan item Perlu cek. Ingatkan bahwa target kirim otomatis = Request date + 5 hari kerja dan bisa dilihat di dashboard https://wmadmin.vercel.app. Jika tidak ada perubahan, tidak perlu notifikasi.
- Jika laptop tidak bisa dijangkau atau connector Supabase gagal, jangan menulis apa pun; laporkan bahwa proses dilewati dan bisa dijalankan manual.
```
