# WM Admin — Selling PO

Dashboard **Selling PO** (pengganti tab *Selling PO* & *Selling PO - Aktif* di Google Sheet
"Update Penjualan COS : Daily"). Static site di Vercel, **Supabase adalah data utama** (sync dari Google Sheet sudah dimatikan).

## Fitur
- Login (username atau email) & Register (Nama, Email, Telepon, Password). Akun baru **menunggu persetujuan admin**; admin menyetujui lewat tombol 👥 Pengguna
- Layout 16:9: satu layar penuh tanpa scroll halaman (tabel & reminder scroll di dalam kartunya sendiri)
- **Reminder Pengiriman** dari kolom *Target kirim*: Terlambat / Hari ini / H-1..H-3 / Belum ada target, aktif sampai *Ceklis Selesai* dicentang (PO canceled tidak diingatkan)
- Kolom Aksi: View, Edit (semua akun disetujui), Hapus (khusus admin); tombol ＋ Tambah PO
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
public/            # file yang di-deploy (index.html, app.js, styles.css, config.js)
supabase/migrations/  # skema tabel selling_po + RLS
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
