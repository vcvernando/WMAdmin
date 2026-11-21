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
public/            # file yang di-deploy (index.html, app.js, payments.js, tracker.js, styles.css, config.js)
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

## Pembayaran Vendor (tab 💳)
Memantau pengajuan pembayaran vendor ke Finance (umumnya entitas IVP) sampai dibayar, agar tidak ada yang terlewat.
- **Jatuh tempo** = tanggal dasar + TOP. Dasar default *barang diterima gudang* (bisa per vendor/tagihan: tanggal invoice / dokumen lengkap).
- **Rencana bayar** = Kamis terdekat dari jatuh tempo; paling cepat Kamis minggu berikutnya setelah **dokumen fisik lengkap**
  (invoice + faktur pajak + surat jalan). Dokumen belum lengkap = belum bisa dijadwalkan. Finance bisa mengisi tanggal manual.
- Peringatan: *Terlewat finance* (sudah diajukan, lewat Kamis/Jumat rencana, belum dibayar), *Lewat jatuh tempo*, *Jadwal mundur* (dokumen telat),
  *Dokumen belum lengkap*, *Siap, belum diajukan*. Panel kanan: jadwal Kamis/Jumat ini & minggu depan.
- Master vendor (🏢 Vendor): TOP & dasar hitung default. Vendor baru otomatis ditambahkan saat tagihan disimpan.
- Data dari email: tugas Cowork `docs/tugas-email-pembayaran.md` → `ingest_payment_requests()` (kunci vendor + no invoice, status hanya naik).
- Hak akses sama dengan Selling PO (lihat & ubah: akun disetujui; hapus: admin).

## PO Principal (tab 🚢) & COS Retur (tab ↩)
Pengganti Google Sheet "Tracker PO Principal & COS Retur" (data awal sudah diimpor: 52 PO, 33 retur).
- Setiap PO pembelian / kasus retur dipantau sampai dicentang **✔ Selesai** (kolom ✔ di tabel atau tombol di View).
- **Perlu perhatian** (panel kanan & chip filter): status *Perlu Cek*, *Pending*, **> 7 hari tanpa update**,
  dan status akhir (Barang Masuk Gudang / Selesai / Cancelled) yang belum dicentang selesai.
- KPI per tahap (PO: menunggu principal, shipping/customs; Retur: request/COS dibuat, unit di gudang/SRV), filter status,
  principal / tindakan, pencarian, CSV, Tambah/Edit/View, Hapus (admin).
- Data dari email: tugas Cowork `docs/tugas-email-po-principal-retur.md` → `ingest_po_principal()` / `ingest_cos_retur()`
  (satu No PO / kasus = satu baris; status hanya diganti bila email lebih baru; catatan ditambahkan; kolom selesai tidak disentuh).
  W per tracker disimpan di `tracker_sync_log`.
