# WM Admin — Selling PO

Dashboard **Selling PO** (pengganti tab *Selling PO* & *Selling PO - Aktif* di Google Sheet
"Update Penjualan COS : Daily"). Static site di Vercel, **Supabase adalah data utama** (sync dari Google Sheet sudah dimatikan).

## Fitur
- Login (username atau email) & Register (Nama, Email, Telepon, Password min. 6 karakter). Akun baru **menunggu persetujuan admin**;
  admin melihat banner + angka di tombol **✅ Approve Akun**, lalu klik Approve/Tolak (fungsi `admin_set_user`). Approve sekaligus mengonfirmasi email akun
- Layout 16:9: satu layar penuh tanpa scroll halaman (tabel & reminder scroll di dalam kartunya sendiri)
- **Reminder Pengiriman**: target kirim otomatis = *Request date + 5 hari kerja* (Senin–Jumat; libur nasional belum dihitung).
  Target boleh dimundurkan lewat Edit hanya dengan *Alasan belum bisa dikirim*. Kotak: Terlambat / Hari ini / H-1..H-3 / Ditunda (ada alasan).
  Reminder aktif sampai *Ceklis Selesai* dicentang (PO canceled tidak diingatkan)
- Kolom Aksi: View, Edit (semua akun disetujui), Hapus (khusus admin); tombol ＋ Tambah PO
- **🔑 Password** (semua pengguna): ganti password sendiri; wajib isi password sekarang, password baru min. 8 karakter berisi huruf & angka
- **⚙ Tampilan** (tab Daftar PO): pilih kolom tabel (Request date, Request by, Customer, COS/GP, Progres, Target kirim, Status, Umur; No PO wajib)
  dan bagian dashboard (KPI, Filter, panel Reminder, legenda). Pilihan disimpan per browser; Progres/Notes default tampil hanya di layar >= 1440px
- KPI: Total aktif, Belum ada COS, Belum posting COS, Belum ada No. GP, Perlu cek, Dicentang belum lengkap, Umur > 30 hari, Total PO (klik = filter)
- Mini pie chart: Status, Request by, Kelengkapan dokumen; bar chart PO per bulan (klik = filter)
- Pencarian teks di semua kolom (tekan `/` untuk fokus ke kotak cari)
- Filter: tampilan (Aktif/Semua/Selesai), status, request by, customer, bulan, rentang tanggal, chip (Belum ada COS, Belum posting COS, Belum ada No. GP, Unit indent, Perlu cek, Umur > 30 hari)
- Ringkasan per Request by (ikut filter, klik baris = filter)
- Tabel lengkap dengan sort per kolom, warna baris seperti sheet, detail per PO (klik baris)
- Print (A4 landscape, mencetak sesuai filter) dan export CSV

## Aturan status (sama dengan logika tab "Selling PO - Aktif")
| Status | Kondisi |
|---|---|
| Canceled | sudah dicentang dan dokumen lengkap, **serta** ada kata "Cancel" di COS/Posting COS/GP/progres/notes (PO cancel yang belum dicentang tetap dihitung aktif, sama seperti sheet) |
| Selesai | Ceklis admin ✔ dan No PO, COS, No. GP terisi |
| Dicentang belum lengkap | Ceklis ✔ tapi No PO/COS/No. GP kosong (baris merah) |
| Belum ada COS | belum dicentang, COS kosong / "BELUM ADA COS" |
| Belum ada No. GP | belum dicentang, No. GP kosong |
| Proses | belum dicentang, dokumen lengkap |

"Non GP", "-", "tidak ada nomer GP" dihitung sebagai No. GP terisi.

Format Request Date yang dikenali saat sync: `11 Jul 2025` / `1 Agu 2026`, `11/07/2025` (hari/bulan/tahun), `2025-07-11`.
Format lain disimpan sebagai tanggal kosong (PO tidak punya umur dan tidak masuk grafik per bulan).

## Struktur
```
public/            # file yang di-deploy (index.html, app.js, purchase.js, tracker.js, styles.css, config.js)
supabase/migrations/  # skema tabel, fungsi ingest email + RLS
vercel.json
```

## Keamanan (RLS)
| Siapa | selling_po | profiles |
|---|---|---|
| Belum login (anon) | tidak bisa apa-apa | tidak bisa apa-apa |
| Login, status *pending/rejected* | tidak bisa membaca | hanya profil sendiri |
| Login, *approved* (user) | baca, tambah, edit | hanya profil sendiri |
| Login, *approved* (admin) | baca, tambah, edit, **hapus** | semua; setujui/tolak, ubah peran |

Akun username (mis. `admin`) memakai email sintetis `<username>@wmadmin.local` (lihat `USERNAME_DOMAIN` di `public/config.js`).
Fungsi `sync_selling_po` sekarang selalu gagal dengan pesan "sync dinonaktifkan" agar job lama tidak menimpa data.

## Alur data dari email
```
Outlook -> macro log CSV (laptop) -> tugas terjadwal Cowork "Update PO Penjualan -> Supabase"
        -> public.ingest_selling_po() -> Supabase (data utama) -> dashboard
```
Prompt tugas & cara membuatnya: [`docs/tugas-email-ke-supabase.md`](docs/tugas-email-ke-supabase.md).
Waktu email terakhir yang diproses disimpan di `sync_log.email_terakhir` (pengganti tab "Log Proses").

