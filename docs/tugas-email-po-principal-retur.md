# Tugas terjadwal: Email → Supabase (PO Principal & COS Retur)

Data tracker **PO Principal** dan **COS Retur** sekarang ada di Supabase (tabel `po_principal` dan `cos_retur`). Keduanya tampil di dashboard https://wmadmin.vercel.app pada tab 🚢 PO Principal dan ↩ COS Retur. Google Sheet "Tracker PO Principal & COS Retur" tidak dipakai lagi.

Ubah dua tugas lama di **Cowork laptop**. Ganti prompt-nya dengan teks di bawah dan tambahkan connector **Supabase**. Jadwal dan folder tetap sama:

| Tugas | Jadwal | Folder |
|---|---|---|
| Update PO Pembelian (PO Principal) | Senin–Jumat 09.40, 13.40, 16.40 WIB | `D:\Anes\EMAIL ANES` |
| Update Barang Retur (COS Retur) | Senin–Jumat 09.50, 13.50, 16.50 WIB | `D:\Anes\EMAIL ANES` |

Data awal sudah dipindahkan dari sheet. Kolom W (email terakhir yang sudah diproses) juga sudah tercatat di `tracker_sync_log`, jadi tugas baru melanjutkan tepat dari posisi terakhir.

---

## Prompt A — Update PO Pembelian (PO Principal) → Supabase

```
Tugas rutin: perbarui tracker PO PEMBELIAN (PO Principal) di database Supabase dari log email Outlook milik Anes (Marketing Operations Supervisor, PT IndoVisual Presentatama / IVP). Tulis ringkasan dalam Bahasa Indonesia. Tugas ini HANYA menangani PO pembelian IVP ke principal/vendor. PO penjualan dan barang retur ditangani tugas lain, jadi abaikan email yang hanya terkait keduanya. Google Sheet TIDAK dipakai lagi: jangan menulis ke sheet mana pun.

## Sumber data
- Di laptop Anes (komputer tertaut), folder `D:\Anes\EMAIL ANES\log\` berisi file harian `log_email_YYYY-MM-DD.csv` (UTF-8 dengan BOM), termasuk file Sabtu, Minggu, dan libur.
  Kolom: Tanggal (yyyy-mm-dd hh:nn:ss, WIB), Arah, Pengirim, Email Pengirim, Kepada, CC, Subjek, Lampiran, Isi (isi lengkap termasuk kutipan).
- Abaikan file bertanggal 2025. Hilangkan duplikat berdasarkan (Tanggal, Arah, Subjek, Pengirim).
- Gunakan device_list_dir lalu device_stage_files untuk menyalin SEMUA file log dari tanggal (W dikurangi 6 jam) sampai hari ini, termasuk Sabtu/Minggu/libur. Baca dengan pandas (encoding 'utf-8-sig'), gabungkan, lalu saring berdasarkan Tanggal.

## Menentukan email yang diproses
1. Ambil W dari Supabase (project id `ojllwkcprvlskoyqzjsq`) dengan execute_sql:
   `select max(email_terakhir) at time zone 'Asia/Jakarta' as w from public.tracker_sync_log where tracker = 'po_principal';`
2. Baca semua email dengan Tanggal lebih baru dari (W dikurangi 6 jam). Jendela 6 jam ini disengaja karena Outlook memakai POP, sehingga email bisa tercatat terlambat. Setelah weekend/libur jumlahnya bisa banyak; tetap proses semuanya. Principal luar negeri sering mengirim email di hari Sabtu/Minggu.
3. Email yang terbaca ulang aman: fungsi database tidak membuat baris ganda dan tidak mengembalikan status ke kondisi lama.
4. Untuk melihat data yang sudah ada:
   `select no_po, principal, status, tgl_update, selesai from public.po_principal order by id;`

## Data per PO (satu No PO = satu objek JSON)
- Sumber email:
  - PO pembelian IVP ke principal/vendor (IH-POTP-…, IH-PONP-…, IH-PORA-…, IVP-OPDN-…, ISP-OPLN-…, MVI-PORA-…, dll).
  - Email ke/dari principal: CUE, JWIPC, Lumi, MMD, Maxhub/Shizhen, USER, Wyrestorm, Philips/PGI via Invia, Hitevision, Microvision, Galva, Skyworth, Tricolor, KIM, SMI, dll.
  - Email "BARANG MASUK … // AJU …", approval POFW, billing PIB, konfirmasi pembayaran, dan pengiriman.
- Kunci JSON:
  - tgl_po: format "20 Nov 2026" (Jan Feb Mar Apr Mei Jun Jul Agu Sep Okt Nov Des)
  - no_po: WAJIB, persis seperti tertulis
  - principal, item, qty, no_aju
  - status: salah satu dari PO Dikirim, Konfirmasi Principal, Pembayaran, Shipping, Customs / AJU, POFW Approved, Barang Masuk Gudang, Selesai, Pending, Cancelled, Perlu Cek
  - update_terakhir: ringkasan 1 kalimat perkembangan terbaru
  - tgl_update: tanggal email perkembangan tersebut
  - pic
  - email_ref: subjek email
  - catatan
  - tgl_email_pertama: tanggal email pertama yang menyebut PO ini
- Jika beberapa email membahas PO yang sama, gabungkan jadi satu objek dengan update_terakhir/tgl_update dari email TERBARU.
- Jangan menebak. Jika tidak yakin, isi yang pasti saja, set status "Perlu Cek", dan jelaskan di catatan.
- JANGAN isi kolom selesai (dicentang admin di dashboard).
- Abaikan "[NOREPLY] Dynamics NAV Approval", newsletter, dan email yang tidak terkait PO pembelian.

## Menulis ke Supabase
- Panggil SATU kali dengan semua PO:
  `select public.ingest_po_principal($ingest$<ARRAY_JSON>$ingest$::jsonb, 'Email PO Principal', '<TANGGAL EMAIL TERBARU yyyy-mm-dd hh:mm:ss>+07', '<ringkasan singkat: file log yang dibaca, jumlah email baru/dilewati>') - 'inserted_rows' - 'updated_rows' as hasil;`
  Pastikan teks `$ingest$` tidak muncul di data.
- Argumen ke-3 adalah tanggal email TERBARU yang dibaca (bukan W dikurangi 6 jam). Tetap panggil fungsi walau tidak ada PO (pakai '[]'), supaya W tercatat maju.
- Yang dilakukan fungsi:
  - Baris baru dibuat bila No PO belum ada (dicocokkan juga lewat nomor IH-… di dalam teks No PO).
  - Kolom kosong diisi.
  - Status, update terakhir, dan tgl update hanya diganti bila tgl_update email sama atau lebih baru.
  - Catatan ditambahkan, bukan ditimpa.
  - Kolom selesai tidak pernah diubah.
  - Baris yang ambigu dilewati dan muncul di skipped_rows.
- JANGAN menjalankan insert/update/delete langsung ke tabel.

## Penutup
- Jika ada PO baru, perubahan status penting, item "Perlu Cek", atau skipped_rows, kirim ringkasan singkat ke Anes dan sebutkan dashboard https://wmadmin.vercel.app (tab 🚢 PO Principal). Sebutkan juga PO yang sudah dicentang selesai tapi menerima email baru. Jika tidak ada perubahan, tidak perlu notifikasi.
- Jika laptop tidak bisa dijangkau atau connector Supabase gagal, jangan menulis apa pun; laporkan bahwa proses dilewati dan bisa dijalankan manual.
```

