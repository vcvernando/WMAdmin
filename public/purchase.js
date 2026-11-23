// Modul 🧾 PO Pembelian & Bayar: satu baris = satu PO ke principal/vendor, lengkap dengan tagihan & jadwal bayarnya.
// Termin:
//  - TOP          : jatuh tempo = tgl dasar (default barang diterima gudang) + TOP hari -> Kamis terdekat;
//                   paling cepat Kamis minggu berikutnya setelah dokumen fisik lengkap (invoice + faktur pajak + surat jalan)
//  - CBD / Exwork : bayar sebelum barang dikirim/diambil; begitu PI/invoice diterima wajib diajukan,
//                   rencana bayar = Kamis minggu berikutnya setelah PI diterima. Faktur/SJ tidak dipersyaratkan.
// PO internal (KIM, ABCD, ISI, Servisindo/ISS) = potong-potongan antar company, TOP 30, disembunyikan default & tanpa peringatan.
(() => {
  "use strict";
  const W = window.WM;
  if (!W) return;
  const { sb, toast, esc, msg, authError, isoToday, fmtDate, fmtDateShort, fmtDateTime, ICON } = W;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const DAY = 86400000;
  const BASI_HARI = 7;

  const STATUS = {
    belum_lengkap: { label: "Dokumen belum lengkap", badge: "b-orange", order: 1 },
    siap_diajukan: { label: "Siap diajukan", badge: "b-yellow", order: 2 },
    diajukan:      { label: "Diajukan ke Finance", badge: "b-blue", order: 3 },
    dijadwalkan:   { label: "Dijadwalkan", badge: "b-purple", order: 4 },
    pending:       { label: "Pending", badge: "b-red", order: 5 },
    ditolak:       { label: "Ditolak", badge: "b-gray", order: 6 },
    dibayar:       { label: "Dibayar", badge: "b-green", order: 7 },
  };
  const PO_STATUS = {
    "PO Dikirim": "b-gray", "Konfirmasi Principal": "b-blue", "Pembayaran": "b-yellow", "Shipping": "b-purple",
    "Customs / AJU": "b-orange", "POFW Approved": "b-purple", "Barang Masuk Gudang": "b-green", "Selesai": "b-green",
    "Pending": "b-red", "Cancelled": "b-gray", "Perlu Cek": "b-red",
  };
  const PO_STATUSES = Object.keys(PO_STATUS);
  const PRE_SHIP = ["PO Dikirim", "Konfirmasi Principal", "Pembayaran"];
  const END_STATUS = ["Barang Masuk Gudang", "Selesai", "Cancelled"];
  const STAGES = [
    { key: "stage:awal", label: "» Menunggu principal / bayar", st: PRE_SHIP },
    { key: "stage:jalan", label: "» Shipping / customs", st: ["Shipping", "Customs / AJU", "POFW Approved"] },
  ];
  const DASAR = { barang_diterima: "Barang diterima gudang", invoice: "Tanggal invoice", dokumen_lengkap: "Dokumen fisik lengkap" };
  const BAYAR = { tanpa: "Belum ada tagihan", belum: "Belum diajukan", proses: "Diajukan / dijadwalkan", lunas: "Lunas" };
  const isCbd = (t) => t === "CBD" || t === "Exwork";
  // peringatan per tagihan
  const PFLAG = {
    terlewat: { label: "Terlewat finance", badge: "b-red" },
    lewat:    { label: "Lewat jatuh tempo", badge: "b-red" },
    mundur:   { label: "Jadwal mundur", badge: "b-orange" },
    dokumen:  { label: "Dokumen belum lengkap", badge: "b-yellow" },
    pi:       { label: "PI belum diterima", badge: "b-yellow" },
    ajukan:   { label: "Segera ajukan", badge: "b-blue" },
    data:     { label: "Tgl dasar/TOP kosong", badge: "b-gray" },
  };
  // peringatan per PO (baris tabel)
  const FLAG = {
    tertahan:  { label: "Tertahan bayar (CBD)", badge: "b-red", color: "#c62828" },
    telat:     { label: "Terlewat / lewat jatuh tempo", badge: "b-red", color: "#8b1d1d" },
    ajukan:    { label: "Siap, belum diajukan", badge: "b-blue", color: "#1f5eff" },
    dokumen:   { label: "Dokumen belum lengkap", badge: "b-yellow", color: "#a68a00" },
    mingguini: { label: "Bayar minggu ini", badge: "b-purple", color: "#7a3ff2" },
    cek:       { label: "Perlu cek", badge: "b-red", color: "#c62828" },
    basi:      { label: `> ${BASI_HARI} hari tanpa update`, badge: "b-orange", color: "#d9730d" },
    tutup:     { label: "Siap dicentang selesai", badge: "b-green", color: "#1e8e4f" },
  };
  const PAY_FIELDS = ["entitas", "vendor_nama", "no_po", "no_invoice", "tgl_invoice", "tgl_barang_diterima", "termin", "top_hari", "dasar_top", "nominal",
    "doc_invoice", "doc_faktur", "doc_sj", "doc_po", "dokumen_cocok", "no_faktur", "no_sj", "tgl_dokumen_lengkap", "catatan_dokumen",
    "status", "tgl_diajukan", "no_pengajuan", "pic_finance", "rencana_bayar", "tgl_dibayar", "no_bukti_transfer", "alasan", "catatan"];
  const PO_FIELDS = ["tgl_po", "no_po", "principal", "item", "qty", "termin", "top_hari", "internal", "no_aju", "status", "tgl_update",
    "update_terakhir", "pic", "email_ref", "catatan", "selesai"];

  const st = {
    loaded: false, pos: [], pays: [], vendors: [], rows: [],
    q: "", scope: "eksternal", view: "open", status: "", bayar: "", vendor: "", flags: new Set(),
    sort: { key: "tgl_po", dir: "desc" },
  };
  let editingPay = null, editingPo = null, payFormPoId = null;

  // ---------- Tanggal ----------
  const toD = (iso) => (iso ? new Date(iso.slice(0, 10) + "T00:00:00") : null);
  const toIso = (d) => (d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : null);
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const today = () => toD(isoToday());
  const mondayOf = (d) => addDays(d, -((d.getDay() + 6) % 7));
  function nearestThursday(d) { let diff = (4 - d.getDay() + 7) % 7; if (diff > 3) diff -= 7; return addDays(d, diff); }
  const thursdayNextWeek = (d) => addDays(mondayOf(d), 10);
  const daysBetween = (a, b) => Math.round((b - a) / DAY);
  const dash = `<span class="muted">–</span>`;
  const fmtD = (d) => (d ? fmtDateShort(toIso(d)) : "");
  const fmtRp = (n) => (n == null ? "" : `${n.toLocaleString("id-ID", { maximumFractionDigits: 2 })}`);
  const norm = (s) => (s || "").trim().toLowerCase();

  // ---------- Vendor & PO ----------
  const INTERNAL_RE = /\bKIM\b|kreasi internusa|internusa mandiri|\bABCD\b|indovisual sistem integrasi|\bISI\b|servisindo|\bISS\b/i;
  const vendorByName = (n) => st.vendors.find((v) => norm(v.nama) === norm(n)) || null;
  const isInternalName = (n) => INTERNAL_RE.test(n || "") || !!vendorByName(n)?.internal;

  // Cocokkan teks No PO dengan PO di tracker (sama dengan public.find_po_id di database)
  function findPo(noPo) {
    if (!noPo) return null;
    const toks = [...new Set((noPo.toUpperCase().match(/[A-Z]{2,4}-[A-Z]{4}-\d{4}-\d{4}/g) || []))].sort((a, b) => b.startsWith("IH-") - a.startsWith("IH-"));
    for (const t of toks) {
      const hit = st.pos.filter((p) => p.no_po.toUpperCase().includes(t));
      if (hit.length === 1) return hit[0];
    }
    const n = noPo.replace(/\s+/g, "").toUpperCase();
    const hit = st.pos.filter((p) => p.no_po.replace(/\s+/g, "").toUpperCase() === n);
    return hit.length === 1 ? hit[0] : null;
  }

  function enrichPo(p) {
    const v = vendorByName(p.principal);
    const internal = p.internal ?? isInternalName(p.principal);
    const termin = p.termin || (v && v.termin !== "TOP" ? v.termin : null) || (internal ? "TOP" : v ? v.termin : null);
    const terminEff = termin || "CBD";
    const top = p.top_hari ?? v?.top_hari ?? (internal ? 30 : null);
    const umur = p.tgl_update ? daysBetween(toD(p.tgl_update), today()) : null;
    const hay = [p.no_po, p.principal, p.item, p.qty, p.no_aju, p.status, p.update_terakhir, p.pic, p.email_ref, p.catatan]
      .filter(Boolean).join(" \u0001 ").toLowerCase();
    return { ...p, kind: "po", internal, termin, terminEff, terminAsumsi: !termin, cbd: isCbd(terminEff), top, umur, hay, pays: [] };
  }

  function enrichPay(r) {
    const po = r.po_id ? st.pos.find((p) => p.id === r.po_id) : null;
    const v = vendorByName(r.vendor_nama);
    const termin = r.termin || po?.termin || v?.termin || po?.terminEff || "TOP";
    const cbd = isCbd(termin);
    const now = today();
    const paid = r.status === "dibayar";
    const closed = paid || r.status === "ditolak";
    let top, dasar, basis, jatuh, target, docsOk, earliest, docDate;
    if (cbd) {
      top = 0; dasar = "invoice";
      basis = toD(r.tgl_invoice); jatuh = basis; target = basis ? nearestThursday(basis) : null;
      docsOk = !!r.doc_invoice;
      docDate = docsOk ? toD(r.tgl_dokumen_lengkap || r.tgl_invoice) : null;
      earliest = docDate ? thursdayNextWeek(docDate) : null;
    } else {
      top = r.top_hari ?? po?.top ?? v?.top_hari ?? null;
      dasar = r.dasar_top || v?.dasar_top || "barang_diterima";
      basis = toD({ barang_diterima: r.tgl_barang_diterima, invoice: r.tgl_invoice, dokumen_lengkap: r.tgl_dokumen_lengkap }[dasar]);
      jatuh = basis && top != null ? addDays(basis, top) : null;
      target = jatuh ? nearestThursday(jatuh) : null;
      docsOk = r.doc_invoice && r.doc_faktur && r.doc_sj;
      docDate = docsOk ? toD(r.tgl_dokumen_lengkap) : null;
      earliest = docDate ? thursdayNextWeek(docDate) : null;
    }
    let rencana = toD(r.rencana_bayar), rencanaAuto = false;
    if (!rencana) {
      rencanaAuto = true;
      rencana = !docsOk ? null : cbd ? earliest : (target && earliest ? (earliest > target ? earliest : target) : target || earliest);
    }
    const flags = [];
    if (!closed) {
      if ((r.status === "diajukan" || r.status === "dijadwalkan") && rencana && daysBetween(rencana, now) > 1) flags.push("terlewat");
      if (!cbd && jatuh && now > jatuh) flags.push("lewat");
      if (!cbd && earliest && target && earliest > target && !r.rencana_bayar) flags.push("mundur");
      if (!docsOk) flags.push(cbd ? "pi" : "dokumen");
      if (docsOk && (r.status === "belum_lengkap" || r.status === "siap_diajukan")) flags.push("ajukan");
      if (!jatuh) flags.push("data");
    }
    const weekStart = mondayOf(now);
    const mingguIni = !closed && rencana && rencana >= weekStart && rencana < addDays(weekStart, 7);
    const hay = [r.vendor_nama, r.entitas, r.no_po, r.no_invoice, r.no_faktur, r.no_sj, r.no_pengajuan, r.pic_finance, r.catatan, r.catatan_dokumen, r.alasan,
      STATUS[r.status]?.label].filter(Boolean).join(" \u0001 ").toLowerCase();
    return { ...r, po, termin, cbd, top, dasar, basis, jatuh, target, earliest, rencana, rencanaAuto, docsOk, paid, closed, flags, mingguIni, hay,
      nominal: r.nominal == null ? null : Number(r.nominal) };
  }

  // Ringkas PO + tagihannya jadi satu baris tabel
  function finishPo(p) {
    const open = p.pays.filter((x) => !x.closed);
    p.openPays = open;
    p.bayar = !p.pays.length ? "tanpa" : !open.length ? (p.pays.some((x) => x.paid) ? "lunas" : "tanpa")
      : open.some((x) => x.status === "diajukan" || x.status === "dijadwalkan") ? "proses" : "belum";
    p.nextPay = open.map((x) => x.rencana).filter(Boolean).sort((a, b) => a - b)[0] || null;
    p.urgent = [...open].sort((a, b) => (b.flags.length - a.flags.length) || ((a.rencana || 9e15) - (b.rencana || 9e15)))[0] || null;
    const f = [];
    if (!p.internal && !p.selesai) {
      const pf = (k) => open.some((x) => x.flags.includes(k));
      if (p.kind === "po" && p.cbd && PRE_SHIP.includes(p.status) && (open.length || (p.status === "Pembayaran" && !p.pays.some((x) => x.paid)))) f.push("tertahan");
      if (pf("terlewat") || pf("lewat")) f.push("telat");
      if (pf("ajukan")) f.push("ajukan");
      if (pf("dokumen") || pf("pi")) f.push("dokumen");
      if (open.some((x) => x.mingguIni)) f.push("mingguini");
      if (p.kind === "po") {
        if (p.status === "Perlu Cek") f.push("cek");
        if (END_STATUS.includes(p.status)) { if (!open.length) f.push("tutup"); }
        else if (p.umur === null || p.umur > BASI_HARI) f.push("basi");
      }
    }
    p.flags = f;
    p.hayAll = p.hay + " \u0001 " + p.pays.map((x) => x.hay).join(" \u0001 ");
    return p;
  }

  function rebuild() {
    st.pos = st.pos.map((p) => enrichPo(p));
    st.pays = st.pays.map((r) => enrichPay(r));
    const byId = new Map(st.pos.map((p) => [p.id, p]));
    const orphans = [];
    for (const r of st.pays) {
      const p = r.po_id ? byId.get(r.po_id) : null;
      if (p) p.pays.push(r); else orphans.push(r);
    }
    // tagihan tanpa PO di tracker (mis. biaya lain-lain) tetap tampil sebagai baris sendiri
    const orphanRows = orphans.map((r) => ({
      kind: "tagihan", id: `t${r.id}`, payId: r.id, tgl_po: r.tgl_invoice, no_po: r.no_po || "(tanpa PO)", principal: r.vendor_nama,
      item: `Invoice ${r.no_invoice || "–"}`, status: null, internal: isInternalName(r.vendor_nama), termin: r.termin, terminEff: r.termin,
      cbd: r.cbd, selesai: r.closed, umur: null, hay: "", pays: [r], update_terakhir: r.catatan, tgl_update: null,
    }));
    st.rows = [...st.pos, ...orphanRows].map(finishPo);
  }

  // ---------- Data ----------
  async function load() {
    $("#payTable tbody").innerHTML = `<tr><td colspan="8" class="loading">Memuat data…</td></tr>`;
    try {
      const [v, po, p, log1, log2] = await Promise.all([
        sb.from("vendors").select("*").order("nama"),
        sb.from("po_principal").select("*").order("id"),
        sb.from("payment_requests").select("*").order("id"),
        sb.from("payment_sync_log").select("synced_at").order("synced_at", { ascending: false }).limit(1),
        sb.from("tracker_sync_log").select("synced_at").eq("tracker", "po_principal").order("synced_at", { ascending: false }).limit(1),
      ]);
      for (const x of [v, po, p]) if (x.error) throw x.error;
      st.vendors = v.data; st.pos = po.data; st.pays = p.data;
      rebuild();
      st.loaded = true;
      const last = [log1.data?.[0]?.synced_at, log2.data?.[0]?.synced_at].filter(Boolean).sort().pop();
      const ext = st.rows.filter((r) => !r.internal && !r.selesai).length;
      $("#payAsOf").textContent = `${ext} PO eksternal dipantau · ${st.pays.filter((x) => !x.closed).length} tagihan terbuka · dimuat ${fmtDateTime(new Date().toISOString())}` +
        (last ? ` · sinkron email terakhir ${fmtDateTime(last)}` : "");
      buildOptions();
      render();
      const late = st.rows.filter((r) => r.flags.includes("telat") || r.flags.includes("tertahan")).length;
      if (late) toast(`🧾 ${late} PO tertahan bayar / tagihan lewat jadwal.`, "err");
    } catch (err) {
      $("#payTable tbody").innerHTML = `<tr><td colspan="8"><div class="error">Gagal memuat data: ${esc(authError(err))}</div></td></tr>`;
    }
  }

  // ---------- Filter & urut ----------
  const inScope = (r) => st.scope === "semua" || (st.scope === "internal" ? r.internal : !r.internal);
  function filtered() {
    const terms = st.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const stage = STAGES.find((s) => s.key === st.status);
    return st.rows.filter((r) => {
      if (!inScope(r)) return false;
      if (st.view === "open" && r.selesai) return false;
      if (st.view === "done" && !r.selesai) return false;
      if (st.status && (stage ? !stage.st.includes(r.status) : r.status !== st.status)) return false;
      if (st.bayar && r.bayar !== st.bayar) return false;
      if (st.vendor && r.principal !== st.vendor) return false;
      for (const f of st.flags) if (!r.flags.includes(f)) return false;
      for (const t of terms) if (!r.hayAll.includes(t)) return false;
      return true;
    });
  }
  function sorted(rows) {
    const { key, dir } = st.sort;
    const m = dir === "asc" ? 1 : -1;
    const val = (r) => {
      if (key === "status") return r.status ? PO_STATUSES.indexOf(r.status) : 99;
      if (key === "bayar") return r.nextPay ? r.nextPay.getTime() : null;
      return (r[key] ?? "").toString().toLowerCase();
    };
    return [...rows].sort((a, b) => {
      const x = val(a), y = val(b);
      if (x === y) return String(b.id).localeCompare(String(a.id), undefined, { numeric: true });
      if (x === null || x === "") return 1;
      if (y === null || y === "") return -1;
      return (x > y ? 1 : -1) * m;
    });
  }

  // ---------- Render ----------
  function render() {
    if (!st.loaded) return;
    renderKpis();
    renderSide();
    renderTable(sorted(filtered()));
    syncControls();
  }

  function renderKpis() {
    const open = st.rows.filter((r) => inScope(r) && !r.selesai);
    const has = (f) => open.filter((r) => r.flags.includes(f)).length;
    const k = [
      { key: "open", label: st.scope === "internal" ? "PO internal dipantau" : "PO dipantau", value: open.length, accent: "#1f5eff" },
      ...["tertahan", "telat", "ajukan", "mingguini", "cek", "basi", "tutup"].map((f) => ({ key: f, label: FLAG[f].label, value: has(f), accent: FLAG[f].color })),
    ];
    const active = st.flags.size === 1 ? [...st.flags][0] : !st.flags.size && st.view === "open" && !st.status && !st.bayar && !st.vendor && !st.q ? "open" : "";
    $("#payKpis").innerHTML = k.map((x) => `
      <button class="kpi ${active === x.key ? "active" : ""}" data-pkpi="${x.key}" style="--accent:${x.accent}" title="${esc(x.label)}">
        <div class="label">${esc(x.label)}</div><div class="value">${x.value}</div>
      </button>`).join("");
  }

  const payFlagBadges = (r, max = 2) => r.flags.filter((f) => f !== "data" || r.flags.length === 1).slice(0, max)
    .map((f) => `<span class="badge ${PFLAG[f].badge}">${PFLAG[f].label}</span>`).join(" ");
  const terminBadge = (p) => p.terminEff ? `<span class="badge ${p.cbd ? "b-orange" : "b-gray"}" title="${p.terminAsumsi ? "Termin belum diisi, vendor eksternal dianggap CBD" : "Termin"}">${esc(p.terminEff)}${p.terminEff === "TOP" && p.top != null ? ` ${p.top}` : ""}${p.terminAsumsi ? "?" : ""}</span>` : "";

  function renderSide() {
    const rows = st.rows.filter((r) => !r.internal && !r.selesai);
    const now = today();
    const thisThu = addDays(mondayOf(now), 3);
    const nextThu = addDays(thisThu, 7);
    const inWeek = (x, thu) => x.rencana && x.rencana >= addDays(thu, -3) && x.rencana < addDays(thu, 4);
    const pays = rows.flatMap((r) => r.openPays.map((x) => ({ x, r })));
    const late = (x) => x.flags.includes("terlewat") || x.flags.includes("lewat");
    const groups = [
      { key: "telat", title: "⚠ Terlewat / lewat jatuh tempo", color: "#c62828", items: pays.filter(({ x }) => late(x)) },
      { key: "tertahan", title: "PO tertahan bayar (CBD)", color: "#d9730d", items: rows.filter((r) => r.flags.includes("tertahan")).map((r) => ({ x: r.urgent, r })) },
      { key: "ini", title: `Kamis/Jumat ini · ${fmtDate(toIso(thisThu))}`, color: "#7a3ff2", items: pays.filter(({ x }) => inWeek(x, thisThu) && !late(x)) },
      { key: "depan", title: `Minggu depan · ${fmtDate(toIso(nextThu))}`, color: "#1f5eff", items: pays.filter(({ x }) => inWeek(x, nextThu)) },
      { key: "ajukan", title: "Siap, belum diajukan", color: "#0e9aa7", items: pays.filter(({ x }) => x.flags.includes("ajukan") && !late(x) && !inWeek(x, thisThu) && !inWeek(x, nextThu)) },
    ];
    $("#payTiles").innerHTML = groups.slice(0, 4).map((g) => `
      <button class="rem-tile" data-pgroup="${g.key}" style="--c:${g.color}"><div class="n">${g.items.length}</div><div class="t">${esc(g.title.replace(/ ·.*/, "").replace("⚠ ", ""))}</div></button>`).join("");
    const item = ({ x, r }, color) => `
      <button class="rem-item" data-rid="${r.id}" style="--c:${color}">
        <div class="top"><span class="po">${esc(r.principal || x?.vendor_nama || "–")}</span>${terminBadge(r)}</div>
        <div class="cust">${esc(r.no_po)}</div>
        <div class="cust">${x ? `${esc(x.vendor_nama !== r.principal ? `${x.vendor_nama} · ` : "")}Inv ${esc(x.no_invoice || "–")}${x.nominal != null ? ` · ${esc(x.mata_uang || "IDR")} ${fmtRp(x.nominal)}` : ""} · ${x.rencana ? `bayar ${fmtDate(toIso(x.rencana))}` : x.cbd ? "PI belum diterima" : "dok. belum lengkap"} · ${esc(STATUS[x.status].label)}`
          : `Status ${esc(r.status)} · belum ada PI / tagihan`}</div>
      </button>`;
    let html = "";
    for (const g of groups) {
      if (!g.items.length) continue;
      const items = [...g.items].sort((a, b) => ((a.x?.rencana || a.x?.jatuh || 0) - (b.x?.rencana || b.x?.jatuh || 0)));
      html += `<div class="rem-group">${esc(g.title)} (${items.length})</div>` + items.slice(0, 25).map((it) => item(it, g.color)).join("");
    }
    $("#payList").innerHTML = html || `<div class="rem-empty">Tidak ada tagihan yang perlu dibayar dalam 2 minggu ini 👍</div>`;
  }

  function docIcons(x) {
    const d = (on, t, label) => `<span class="doc ${on ? "on" : ""}" title="${label}: ${on ? "diterima" : "belum"}">${t}</span>`;
    return x.cbd ? `<div class="docs">${d(x.doc_invoice, "PI", "Proforma invoice")}</div>`
      : `<div class="docs">${d(x.doc_invoice, "INV", "Invoice")}${d(x.doc_faktur, "FP", "Faktur pajak")}${d(x.doc_sj, "SJ", "Surat jalan")}${d(x.doc_po, "PO", "PO")}</div>`;
  }

  function payCell(r) {
    const n = r.pays.length;
    if (!n) {
      if (r.internal) return `<span class="muted">TOP ${r.top ?? 30} · belum ada tagihan</span>`;
      if (r.cbd && PRE_SHIP.includes(r.status)) return `<span class="badge b-orange">${esc(r.terminEff)}: tunggu PI</span><span class="sub2 ell">bayar sebelum barang dikirim</span>`;
      return `<span class="muted">Belum ada tagihan</span>`;
    }
    if (r.bayar === "lunas") {
      const last = r.pays.map((x) => x.tgl_dibayar).filter(Boolean).sort().pop();
      return `<span class="badge b-green">✔ Lunas${last ? ` ${fmtDateShort(last)}` : ""}</span><span class="sub2 ell">${n} tagihan</span>`;
    }
    const x = r.urgent;
    return `<span class="badge ${STATUS[x.status].badge}">${STATUS[x.status].label}</span>
      <span class="sub2 ell">${x.rencana ? `bayar ${fmtD(x.rencana)}${x.rencanaAuto ? "" : " (finance)"}` : x.cbd ? "PI belum diterima" : x.target ? `target ${fmtD(x.target)}, tunggu dokumen` : "jadwal belum bisa dihitung"}${n > 1 ? ` · ${r.openPays.length}/${n} terbuka` : ""}</span>
      ${docIcons(x)}`;
  }

  function renderTable(rows) {
    $("#payCount").textContent = `(${rows.length})`;
    $("#payEmpty").hidden = rows.length > 0;
    const isAdmin = W.me()?.role === "admin";
    $("#payTable tbody").innerHTML = rows.map((r) => {
      const tone = r.selesai ? "row-done" : r.flags.includes("telat") || r.flags.includes("tertahan") || r.flags.includes("cek") ? "row-red"
        : r.flags.includes("basi") || r.flags.includes("ajukan") ? "row-yellow" : "";
      const shown = r.flags.filter((f) => !["cek", "mingguini"].includes(f)).slice(0, 2);
      return `<tr class="${tone}" data-rid="${r.id}">
        <td>${r.tgl_po ? fmtDateShort(r.tgl_po) : dash}</td>
        <td><span class="ell" title="${esc(r.no_po)}"><strong>${esc(r.no_po)}</strong></span>
            <span class="ell sub2" title="${esc(r.principal)}">${r.internal ? `<span class="badge b-gray">Internal</span> ` : ""}${esc(r.principal || "–")}</span></td>
        <td><span class="ell" title="${esc(r.item)}">${esc(r.item || "–")}</span><span class="ell sub2">${esc(r.qty || "")}${r.no_aju ? ` · AJU ${esc(r.no_aju)}` : ""}</span></td>
        <td>${r.status ? `<span class="badge ${PO_STATUS[r.status] || "b-gray"}">${esc(r.status)}</span>` : `<span class="badge b-gray">Tagihan tanpa PO</span>`} ${terminBadge(r)}
            ${shown.length ? `<div class="tags">${shown.map((f) => `<span class="badge ${FLAG[f].badge}">${FLAG[f].label}</span>`).join(" ")}</div>` : ""}</td>
        <td>${payCell(r)}</td>
        <td class="c-upd"><span class="clamp2" title="${esc(r.update_terakhir)}">${esc(r.update_terakhir || "")}</span>
            <span class="sub2">${r.tgl_update ? `${fmtDateShort(r.tgl_update)} · ${r.umur} hr lalu` : r.kind === "po" ? "tgl update kosong" : ""}${r.sumber === "email" ? " · ✉" : ""}</span></td>
        <td class="num">${r.kind === "po" ? `<input type="checkbox" data-pdone ${r.selesai ? "checked" : ""} title="${r.selesai ? "Sudah selesai" : "Centang bila selesai"}" />` : ""}</td>
        <td class="no-print"><div class="acts">
          <button class="act view" data-pact="view" title="View">${ICON.view}</button>
          <button class="act edit" data-pact="edit" title="Edit">${ICON.edit}</button>
          ${r.kind === "po" ? `<button class="act" data-pact="addpay" title="Tambah tagihan untuk PO ini">＋Rp</button>` : ""}
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
    const used = new Set(st.pos.map((p) => p.status));
    $("#payStatus").innerHTML = `<option value="">Semua status PO</option>` + STAGES.map((s) => `<option value="${s.key}">${esc(s.label)}</option>`).join("") +
      PO_STATUSES.filter((s) => used.has(s)).map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
    const names = [...new Set(st.rows.filter(inScope).map((r) => r.principal).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    if (st.vendor && !names.includes(st.vendor)) names.unshift(st.vendor);
    $("#payVendor").innerHTML = `<option value="">Semua principal</option>` + names.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
    $("#dlVendor").innerHTML = [...new Set([...st.vendors.map((v) => v.nama), ...st.pos.map((p) => p.principal), ...st.pays.map((r) => r.vendor_nama)].filter(Boolean))]
      .sort().map((v) => `<option value="${esc(v)}">`).join("");
    $("#dlPoPrincipal").innerHTML = st.pos.filter((p) => !p.selesai).map((p) => `<option value="${esc(p.no_po)}">${esc(p.principal || "")}</option>`).join("");
  }

  function syncControls() {
    $("#payQ").value = st.q;
    $("#payScope").value = st.scope;
    $("#payView").value = st.view;
    $("#payStatus").value = st.status;
    $("#payBayar").value = st.bayar;
    $("#payVendor").value = st.vendor;
    $$("#payChips [data-pflag]").forEach((b) => b.classList.toggle("on", st.flags.has(b.dataset.pflag)));
  }
  function resetFilters() { Object.assign(st, { q: "", view: "open", status: "", bayar: "", vendor: "" }); st.flags.clear(); }

  // ---------- View ----------
  function payCard(x) {
    const f = (label, v) => (v === "" || v == null ? "" : `<dt>${label}</dt><dd>${v}</dd>`);
    const yn = (b) => (b ? "✔" : "✕");
    return `<div class="pay-card">
      <div class="pay-card-head">
        <strong>${esc(x.vendor_nama)}</strong> · Inv ${esc(x.no_invoice || "–")}
        <span class="badge ${STATUS[x.status].badge}">${STATUS[x.status].label}</span> <span class="badge ${x.cbd ? "b-orange" : "b-gray"}">${esc(x.termin)}</span> ${payFlagBadges(x, 3)}
      </div>
      <dl>
        ${f("Nominal", x.nominal != null ? `${esc(x.mata_uang || "IDR")} ${fmtRp(x.nominal)}` : "")}
        ${f(x.cbd ? "PI / invoice" : "Tgl invoice", x.tgl_invoice ? fmtDate(x.tgl_invoice) : "")}
        ${x.cbd ? "" : f("Barang diterima", x.tgl_barang_diterima ? fmtDate(x.tgl_barang_diterima) : "")}
        ${x.cbd ? "" : f("TOP", x.top != null ? `${x.top} hari dari ${esc(DASAR[x.dasar].toLowerCase())}` : "")}
        ${x.cbd ? "" : f("Jatuh tempo", x.jatuh ? `${fmtDate(toIso(x.jatuh))} → Kamis ${fmtDate(toIso(x.target))}` : "")}
        ${f("Rencana bayar", x.rencana ? `${fmtDate(toIso(x.rencana))}${x.rencanaAuto ? " (otomatis)" : " (dari finance)"}` : x.cbd ? "menunggu PI diterima" : "menunggu dokumen fisik lengkap")}
        ${f("Dokumen", x.cbd ? `PI ${yn(x.doc_invoice)}` : `Invoice ${yn(x.doc_invoice)} · Faktur ${yn(x.doc_faktur)} · SJ ${yn(x.doc_sj)} · PO ${yn(x.doc_po)}${x.dokumen_cocok === false ? " · ✕ ada selisih" : ""}`)}
        ${f("Diajukan", x.tgl_diajukan ? `${fmtDate(x.tgl_diajukan)}${x.no_pengajuan ? ` · ${esc(x.no_pengajuan)}` : ""}${x.pic_finance ? ` · ${esc(x.pic_finance)}` : ""}` : "")}
        ${f("Dibayar", x.tgl_dibayar ? `${fmtDate(x.tgl_dibayar)}${x.no_bukti_transfer ? ` · ${esc(x.no_bukti_transfer)}` : ""}` : "")}
        ${f("Alasan", esc(x.alasan || ""))}
        ${f("Catatan", x.catatan ? `<span class="pre">${esc(x.catatan)}</span>` : "")}
      </dl>
      <div class="drawer-actions small">
        <button class="btn light" data-pact="payedit" data-pid="${x.id}">✎ Edit tagihan</button>
        ${!x.paid ? `<button class="btn light" data-pact="paid" data-pid="${x.id}">✓ Dibayar hari ini</button>` : ""}
        ${W.me()?.role === "admin" ? `<button class="btn light danger" data-pact="paydel" data-pid="${x.id}">Hapus</button>` : ""}
      </div>
    </div>`;
  }

  function openDrawer(rid) {
    const r = st.rows.find((x) => String(x.id) === String(rid));
    if (!r) return;
    const f = (label, v) => `<dt>${label}</dt><dd>${v === "" || v == null ? dash : v}</dd>`;
    const pre = (v) => (v ? `<span class="pre">${esc(v)}</span>` : "");
    $("#payDrawerBody").innerHTML = r.kind === "po" ? `
      <h2>${esc(r.no_po)}</h2>
      <span class="badge ${PO_STATUS[r.status] || "b-gray"}">${esc(r.status)}</span> ${terminBadge(r)} ${r.internal ? `<span class="badge b-gray">Internal</span>` : ""}
      ${r.selesai ? `<span class="badge b-green">✔ Selesai</span>` : r.flags.map((k) => `<span class="badge ${FLAG[k].badge}">${FLAG[k].label}</span>`).join(" ")}
      <dl>
        ${f("Principal", esc(r.principal || ""))}
        ${f("Tgl PO", r.tgl_po ? fmtDate(r.tgl_po) : "")}
        ${f("Item / qty", esc([r.item, r.qty].filter(Boolean).join(" · ")))}
        ${f("Termin", `${esc(r.terminEff)}${r.terminEff === "TOP" && r.top != null ? ` ${r.top} hari` : ""}${r.terminAsumsi ? " (belum diisi, dianggap CBD)" : ""}`)}
        ${f("No AJU / PIB", esc(r.no_aju || ""))}
        ${f("Update terakhir", pre(r.update_terakhir))}
        ${f("Tgl update", r.tgl_update ? `${fmtDate(r.tgl_update)} · ${r.umur} hari lalu` : "")}
        ${f("PIC", esc(r.pic || ""))}
        ${f("Ref email", esc(r.email_ref || ""))}
        ${f("Catatan", pre(r.catatan))}
        ${f("Sumber", r.sumber === "email" ? "Email (otomatis)" : r.sumber === "sheet" ? "Import dari sheet" : "Input manual")}
      </dl>
      <div class="drawer-actions">
        <button class="btn primary" data-pact="poedit" data-rid="${r.id}">✎ Edit PO</button>
        <button class="btn light" data-pact="addpay" data-rid="${r.id}">＋ Tagihan</button>
        <button class="btn light" data-pact="done" data-rid="${r.id}">${r.selesai ? "↺ Pantau lagi" : "✔ Tandai selesai"}</button>
      </div>
      <h3 class="drawer-sub">Tagihan &amp; pembayaran (${r.pays.length})</h3>
      ${r.pays.length ? r.pays.map(payCard).join("") : `<p class="muted">${r.cbd ? "Termin CBD/Exwork: begitu PI/invoice diterima, tambahkan tagihan agar diajukan ke Finance minggu berikutnya." : "Belum ada tagihan untuk PO ini."}</p>`}`
      : `<h2>Tagihan tanpa PO</h2><p class="muted">No PO "${esc(r.no_po)}" tidak ditemukan di daftar PO. Edit tagihan untuk menautkan ke PO yang benar.</p>${payCard(r.pays[0])}`;
    $("#payDrawer").classList.add("open");
  }
  const closeDrawer = () => $("#payDrawer").classList.remove("open");

  // ---------- Form PO ----------
  function openPoForm(id) {
    editingPo = id;
    const p = id ? st.pos.find((x) => x.id === id) : null;
    const form = $("#beliForm");
    form.reset();
    PO_FIELDS.forEach((k) => {
      const el = form.elements[k];
      if (el.type === "checkbox") el.checked = k === "internal" ? !!(p ? p.internal : false) : !!p?.[k];
      else if (k === "termin") el.value = p?.termin || "";
      else el.value = p ? (p[k] ?? "") : k === "status" ? "PO Dikirim" : k === "tgl_po" || k === "tgl_update" ? isoToday() : "";
    });
    $("#beliTitle").textContent = p ? `Edit PO · ${p.no_po}` : "Tambah PO pembelian";
    msg("#beliMsg", "");
    $("#beliModal").hidden = false;
    setTimeout(() => form.elements[p ? "status" : "no_po"].focus(), 0);
  }

  async function savePo(e) {
    e.preventDefault();
    const form = $("#beliForm");
    const rec = {};
    PO_FIELDS.forEach((k) => { const el = form.elements[k]; rec[k] = el.type === "checkbox" ? el.checked : el.value.trim() || null; });
    if (!rec.no_po) return msg("#beliMsg", "No PO wajib diisi.");
    if (rec.top_hari != null) rec.top_hari = Number(rec.top_hari);
    const btn = $("button[type=submit]", form); btn.disabled = true;
    const q = editingPo ? sb.from("po_principal").update(rec).eq("id", editingPo) : sb.from("po_principal").insert({ ...rec, sumber: "manual" });
    const { data, error } = await q.select().single();
    btn.disabled = false;
    if (error) return msg("#beliMsg", error.code === "23505" ? "No PO ini sudah ada." : `Gagal menyimpan: ${authError(error)}`);
    const i = st.pos.findIndex((x) => x.id === data.id);
    if (i >= 0) st.pos[i] = data; else st.pos.push(data);
    $("#beliModal").hidden = true;
    rebuild(); buildOptions(); render();
    if ($("#payDrawer").classList.contains("open")) openDrawer(data.id);
    toast(editingPo ? "PO diperbarui." : "PO ditambahkan.");
  }

  async function toggleDone(id, value) {
    const p = st.pos.find((x) => x.id === id);
    const row = st.rows.find((x) => x.id === id);
    if (!p) return;
    const next = value ?? !p.selesai;
    const patch = { selesai: next };
    if (next && row?.openPays.length && !confirm(`Masih ada ${row.openPays.length} tagihan belum dibayar untuk PO ini. Tetap tandai selesai?`)) { render(); return; }
    if (next && !END_STATUS.includes(p.status) && confirm(`Status masih "${p.status}". Ubah status jadi "Selesai" juga?`)) patch.status = "Selesai";
    const { data, error } = await sb.from("po_principal").update(patch).eq("id", id).select().single();
    if (error) { toast(`Gagal: ${authError(error)}`, "err"); render(); return; }
    st.pos[st.pos.findIndex((x) => x.id === id)] = data;
    rebuild(); render();
    if ($("#payDrawer").classList.contains("open")) openDrawer(id);
    toast(next ? `${data.no_po} ditandai selesai.` : "Dipantau lagi.");
  }

  async function deletePo(id) {
    const p = st.pos.find((x) => x.id === id);
    if (!p || W.me()?.role !== "admin") return;
    const n = st.pays.filter((x) => x.po_id === id).length;
    if (!confirm(`Hapus PO ${p.no_po}?${n ? `\n${n} tagihan terkait tidak ikut terhapus (jadi tagihan tanpa PO).` : ""}\nData yang dihapus tidak bisa dikembalikan.`)) return;
    const { data, error } = await sb.from("po_principal").delete().eq("id", id).select("id");
    if (error) return toast(`Gagal menghapus: ${authError(error)}`, "err");
    if (!data?.length) return toast("PO tidak terhapus (tidak ada izin).", "err");
    st.pos = st.pos.filter((x) => x.id !== id);
    st.pays = st.pays.map((x) => (x.po_id === id ? { ...x, po_id: null } : x));
    rebuild(); buildOptions(); render();
    toast("PO dihapus.");
  }

  // ---------- Form tagihan ----------
  function openPayForm(id, poId = null) {
    editingPay = id;
    const r = id ? st.pays.find((x) => x.id === id) : null;
    const po = poId ? st.pos.find((x) => x.id === poId) : r?.po || null;
    payFormPoId = po?.id || null;
    const form = $("#payForm");
    form.reset();
    PAY_FIELDS.forEach((k) => {
      const el = form.elements[k];
      if (!el) return;
      if (el.type === "checkbox") el.checked = !!r?.[k];
      else if (k === "nominal") el.value = r?.nominal != null ? r.nominal.toLocaleString("id-ID") : "";
      else el.value = r ? (r[k] ?? "") : k === "entitas" ? "IVP" : k === "status" ? "belum_lengkap"
        : k === "vendor_nama" ? po?.principal || "" : k === "no_po" ? po?.no_po || "" : "";
    });
    $("#payModalTitle").textContent = r ? `Edit tagihan ${r.vendor_nama} · ${r.no_invoice || ""}` : po ? `Tagihan untuk PO ${po.no_po}` : "Tambah tagihan";
    msg("#payMsg", "");
    updateCalc();
    $("#payModal").hidden = false;
    setTimeout(() => form.elements[r ? "status" : po ? "no_invoice" : "vendor_nama"].focus(), 0);
  }

  function formRecord() {
    const form = $("#payForm");
    const rec = {};
    PAY_FIELDS.forEach((k) => {
      const el = form.elements[k];
      if (el.type === "checkbox") rec[k] = el.checked;
      else { const v = el.value.trim(); rec[k] = v === "" ? null : v; }
    });
    if (rec.top_hari != null) rec.top_hari = Number(rec.top_hari);
    if (rec.nominal != null) rec.nominal = parseNominal(rec.nominal);
    if (rec.dokumen_cocok === false) rec.dokumen_cocok = null;
    return rec;
  }
  function formPo(rec) {
    const byText = findPo(rec.no_po);
    if (byText) return byText;
    const keep = payFormPoId && st.pos.find((p) => p.id === payFormPoId);
    return keep && (!rec.no_po || norm(rec.no_po) === norm(keep.no_po)) ? keep : null;
  }

  function updateCalc() {
    const rec = formRecord();
    const po = formPo(rec);
    $("#payPoLink").textContent = rec.no_po ? (po ? `→ tertaut ke ${po.principal || po.no_po}` : "→ PO tidak ditemukan di daftar") : "";
    const e = enrichPay({ ...rec, id: editingPay || 0, po_id: po?.id ?? null });
    const parts = [`Termin ${e.termin}.`];
    if (e.cbd) {
      parts.push("Bayar sebelum barang dikirim/diambil: begitu PI/invoice diterima, ajukan ke Finance.");
      if (e.earliest) parts.push(`Rencana bayar ${fmtDate(toIso(e.earliest))} (Kamis minggu berikutnya setelah PI diterima).`);
      else parts.push("Centang Invoice/PI diterima & isi tanggalnya untuk menghitung jadwal.");
    } else {
      const v = vendorByName(rec.vendor_nama);
      if (v) parts.push(`Vendor terdaftar: TOP ${v.top_hari} hari dari ${DASAR[v.dasar_top].toLowerCase()}.`);
      else if (rec.vendor_nama) parts.push("Vendor baru: akan ditambahkan ke master vendor saat disimpan.");
      if (e.jatuh) parts.push(`Jatuh tempo ${fmtDate(toIso(e.jatuh))} → Kamis terdekat ${fmtDate(toIso(e.target))}.`);
      else parts.push("Isi tanggal dasar & TOP untuk menghitung jatuh tempo.");
      if (e.earliest) parts.push(`Paling cepat bayar ${fmtDate(toIso(e.earliest))}.`);
      if (e.rencana) parts.push(`Rencana bayar: ${fmtDate(toIso(e.rencana))}${e.rencanaAuto ? " (otomatis)" : ""}.`);
      if (e.flags.includes("mundur")) parts.push("⚠ Dokumen membuat jadwal mundur dari Kamis jatuh tempo.");
    }
    $("#payCalc").textContent = parts.join(" ");
  }

  async function ensureVendor(rec, po) {
    let v = vendorByName(rec.vendor_nama);
    if (v) return v;
    const internal = po?.internal ?? isInternalName(rec.vendor_nama);
    const { data, error } = await sb.from("vendors").insert({
      nama: rec.vendor_nama.trim(), top_hari: rec.top_hari ?? (internal ? 30 : po?.top ?? 30), dasar_top: rec.dasar_top || "barang_diterima",
      internal, termin: rec.termin || (po && norm(po.principal) === norm(rec.vendor_nama) ? po.terminEff : "TOP"),
    }).select().single();
    if (error) throw error;
    st.vendors.push(data);
    return data;
  }

  async function savePay(e) {
    e.preventDefault();
    const form = $("#payForm");
    const rec = formRecord();
    if (!rec.vendor_nama) return msg("#payMsg", "Vendor wajib diisi.");
    if (!rec.no_invoice) return msg("#payMsg", "No invoice / PI wajib diisi.");
    if (form.elements.nominal.value.trim() && rec.nominal == null) return msg("#payMsg", "Nominal tidak valid. Contoh: 25.000.000");
    const po = formPo(rec);
    rec.po_id = po?.id ?? null;
    const preview = enrichPay({ ...rec, id: 0 });
    rec.dokumen_cocok = form.elements.dokumen_cocok.checked ? true : (editingPay ? st.pays.find((x) => x.id === editingPay)?.dokumen_cocok ?? null : null);
    const docsOk = preview.docsOk;
    if (docsOk && !rec.tgl_dokumen_lengkap) rec.tgl_dokumen_lengkap = preview.cbd ? rec.tgl_invoice || isoToday() : isoToday();
    if (docsOk && rec.status === "belum_lengkap") rec.status = "siap_diajukan";
    if (rec.status === "diajukan" && !rec.tgl_diajukan) rec.tgl_diajukan = isoToday();
    if (rec.status === "dibayar" && !rec.tgl_dibayar) rec.tgl_dibayar = isoToday();
    if (["diajukan", "dijadwalkan", "dibayar"].includes(rec.status) && !docsOk) {
      if (!confirm(preview.cbd ? "PI / invoice belum dicentang diterima. Tetap simpan dengan status ini?"
        : "Dokumen fisik (invoice, faktur pajak, surat jalan) belum lengkap. Tetap simpan dengan status ini?")) return;
    }
    if ((rec.status === "pending" || rec.status === "ditolak") && !rec.alasan) return msg("#payMsg", "Isi alasan pending / ditolak.");
    const btn = $("#paySave"); btn.disabled = true;
    try {
      const v = await ensureVendor(rec, po);
      rec.vendor_id = v.id;
      rec.vendor_nama = v.nama;
      const wasEdit = !!editingPay;
      const { data, error } = await (wasEdit
        ? sb.from("payment_requests").update(rec).eq("id", editingPay).select().single()
        : sb.from("payment_requests").insert(rec).select().single());
      if (error) throw error;
      const i = st.pays.findIndex((x) => x.id === data.id);
      if (i >= 0) st.pays[i] = data; else st.pays.push(data);
      $("#payModal").hidden = true;
      rebuild(); buildOptions(); render();
      if ($("#payDrawer").classList.contains("open")) openDrawer(data.po_id || `t${data.id}`);
      toast(wasEdit ? "Tagihan diperbarui." : "Tagihan ditambahkan.");
    } catch (err) {
      const m = authError(err);
      msg("#payMsg", /duplicate key|payment_requests_invoice_key/i.test(m) ? "No invoice ini sudah tercatat untuk vendor yang sama." : `Gagal menyimpan: ${m}`);
    } finally { btn.disabled = false; }
  }

  async function markPaid(id) {
    const r = st.pays.find((x) => x.id === id);
    if (!r) return;
    const no = prompt(`Tandai tagihan ${r.vendor_nama} · ${r.no_invoice} sudah DIBAYAR hari ini.\nNo bukti transfer (boleh dikosongkan):`, r.no_bukti_transfer || "");
    if (no === null) return;
    const { data, error } = await sb.from("payment_requests")
      .update({ status: "dibayar", tgl_dibayar: r.tgl_dibayar || isoToday(), no_bukti_transfer: no.trim() || r.no_bukti_transfer || null })
      .eq("id", id).select().single();
    if (error) return toast(`Gagal: ${authError(error)}`, "err");
    st.pays[st.pays.findIndex((x) => x.id === id)] = data;
    rebuild(); render();
    openDrawer(data.po_id || `t${data.id}`);
    toast("Tagihan ditandai dibayar.");
  }

  async function deletePay(id) {
    const r = st.pays.find((x) => x.id === id);
    if (!r || W.me()?.role !== "admin") return;
    if (!confirm(`Hapus tagihan ${r.vendor_nama} · ${r.no_invoice}?\nData yang dihapus tidak bisa dikembalikan.`)) return;
    const { data, error } = await sb.from("payment_requests").delete().eq("id", id).select("id");
    if (error) return toast(`Gagal menghapus: ${authError(error)}`, "err");
    if (!data?.length) return toast("Tagihan tidak terhapus (tidak ada izin).", "err");
    st.pays = st.pays.filter((x) => x.id !== id);
    rebuild(); buildOptions(); render();
    if (r.po_id) openDrawer(r.po_id); else closeDrawer();
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
    const count = (v) => st.pays.filter((r) => r.vendor_id === v.id && !r.closed).length;
    $("#vendorTable").innerHTML = `
      <thead><tr><th>Vendor</th><th>Jenis</th><th>Termin</th><th class="num">TOP</th><th>Dasar hitung</th><th>Mata uang</th><th>PIC</th><th class="num">Tagihan terbuka</th><th></th></tr></thead>
      <tbody>${st.vendors.map((v) => `<tr>
        <td><strong>${esc(v.nama)}</strong></td><td>${v.internal ? "Internal" : "Eksternal"}</td><td>${esc(v.termin)}</td><td class="num">${v.top_hari} hr</td><td>${esc(DASAR[v.dasar_top])}</td>
        <td>${esc(v.mata_uang)}</td><td>${esc(v.pic || "–")}</td><td class="num">${count(v)}</td>
        <td><button class="btn light" data-vedit="${v.id}">Edit</button></td></tr>`).join("") || `<tr><td colspan="9" class="muted">Belum ada vendor. Vendor otomatis ditambahkan saat tagihan disimpan.</td></tr>`}</tbody>`;
  }
  async function saveVendor(e) {
    e.preventDefault();
    const f = $("#vendorForm").elements;
    const rec = { nama: f.nama.value.trim(), top_hari: Number(f.top_hari.value || 30), dasar_top: f.dasar_top.value, termin: f.termin.value, internal: f.internal.checked,
      mata_uang: (f.mata_uang.value.trim() || "IDR").toUpperCase(), npwp: f.npwp.value.trim() || null, pic: f.pic.value.trim() || null };
    if (!rec.nama) return msg("#vendorMsg", "Nama vendor wajib diisi.");
    const id = f.id.value ? Number(f.id.value) : null;
    const { data, error } = await (id ? sb.from("vendors").update(rec).eq("id", id).select().single() : sb.from("vendors").insert(rec).select().single());
    if (error) return msg("#vendorMsg", /duplicate key/i.test(error.message) ? "Nama vendor sudah ada." : authError(error));
    const i = st.vendors.findIndex((x) => x.id === data.id);
    if (i >= 0) st.vendors[i] = data; else st.vendors.push(data);
    st.vendors.sort((a, b) => a.nama.localeCompare(b.nama));
    rebuild();
    $("#vendorForm").reset(); f.id.value = "";
    msg("#vendorMsg", "Vendor tersimpan. Jadwal tagihan yang ikut vendor sudah dihitung ulang.", "ok");
    renderVendors(); buildOptions(); render();
  }

  // ---------- CSV ----------
  function exportCsv() {
    const rows = sorted(filtered());
    const cols = [["tgl_po", "Tgl PO"], ["no_po", "No PO"], ["principal", "Principal"], ["jenis", "Jenis"], ["terminEff", "Termin"], ["item", "Item"], ["qty", "Qty"],
      ["no_aju", "No AJU"], ["status", "Status PO"], ["update_terakhir", "Update terakhir"], ["tgl_update", "Tgl update"], ["bayarLabel", "Status bayar"],
      ["tagihan", "Tagihan"], ["nextPayIso", "Rencana bayar terdekat"], ["flagsLabel", "Peringatan"], ["pic", "PIC"], ["selesai", "Selesai"]];
    const val = (r, k) => ({
      jenis: r.internal ? "Internal" : "Eksternal", bayarLabel: BAYAR[r.bayar], nextPayIso: toIso(r.nextPay), selesai: r.selesai ? "Ya" : "",
      flagsLabel: r.flags.map((f) => FLAG[f].label).join(", "),
      tagihan: r.pays.map((x) => `${x.vendor_nama} ${x.no_invoice || ""} ${x.nominal != null ? `${x.mata_uang || "IDR"} ${x.nominal}` : ""} [${STATUS[x.status].label}${x.rencana ? ` ${toIso(x.rencana)}` : ""}]`).join(" | "),
    }[k] ?? r[k]);
    const q = (v) => { const s = v == null ? "" : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [cols.map((c) => c[1]).join(","), ...rows.map((r) => cols.map(([k]) => q(val(r, k))).join(","))].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
    a.download = `po-pembelian-bayar-${isoToday()}.csv`;
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
  // Registry modul: selling & pay di sini, tracker.js mendaftarkan "retur" lewat WM.registerModule.
  const MODS = {
    selling: { title: "Selling PO", layout: "#layout", actions: "#sellingActions", asOf: "#asOf" },
    pay: { title: "PO Pembelian & Bayar", layout: "#payLayout", actions: "#payActions", asOf: "#payAsOf", show: () => { if (!st.loaded) load(); } },
  };
  W.registerModule = (key, def) => { MODS[key] = def; };
  const el = (x) => (typeof x === "string" ? $(x) : x);
  function setModule(mod) {
    if (mod === "po") mod = "pay"; // tab lama PO Principal sudah digabung
    if (!MODS[mod]) mod = "selling";
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
    $("#payScope").addEventListener("change", (e) => { st.scope = e.target.value; st.vendor = ""; buildOptions(); render(); });
    $("#payView").addEventListener("change", (e) => { st.view = e.target.value; render(); });
    $("#payStatus").addEventListener("change", (e) => { st.status = e.target.value; if (["Selesai", "Cancelled"].includes(st.status)) st.view = "all"; render(); });
    $("#payBayar").addEventListener("change", (e) => { st.bayar = e.target.value; if (st.bayar === "lunas") st.view = "all"; render(); });
    $("#payVendor").addEventListener("change", (e) => { st.vendor = e.target.value; render(); });
    $$("#payChips [data-pflag]").forEach((b) => b.addEventListener("click", () => {
      const f = b.dataset.pflag; st.flags.has(f) ? st.flags.delete(f) : st.flags.add(f); render();
    }));
    $("#payReset").addEventListener("click", () => { resetFilters(); render(); });
    $("#payKpis").addEventListener("click", (e) => {
      const k = e.target.closest("[data-pkpi]")?.dataset.pkpi; if (!k) return;
      resetFilters();
      if (k !== "open") st.flags.add(k);
      render();
    });
    $("#payTiles").addEventListener("click", (e) => {
      const g = e.target.closest("[data-pgroup]")?.dataset.pgroup; if (!g) return;
      resetFilters();
      st.flags.add({ telat: "telat", tertahan: "tertahan", ini: "mingguini", depan: "ajukan" }[g]);
      if (g === "depan") { st.flags.clear(); st.sort = { key: "bayar", dir: "asc" }; st.bayar = ""; }
      render();
    });
    $("#payList").addEventListener("click", (e) => { const i = e.target.closest("[data-rid]"); if (i) openDrawer(i.dataset.rid); });
    $$("#payTable thead th[data-psort]").forEach((th) => th.addEventListener("click", () => {
      const key = th.dataset.psort;
      st.sort = { key, dir: st.sort.key === key && st.sort.dir === "asc" ? "desc" : "asc" };
      render();
    }));
    $("#payTable tbody").addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-rid]"); if (!tr) return;
      const row = st.rows.find((x) => String(x.id) === tr.dataset.rid);
      if (!row) return;
      if (e.target.matches("[data-pdone]")) { toggleDone(row.id, e.target.checked); return; }
      const act = e.target.closest("[data-pact]")?.dataset.pact || "view";
      if (row.kind === "tagihan") {
        if (act === "edit") openPayForm(row.payId); else if (act === "del") deletePay(row.payId); else openDrawer(row.id);
        return;
      }
      if (act === "edit") openPoForm(row.id); else if (act === "del") deletePo(row.id); else if (act === "addpay") openPayForm(null, row.id); else openDrawer(row.id);
    });
    $("#payDrawer").addEventListener("click", (e) => { if (e.target.id === "payDrawer") closeDrawer(); });
    $("#payDrawerClose").addEventListener("click", closeDrawer);
    $("#payDrawerBody").addEventListener("click", (e) => {
      const b = e.target.closest("[data-pact]"); if (!b) return;
      const pid = +b.dataset.pid, rid = +b.dataset.rid;
      switch (b.dataset.pact) {
        case "poedit": openPoForm(rid); break;
        case "addpay": openPayForm(null, rid); break;
        case "done": toggleDone(rid); break;
        case "payedit": openPayForm(pid); break;
        case "paid": markPaid(pid); break;
        case "paydel": deletePay(pid); break;
      }
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
    $("#payAddPo").addEventListener("click", () => openPoForm(null));
    $("#payAdd").addEventListener("click", () => openPayForm(null));
    $("#payVendors").addEventListener("click", openVendors);
    $("#payRefresh").addEventListener("click", load);
    $("#payCsv").addEventListener("click", exportCsv);
    $("#beliForm").addEventListener("submit", savePo);
    $("#payForm").addEventListener("submit", savePay);
    $("#payForm").addEventListener("input", updateCalc);
    $("#payForm").addEventListener("change", updateCalc);
    $("#vendorForm").addEventListener("submit", saveVendor);
    $("#vendorNew").addEventListener("click", () => { $("#vendorForm").reset(); $("#vendorForm").elements.id.value = ""; msg("#vendorMsg", ""); });
    $("#vendorTable").addEventListener("click", (e) => {
      const id = e.target.closest("[data-vedit]")?.dataset.vedit; if (!id) return;
      const v = st.vendors.find((x) => x.id === +id); const f = $("#vendorForm").elements;
      f.id.value = v.id; f.nama.value = v.nama; f.top_hari.value = v.top_hari; f.dasar_top.value = v.dasar_top; f.termin.value = v.termin;
      f.internal.checked = !!v.internal; f.mata_uang.value = v.mata_uang; f.npwp.value = v.npwp || ""; f.pic.value = v.pic || "";
      msg("#vendorMsg", ""); f.nama.focus();
    });
  }

  document.addEventListener("wm:login", () => {
    st.loaded = false;
    let mod = "selling";
    try { mod = localStorage.getItem(MOD_KEY) || "selling"; } catch (_) { /* abaikan */ }
    setModule(mod);
  });
  document.addEventListener("wm:logout", () => { st.pos = []; st.pays = []; st.rows = []; st.vendors = []; st.loaded = false; });

  bind();
})();
