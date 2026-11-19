# WM Admin — Selling PO

Dashboard listing **Selling PO** (pengganti tab *Selling PO* & *Selling PO - Aktif* di Google Sheet
"Update Penjualan COS : Daily"). Static site di Vercel, data di Supabase.

## Fitur
- KPI: Total PO, PO aktif, Belum ada COS, Belum ada No. GP, Perlu cek, Unit indent, Dicentang belum lengkap, Selesai (klik = filter)
- Mini pie chart: Status, Request by, Kelengkapan dokumen; bar chart PO per bulan (klik = filter)
- Pencarian teks di semua kolom (tekan `/` untuk fokus ke kotak cari)
- Filter: tampilan (Aktif/Semua/Selesai), status, request by, customer, bulan, rentang tanggal, chip (Belum COS, Belum GP, Indent, Perlu cek, Umur > 14 hari)
- Ringkasan per Request by (ikut filter, klik baris = filter)
- Tabel lengkap dengan sort per kolom, warna baris seperti sheet, detail per PO (klik baris)
- Print (A4 landscape, mencetak sesuai filter) dan export CSV

## Aturan status (sama dengan logika tab "Selling PO - Aktif")
| Status | Kondisi |
|---|---|
| Canceled | ada kata "Cancel" di COS/GP/progres/notes |
| Selesai | Ceklis admin ✔ dan No PO, COS, No. GP terisi |
| Dicentang belum lengkap | Ceklis ✔ tapi No PO/COS/No. GP kosong (baris merah) |
| Belum ada COS | belum dicentang, COS kosong / "BELUM ADA COS" |
| Belum ada No. GP | belum dicentang, No. GP kosong |
| Proses | belum dicentang, dokumen lengkap |

"Non GP", "-", "tidak ada nomer GP" dihitung sebagai No. GP terisi.

## Struktur
```
public/            # file yang di-deploy (index.html, app.js, styles.css, config.js)
supabase/migrations/  # skema tabel selling_po + RLS
vercel.json
```

## Keamanan
Tabel `selling_po` memakai RLS: publik (publishable key) **hanya bisa membaca**. Insert/update/delete
belum dibuka — tahap berikutnya: login Supabase Auth untuk admin.