---

## Prompt B — Update Barang Retur (COS Retur) → Supabase

```
Tugas rutin: perbarui tracker BARANG RETUR (COS Retur) di database Supabase dari log email Outlook milik Anes (Marketing Operations Supervisor, PT IndoVisual Presentatama / IVP). Tulis ringkasan dalam Bahasa Indonesia. Tugas ini HANYA menangani retur. PO penjualan dan PO pembelian ditangani tugas lain, jadi abaikan email yang hanya terkait keduanya. Google Sheet TIDAK dipakai lagi: jangan menulis ke sheet mana pun.

## Sumber data
- Di laptop Anes (komputer tertaut), folder `D:\Anes\EMAIL ANES\log\` berisi file harian `log_email_YYYY-MM-DD.csv` (UTF-8 dengan BOM), termasuk file Sabtu, Minggu, dan libur.
  Kolom: Tanggal (yyyy-mm-dd hh:nn:ss, WIB), Arah, Pengirim, Email Pengirim, Kepada, CC, Subjek, Lampiran, Isi (isi lengkap termasuk kutipan).
- Abaikan file bertanggal 2025. Hilangkan duplikat berdasarkan (Tanggal, Arah, Subjek, Pengirim).
- Gunakan device_list_dir lalu device_stage_files untuk menyalin SEMUA file log dari tanggal (W dikurangi 6 jam) sampai hari ini, termasuk Sabtu/Minggu/libur. Baca dengan pandas (encoding 'utf-8-sig'), gabungkan, lalu saring berdasarkan Tanggal.

## Menentukan email yang diproses
1. Ambil W dari Supabase (project id `ojllwkcprvlskoyqzjsq`) dengan execute_sql:
   `select max(email_terakhir) at time zone 'Asia/Jakarta' as w from public.tracker_sync_log where tracker = 'cos_retur';`
2. Baca semua email dengan Tanggal lebih baru dari (W dikurangi 6 jam). Jendela 6 jam ini disengaja karena Outlook memakai POP. Setelah weekend/libur jumlahnya bisa banyak; tetap proses semuanya.
3. Email yang terbaca ulang aman: fungsi database tidak membuat baris ganda dan tidak mengembalikan status ke kondisi lama.
4. Untuk melihat data yang sudah ada (agar customer/tipe unit/SN ditulis sama persis dengan baris yang ada):
   `select id, no_cos_retur, customer, tipe_unit, serial_number, status, tgl_update, selesai from public.cos_retur order by id;`

## Data per kasus retur (satu kasus = satu objek JSON)
- Sumber email: retur, COS retur (IH-SRTP-…, IH-SCNP-…), COS replace, PO buyback, penarikan unit, unit rusak dikirim ke SRV/Servisindo/ISS, rencana scrap, unit masuk TLJ, dan RMA ke principal.
- Kunci JSON:
  - tgl_request: format "20 Nov 2026"
  - no_cos_retur
  - cos_asal
  - customer: WAJIB bila no_cos_retur kosong
  - tipe_unit, serial_number, qty, alasan
  - tindakan: salah satu dari Kirim ke SRV, Scrap, Masuk TLJ, PO Buyback, COS Replace, Kembali ke Stock, Retur ke Principal, Belum Ditentukan
  - no_replace: No COS replace / PO buyback
  - status: salah satu dari Request, COS Retur Dibuat, Unit Ditarik, Unit di Gudang, Di SRV, Selesai, Pending, Cancelled, Perlu Cek
  - update_terakhir: ringkasan 1 kalimat perkembangan terbaru
  - tgl_update: tanggal email perkembangan tersebut
  - pic
  - email_ref: subjek email
  - catatan
- Kasus dikenali dari No COS Retur. Bila No COS belum ada, kasus dikenali dari Customer + Tipe Unit + Serial Number, yang harus ditulis SAMA PERSIS dengan baris yang sudah ada.
- Bila No COS Retur baru terbit untuk kasus lama, kirim objek dengan no_cos_retur baru dan customer/tipe_unit/serial_number yang persis sama, supaya baris lama dilengkapi.
- Jika beberapa email membahas kasus yang sama, gabungkan dengan update_terakhir/tgl_update dari email TERBARU.
- Jangan menebak. Jika tidak yakin (misalnya COS asal tidak disebut), isi yang pasti saja, set status "Perlu Cek", dan jelaskan di catatan.
- JANGAN isi kolom selesai.
- Abaikan "[NOREPLY] Dynamics NAV Approval" kecuali isinya satu-satunya sumber No COS retur. Abaikan juga newsletter dan email yang tidak terkait retur.

## Menulis ke Supabase
- Panggil SATU kali dengan semua kasus:
  `select public.ingest_cos_retur($ingest$<ARRAY_JSON>$ingest$::jsonb, 'Email COS Retur', '<TANGGAL EMAIL TERBARU yyyy-mm-dd hh:mm:ss>+07', '<ringkasan singkat: file log yang dibaca, jumlah email baru/dilewati>') - 'inserted_rows' - 'updated_rows' as hasil;`
  Pastikan teks `$ingest$` tidak muncul di data.
- Argumen ke-3 adalah tanggal email TERBARU yang dibaca. Tetap panggil fungsi walau tidak ada kasus (pakai '[]').
- Yang dilakukan fungsi:
  - Kolom kosong diisi.
  - Status, update terakhir, dan tgl update hanya diganti bila tgl_update email sama atau lebih baru.
  - Catatan ditambahkan, bukan ditimpa.
  - Kolom selesai tidak pernah diubah.
- JANGAN menjalankan insert/update/delete langsung ke tabel.

## Penutup
- Jika ada retur baru, perubahan status penting, item "Perlu Cek", atau skipped_rows, kirim ringkasan singkat ke Anes dan sebutkan dashboard https://wmadmin.vercel.app (tab ↩ COS Retur). Jika tidak ada perubahan, tidak perlu notifikasi.
- Jika laptop tidak bisa dijangkau atau connector Supabase gagal, jangan menulis apa pun; laporkan bahwa proses dilewati dan bisa dijalankan manual.
```