`ingest_selling_po(rows, source, email_terakhir, catatan)` hanya menambah PO baru dan mengisi kolom yang masih kosong.
Isian dashboard, Ceklis Selesai, target kirim, dan alasan tidak pernah ditimpa; PO yang dihapus admin (`selling_po_deleted`)
tidak diimpor ulang; data dari email tanpa No PO yang jelas ditolak (dilaporkan "perlu cek") agar tidak ganda.
Fungsi ini tidak bisa dipanggil dari browser.

## Peringatan COS / PO double (tab 📦 Selling PO)
Dashboard menandai **⚠ Double?** (KPI *Kemungkinan double*, chip filter, baris merah muda) bila:
- No PO yang sama tercatat di lebih dari satu baris;
- satu nomor COS (IH-SOTP/SONP-…) atau nomor posting COS (IH-SITP-…) dipakai lebih dari satu PO;
- satu baris berisi lebih dari satu nomor COS (1 PO dengan 2 COS).
Saat Tambah/Edit PO, admin diperingatkan sebelum menyimpan No PO / COS yang sudah dipakai. Bila memang bukan double
(mis. 1 PO dikirim bertahap dengan 2 GP), buka View → **Sudah dicek, bukan double** (kolom `cek_double_ok`, berlaku untuk baris-baris terkait).

## Laporan Excel
Tombol **⬇ Excel** di setiap tab mengunduh `.xlsx` sesuai filter yang sedang aktif (tanggal sebagai tanggal Excel, auto-filter, judul & waktu ekspor):
Selling PO (+ sheet *Cek Double*), PO Pembelian & Bayar (+ sheet *Tagihan*), COS Retur. Library SheetJS dimuat saat tombol diklik.

## PO Pembelian & Bayar (tab 🧾)
Gabungan tracker PO Principal + pembayaran vendor: satu baris = satu PO ke principal/vendor, beserta tagihan & jadwal bayarnya
(satu PO bisa punya beberapa tagihan: barang, freight, surveyor, bea cukai). Tagihan otomatis ditautkan ke PO lewat No PO (`find_po_id`).
- **PO internal** (KIM, ABCD, ISI, Servisindo/ISS; atau vendor yang ditandai internal di 🏢) = potong-potongan antar company, TOP 30,
  **disembunyikan default** & tanpa peringatan. Lihat lewat filter *PO internal* / *Semua PO*.
- **Termin** per PO / vendor / tagihan: `TOP`, `CBD`, `Exwork`, `DP`. Vendor eksternal yang termin-nya belum diisi dianggap CBD (tanda `CBD?`).
  - **CBD / Exwork**: bayar sebelum barang dikirim/diambil. Begitu PI/invoice diterima → wajib diajukan; rencana bayar = Kamis minggu berikutnya
    setelah PI diterima. Faktur/SJ tidak dipersyaratkan. PO berstatus PO Dikirim / Konfirmasi Principal / Pembayaran dengan tagihan belum lunas
    = **Tertahan bayar (CBD)**.
  - **TOP**: jatuh tempo = tanggal dasar (default barang diterima gudang) + TOP → Kamis terdekat; paling cepat Kamis minggu berikutnya setelah
    dokumen fisik lengkap (invoice + faktur pajak + surat jalan).
- **Auto update** (trigger database, berlaku untuk dashboard & tugas email):
  - TOP (hari) diisi tapi termin kosong → termin **TOP** (di tagihan maupun PO).
  - Termin/TOP **PO diubah** → tagihan yang belum dibayar & masih mengikuti nilai lama PO ikut berubah.
    Termin/TOP **diisi di tagihan** → termin/TOP PO yang masih kosong ikut terisi.
  - Status tagihan ikut tanggal: *Tgl dibayar* → Dibayar; *Tgl diajukan* → Diajukan; *Rencana bayar* (dari finance, setelah diajukan) → Dijadwalkan.
    Hanya saat tanggalnya baru diisi/diubah, jadi status yang diubah manual tidak dipaksa balik.
  - Cegah dobel: No invoice yang sudah ada → form menawarkan membuka tagihan lama (isian baru dipindahkan ke sana);
    nominal sama di PO yang sama / nomor invoice mirip (akhiran -01, /002) → konfirmasi dulu.
- Peringatan: Tertahan bayar (CBD), Terlewat / lewat jatuh tempo, Siap belum diajukan, Dokumen belum lengkap, Bayar minggu ini, Perlu cek,
  > 7 hari tanpa update, Siap dicentang selesai (status akhir & semua tagihan lunas). Panel kanan: jadwal bayar Kamis/Jumat.
- Data dari email: `ingest_po_principal()` + `set_po_termin()` (docs/tugas-email-po-principal-retur.md, Prompt A) dan
  `ingest_payment_requests()` (docs/tugas-email-pembayaran.md).

## COS Retur (tab ↩)
Pengganti tab COS Retur di Google Sheet "Tracker PO Principal & COS Retur" (data awal: 33 retur).
- Setiap kasus retur dipantau sampai dicentang **✔ Selesai**. Perlu perhatian: Perlu Cek, Pending, > 7 hari tanpa update,
  status akhir yang belum dicentang. Filter tindakan, pencarian, CSV, Tambah/Edit/View, Hapus (admin).
- Data dari email: `ingest_cos_retur()` (docs/tugas-email-po-principal-retur.md, Prompt B). W disimpan di `tracker_sync_log`.
