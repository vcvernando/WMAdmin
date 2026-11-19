(() => {
  "use strict";

  const CFG = window.WM_CONFIG;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
  const DAY = 86400000;

  // Status & warna (konsisten di chart, badge, legend)
  const STATUS = {
    "Belum ada COS":        { color: "#d9730d", badge: "b-orange", order: 1 },
    "Belum ada No. GP":     { color: "#f2a541", badge: "b-orange", order: 2 },
    "Proses":               { color: "#1f5eff", badge: "b-blue",   order: 3 },
    "Dicentang belum lengkap": { color: "#c62828", badge: "b-red", order: 4 },
    "Selesai":              { color: "#1e8e4f", badge: "b-green",  order: 5 },
    "Canceled":             { color: "#9aa3af", badge: "b-gray",   order: 6 },
  };
  const PALETTE = ["#1f5eff", "#d9730d", "#1e8e4f", "#7a3ff2", "#c62828", "#0e9aa7", "#a68a00", "#e05297", "#5f6b7a"];

  const state = {
    rows: [],
    view: "aktif",
    q: "",
    status: "",
    by: "",
    customer: "",
    month: "",
    from: "",
    to: "",
    flags: new Set(),
    sort: { key: "request_date", dir: "desc" },
  };

  // ---------- Data ----------
  async function load() {
    $("#listing tbody").innerHTML = `<tr><td colspan="14" class="loading">Memuat data…</td></tr>`;
    try {
      const url = `${CFG.SUPABASE_URL}/rest/v1/${CFG.TABLE}?select=*&order=sheet_row.asc`;
      const res = await fetch(url, {
        headers: { apikey: CFG.SUPABASE_KEY, Authorization: `Bearer ${CFG.SUPABASE_KEY}` },
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const data = await res.json();
      state.rows = data.map(enrich);
      let syncTxt = "";
      try {
        const sr = await fetch(`${CFG.SUPABASE_URL}/rest/v1/sync_log?select=synced_at,source&order=synced_at.desc&limit=1`, {
          headers: { apikey: CFG.SUPABASE_KEY, Authorization: `Bearer ${CFG.SUPABASE_KEY}` },
        });
        const s = sr.ok ? await sr.json() : [];
        if (s[0]) syncTxt = ` · sinkron dari Google Sheet ${fmtDateTime(s[0].synced_at)}`;
      } catch (_) { /* abaikan */ }
      $("#asOf").textContent = `${state.rows.length} PO${syncTxt}`;
      buildOptions();
      render();
    } catch (err) {
      $("#listing tbody").innerHTML = `<tr><td colspan="14"><div class="error">Gagal memuat data: ${esc(err.message)}</div></td></tr>`;
    }
  }

  const blank = (v) => !v || !String(v).trim();
  const has = (v, re) => !blank(v) && re.test(v);

  // ATURAN = sama dengan rumus tab "Selling PO - Aktif" di Google Sheet:
  //  - lengkap  : No PO, COS, dan No. GP terisi (sel tidak kosong)
  //  - aktif    : (No PO atau Customer terisi) DAN (Selesai (Admin) belum dicentang ATAU belum lengkap)
  //  - merah    : dicentang tapi belum lengkap ("Ditolak: data belum lengkap")
  //  - kuning   : kolom Unit indent / progres mengandung "perlu cek"
  //  - oranye   : sel COS / Nomor Posting COS / No. GP kosong (PO aktif)
  //  - umur     : hari ini - Request Date; > 30 hari ditebalkan merah
  function enrich(r) {
    const noPo = blank(r.no_po);
    const noCos = blank(r.cos);
    const noPosting = blank(r.posting_cos);
    const noGp = blank(r.no_gp);
    const cek = has(r.progres, /perlu cek/i);
    const cekNote = has(r.notes, /perlu cek/i) || /^\s*\?\s*$/.test(r.progres || "") || /^\s*\?\s*$/.test(r.notes || "");
    const indent = has(r.notes, /indent/i) || has(r.details, /indent/i) || has(r.progres, /indent/i);
    const canceled = [r.cos, r.posting_cos, r.no_gp, r.progres, r.notes].some((v) => has(v, /cancel/i));
    const complete = !noPo && !noCos && !noGp;
    const listed = !noPo || !blank(r.customer);
    const aktif = listed && (!r.selesai || !complete);
    const ditolak = r.selesai && !complete;

    let status;
    if (ditolak) status = "Dicentang belum lengkap";
    else if (!aktif && canceled) status = "Canceled";
    else if (!aktif) status = "Selesai";
    else if (noCos) status = "Belum ada COS";
    else if (noGp) status = "Belum ada No. GP";
    else status = "Proses";

    const d = r.request_date ? new Date(r.request_date + "T00:00:00") : null;
    const age = aktif && d ? Math.floor((startOfToday() - d) / DAY) : null;
    const month = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}` : "";

    let tone = "";
    if (ditolak) tone = "row-red";
    else if (aktif && cek) tone = "row-yellow";

    const hay = [r.request_by, r.no_po, r.customer, r.project, r.details, r.cos, r.posting_cos, r.no_gp, r.progres, r.notes, status]
      .filter(Boolean).join(" \u0001 ").toLowerCase();

    return { ...r, status, aktif, ditolak, noPo, noCos, noPosting, noGp, cek, cekNote, indent, canceled, age, month, tone, hay, _d: d };
  }

  function startOfToday() { const t = new Date(); t.setHours(0, 0, 0, 0); return t; }

  // ---------- Filtering ----------
  function filtered({ ignore = [] } = {}) {
    const q = state.q.trim().toLowerCase();
    const terms = q ? q.split(/\s+/) : [];
    return state.rows.filter((r) => {
      if (!ignore.includes("view")) {
        if (state.view === "aktif" && !r.aktif) return false;
        if (state.view === "selesai" && r.status !== "Selesai") return false;
      }
      if (!ignore.includes("status") && state.status && r.status !== state.status) return false;
      if (!ignore.includes("by") && state.by && (r.request_by || "(kosong)") !== state.by) return false;
      if (state.customer && (r.customer || "") !== state.customer) return false;
      if (!ignore.includes("month") && state.month && r.month !== state.month) return false;
      if (state.from && (!r.request_date || r.request_date < state.from)) return false;
      if (state.to && (!r.request_date || r.request_date > state.to)) return false;
      for (const f of state.flags) {
        if (f === "noCos" && !(r.aktif && r.noCos)) return false;
        if (f === "noGp" && !(r.aktif && r.noGp)) return false;
        if (f === "noPosting" && !(r.aktif && r.noPosting)) return false;
        if (f === "indent" && !r.indent) return false;
        if (f === "cek" && !r.cek) return false;
        if (f === "old" && !(r.age != null && r.age > 30)) return false;
      }
      for (const t of terms) if (!r.hay.includes(t)) return false;
      return true;
    });
  }

  function sorted(rows) {
    const { key, dir } = state.sort;
    const m = dir === "asc" ? 1 : -1;
    const val = (r) => {
      if (key === "status") return STATUS[r.status]?.order ?? 99;
      if (key === "age") return r.age ?? -1;
      if (key === "sheet_row") return r.sheet_row ?? 0;
      return (r[key] ?? "").toString().toLowerCase();
    };
    return [...rows].sort((a, b) => {
      const x = val(a), y = val(b);
      if (x === y) return (a.sheet_row - b.sheet_row) * m;
      if (x === "" || x == null) return 1;
      if (y === "" || y == null) return -1;
      return (x > y ? 1 : -1) * m;
    });
  }

  // ---------- Render ----------
  function render() {
    const rows = filtered();
    renderKpis();
    renderStatusChart(filtered({ ignore: ["status"] }));
    renderByChart(filtered({ ignore: ["by"] }));
    renderDocsChart(rows);
    renderMonthChart(filtered({ ignore: ["month"] }));
    renderSummary(rows);
    renderTable(sorted(rows));
    renderPrintMeta(rows);
    syncControls();
  }

  function renderKpis() {
    // KPI dihitung dari seluruh data (bukan filter), sama seperti header tab "Selling PO - Aktif"
    const all = state.rows;
    const aktif = all.filter((r) => r.aktif);
    const aktifCust = aktif.filter((r) => !blank(r.customer));
    const k = [
      { key: "aktif", label: "Total aktif", value: aktifCust.length, note: "= sheet: Total aktif", accent: "#1f5eff" },
      { key: "noCos", label: "Belum ada COS", value: aktifCust.filter((r) => r.noCos).length, note: "= sheet: Belum ada COS", accent: "#d9730d" },
      { key: "noPosting", label: "Belum posting COS", value: aktifCust.filter((r) => r.noPosting).length, note: "= angka sheet \"Belum ada No. GP\"", accent: "#f2a541" },
      { key: "noGp", label: "Belum ada No. GP", value: aktifCust.filter((r) => r.noGp).length, note: "kolom No. GP kosong", accent: "#e8890c" },
      { key: "cek", label: "Perlu cek", value: aktif.filter((r) => r.cek).length, note: "Unit indent berisi \"perlu cek\"", accent: "#a68a00" },
      { key: "red", label: "Dicentang blm lengkap", value: all.filter((r) => r.ditolak).length, note: "= sheet: ditolak", accent: "#c62828" },
      { key: "old", label: "Umur > 30 hari", value: aktif.filter((r) => r.age != null && r.age > 30).length, note: "PO aktif", accent: "#8b1d1d" },
      { key: "all", label: "Total PO", value: all.length, note: "semua baris sheet", accent: "#5f6b7a" },
    ];
    const activeKey = currentKpiKey();
    $("#kpis").innerHTML = k.map((x) => `
      <button class="kpi ${activeKey === x.key ? "active" : ""}" data-kpi="${x.key}" style="--accent:${x.accent}">
        <div class="label">${x.label}</div>
        <div class="value">${x.value}</div>
        <div class="note">${x.note}</div>
      </button>`).join("");
  }

  function currentKpiKey() {
    const f = [...state.flags];
    if (state.view === "all" && !state.flags.size && state.status === "Dicentang belum lengkap"
      && !state.by && !state.customer && !state.month && !state.q && !state.from && !state.to) return "red";
    const clean = !state.status && !state.by && !state.customer && !state.month && !state.q && !state.from && !state.to;
    if (!clean) return "";
    if (state.view === "all" && !f.length) return "all";
    if (state.view === "aktif" && !f.length) return "aktif";
    if (state.view === "aktif" && f.length === 1) return f[0];
    return "";
  }

  function applyKpi(key) {
    resetFilters(false);
    if (key === "all") state.view = "all";
    else if (key === "aktif") state.view = "aktif";
    else if (key === "red") { state.view = "all"; state.status = "Dicentang belum lengkap"; }
    else { state.view = "aktif"; state.flags.add(key); }
    render();
  }

  // Donut SVG
  function donut(el, items, { total, centerLabel, onPick, selected }) {
    const size = 120, r = 46, w = 18, c = size / 2;
    const sum = items.reduce((s, i) => s + i.value, 0);
    let svg = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img">`;
    if (!sum) {
      svg += `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="#e3e7ee" stroke-width="${w}"/>`;
    } else {
      let a0 = -Math.PI / 2;
      items.forEach((it, i) => {
        if (!it.value) return;
        const frac = it.value / sum;
        const dim = selected && selected !== it.key ? "dim" : "";
        if (frac >= 0.9999) {
          svg += `<circle data-i="${i}" class="${dim}" cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${it.color}" stroke-width="${w}"><title>${esc(it.label)}: ${it.value}</title></circle>`;
          return;
        }
        const a1 = a0 + frac * Math.PI * 2;
        const large = a1 - a0 > Math.PI ? 1 : 0;
        const p = (a) => `${(c + r * Math.cos(a)).toFixed(2)} ${(c + r * Math.sin(a)).toFixed(2)}`;
        svg += `<path data-i="${i}" class="${dim}" d="M ${p(a0)} A ${r} ${r} 0 ${large} 1 ${p(a1)}" fill="none" stroke="${it.color}" stroke-width="${w}"><title>${esc(it.label)}: ${it.value} (${Math.round(frac * 100)}%)</title></path>`;
        a0 = a1;
      });
    }
    svg += `<text x="${c}" y="${c + 2}" text-anchor="middle" class="donut-center">${total ?? sum}</text>`;
    svg += `<text x="${c}" y="${c + 16}" text-anchor="middle" class="donut-sub">${esc(centerLabel || "PO")}</text></svg>`;

    const legend = `<ul class="legend-list">${items.map((it, i) => `
      <li data-i="${i}" class="${selected === it.key ? "sel" : ""}">
        <span class="sw" style="background:${it.color}"></span>
        <span class="nm" title="${esc(it.label)}">${esc(it.label)}</span>
        <span class="vl">${it.value}${sum ? ` · ${Math.round((it.value / sum) * 100)}%` : ""}</span>
      </li>`).join("")}</ul>`;

    el.innerHTML = svg + legend;
    if (onPick) {
      $$("[data-i]", el).forEach((n) => n.addEventListener("click", () => onPick(items[+n.dataset.i])));
    }
  }

  function renderStatusChart(rows) {
    const counts = countBy(rows, (r) => r.status);
    const items = Object.keys(STATUS)
      .filter((k) => counts[k])
      .map((k) => ({ key: k, label: k, value: counts[k], color: STATUS[k].color }));
    donut($("#chartStatus"), items, {
      centerLabel: "PO",
      selected: state.status,
      onPick: (it) => { state.status = state.status === it.key ? "" : it.key; if (state.status && state.view === "aktif" && (it.key === "Selesai" || it.key === "Canceled")) state.view = "all"; render(); },
    });
  }

  function renderByChart(rows) {
    const counts = countBy(rows, (r) => r.request_by || "(kosong)");
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const top = entries.slice(0, 7);
    const rest = entries.slice(7).reduce((s, e) => s + e[1], 0);
    const items = top.map(([k, v], i) => ({ key: k, label: k, value: v, color: PALETTE[i % PALETTE.length] }));
    if (rest) items.push({ key: "__rest", label: `Lainnya (${entries.length - 7})`, value: rest, color: "#c5ccd6" });
    donut($("#chartBy"), items, {
      centerLabel: "PO",
      selected: state.by,
      onPick: (it) => { if (it.key === "__rest") return; state.by = state.by === it.key ? "" : it.key; render(); },
    });
  }

  function renderDocsChart(rows) {
    const aktif = rows.filter((r) => r.aktif);
    const both = aktif.filter((r) => !r.noCos && !r.noGp).length;
    const noCos = aktif.filter((r) => r.noCos).length;
    const noGpOnly = aktif.filter((r) => !r.noCos && r.noGp).length;
    donut($("#chartDocs"), [
      { key: "ok", label: "COS & No. GP lengkap", value: both, color: "#1e8e4f" },
      { key: "noCos", label: "Belum ada COS", value: noCos, color: "#d9730d" },
      { key: "noGp", label: "COS ada, No. GP belum", value: noGpOnly, color: "#f2a541" },
    ], {
      centerLabel: "aktif",
      selected: [...state.flags].find((f) => f === "noCos" || f === "noGp") || "",
      onPick: (it) => {
        state.flags.delete("noCos"); state.flags.delete("noGp");
        if (it.key !== "ok") state.flags.add(it.key);
        render();
      },
    });
  }

  function renderMonthChart(rows) {
    const map = {};
    rows.forEach((r) => {
      if (!r.month) return;
      map[r.month] ??= { open: 0, done: 0 };
      if (r.aktif) map[r.month].open++; else map[r.month].done++;
    });
    const keys = Object.keys(map).sort();
    const max = Math.max(1, ...keys.map((k) => map[k].open + map[k].done));
    const el = $("#chartMonth");
    if (!keys.length) { el.innerHTML = `<p class="muted">Tidak ada data.</p>`; return; }
    el.innerHTML = keys.map((k) => {
      const { open, done } = map[k];
      const h = ((open + done) / max) * 100;
      const [y, m] = k.split("-");
      return `<div class="bar ${state.month === k ? "sel" : ""}" data-m="${k}" title="${MONTHS[+m - 1]} ${y}: ${open + done} PO (${open} aktif)">
        <span class="v">${open + done}</span>
        <div class="stack" style="height:${Math.max(4, h)}px">
          <div class="seg-done" style="flex:${done}"></div>
          <div class="seg-open" style="flex:${open}"></div>
        </div>
        <span class="m">${MONTHS[+m - 1]} ${y.slice(2)}</span>
      </div>`;
    }).join("");
    if (!$("#barsLegend")) {
      el.insertAdjacentHTML("afterend", `<div class="bars-legend" id="barsLegend"><span><i style="background:#d9730d"></i>Aktif</span><span><i style="background:#9db7ff"></i>Selesai / canceled</span></div>`);
    }
    $$(".bar", el).forEach((b) => b.addEventListener("click", () => {
      state.month = state.month === b.dataset.m ? "" : b.dataset.m; render();
    }));
  }

  function renderSummary(rows) {
    const groups = {};
    rows.forEach((r) => {
      const k = r.request_by || "(kosong)";
      groups[k] ??= { total: 0, aktif: 0, selesai: 0, noCos: 0, noGp: 0, indent: 0, ages: [] };
      const g = groups[k];
      g.total++;
      if (r.aktif) g.aktif++;
      if (r.status === "Selesai") g.selesai++;
      if (r.aktif && r.noCos) g.noCos++;
      if (r.aktif && r.noGp) g.noGp++;
      if (r.aktif && r.indent) g.indent++;
      if (r.age != null) g.ages.push(r.age);
    });
    const list = Object.entries(groups).sort((a, b) => b[1].aktif - a[1].aktif || b[1].total - a[1].total);
    const maxAktif = Math.max(1, ...list.map(([, g]) => g.aktif));
    const tot = list.reduce((t, [, g]) => {
      ["total", "aktif", "selesai", "noCos", "noGp", "indent"].forEach((f) => (t[f] += g[f]));
      t.ages.push(...g.ages);
      return t;
    }, { total: 0, aktif: 0, selesai: 0, noCos: 0, noGp: 0, indent: 0, ages: [] });
    const avg = (a) => (a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : "–");
    const mx = (a) => (a.length ? Math.max(...a) : "–");

    $("#summaryTable").innerHTML = `
      <thead><tr>
        <th>Request by</th><th class="num">Total</th><th class="num">Aktif</th><th class="num">Selesai</th>
        <th class="num">Belum COS</th><th class="num">Belum GP</th><th class="num">Indent</th>
        <th class="num">Rata² umur aktif</th><th class="num">Umur tertua</th>
      </tr></thead>
      <tbody>${list.map(([k, g]) => `
        <tr data-by="${esc(k)}" class="${state.by === k ? "sel" : ""}">
          <td><strong>${esc(k)}</strong></td>
          <td class="num">${g.total}</td>
          <td class="num">${g.aktif}<span class="mini-bar" style="width:${(g.aktif / maxAktif) * 60}px"></span></td>
          <td class="num">${g.selesai}</td>
          <td class="num ${g.noCos ? "missing" : ""}">${g.noCos}</td>
          <td class="num ${g.noGp ? "missing" : ""}">${g.noGp}</td>
          <td class="num">${g.indent}</td>
          <td class="num">${avg(g.ages)}${g.ages.length ? " hr" : ""}</td>
          <td class="num">${mx(g.ages)}${g.ages.length ? " hr" : ""}</td>
        </tr>`).join("")}
      </tbody>
      <tfoot><tr>
        <td>Total</td><td class="num">${tot.total}</td><td class="num">${tot.aktif}</td><td class="num">${tot.selesai}</td>
        <td class="num">${tot.noCos}</td><td class="num">${tot.noGp}</td><td class="num">${tot.indent}</td>
        <td class="num">${avg(tot.ages)}${tot.ages.length ? " hr" : ""}</td><td class="num">${mx(tot.ages)}${tot.ages.length ? " hr" : ""}</td>
      </tr></tfoot>`;
    $$("#summaryTable tbody tr").forEach((tr) => tr.addEventListener("click", () => {
      state.by = state.by === tr.dataset.by ? "" : tr.dataset.by; render();
    }));
  }

  function cell(v, cls = "") {
    return blank(v) ? `<td class="${cls}"><span class="muted">–</span></td>` : `<td class="${cls}">${esc(v)}</td>`;
  }
  function longCell(v) {
    return blank(v) ? `<td class="long"><span class="muted">–</span></td>` : `<td class="long"><div class="clip" title="${esc(v)}">${esc(v)}</div></td>`;
  }

  function renderTable(rows) {
    $("#rowCount").textContent = `(${rows.length})`;
    $("#empty").hidden = rows.length > 0;
    const tb = $("#listing tbody");
    tb.innerHTML = rows.map((r) => {
      const tags = [
        r.indent ? `<span class="badge b-purple">Indent</span>` : "",
        r.cek || r.cekNote ? `<span class="badge b-yellow">Perlu cek</span>` : "",
      ].join("");
      return `<tr class="${r.tone}" data-id="${r.id}">
        <td class="num muted">${r.sheet_row ?? ""}</td>
        <td class="date">${r.request_date ? fmtDate(r.request_date) : `<span class="missing">–</span>`}</td>
        ${cell(r.request_by)}
        <td class="po">${r.noPo ? `<span class="missing">Belum ada</span>` : esc(r.no_po)}</td>
        ${cell(r.customer)}
        ${cell(r.project)}
        ${longCell(r.details)}
        <td class="code ${r.aktif && r.noCos ? "cell-orange" : ""}">${r.noCos ? `<span class="missing">Belum ada</span>` : esc(r.cos)}</td>
        <td class="code ${r.aktif && r.noPosting ? "cell-orange" : ""}">${r.noPosting ? `<span class="muted">–</span>` : esc(r.posting_cos)}</td>
        <td class="code ${r.aktif && r.noGp ? "cell-orange" : ""}">${r.noGp ? `<span class="missing">Belum ada</span>` : esc(r.no_gp)}</td>
        ${longCell(r.progres)}
        ${longCell(r.notes)}
        <td><span class="badge ${STATUS[r.status].badge}">${r.status}</span>${tags ? `<div class="tags">${tags}</div>` : ""}</td>
        <td class="num ${r.age > 30 ? "age-old" : ""}">${r.age != null ? `${r.age} hr` : `<span class="muted">–</span>`}</td>
      </tr>`;
    }).join("");
    $$("#listing thead th").forEach((th) => {
      th.classList.remove("sorted-asc", "sorted-desc");
      if (th.dataset.sort === state.sort.key) th.classList.add(`sorted-${state.sort.dir}`);
    });
  }

  function renderPrintMeta(rows) {
    const parts = [];
    parts.push(`Tampilan: ${{ aktif: "PO aktif", all: "Semua PO", selesai: "PO selesai" }[state.view]}`);
    if (state.status) parts.push(`Status: ${state.status}`);
    if (state.by) parts.push(`Request by: ${state.by}`);
    if (state.customer) parts.push(`Customer: ${state.customer}`);
    if (state.month) { const [y, m] = state.month.split("-"); parts.push(`Bulan: ${MONTHS[+m - 1]} ${y}`); }
    if (state.from || state.to) parts.push(`Tanggal: ${state.from ? fmtDate(state.from) : "…"} s/d ${state.to ? fmtDate(state.to) : "…"}`);
    const flagNames = { noCos: "Belum ada COS", noPosting: "Belum posting COS", noGp: "Belum ada No. GP", indent: "Unit indent", cek: "Perlu cek", old: "Umur > 30 hari" };
    state.flags.forEach((f) => parts.push(flagNames[f]));
    if (state.q) parts.push(`Cari: "${state.q}"`);
    $("#printMeta").textContent = `${parts.join(" · ")} — ${rows.length} PO · dicetak ${fmtDateTime(new Date().toISOString())}`;
  }

  // ---------- Controls ----------
  function buildOptions() {
    const uniq = (f) => [...new Set(state.rows.map(f).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    fill("#fStatus", Object.keys(STATUS), "Semua status");
    fill("#fBy", uniq((r) => r.request_by || "(kosong)"), "Semua");
    fill("#fCustomer", uniq((r) => r.customer), "Semua customer");
    const months = [...new Set(state.rows.map((r) => r.month).filter(Boolean))].sort().reverse();
    $("#fMonth").innerHTML = `<option value="">Semua bulan</option>` +
      months.map((m) => { const [y, mm] = m.split("-"); return `<option value="${m}">${MONTHS[+mm - 1]} ${y}</option>`; }).join("");
  }
  function fill(sel, values, allLabel) {
    $(sel).innerHTML = `<option value="">${allLabel}</option>` + values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
  }

  function syncControls() {
    $("#q").value = state.q;
    $("#fView").value = state.view;
    $("#fStatus").value = state.status;
    $("#fBy").value = state.by;
    $("#fCustomer").value = state.customer;
    $("#fMonth").value = state.month;
    $("#fFrom").value = state.from;
    $("#fTo").value = state.to;
    $$("#flagChips [data-flag]").forEach((b) => b.classList.toggle("on", state.flags.has(b.dataset.flag)));
    saveState();
  }

  function resetFilters(doRender = true) {
    Object.assign(state, { view: "aktif", q: "", status: "", by: "", customer: "", month: "", from: "", to: "" });
    state.flags.clear();
    if (doRender) render();
  }

  function bind() {
    let t;
    $("#q").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value; render(); }, 150); });
    $("#fView").addEventListener("change", (e) => { state.view = e.target.value; render(); });
    $("#fStatus").addEventListener("change", (e) => {
      state.status = e.target.value;
      if ((state.status === "Selesai" || state.status === "Canceled") && state.view === "aktif") state.view = "all";
      render();
    });
    $("#fBy").addEventListener("change", (e) => { state.by = e.target.value; render(); });
    $("#fCustomer").addEventListener("change", (e) => { state.customer = e.target.value; render(); });
    $("#fMonth").addEventListener("change", (e) => { state.month = e.target.value; render(); });
    $("#fFrom").addEventListener("change", (e) => { state.from = e.target.value; render(); });
    $("#fTo").addEventListener("change", (e) => { state.to = e.target.value; render(); });
    $$("#flagChips [data-flag]").forEach((b) => b.addEventListener("click", () => {
      const f = b.dataset.flag;
      state.flags.has(f) ? state.flags.delete(f) : state.flags.add(f);
      render();
    }));
    $("#btnReset").addEventListener("click", () => resetFilters());
    $("#kpis").addEventListener("click", (e) => { const k = e.target.closest("[data-kpi]"); if (k) applyKpi(k.dataset.kpi); });
    $$("#listing thead th[data-sort]").forEach((th) => th.addEventListener("click", () => {
      const key = th.dataset.sort;
      state.sort = { key, dir: state.sort.key === key && state.sort.dir === "asc" ? "desc" : "asc" };
      renderTable(sorted(filtered()));
      saveState();
    }));
    $("#listing tbody").addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-id]"); if (tr) openDrawer(+tr.dataset.id);
    });
    $("#drawer").addEventListener("click", (e) => { if (e.target.id === "drawer") closeDrawer(); });
    $("#drawerClose").addEventListener("click", closeDrawer);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeDrawer();
      if (e.key === "/" && document.activeElement.tagName !== "INPUT") { e.preventDefault(); $("#q").focus(); }
    });
    $("#btnPrint").addEventListener("click", () => { renderPrintMeta(filtered()); window.print(); });
    $("#btnCsv").addEventListener("click", exportCsv);
    $("#btnRefresh").addEventListener("click", load);
  }

  function openDrawer(id) {
    const r = state.rows.find((x) => x.id === id);
    if (!r) return;
    const f = (label, v) => `<dt>${label}</dt><dd>${blank(v) ? `<span class="muted">–</span>` : esc(v)}</dd>`;
    $("#drawerBody").innerHTML = `
      <h2>${esc(r.no_po || "No PO belum ada")}</h2>
      <span class="badge ${STATUS[r.status].badge}">${r.status}</span>
      ${r.indent ? `<span class="badge b-purple">Indent</span>` : ""}
      ${r.cek || r.cekNote ? `<span class="badge b-yellow">Perlu cek</span>` : ""}
      <dl>
        ${f("Request date", r.request_date ? fmtDate(r.request_date) : "")}
        ${f("Request by", r.request_by)}
        ${f("Customer", r.customer)}
        ${f("Project", r.project)}
        ${f("Details", r.details)}
        ${f("COS", r.cos)}
        ${f("Nomor posting COS", r.posting_cos)}
        ${f("No. GP", r.no_gp)}
        ${f("Progres / Unit indent", r.progres)}
        ${f("Notes", r.notes)}
        ${f("Ceklis admin", r.selesai ? "✔ Selesai (dicentang)" : "Belum")}
        ${f("Umur PO", r.age != null ? `${r.age} hari` : "")}
        ${f("Baris di sheet", r.sheet_row)}
        ${f("Terakhir diubah", fmtDateTime(r.updated_at))}
      </dl>`;
    $("#drawer").classList.add("open");
    $("#drawer").setAttribute("aria-hidden", "false");
  }
  function closeDrawer() { $("#drawer").classList.remove("open"); $("#drawer").setAttribute("aria-hidden", "true"); }

  function exportCsv() {
    const rows = sorted(filtered());
    const cols = [
      ["request_date", "Request Date"], ["request_by", "Request by"], ["no_po", "No PO"], ["customer", "Customer"],
      ["project", "Project"], ["details", "Details"], ["cos", "COS"], ["posting_cos", "Nomor Posting COS"],
      ["no_gp", "No. GP"], ["progres", "Progres / Unit indent"], ["notes", "Notes"], ["selesai", "Selesai (Admin)"],
      ["status", "Status"], ["age", "Umur (hari)"],
    ];
    const q = (v) => { const s = v == null ? "" : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [cols.map((c) => c[1]).join(","), ...rows.map((r) => cols.map(([k]) => q(k === "selesai" ? (r.selesai ? "Ya" : "Tidak") : r[k])).join(","))].join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `selling-po-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- Utils ----------
  function countBy(rows, f) { return rows.reduce((m, r) => { const k = f(r); m[k] = (m[k] || 0) + 1; return m; }, {}); }
  function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function fmtDate(iso) { const [y, m, d] = iso.slice(0, 10).split("-"); return `${+d} ${MONTHS[+m - 1]} ${y}`; }
  function fmtDateTime(iso) {
    if (!iso) return "–";
    const d = new Date(iso);
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  // Simpan filter terakhir per browser (opsional)
  function saveState() {
    try {
      localStorage.setItem("wm-selling-po", JSON.stringify({ ...state, rows: undefined, flags: [...state.flags] }));
    } catch (_) { /* abaikan */ }
  }
  function restoreState() {
    try {
      const s = JSON.parse(localStorage.getItem("wm-selling-po") || "null");
      if (!s) return;
      ["view", "status", "by", "customer", "month", "from", "to", "sort"].forEach((k) => { if (s[k] !== undefined) state[k] = s[k]; });
      state.flags = new Set(s.flags || []);
    } catch (_) { /* abaikan */ }
  }

  restoreState();
  bind();
  load();
})();
