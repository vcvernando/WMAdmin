// Modul Pembayaran Vendor: memantau pengajuan pembayaran ke Finance sampai dibayar.
// Aturan jadwal:
//  - Jatuh tempo   = tanggal dasar (default: barang diterima gudang) + TOP hari
//  - Target bayar  = hari Kamis terdekat dari jatuh tempo
//  - Paling cepat  = Kamis minggu berikutnya setelah dokumen fisik lengkap (invoice + faktur pajak + surat jalan)
//  - Rencana bayar = isian manual finance, atau yang lebih akhir dari target & paling cepat
(() => {
  "use strict";
  const W = window.WM;
  if (!W) return;
  const { sb, toast, esc, msg, authError, isoToday, fmtDate, fmtDateShort, fmtDateTime, ICON } = W;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const DAY = 86400000;

  const STATUS = {
    belum_lengkap: { label: "Dokumen belum lengkap", badge: "b-orange", order: 1 },
    siap_diajukan: { label: "Siap diajukan", badge: "b-yellow", order: 2 },
    diajukan:      { label: "Diajukan ke Finance", badge: "b-blue", order: 3 },
    dijadwalkan:   { label: "Dijadwalkan", badge: "b-purple", order: 4 },
    pending:       { label: "Pending", badge: "b-red", order: 5 },
    ditolak:       { label: "Ditolak", badge: "b-gray", order: 6 },
    dibayar:       { label: "Dibayar", badge: "b-green", order: 7 },
  };
  const DASAR = { barang_diterima: "Barang diterima gudang", invoice: "Tanggal invoice", dokumen_lengkap: "Dokumen fisik lengkap" };
  const FLAG = {
    terlewat: { label: "Terlewat finance", badge: "b-red", color: "#c62828" },
    lewat:    { label: "Lewat jatuh tempo", badge: "b-red", color: "#8b1d1d" },
    mundur:   { label: "Jadwal mundur", badge: "b-orange", color: "#d9730d" },
    dokumen:  { label: "Dokumen belum lengkap", badge: "b-yellow", color: "#a68a00" },
    ajukan:   { label: "Segera ajukan", badge: "b-blue", color: "#1f5eff" },
    data:     { label: "Tgl dasar/TOP kosong", badge: "b-gray", color: "#5f6b7a" },
  };
  const FIELDS = ["entitas", "vendor_nama", "no_po", "no_invoice", "tgl_invoice", "tgl_barang_diterima", "top_hari", "dasar_top", "nominal",
    "doc_invoice", "doc_faktur", "doc_sj", "doc_po", "dokumen_cocok", "no_faktur", "no_sj", "tgl_dokumen_lengkap", "catatan_dokumen",
    "status", "tgl_diajukan", "no_pengajuan", "pic_finance", "rencana_bayar", "tgl_dibayar", "no_bukti_transfer", "alasan", "catatan"];

  const st = {
    active: false, loaded: false, rows: [], vendors: [],
    q: "", view: "open", status: "", vendor: "", entitas: "", flags: new Set(),
    sort: { key: "rencana", dir: "asc" },
  };
  let editingId = null;

  // ---------- Tanggal ----------
  const toD = (iso) => (iso ? new Date(iso.slice(0, 10) + "T00:00:00") : null);
  const toIso = (d) => (d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : null);
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const today = () => toD(isoToday());
  const mondayOf = (d) => addDays(d, -((d.getDay() + 6) % 7));
  function nearestThursday(d) { let diff = (4 - d.getDay() + 7) % 7; if (diff > 3) diff -= 7; return addDays(d, diff); }
  const thursdayNextWeek = (d) => addDays(mondayOf(d), 10);
  const daysBetween = (a, b) => Math.round((b - a) / DAY);

  function vendorOf(r) {
    const n = (r.vendor_nama || "").trim().toLowerCase();
    return st.vendors.find((v) => v.id === r.vendor_id) || st.vendors.find((v) => v.nama.trim().toLowerCase() === n) || null;
  }

  function enrich(r) {
    const v = vendorOf(r);
    const top = r.top_hari ?? v?.top_hari ?? null;
    const dasar = r.dasar_top || v?.dasar_top || "barang_diterima";
    const basisIso = { barang_diterima: r.tgl_barang_diterima, invoice: r.tgl_invoice, dokumen_lengkap: r.tgl_dokumen_lengkap }[dasar];
    const basis = toD(basisIso);
    const jatuh = basis && top != null ? addDays(basis, top) : null;
    const target = jatuh ? nearestThursday(jatuh) : null;
    const docsOk = r.doc_invoice && r.doc_faktur && r.doc_sj;
    const docDate = docsOk ? toD(r.tgl_dokumen_lengkap) : null;
    const earliest = docDate ? thursdayNextWeek(docDate) : null;
    let rencana = toD(r.rencana_bayar);
    let rencanaAuto = false;
    if (!rencana) {
      rencanaAuto = true;
      // dokumen fisik belum lengkap -> belum bisa dijadwalkan (hanya ada target Kamis jatuh tempo)
      rencana = docsOk ? (target && earliest ? (earliest > target ? earliest : target) : target || earliest) : null;
    }
    const now = today();
    const paid = r.status === "dibayar";
    const closed = paid || r.status === "ditolak";
    const flags = [];
    if (!closed) {
      if ((r.status === "diajukan" || r.status === "dijadwalkan") && rencana && daysBetween(rencana, now) > 1) flags.push("terlewat");
      if (jatuh && now > jatuh) flags.push("lewat");
      if (earliest && target && earliest > target && !r.rencana_bayar) flags.push("mundur");
      if (!docsOk) flags.push("dokumen");
      if (docsOk && (r.status === "belum_lengkap" || r.status === "siap_diajukan")) flags.push("ajukan");
      if (!jatuh) flags.push("data");
    }
    const weekStart = mondayOf(now);
    const mingguIni = !closed && rencana && rencana >= weekStart && rencana < addDays(weekStart, 7);
    const hay = [r.vendor_nama, r.entitas, r.no_po, r.no_invoice, r.no_faktur, r.no_sj, r.no_pengajuan, r.pic_finance, r.catatan, r.catatan_dokumen, r.alasan,
      STATUS[r.status]?.label].filter(Boolean).join(" \u0001 ").toLowerCase();
    return { ...r, _v: v, top, dasar, basis, jatuh, target, earliest, rencana, rencanaAuto, docsOk, paid, closed, flags, mingguIni, hay,
      nominal: r.nominal == null ? null : Number(r.nominal) };
  }

  // ---------- Data ----------
  async function load() {
    $("#payTable tbody").innerHTML = `<tr><td colspan="9" class="loading">Memuat data…</td></tr>`;
    try {
      const [v, p, po] = await Promise.all([
        sb.from("vendors").select("*").order("nama"),
        sb.from("payment_requests").select("*").order("id"),
        sb.from("payment_sync_log").select("synced_at").order("synced_at", { ascending: false }).limit(1),
      ]);
      if (v.error) throw v.error;
      if (p.error) throw p.error;
      st.vendors = v.data;
      st.rows = p.data.map(enrich);
      st.loaded = true;
      const last = po.data?.[0]?.synced_at;
      $("#payAsOf").textContent = `${st.rows.length} tagihan · dimuat ${fmtDateTime(new Date().toISOString())}${last ? ` · tarikan email terakhir ${fmtDateTime(last)}` : ""}`;
      buildOptions();
      render();
      const late = st.rows.filter((r) => r.flags.includes("terlewat") || r.flags.includes("lewat")).length;
      if (late) toast(`💳 ${late} tagihan lewat jatuh tempo / terlewat finance.`, "err");
    } catch (err) {
      $("#payTable tbody").innerHTML = `<tr><td colspan="9"><div class="error">Gagal memuat data: ${esc(authError(err))}</div></td></tr>`;
    }
  }

  // ---------- Filter & urut ----------
  function filtered() {
    const terms = st.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return st.rows.filter((r) => {
      if (st.view === "open" && r.closed) return false;
      if (st.view === "paid" && !r.paid) return false;
      if (st.status && r.status !== st.status) return false;
      if (st.vendor && r.vendor_nama !== st.vendor) return false;
      if (st.entitas && r.entitas !== st.entitas) return false;
      for (const f of st.flags) {
        if (f === "mingguini" ? !r.mingguIni : !r.flags.includes(f)) return false;
      }
      for (const t of terms) if (!r.hay.includes(t)) return false;
      return true;
    });
  }
  function sorted(rows) {
    const { key, dir } = st.sort;
    const m = dir === "asc" ? 1 : -1;
    const val = (r) => {
      if (key === "status") return STATUS[r.status]?.order ?? 99;
      if (key === "top") return r.top ?? -1;
      if (["basis", "jatuh", "rencana"].includes(key)) return r[key] ? r[key].getTime() : null;
      return (r[key] ?? "").toString().toLowerCase();
    };
    return [...rows].sort((a, b) => {
      const x = val(a), y = val(b);
      if (x === y) return (a.id - b.id) * m;
      if (x === null || x === "") return 1;
      if (y === null || y === "") return -1;
      return (x > y ? 1 : -1) * m;
    });
  }

  // ---------- Render ----------
  const dash = `<span class="muted">–</span>`;
  const fmtD = (d) => (d ? fmtDateShort(toIso(d)) : "");
  const fmtRp = (n) => (n == null ? "" : `${n.toLocaleString("id-ID", { maximumFractionDigits: 2 })}`);

  function render() {
    if (!st.loaded) return;
    renderKpis();
    renderSide();
    renderTable(sorted(filtered()));
    syncControls();
  }

  function renderKpis() {
    const open = st.rows.filter((r) => !r.closed);
    const now = today();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const k = [
      { key: "open", label: "Tagihan belum dibayar", value: open.length, accent: "#1f5eff" },
      { key: "terlewat", label: "Terlewat finance", value: open.filter((r) => r.flags.includes("terlewat")).length, accent: "#c62828" },
      { key: "lewat", label: "Lewat jatuh tempo", value: open.filter((r) => r.flags.includes("lewat")).length, accent: "#8b1d1d" },
      { key: "mundur", label: "Jadwal mundur (dokumen)", value: open.filter((r) => r.flags.includes("mundur")).length, accent: "#d9730d" },
      { key: "dokumen", label: "Dokumen belum lengkap", value: open.filter((r) => r.flags.includes("dokumen")).length, accent: "#a68a00" },
      { key: "ajukan", label: "Siap, belum diajukan", value: open.filter((r) => r.flags.includes("ajukan")).length, accent: "#0e9aa7" },
      { key: "mingguini", label: "Bayar minggu ini", value: open.filter((r) => r.mingguIni).length, accent: "#7a3ff2" },
      { key: "paid", label: "Dibayar bulan ini", value: st.rows.filter((r) => r.paid && toD(r.tgl_dibayar) >= monthStart).length, accent: "#1e8e4f" },
    ];
    const active = st.flags.size === 1 ? [...st.flags][0] : st.view === "paid" ? "paid" : !st.flags.size && st.view === "open" && !st.status && !st.vendor && !st.q ? "open" : "";
    $("#payKpis").innerHTML = k.map((x) => `
      <button class="kpi ${active === x.key ? "active" : ""}" data-pkpi="${x.key}" style="--accent:${x.accent}" title="${x.label}">
        <div class="label">${x.label}</div><div class="value">${x.value}</div>
      </button>`).join("");
  }

  function flagBadges(r, max = 2) {
    return r.flags.filter((f) => f !== "data" || r.flags.length === 1).slice(0, max)
      .map((f) => `<span class="badge ${FLAG[f].badge}">${FLAG[f].label}</span>`).join(" ");
  }

  function renderSide() {
    const open = st.rows.filter((r) => !r.closed);
    const now = today();
    const thisThu = addDays(mondayOf(now), 3);
    const nextThu = addDays(thisThu, 7);
    const inWeek = (r, thu) => r.rencana && r.rencana >= addDays(thu, -3) && r.rencana < addDays(thu, 4);
    const groups = [
      { key: "masalah", title: "⚠ Terlewat / lewat jatuh tempo", color: "#c62828", rows: open.filter((r) => r.flags.includes("terlewat") || r.flags.includes("lewat")) },
      { key: "ini", title: `Kamis/Jumat ini · ${fmtDate(toIso(thisThu))}`, color: "#7a3ff2", rows: open.filter((r) => inWeek(r, thisThu) && !r.flags.includes("lewat") && !r.flags.includes("terlewat")) },
      { key: "depan", title: `Minggu depan · ${fmtDate(toIso(nextThu))}`, color: "#1f5eff", rows: open.filter((r) => inWeek(r, nextThu)) },
      { key: "tindakan", title: "Perlu tindakan admin", color: "#a68a00", rows: open.filter((r) => !r.flags.includes("lewat") && !r.flags.includes("terlewat") && (r.flags.includes("ajukan") || (r.flags.includes("dokumen") && r.jatuh && daysBetween(now, r.jatuh) <= 10))) },
    ];
    $("#payTiles").innerHTML = groups.map((g) => `
      <button class="rem-tile" data-pgroup="${g.key}" style="--c:${g.color}"><div class="n">${g.rows.length}</div><div class="t">${esc(g.title.replace(/ ·.*/, ""))}</div></button>`).join("");
    const item = (r, color) => `
      <button class="rem-item" data-pid="${r.id}" style="--c:${color}">
        <div class="top"><span class="po">${esc(r.vendor_nama)}</span>${flagBadges(r, 1)}</div>
        <div class="cust">Inv ${esc(r.no_invoice || "–")}${r.nominal != null ? ` · ${r.mata_uang || "IDR"} ${fmtRp(r.nominal)}` : ""}</div>
        <div class="cust">Jatuh tempo ${r.jatuh ? fmtDate(toIso(r.jatuh)) : "–"} · bayar ${r.rencana ? fmtDate(toIso(r.rencana)) : r.target ? `target ${fmtDate(toIso(r.target))} (dok. belum lengkap)` : "–"} · ${esc(STATUS[r.status].label)}</div>
      </button>`;
    let html = "";
    for (const g of groups) {
      if (!g.rows.length) continue;
      const rows = [...g.rows].sort((a, b) => (a.rencana || a.jatuh || 0) - (b.rencana || b.jatuh || 0));
      html += `<div class="rem-group">${esc(g.title)} (${rows.length})</div>` + rows.slice(0, 25).map((r) => item(r, g.color)).join("");
    }
    $("#payList").innerHTML = html || `<div class="rem-empty">Belum ada tagihan terbuka. Tambahkan lewat ＋ Tambah Tagihan, atau tunggu tarikan email.</div>`;
  }

  function docIcons(r) {
    const d = (on, t, label) => `<span class="doc ${on ? "on" : ""}" title="${label}: ${on ? "fisik diterima" : "belum"}">${t}</span>`;
    return `<div class="docs">${d(r.doc_invoice, "INV", "Invoice")}${d(r.doc_faktur, "FP", "Faktur pajak")}${d(r.doc_sj, "SJ", "Surat jalan")}${d(r.doc_po, "PO", "PO")}</div>
      ${r.docsOk && r.tgl_dokumen_lengkap ? `<span class="sub2">lengkap ${fmtDateShort(r.tgl_dokumen_lengkap)}</span>` : ""}
      ${r.dokumen_cocok === false ? `<span class="badge b-red">Tidak cocok</span>` : ""}`;
  }

  function renderTable(rows) {
    $("#payCount").textContent = `(${rows.length})`;
    $("#payEmpty").hidden = rows.length > 0;
    const isAdmin = W.me()?.role === "admin";
    $("#payTable tbody").innerHTML = rows.map((r) => {
      const tone = r.flags.includes("terlewat") || r.flags.includes("lewat") ? "row-red" : r.flags.includes("mundur") ? "row-yellow" : "";
      return `<tr class="${tone}" data-pid="${r.id}">
        <td><span class="ell" title="${esc(r.vendor_nama)}"><strong>${esc(r.vendor_nama)}</strong></span>
            <span class="ell sub2">${esc(r.entitas || "IVP")}${r.nominal != null ? ` · ${esc(r.mata_uang || "IDR")} ${fmtRp(r.nominal)}` : ""}${r.sumber === "email" ? " · ✉" : ""}</span></td>
        <td><span class="ell" title="${esc(r.no_invoice)}">${esc(r.no_invoice || "–")}</span><span class="ell sub2" title="${esc(r.no_po)}">${r.no_po ? `PO ${esc(r.no_po)}` : ""}</span></td>
        <td title="${esc(DASAR[r.dasar])}">${r.basis ? fmtD(r.basis) : `<span class="missing">–</span>`}<span class="sub2 ell">${esc({ barang_diterima: "terima barang", invoice: "invoice", dokumen_lengkap: "dok. lengkap" }[r.dasar])}</span></td>
        <td class="num">${r.top != null ? r.top : dash}</td>
        <td>${r.jatuh ? fmtD(r.jatuh) : dash}${r.flags.includes("lewat") ? `<div><span class="badge b-red">+${daysBetween(r.jatuh, today())} hr</span></div>` : ""}</td>
        <td>${r.paid ? `<span class="badge b-green">Dibayar ${r.tgl_dibayar ? fmtDateShort(r.tgl_dibayar) : ""}</span>` : r.rencana ? `${fmtD(r.rencana)}${r.rencanaAuto ? `<span class="sub2"> auto</span>` : ""}` : r.target ? `<span class="muted" title="Belum bisa dijadwalkan sampai dokumen fisik lengkap">Target ${fmtD(r.target)}</span><span class="sub2 ell">menunggu dokumen</span>` : dash}
            ${!r.paid ? `<div class="tags">${flagBadges(r)}</div>` : ""}</td>
        <td>${docIcons(r)}</td>
        <td><span class="badge ${STATUS[r.status].badge}">${STATUS[r.status].label}</span>${r.tgl_diajukan ? `<span class="sub2 ell">diajukan ${fmtDateShort(r.tgl_diajukan)}</span>` : ""}</td>
        <td class="no-print"><div class="acts">
          <button class="act view" data-pact="view" title="View">${ICON.view}</button>
          <button class="act edit" data-pact="edit" title="Edit">${ICON.edit}</button>
          ${isAdmin ? `<button class="act del" data-pact="del" title="Hapus">${ICON.del}</button>` : ""}
        </div></td>
      </tr>`;
    }).join("");
    $$("#payTable thead th").forEach((th) => {
      th.classList.remove("sorted-asc", "sorted-desc");
      if (th.dataset.psort === st.sort.key) th.classList.add(`sorted-${st.sort.dir}`);
    });
  }

  function buildOptions() {
    const uniq = (f) => [...new Set(st.rows.map(f).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const fill = (sel, vals, all, labels = {}) => { $(sel).innerHTML = `<option value="">${all}</option>` + vals.map((v) => `<option value="${esc(v)}">${esc(labels[v] || v)}</option>`).join(""); };
    fill("#payStatus", Object.keys(STATUS), "Semua status", Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [k, v.label])));
    fill("#payVendor", uniq((r) => r.vendor_nama), "Semua vendor");
    fill("#payEntitas", uniq((r) => r.entitas), "Semua entitas");
    $("#dlVendor").innerHTML = [...new Set([...st.vendors.map((v) => v.nama), ...st.rows.map((r) => r.vendor_nama)])].sort().map((v) => `<option value="${esc(v)}">`).join("");
  }

  function syncControls() {
    $("#payQ").value = st.q;
    $("#payView").value = st.view;
    $("#payStatus").value = st.status;
    $("#payVendor").value = st.vendor;
    $("#payEntitas").value = st.entitas;
    $$("#payChips [data-pflag]").forEach((b) => b.classList.toggle("on", st.flags.has(b.dataset.pflag)));
  }

  function resetFilters() { Object.assign(st, { q: "", view: "open", status: "", vendor: "", entitas: "" }); st.flags.clear(); }

  // ---------- View ----------
  function openDrawer(id) {
    const r = st.rows.find((x) => x.id === id);
    if (!r) return;
    const f = (label, v) => `<dt>${label}</dt><dd>${v === "" || v == null ? dash : v}</dd>`;
    const yn = (b) => (b ? "✔ diterima" : "✕ belum");
    $("#payDrawerBody").innerHTML = `
      <h2>${esc(r.vendor_nama)}</h2>
      <span class="badge ${STATUS[r.status].badge}">${STATUS[r.status].label}</span> ${flagBadges(r, 4)}
      <dl>
        ${f("Entitas", esc(r.entitas))}
        ${f("No invoice", esc(r.no_invoice))}
        ${f("No PO", esc(r.no_po || ""))}
        ${f("Nominal", r.nominal != null ? `${esc(r.mata_uang || "IDR")} ${fmtRp(r.nominal)}` : "")}
        ${f("Tgl invoice", r.tgl_invoice ? fmtDate(r.tgl_invoice) : "")}
        ${f("Barang diterima", r.tgl_barang_diterima ? fmtDate(r.tgl_barang_diterima) : "")}
        ${f("TOP", r.top != null ? `${r.top} hari dari ${esc(DASAR[r.dasar].toLowerCase())}${r.top_hari == null ? " (ikut vendor)" : ""}` : "")}
        ${f("Jatuh tempo", r.jatuh ? fmtDate(toIso(r.jatuh)) : "")}
        ${f("Kamis terdekat", r.target ? fmtDate(toIso(r.target)) : "")}
        ${f("Paling cepat bayar", r.earliest ? `${fmtDate(toIso(r.earliest))} (Kamis minggu berikutnya setelah dokumen lengkap)` : "menunggu dokumen fisik lengkap")}
        ${f("Rencana bayar", r.rencana ? `${fmtDate(toIso(r.rencana))}${r.rencanaAuto ? " (otomatis)" : " (dari finance)"}` : "")}
        ${f("Dokumen fisik", `Invoice ${yn(r.doc_invoice)} · Faktur ${yn(r.doc_faktur)} · SJ ${yn(r.doc_sj)} · PO ${yn(r.doc_po)}`)}
        ${f("Kecocokan dokumen", r.dokumen_cocok == null ? "" : r.dokumen_cocok ? "✔ PO = SJ = Invoice" : "✕ ada selisih")}
        ${f("No faktur / SJ", esc([r.no_faktur, r.no_sj].filter(Boolean).join(" · ")))}
        ${f("Dokumen lengkap", r.tgl_dokumen_lengkap ? fmtDate(r.tgl_dokumen_lengkap) : "")}
        ${f("Catatan dokumen", esc(r.catatan_dokumen || ""))}
        ${f("Diajukan", r.tgl_diajukan ? `${fmtDate(r.tgl_diajukan)}${r.no_pengajuan ? ` · ${esc(r.no_pengajuan)}` : ""}${r.pic_finance ? ` · ${esc(r.pic_finance)}` : ""}` : "")}
        ${f("Dibayar", r.tgl_dibayar ? `${fmtDate(r.tgl_dibayar)}${r.no_bukti_transfer ? ` · ${esc(r.no_bukti_transfer)}` : ""}` : "")}
        ${f("Alasan", esc(r.alasan || ""))}
        ${f("Catatan", esc(r.catatan || ""))}
        ${f("Sumber", r.sumber === "email" ? `Email${r.email_ref ? ` · ${esc(r.email_ref)}` : ""}` : "Input manual")}
        ${f("Terakhir diubah", fmtDateTime(r.updated_at))}
      </dl>
      <div class="drawer-actions">
        <button class="btn primary" data-pact="edit" data-pid="${r.id}">✎ Edit</button>
        ${!r.paid ? `<button class="btn light" data-pact="paid" data-pid="${r.id}">✓ Tandai dibayar hari ini</button>` : ""}
      </div>`;
    $("#payDrawer").classList.add("open");
  }
  const closeDrawer = () => $("#payDrawer").classList.remove("open");

  // ---------- Tambah / Edit ----------
  function openForm(id) {
    editingId = id;
    const r = id ? st.rows.find((x) => x.id === id) : null;
    const form = $("#payForm");
    form.reset();
    FIELDS.forEach((k) => {
      const el = form.elements[k];
      if (!el) return;
      if (el.type === "checkbox") el.checked = !!r?.[k];
      else if (k === "nominal") el.value = r?.nominal != null ? r.nominal.toLocaleString("id-ID") : "";
      else el.value = r ? (r[k] ?? "") : k === "entitas" ? "IVP" : k === "status" ? "belum_lengkap" : "";
    });
    $("#payModalTitle").textContent = r ? `Edit tagihan ${r.vendor_nama} · ${r.no_invoice || ""}` : "Tambah tagihan";
    msg("#payMsg", "");
    updateCalc();
    $("#payModal").hidden = false;
    setTimeout(() => form.elements[r ? "status" : "vendor_nama"].focus(), 0);
  }

  function formRecord() {
    const form = $("#payForm");
    const rec = {};
    FIELDS.forEach((k) => {
      const el = form.elements[k];
      if (el.type === "checkbox") rec[k] = el.checked;
      else { const v = el.value.trim(); rec[k] = v === "" ? null : v; }
    });
    if (rec.top_hari != null) rec.top_hari = Number(rec.top_hari);
    if (rec.nominal != null) rec.nominal = parseNominal(rec.nominal);
    if (rec.dokumen_cocok === false && !$("#payForm").elements.dokumen_cocok.checked) rec.dokumen_cocok = null;
    return rec;
  }

  function updateCalc() {
    const rec = formRecord();
    const e = enrich({ ...rec, id: editingId || 0, vendor_id: null, nominal: rec.nominal });
    const v = e._v;
    const parts = [];
    if (v) parts.push(`Vendor terdaftar: TOP ${v.top_hari} hari dari ${DASAR[v.dasar_top].toLowerCase()}.`);
    else if (rec.vendor_nama) parts.push("Vendor baru: akan ditambahkan ke master vendor saat disimpan.");
    if (e.jatuh) parts.push(`Jatuh tempo ${fmtDate(toIso(e.jatuh))} → Kamis terdekat ${fmtDate(toIso(e.target))}.`);
    else parts.push("Isi tanggal dasar & TOP untuk menghitung jatuh tempo.");
    if (e.earliest) parts.push(`Paling cepat bayar ${fmtDate(toIso(e.earliest))}.`);
    if (e.rencana) parts.push(`Rencana bayar: ${fmtDate(toIso(e.rencana))}${e.rencanaAuto ? " (otomatis)" : ""}.`);
    if (e.flags.includes("mundur")) parts.push("⚠ Dokumen membuat jadwal mundur dari Kamis jatuh tempo.");
    $("#payCalc").textContent = parts.join(" ");
  }

  async function ensureVendor(rec) {
    const n = rec.vendor_nama.trim().toLowerCase();
    let v = st.vendors.find((x) => x.nama.trim().toLowerCase() === n);
    if (v) return v;
    const { data, error } = await sb.from("vendors").insert({
      nama: rec.vendor_nama.trim(), top_hari: rec.top_hari ?? 30, dasar_top: rec.dasar_top || "barang_diterima",
    }).select().single();
    if (error) throw error;
    st.vendors.push(data);
    return data;
  }

  async function savePay(e) {
    e.preventDefault();
    const rec = formRecord();
    if (!rec.vendor_nama) return msg("#payMsg", "Vendor wajib diisi.");
    if (!rec.no_invoice) return msg("#payMsg", "No invoice wajib diisi.");
    if ($("#payForm").elements.nominal.value.trim() && rec.nominal == null) return msg("#payMsg", "Nominal tidak valid. Contoh: 25.000.000");
    rec.dokumen_cocok = $("#payForm").elements.dokumen_cocok.checked ? true : (editingId ? st.rows.find((x) => x.id === editingId)?.dokumen_cocok ?? null : null);
    const docsOk = rec.doc_invoice && rec.doc_faktur && rec.doc_sj;
    if (docsOk && !rec.tgl_dokumen_lengkap) rec.tgl_dokumen_lengkap = isoToday();
    if (docsOk && rec.status === "belum_lengkap") rec.status = "siap_diajukan";
    if (rec.status === "diajukan" && !rec.tgl_diajukan) rec.tgl_diajukan = isoToday();
    if (rec.status === "dibayar" && !rec.tgl_dibayar) rec.tgl_dibayar = isoToday();
    if (["diajukan", "dijadwalkan", "dibayar"].includes(rec.status) && !docsOk) {
      if (!confirm("Dokumen fisik (invoice, faktur pajak, surat jalan) belum lengkap. Tetap simpan dengan status ini?")) return;
    }
    if ((rec.status === "pending" || rec.status === "ditolak") && !rec.alasan) return msg("#payMsg", "Isi alasan pending / ditolak.");
    const btn = $("#paySave"); btn.disabled = true;
    try {
      const v = await ensureVendor(rec);
      rec.vendor_id = v.id;
      rec.vendor_nama = v.nama;
      const wasEdit = !!editingId;
      const q = wasEdit
        ? sb.from("payment_requests").update(rec).eq("id", editingId).select().single()
        : sb.from("payment_requests").insert(rec).select().single();
      const { data, error } = await q;
      if (error) throw error;
      upsertRow(data);
      $("#payModal").hidden = true;
      buildOptions();
      render();
      toast(wasEdit ? "Tagihan diperbarui." : "Tagihan ditambahkan.");
    } catch (err) {
      const m = authError(err);
      msg("#payMsg", /duplicate key|payment_requests_invoice_key/i.test(m) ? "No invoice ini sudah tercatat untuk vendor yang sama." : `Gagal menyimpan: ${m}`);
    } finally { btn.disabled = false; }
  }

  function upsertRow(data) {
    const row = enrich(data);
    const i = st.rows.findIndex((x) => x.id === row.id);
    if (i >= 0) st.rows[i] = row; else st.rows.push(row);
  }

  async function markPaid(id) {
    const r = st.rows.find((x) => x.id === id);
    if (!r) return;
    const no = prompt(`Tandai tagihan ${r.vendor_nama} · ${r.no_invoice} sudah DIBAYAR hari ini.\nNo bukti transfer (boleh dikosongkan):`, r.no_bukti_transfer || "");
    if (no === null) return;
    const { data, error } = await sb.from("payment_requests")
      .update({ status: "dibayar", tgl_dibayar: r.tgl_dibayar || isoToday(), no_bukti_transfer: no.trim() || r.no_bukti_transfer || null })
      .eq("id", id).select().single();
    if (error) return toast(`Gagal: ${authError(error)}`, "err");
    upsertRow(data);
    closeDrawer();
    render();
    toast("Tagihan ditandai dibayar.");
  }

  async function deletePay(id) {
    const r = st.rows.find((x) => x.id === id);
    if (!r || W.me()?.role !== "admin") return;
    if (!confirm(`Hapus tagihan ${r.vendor_nama} · ${r.no_invoice}?\nData yang dihapus tidak bisa dikembalikan.`)) return;
    const { data, error } = await sb.from("payment_requests").delete().eq("id", id).select("id");
    if (error) return toast(`Gagal menghapus: ${authError(error)}`, "err");
    if (!data?.length) return toast("Tagihan tidak terhapus (tidak ada izin).", "err");
    st.rows = st.rows.filter((x) => x.id !== id);
    buildOptions();
    render();
    toast("Tagihan dihapus.");
  }

  // ---------- Master vendor ----------
  function openVendors() {
    $("#vendorForm").reset();
    $("#vendorForm").elements.id.value = "";
    msg("#vendorMsg", "");
    renderVendors();
    $("#vendorModal").hidden = false;
  }
  function renderVendors() {
    const count = (v) => st.rows.filter((r) => r.vendor_id === v.id && !r.closed).length;
    $("#vendorTable").innerHTML = `
      <thead><tr><th>Vendor</th><th class="num">TOP</th><th>Dasar hitung</th><th>Mata uang</th><th>NPWP</th><th>PIC</th><th class="num">Tagihan terbuka</th><th></th></tr></thead>
      <tbody>${st.vendors.map((v) => `<tr>
        <td><strong>${esc(v.nama)}</strong></td><td class="num">${v.top_hari} hr</td><td>${esc(DASAR[v.dasar_top])}</td>
        <td>${esc(v.mata_uang)}</td><td>${esc(v.npwp || "–")}</td><td>${esc(v.pic || "–")}</td><td class="num">${count(v)}</td>
        <td><button class="btn light" data-vedit="${v.id}">Edit</button></td></tr>`).join("") || `<tr><td colspan="8" class="muted">Belum ada vendor.</td></tr>`}</tbody>`;
  }
  async function saveVendor(e) {
    e.preventDefault();
    const f = $("#vendorForm").elements;
    const rec = { nama: f.nama.value.trim(), top_hari: Number(f.top_hari.value || 30), dasar_top: f.dasar_top.value,
      mata_uang: (f.mata_uang.value.trim() || "IDR").toUpperCase(), npwp: f.npwp.value.trim() || null, pic: f.pic.value.trim() || null };
    if (!rec.nama) return msg("#vendorMsg", "Nama vendor wajib diisi.");
    const id = f.id.value ? Number(f.id.value) : null;
    const q = id ? sb.from("vendors").update(rec).eq("id", id).select().single() : sb.from("vendors").insert(rec).select().single();
    const { data, error } = await q;
    if (error) return msg("#vendorMsg", /duplicate key/i.test(error.message) ? "Nama vendor sudah ada." : authError(error));
    const i = st.vendors.findIndex((x) => x.id === data.id);
    if (i >= 0) st.vendors[i] = data; else st.vendors.push(data);
    st.vendors.sort((a, b) => a.nama.localeCompare(b.nama));
    st.rows = st.rows.map((r) => enrich(r));
    $("#vendorForm").reset(); f.id.value = "";
    msg("#vendorMsg", "Vendor tersimpan. Tagihan yang TOP-nya ikut vendor sudah dihitung ulang.", "ok");
    renderVendors();
    buildOptions();
    render();
  }

  // ---------- CSV ----------
  function exportCsv() {
    const rows = sorted(filtered());
    const cols = [["entitas", "Entitas"], ["vendor_nama", "Vendor"], ["no_invoice", "No invoice"], ["no_po", "No PO"], ["nominal", "Nominal"], ["mata_uang", "Mata uang"],
      ["tgl_invoice", "Tgl invoice"], ["tgl_barang_diterima", "Tgl barang diterima"], ["top", "TOP (hari)"], ["dasarLabel", "Dasar TOP"], ["jatuhIso", "Jatuh tempo"],
      ["rencanaIso", "Rencana bayar"], ["docs", "Dokumen fisik"], ["tgl_dokumen_lengkap", "Tgl dokumen lengkap"], ["statusLabel", "Status"], ["tgl_diajukan", "Tgl diajukan"],
      ["no_pengajuan", "No pengajuan"], ["pic_finance", "PIC finance"], ["tgl_dibayar", "Tgl dibayar"], ["no_bukti_transfer", "No bukti transfer"], ["flagsLabel", "Peringatan"], ["alasan", "Alasan"], ["catatan", "Catatan"]];
    const val = (r, k) => ({
      dasarLabel: DASAR[r.dasar], jatuhIso: toIso(r.jatuh), rencanaIso: toIso(r.rencana), statusLabel: STATUS[r.status].label,
      docs: [r.doc_invoice && "Invoice", r.doc_faktur && "Faktur", r.doc_sj && "SJ", r.doc_po && "PO"].filter(Boolean).join(" + "),
      flagsLabel: r.flags.map((f) => FLAG[f].label).join(", "),
    }[k] ?? r[k]);
    const q = (v) => { const s = v == null ? "" : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [cols.map((c) => c[1]).join(","), ...rows.map((r) => cols.map(([k]) => q(val(r, k))).join(","))].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
    a.download = `pembayaran-vendor-${isoToday()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // "Rp 12.500.000", "12,500,000.00", "12.500.000,50", "12,5 jt", "1,2 M" -> angka
  function parseNominal(t) {
    let s = String(t).trim().toLowerCase().replace(/^(rp\.?|idr|usd|\$)\s*/, "");
    let mult = 1;
    if (/(jt|juta)\s*$/.test(s)) { mult = 1e6; s = s.replace(/\s*(jt|juta)\s*$/, ""); }
    else if (/(m|miliar|milyar)\s*$/.test(s)) { mult = 1e9; s = s.replace(/\s*(m|miliar|milyar)\s*$/, ""); }
    if (/[^0-9.,\s]/.test(s)) return null;
    s = s.replace(/\s/g, "");
    if (!s) return null;
    const d = s.lastIndexOf("."), c = s.lastIndexOf(",");
    if (d >= 0 && c >= 0) s = c > d ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
    else if (c >= 0) s = /,\d{1,2}$/.test(s) && s.indexOf(",") === c ? s.replace(",", ".") : s.replace(/,/g, "");
    else if (d >= 0) s = /\.\d{1,2}$/.test(s) && s.indexOf(".") === d ? s : s.replace(/\./g, "");
    const n = Number(s) * mult;
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
  }

  // ---------- Pindah modul ----------
  const MOD_KEY = "wm-module";
  // Registry modul: selling & pay di sini, tracker.js mendaftarkan "po" & "retur" lewat WM.registerModule.
  const MODS = {
    selling: { title: "Selling PO", layout: "#layout", actions: "#sellingActions", asOf: "#asOf" },
    pay: { title: "Pembayaran Vendor", layout: "#payLayout", actions: "#payActions", asOf: "#payAsOf", show: () => { if (!st.loaded) load(); } },
  };
  W.registerModule = (key, def) => { MODS[key] = def; };
  const el = (x) => (typeof x === "string" ? $(x) : x);
  function setModule(mod) {
    if (!MODS[mod]) mod = "selling";
    st.active = mod === "pay";
    $$(".mod").forEach((b) => b.classList.toggle("on", b.dataset.module === mod));
    for (const [k, m] of Object.entries(MODS)) {
      const on = k === mod;
      el(m.layout).hidden = !on;
      el(m.actions).hidden = !on;
      el(m.asOf).hidden = !on;
    }
    document.title = `${MODS[mod].title} · WM Admin`;
    try { localStorage.setItem(MOD_KEY, mod); } catch (_) { /* abaikan */ }
    MODS[mod].show?.();
  }

  function bind() {
    $(".modules").addEventListener("click", (e) => { const b = e.target.closest(".mod"); if (b) setModule(b.dataset.module); });
    let t;
    $("#payQ").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { st.q = e.target.value; render(); }, 150); });
    $("#payView").addEventListener("change", (e) => { st.view = e.target.value; render(); });
    $("#payStatus").addEventListener("change", (e) => { st.status = e.target.value; if (st.status === "dibayar" || st.status === "ditolak") st.view = "all"; render(); });
    $("#payVendor").addEventListener("change", (e) => { st.vendor = e.target.value; render(); });
    $("#payEntitas").addEventListener("change", (e) => { st.entitas = e.target.value; render(); });
    $$("#payChips [data-pflag]").forEach((b) => b.addEventListener("click", () => {
      const f = b.dataset.pflag; st.flags.has(f) ? st.flags.delete(f) : st.flags.add(f); render();
    }));
    $("#payReset").addEventListener("click", () => { resetFilters(); render(); });
    $("#payKpis").addEventListener("click", (e) => {
      const k = e.target.closest("[data-pkpi]")?.dataset.pkpi; if (!k) return;
      resetFilters();
      if (k === "paid") st.view = "paid";
      else if (k !== "open") st.flags.add(k);
      render();
    });
    $("#payTiles").addEventListener("click", (e) => {
      const g = e.target.closest("[data-pgroup]")?.dataset.pgroup; if (!g) return;
      resetFilters();
      st.flags.add({ masalah: "lewat", ini: "mingguini", depan: "mingguini", tindakan: "ajukan" }[g]);
      if (g === "masalah") { st.flags.clear(); st.sort = { key: "jatuh", dir: "asc" }; st.view = "open"; }
      render();
    });
    $("#payList").addEventListener("click", (e) => { const i = e.target.closest("[data-pid]"); if (i) openDrawer(+i.dataset.pid); });
    $$("#payTable thead th[data-psort]").forEach((th) => th.addEventListener("click", () => {
      const key = th.dataset.psort;
      st.sort = { key, dir: st.sort.key === key && st.sort.dir === "asc" ? "desc" : "asc" };
      render();
    }));
    $("#payTable tbody").addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-pid]"); if (!tr) return;
      const id = +tr.dataset.pid;
      const act = e.target.closest("[data-pact]")?.dataset.pact || "view";
      if (act === "edit") openForm(id); else if (act === "del") deletePay(id); else openDrawer(id);
    });
    $("#payDrawer").addEventListener("click", (e) => { if (e.target.id === "payDrawer") closeDrawer(); });
    $("#payDrawerClose").addEventListener("click", closeDrawer);
    $("#payDrawerBody").addEventListener("click", (e) => {
      const b = e.target.closest("[data-pact]"); if (!b) return;
      const id = +b.dataset.pid;
      if (b.dataset.pact === "edit") { closeDrawer(); openForm(id); } else if (b.dataset.pact === "paid") markPaid(id);
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
    $("#payAdd").addEventListener("click", () => openForm(null));
    $("#payVendors").addEventListener("click", openVendors);
    $("#payRefresh").addEventListener("click", load);
    $("#payCsv").addEventListener("click", exportCsv);
    $("#payForm").addEventListener("submit", savePay);
    $("#payForm").addEventListener("input", updateCalc);
    $("#payForm").addEventListener("change", updateCalc);
    $("#vendorForm").addEventListener("submit", saveVendor);
    $("#vendorNew").addEventListener("click", () => { $("#vendorForm").reset(); $("#vendorForm").elements.id.value = ""; msg("#vendorMsg", ""); });
    $("#vendorTable").addEventListener("click", (e) => {
      const id = e.target.closest("[data-vedit]")?.dataset.vedit; if (!id) return;
      const v = st.vendors.find((x) => x.id === +id); const f = $("#vendorForm").elements;
      f.id.value = v.id; f.nama.value = v.nama; f.top_hari.value = v.top_hari; f.dasar_top.value = v.dasar_top;
      f.mata_uang.value = v.mata_uang; f.npwp.value = v.npwp || ""; f.pic.value = v.pic || "";
      msg("#vendorMsg", ""); f.nama.focus();
    });
  }

  document.addEventListener("wm:login", () => {
    st.loaded = false;
    let mod = "selling";
    try { mod = localStorage.getItem(MOD_KEY) || "selling"; } catch (_) { /* abaikan */ }
    setModule(mod);
  });
  document.addEventListener("wm:logout", () => { st.rows = []; st.vendors = []; st.loaded = false; });

  bind();
})();
