// Modul tracker generik (saat ini: ↩ COS Retur / cos_retur). PO Principal digabung ke purchase.js (PO Pembelian & Bayar).
// Pantau setiap PO pembelian / retur sampai dicentang "Selesai".
// Perlu perhatian: status Perlu Cek, Pending, tanpa update > 7 hari, atau status akhir tapi belum dicentang selesai.
(() => {
  "use strict";
  const W = window.WM;
  if (!W || !W.registerModule) return;
  const { sb, toast, esc, msg, authError, isoToday, fmtDate, fmtDateShort, fmtDateTime, ICON } = W;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const DAY = 86400000;
  const BASI_HARI = 7;

  const toD = (iso) => (iso ? new Date(iso.slice(0, 10) + "T00:00:00") : null);
  const daysSince = (iso) => (iso ? Math.floor((toD(isoToday()) - toD(iso)) / DAY) : null);
  const dash = `<span class="muted">–</span>`;
  const short = (iso) => (iso ? fmtDateShort(iso) : "");

  const CONFIGS = [
    {
      key: "retur", table: "cos_retur", title: "COS Retur", icon: "↩", noun: "retur", dateKey: "tgl_request",
      addLabel: "＋ Tambah Retur", searchPh: "Cari No COS, customer, unit, SN, PIC…",
      statuses: {
        "Request": "b-gray", "COS Retur Dibuat": "b-blue", "Unit Ditarik": "b-yellow", "Unit di Gudang": "b-orange", "Di SRV": "b-purple",
        "Selesai": "b-green", "Pending": "b-red", "Cancelled": "b-gray", "Perlu Cek": "b-red",
      },
      stages: [
        { key: "awal", label: "Request / COS dibuat", accent: "#5f6b7a", st: ["Request", "COS Retur Dibuat", "Unit Ditarik"] },
        { key: "jalan", label: "Unit di gudang / SRV", accent: "#7a3ff2", st: ["Unit di Gudang", "Di SRV"] },
      ],
      endStatus: ["Selesai", "Cancelled"],
      tindakan: ["Kirim ke SRV", "Scrap", "Masuk TLJ", "PO Buyback", "COS Replace", "Kembali ke Stock", "Retur ke Principal", "Belum Ditentukan"],
      groupBy: { key: "tindakan", all: "Semua tindakan" },
      hay: ["no_cos_retur", "cos_asal", "customer", "tipe_unit", "serial_number", "qty", "alasan", "tindakan", "no_replace", "status", "update_terakhir", "pic", "email_ref", "catatan"],
      cols: [
        { label: "Tgl request", sort: "tgl_request", w: 78, td: (r) => (r.tgl_request ? short(r.tgl_request) : dash) },
        { label: "Customer / No COS", sort: "customer", w: 180, td: (r) => `<span class="ell" title="${esc(r.customer)}"><strong>${esc(r.customer || "–")}</strong></span><span class="ell sub2" title="${esc(r.no_cos_retur)}">${r.no_cos_retur ? esc(r.no_cos_retur) : "belum ada No COS retur"}</span>` },
        { label: "Unit / SN", sort: "tipe_unit", td: (r) => `<span class="ell" title="${esc(r.tipe_unit)}">${esc(r.tipe_unit || "–")}${r.qty ? ` <span class="sub2">× ${esc(r.qty)}</span>` : ""}</span><span class="ell sub2" title="${esc(r.serial_number)}">${esc(r.serial_number || "")}</span>` },
        { label: "Tindakan", sort: "tindakan", w: 110, td: (r) => `<span class="ell">${esc(r.tindakan || "–")}</span><span class="ell sub2" title="${esc(r.no_replace)}">${esc(r.no_replace || "")}</span>` },
      ],
      form: [
        { k: "tgl_request", label: "Tgl request", type: "date" },
        { k: "no_cos_retur", label: "No COS retur" },
        { k: "cos_asal", label: "COS asal" },
        { k: "customer", label: "Customer / project *", req: true, span: 2, list: true },
        { k: "qty", label: "Qty" },
        { k: "tipe_unit", label: "Tipe unit" },
        { k: "serial_number", label: "Serial number", span: 2 },
        { k: "alasan", label: "Alasan retur", span: 3 },
        { k: "tindakan", label: "Tindakan", type: "tindakan" },
        { k: "no_replace", label: "No replace / PO buyback", span: 2 },
        { k: "status", label: "Status", type: "status" },
        { k: "tgl_update", label: "Tgl update", type: "date" },
        { k: "pic", label: "PIC" },
        { k: "update_terakhir", label: "Update terakhir", type: "textarea", span: 3 },
        { k: "email_ref", label: "Ref email (subjek)", span: 3 },
        { k: "catatan", label: "Catatan", type: "textarea", span: 3 },
        { k: "selesai", label: "Selesai (berhenti dipantau)", type: "check" },
      ],
      csv: [["tgl_request", "Tgl request"], ["no_cos_retur", "No COS retur"], ["cos_asal", "COS asal"], ["customer", "Customer"], ["tipe_unit", "Tipe unit"],
        ["serial_number", "Serial number"], ["qty", "Qty"], ["alasan", "Alasan"], ["tindakan", "Tindakan"], ["no_replace", "No replace"], ["status", "Status"],
        ["update_terakhir", "Update terakhir"], ["tgl_update", "Tgl update"], ["pic", "PIC"], ["email_ref", "Ref email"], ["catatan", "Catatan"], ["selesai", "Selesai"]],
      headline: (r) => r.customer || r.no_cos_retur, subline: (r) => [r.no_cos_retur, r.tipe_unit].filter(Boolean).join(" · "),
      dupMsg: "Data retur ini sudah ada.",
    },
  ];

  const FLAG = {
    cek:     { label: "Perlu cek", badge: "b-red", color: "#c62828" },
    basi:    { label: `> ${BASI_HARI} hari tanpa update`, badge: "b-orange", color: "#d9730d" },
    pending: { label: "Pending", badge: "b-yellow", color: "#a68a00" },
    tutup:   { label: "Siap dicentang selesai", badge: "b-green", color: "#1e8e4f" },
  };

  function make(cfg) {
    const P = `trk-${cfg.key}`;
    const id = (s) => `${P}-${s}`;
    const st = { loaded: false, rows: [], q: "", view: "open", status: "", group: "", flags: new Set(), sort: { key: cfg.dateKey, dir: "desc" } };
    let editingId = null;

    // ---------- DOM ----------
    const statusOpts = Object.keys(cfg.statuses);
    const layout = document.createElement("div");
    layout.className = "layout trk-layout";
    layout.id = id("layout");
    layout.hidden = true;
    const colgroup = cfg.cols.map((c) => `<col${c.w ? ` style="width:${c.w}px"` : ""} />`).join("") +
      `<col style="width:150px" /><col style="width:22%" /><col style="width:54px" /><col class="no-print" style="width:94px" />`;
    layout.innerHTML = `
      <main class="main">
        <section class="kpis" id="${id("kpis")}"></section>
        <section class="card filters no-print">
          <div class="filter-row trk-filter-row">
            <label class="search"><span aria-hidden="true">🔍</span><input id="${id("q")}" type="search" placeholder="${esc(cfg.searchPh)}" autocomplete="off" /></label>
            <select id="${id("view")}" title="Tampilan">
              <option value="open">Masih dipantau</option><option value="all">Semua</option><option value="done">Sudah selesai</option>
            </select>
            <select id="${id("status")}" title="Status"></select>
            <select id="${id("group")}" title="${esc(cfg.groupBy.all)}"></select>
          </div>
          <div class="chips" id="${id("chips")}">
            ${Object.entries(FLAG).map(([k, f]) => `<button class="chip" data-tflag="${k}">${f.label}</button>`).join("")}
            <button class="chip reset" data-treset>✕ Reset filter</button>
          </div>
        </section>
        <section class="card flow grow">
          <header class="card-head">
            <h3>${cfg.icon} ${esc(cfg.title)} <span class="count" id="${id("count")}"></span></h3>
            <div class="legend"><span class="hint">Klik baris untuk detail · centang ✔ bila sudah selesai agar tidak dipantau lagi</span></div>
          </header>
          <div class="tab-pane">
            <div class="table-wrap scroll">
              <table class="listing trk-table" id="${id("table")}">
                <colgroup>${colgroup}</colgroup>
                <thead><tr>
                  ${cfg.cols.map((c) => `<th data-tsort="${c.sort}">${c.label}</th>`).join("")}
                  <th data-tsort="status">Status</th><th data-tsort="tgl_update">Update terakhir</th><th class="num" title="Selesai">✔</th><th class="no-print act-col">Aksi</th>
                </tr></thead>
                <tbody></tbody>
              </table>
              <p class="empty" id="${id("empty")}" hidden>Tidak ada data yang cocok dengan filter.</p>
            </div>
          </div>
        </section>
      </main>
      <aside class="card reminder no-print">
        <header class="card-head"><h3>⚠ Perlu perhatian</h3><span class="hint">yang belum selesai</span></header>
        <div class="rem-tiles" id="${id("tiles")}"></div>
        <div class="rem-list scroll" id="${id("list")}"></div>
      </aside>`;
    $("#app").appendChild(layout);

    const actions = document.createElement("span");
    actions.className = "act-group";
    actions.id = id("actions");
    actions.hidden = true;
    actions.innerHTML = `<button class="btn primary" data-tact="add">${esc(cfg.addLabel)}</button>
      <button class="btn ghost" data-tact="refresh" title="Muat ulang data">⟳</button>
      <button class="btn ghost" data-tact="csv">⬇ CSV</button>`;
    $("#btnUsers").before(actions);

    const asOf = document.createElement("span");
    asOf.id = id("asof");
    asOf.hidden = true;
    $("#asOf").parentElement.appendChild(asOf);

    const drawer = document.createElement("aside");
    drawer.className = "drawer no-print";
    drawer.setAttribute("aria-hidden", "true");
    drawer.innerHTML = `<div class="drawer-panel"><button class="close" data-tclose aria-label="Tutup">✕</button><div class="trk-body"></div></div>`;
    document.body.appendChild(drawer);

    const field = (f) => {
      const span = f.span ? ` span${f.span}` : "";
      if (f.type === "check") return `<label class="check span3"><input type="checkbox" name="${f.k}" /> ${f.label}</label>`;
      if (f.type === "textarea") return `<label class="${span.trim()}">${f.label}<textarea name="${f.k}" rows="2"></textarea></label>`;
      if (f.type === "status") return `<label class="${span.trim()}">${f.label}<select name="${f.k}">${statusOpts.map((s) => `<option>${esc(s)}</option>`).join("")}</select></label>`;
      if (f.type === "tindakan") return `<label class="${span.trim()}">${f.label}<select name="${f.k}"><option value="">–</option>${cfg.tindakan.map((s) => `<option>${esc(s)}</option>`).join("")}</select></label>`;
      return `<label class="${span.trim()}">${f.label}<input name="${f.k}" ${f.type === "date" ? `type="date"` : ""} ${f.list ? `list="${id("dl")}"` : ""} ${f.req ? "required" : ""} autocomplete="off" /></label>`;
    };
    const modal = document.createElement("div");
    modal.className = "modal no-print";
    modal.hidden = true;
    modal.innerHTML = `
      <form class="modal-panel wide" novalidate>
        <header class="modal-head"><h2 class="trk-mtitle"></h2><button type="button" class="close" data-close aria-label="Tutup">✕</button></header>
        <div class="form-grid three">${cfg.form.map(field).join("")}</div>
        <datalist id="${id("dl")}"></datalist>
        <p class="auth-msg" id="${id("msg")}" role="alert"></p>
        <footer class="modal-foot"><button type="button" class="btn light" data-close>Batal</button><button type="submit" class="btn primary">Simpan</button></footer>
      </form>`;
    document.body.appendChild(modal);
    const form = $("form", modal);

    // ---------- Data ----------
    function enrich(r) {
      const umur = daysSince(r.tgl_update);
      const flags = [];
      if (!r.selesai) {
        if (r.status === "Perlu Cek") flags.push("cek");
        if (r.status === "Pending") flags.push("pending");
        if (cfg.endStatus.includes(r.status)) flags.push("tutup");
        else if (umur === null || umur > BASI_HARI) flags.push("basi");
      }
      const hay = cfg.hay.map((k) => r[k]).filter(Boolean).join(" \u0001 ").toLowerCase();
      return { ...r, umur, flags, hay };
    }

    async function load() {
      const tb = $(`#${id("table")} tbody`);
      tb.innerHTML = `<tr><td colspan="9" class="loading">Memuat data…</td></tr>`;
      try {
        const [d, log] = await Promise.all([
          sb.from(cfg.table).select("*").order("id"),
          sb.from("tracker_sync_log").select("synced_at,email_terakhir").eq("tracker", cfg.table).order("synced_at", { ascending: false }).limit(1),
        ]);
        if (d.error) throw d.error;
        st.rows = d.data.map(enrich);
        st.loaded = true;
        const last = log.data?.[0];
        asOf.textContent = `${st.rows.filter((r) => !r.selesai).length} dipantau dari ${st.rows.length} ${cfg.noun} · dimuat ${fmtDateTime(new Date().toISOString())}` +
          (last ? ` · sinkron email terakhir ${fmtDateTime(last.synced_at)}` : "");
        buildOptions();
        render();
      } catch (err) {
        tb.innerHTML = `<tr><td colspan="9"><div class="error">Gagal memuat data: ${esc(authError(err))}</div></td></tr>`;
      }
    }

    function filtered() {
      const terms = st.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
      return st.rows.filter((r) => {
        if (st.view === "open" && r.selesai) return false;
        if (st.view === "done" && !r.selesai) return false;
        if (st.status) {
          const stage = cfg.stages.find((s) => s.key === st.status);
          if (stage ? !stage.st.includes(r.status) : r.status !== st.status) return false;
        }
        if (st.group && (r[cfg.groupBy.key] || "") !== st.group) return false;
        for (const f of st.flags) if (!r.flags.includes(f)) return false;
        for (const t of terms) if (!r.hay.includes(t)) return false;
        return true;
      });
    }
    function sorted(rows) {
      const { key, dir } = st.sort;
      const m = dir === "asc" ? 1 : -1;
      const val = (r) => (key === "status" ? statusOpts.indexOf(r.status) : (r[key] ?? "").toString().toLowerCase());
      return [...rows].sort((a, b) => {
        const x = val(a), y = val(b);
        if (x === y) return (b.id - a.id);
        if (x === "") return 1;
        if (y === "") return -1;
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
      const open = st.rows.filter((r) => !r.selesai);
      const has = (f) => open.filter((r) => r.flags.includes(f)).length;
      const k = [
        { key: "open", label: `${cfg.title} dipantau`, value: open.length, accent: "#1f5eff" },
        ...cfg.stages.map((s) => ({ key: `stage:${s.key}`, label: s.label, value: open.filter((r) => s.st.includes(r.status)).length, accent: s.accent })),
        { key: "flag:cek", label: "Perlu cek", value: has("cek"), accent: FLAG.cek.color },
        { key: "flag:pending", label: "Pending", value: has("pending"), accent: FLAG.pending.color },
        { key: "flag:basi", label: `> ${BASI_HARI} hari tanpa update`, value: has("basi"), accent: FLAG.basi.color },
        { key: "flag:tutup", label: "Siap dicentang selesai", value: has("tutup"), accent: FLAG.tutup.color },
        { key: "done", label: "Sudah selesai", value: st.rows.length - open.length, accent: "#5f6b7a" },
      ];
      const active = st.view === "done" ? "done" : st.flags.size === 1 ? `flag:${[...st.flags][0]}`
        : cfg.stages.some((s) => s.key === st.status) ? `stage:${st.status}` : !st.flags.size && !st.status && !st.group && !st.q && st.view === "open" ? "open" : "";
      $(`#${id("kpis")}`).innerHTML = k.map((x) => `
        <button class="kpi ${active === x.key ? "active" : ""}" data-tkpi="${x.key}" style="--accent:${x.accent}" title="${esc(x.label)}">
          <div class="label">${esc(x.label)}</div><div class="value">${x.value}</div>
        </button>`).join("");
    }

    function flagBadges(r, max = 2) {
      return r.flags.slice(0, max).map((f) => `<span class="badge ${FLAG[f].badge}">${FLAG[f].label}</span>`).join(" ");
    }

    function renderSide() {
      const open = st.rows.filter((r) => !r.selesai);
      const groups = Object.entries(FLAG).map(([k, f]) => ({ key: k, title: f.label, color: f.color, rows: open.filter((r) => r.flags.includes(k)) }));
      $(`#${id("tiles")}`).innerHTML = groups.map((g) => `
        <button class="rem-tile ${st.flags.size === 1 && st.flags.has(g.key) ? "on" : ""}" data-tgroup="${g.key}" style="--c:${g.color}"><div class="n">${g.rows.length}</div><div class="t">${esc(g.title)}</div></button>`).join("");
      const seen = new Set();
      let html = "";
      for (const g of groups) {
        const rows = g.rows.filter((r) => !seen.has(r.id)).sort((a, b) => (b.umur ?? 999) - (a.umur ?? 999));
        rows.forEach((r) => seen.add(r.id));
        if (!rows.length) continue;
        html += `<div class="rem-group">${esc(g.title)} (${rows.length})</div>` + rows.slice(0, 30).map((r) => `
          <button class="rem-item" data-tid="${r.id}" style="--c:${g.color}">
            <div class="top"><span class="po">${esc(cfg.headline(r) || "–")}</span><span class="badge ${cfg.statuses[r.status] || "b-gray"}">${esc(r.status)}</span></div>
            <div class="cust">${esc(cfg.subline(r) || "")}</div>
            <div class="cust">${r.tgl_update ? `update ${fmtDate(r.tgl_update)} · ${r.umur} hari lalu` : "belum ada tgl update"}</div>
          </button>`).join("");
      }
      $(`#${id("list")}`).innerHTML = html || `<div class="rem-empty">Semua ${cfg.noun} terpantau aman 👍</div>`;
    }

    function renderTable(rows) {
      $(`#${id("count")}`).textContent = `(${rows.length})`;
      $(`#${id("empty")}`).hidden = rows.length > 0;
      const isAdmin = W.me()?.role === "admin";
      $(`#${id("table")} tbody`).innerHTML = rows.map((r) => {
        const tone = r.selesai ? "row-done" : r.flags.includes("cek") ? "row-red" : r.flags.includes("basi") || r.flags.includes("pending") ? "row-yellow" : "";
        return `<tr class="${tone}" data-tid="${r.id}">
          ${cfg.cols.map((c) => `<td>${c.td(r)}</td>`).join("")}
          <td><span class="badge ${cfg.statuses[r.status] || "b-gray"}">${esc(r.status)}</span>${!r.selesai ? `<div class="tags">${r.flags.filter((f) => f === "basi" || f === "tutup").map((f) => `<span class="badge ${FLAG[f].badge}">${FLAG[f].label}</span>`).join(" ")}</div>` : ""}</td>
          <td><span class="clamp2" title="${esc(r.update_terakhir)}">${esc(r.update_terakhir || "")}</span>
              <span class="sub2">${r.tgl_update ? `${short(r.tgl_update)} · ${r.umur} hr lalu` : "tgl update kosong"}${r.sumber === "email" ? " · ✉" : ""}</span></td>
          <td class="num"><input type="checkbox" data-tdone ${r.selesai ? "checked" : ""} title="${r.selesai ? "Sudah selesai" : "Centang bila selesai"}" /></td>
          <td class="no-print"><div class="acts">
            <button class="act view" data-tact="view" title="View">${ICON.view}</button>
            <button class="act edit" data-tact="edit" title="Edit">${ICON.edit}</button>
            ${isAdmin ? `<button class="act del" data-tact="del" title="Hapus">${ICON.del}</button>` : ""}
          </div></td>
        </tr>`;
      }).join("");
      $$(`#${id("table")} thead th`).forEach((th) => {
        th.classList.remove("sorted-asc", "sorted-desc");
        if (th.dataset.tsort === st.sort.key) th.classList.add(`sorted-${st.sort.dir}`);
      });
    }

    function buildOptions() {
      const used = new Set(st.rows.map((r) => r.status));
      $(`#${id("status")}`).innerHTML = `<option value="">Semua status</option>` +
        cfg.stages.map((s) => `<option value="${s.key}">» ${esc(s.label)}</option>`).join("") +
        statusOpts.filter((s) => used.has(s)).map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
      const groups = [...new Set(st.rows.map((r) => r[cfg.groupBy.key]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
      $(`#${id("group")}`).innerHTML = `<option value="">${esc(cfg.groupBy.all)}</option>` + groups.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join("");
      const listKey = cfg.form.find((f) => f.list)?.k;
      if (listKey) $(`#${id("dl")}`).innerHTML = [...new Set(st.rows.map((r) => r[listKey]).filter(Boolean))].sort().map((v) => `<option value="${esc(v)}">`).join("");
    }

    function syncControls() {
      $(`#${id("q")}`).value = st.q;
      $(`#${id("view")}`).value = st.view;
      $(`#${id("status")}`).value = st.status;
      $(`#${id("group")}`).value = st.group;
      $$(`#${id("chips")} [data-tflag]`).forEach((b) => b.classList.toggle("on", st.flags.has(b.dataset.tflag)));
    }
    const resetFilters = () => { Object.assign(st, { q: "", view: "open", status: "", group: "" }); st.flags.clear(); };

    // ---------- View ----------
    function openDrawer(rid) {
      const r = st.rows.find((x) => x.id === rid);
      if (!r) return;
      const lbl = Object.fromEntries(cfg.form.map((f) => [f.k, f.label.replace(" *", "")]));
      const val = (k) => {
        const v = r[k];
        if (v == null || v === "") return dash;
        if (/^tgl_/.test(k)) return fmtDate(v);
        return `<span class="pre">${esc(v)}</span>`;
      };
      const keys = cfg.form.filter((f) => f.type !== "check").map((f) => f.k);
      $(".trk-body", drawer).innerHTML = `
        <h2>${esc(cfg.headline(r) || "–")}</h2>
        <span class="badge ${cfg.statuses[r.status] || "b-gray"}">${esc(r.status)}</span> ${r.selesai ? `<span class="badge b-green">✔ Selesai</span>` : flagBadges(r, 4)}
        <dl>
          ${keys.map((k) => `<dt>${esc(lbl[k])}</dt><dd>${val(k)}</dd>`).join("")}
          <dt>Sumber</dt><dd>${r.sumber === "email" ? "Email (otomatis)" : r.sumber === "sheet" ? "Import dari sheet" : "Input manual"}</dd>
          <dt>Terakhir diubah</dt><dd>${fmtDateTime(r.updated_at)}</dd>
        </dl>
        <div class="drawer-actions">
          <button class="btn primary" data-tact="edit" data-tid="${r.id}">✎ Edit</button>
          <button class="btn light" data-tact="done" data-tid="${r.id}">${r.selesai ? "↺ Pantau lagi" : "✔ Tandai selesai"}</button>
        </div>`;
      drawer.classList.add("open");
    }
    const closeDrawer = () => drawer.classList.remove("open");

    // ---------- Tambah / Edit ----------
    function openForm(rid) {
      editingId = rid;
      const r = rid ? st.rows.find((x) => x.id === rid) : null;
      form.reset();
      cfg.form.forEach((f) => {
        const el = form.elements[f.k];
        if (f.type === "check") el.checked = !!r?.[f.k];
        else el.value = r ? (r[f.k] ?? "") : f.type === "status" ? statusOpts[0] : f.k === "tgl_update" || f.k === cfg.dateKey ? isoToday() : "";
      });
      $(".trk-mtitle", modal).textContent = r ? `Edit ${cfg.title} · ${cfg.headline(r) || ""}` : `Tambah ${cfg.title}`;
      msg(`#${id("msg")}`, "");
      modal.hidden = false;
      setTimeout(() => form.elements[r ? "status" : cfg.form[1].k].focus(), 0);
    }

    async function save(e) {
      e.preventDefault();
      const rec = {};
      cfg.form.forEach((f) => {
        const el = form.elements[f.k];
        rec[f.k] = f.type === "check" ? el.checked : el.value.trim() || null;
      });
      const req = cfg.form.find((f) => f.req);
      if (!rec[req.k]) return msg(`#${id("msg")}`, `${req.label.replace(" *", "")} wajib diisi.`);
      if (!rec.status) rec.status = statusOpts[0];
      const btn = $("button[type=submit]", form);
      btn.disabled = true;
      const q = editingId ? sb.from(cfg.table).update(rec).eq("id", editingId) : sb.from(cfg.table).insert({ ...rec, sumber: "manual" });
      const { data, error } = await q.select().single();
      btn.disabled = false;
      if (error) return msg(`#${id("msg")}`, error.code === "23505" ? cfg.dupMsg : `Gagal menyimpan: ${authError(error)}`);
      upsert(data);
      modal.hidden = true;
      buildOptions();
      render();
      toast(editingId ? "Perubahan disimpan." : `${cfg.title} ditambahkan.`);
    }

    function upsert(data) {
      const row = enrich(data);
      const i = st.rows.findIndex((x) => x.id === row.id);
      if (i >= 0) st.rows[i] = row; else st.rows.push(row);
    }

    async function toggleDone(rid, value) {
      const r = st.rows.find((x) => x.id === rid);
      if (!r) return;
      const next = value ?? !r.selesai;
      const patch = { selesai: next };
      if (next && !cfg.endStatus.includes(r.status) && confirm(`Status masih "${r.status}". Ubah status jadi "Selesai" juga?`)) patch.status = "Selesai";
      const { data, error } = await sb.from(cfg.table).update(patch).eq("id", rid).select().single();
      if (error) { toast(`Gagal: ${authError(error)}`, "err"); render(); return; }
      upsert(data);
      if (drawer.classList.contains("open")) openDrawer(rid);
      render();
      toast(next ? `${cfg.headline(data) || cfg.title} ditandai selesai.` : "Dipantau lagi.");
    }

    async function del(rid) {
      const r = st.rows.find((x) => x.id === rid);
      if (!r || W.me()?.role !== "admin") return;
      if (!confirm(`Hapus ${cfg.title} "${cfg.headline(r)}"?\nData yang dihapus tidak bisa dikembalikan.`)) return;
      const { data, error } = await sb.from(cfg.table).delete().eq("id", rid).select("id");
      if (error) return toast(`Gagal menghapus: ${authError(error)}`, "err");
      if (!data?.length) return toast("Tidak terhapus (tidak ada izin).", "err");
      st.rows = st.rows.filter((x) => x.id !== rid);
      buildOptions();
      render();
      toast("Data dihapus.");
    }

    function exportCsv() {
      const rows = sorted(filtered());
      const q = (v) => { const s = v == null ? "" : v === true ? "Ya" : v === false ? "" : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const csv = [cfg.csv.map((c) => c[1]).join(","), ...rows.map((r) => cfg.csv.map(([k]) => q(r[k])).join(","))].join("\n");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
      a.download = `${cfg.table.replace("_", "-")}-${isoToday()}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    // ---------- Event ----------
    let t;
    $(`#${id("q")}`).addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { st.q = e.target.value; render(); }, 150); });
    $(`#${id("view")}`).addEventListener("change", (e) => { st.view = e.target.value; render(); });
    $(`#${id("status")}`).addEventListener("change", (e) => { st.status = e.target.value; if (["Selesai", "Cancelled"].includes(st.status)) st.view = "all"; render(); });
    $(`#${id("group")}`).addEventListener("change", (e) => { st.group = e.target.value; render(); });
    $(`#${id("chips")}`).addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.hasAttribute("data-treset")) resetFilters();
      else { const f = b.dataset.tflag; st.flags.has(f) ? st.flags.delete(f) : st.flags.add(f); }
      render();
    });
    $(`#${id("kpis")}`).addEventListener("click", (e) => {
      const k = e.target.closest("[data-tkpi]")?.dataset.tkpi; if (!k) return;
      resetFilters();
      if (k === "done") st.view = "done";
      else if (k.startsWith("flag:")) st.flags.add(k.slice(5));
      else if (k.startsWith("stage:")) st.status = k.slice(6);
      render();
    });
    $(`#${id("tiles")}`).addEventListener("click", (e) => {
      const g = e.target.closest("[data-tgroup]")?.dataset.tgroup; if (!g) return;
      const was = st.flags.size === 1 && st.flags.has(g);
      resetFilters();
      if (!was) st.flags.add(g);
      render();
    });
    $(`#${id("list")}`).addEventListener("click", (e) => { const i = e.target.closest("[data-tid]"); if (i) openDrawer(+i.dataset.tid); });
    $$(`#${id("table")} thead th[data-tsort]`).forEach((th) => th.addEventListener("click", () => {
      const key = th.dataset.tsort;
      st.sort = { key, dir: st.sort.key === key && st.sort.dir === "asc" ? "desc" : "asc" };
      render();
    }));
    $(`#${id("table")} tbody`).addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-tid]"); if (!tr) return;
      const rid = +tr.dataset.tid;
      if (e.target.matches("[data-tdone]")) { toggleDone(rid, e.target.checked); return; }
      const act = e.target.closest("[data-tact]")?.dataset.tact || "view";
      if (act === "edit") openForm(rid); else if (act === "del") del(rid); else openDrawer(rid);
    });
    drawer.addEventListener("click", (e) => {
      if (e.target === drawer || e.target.closest("[data-tclose]")) return closeDrawer();
      const b = e.target.closest("[data-tact]"); if (!b) return;
      const rid = +b.dataset.tid;
      if (b.dataset.tact === "edit") { closeDrawer(); openForm(rid); } else if (b.dataset.tact === "done") toggleDone(rid);
    });
    modal.addEventListener("click", (e) => { if (e.target === modal || e.target.closest("[data-close]")) modal.hidden = true; });
    form.addEventListener("submit", save);
    actions.addEventListener("click", (e) => {
      const a = e.target.closest("[data-tact]")?.dataset.tact;
      if (a === "add") openForm(null); else if (a === "refresh") load(); else if (a === "csv") exportCsv();
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
    document.addEventListener("wm:logout", () => { st.rows = []; st.loaded = false; });

    W.registerModule(cfg.key, {
      title: cfg.title, layout: layout, actions: actions, asOf: asOf,
      show: () => { if (!st.loaded) load(); },
    });
  }

  CONFIGS.forEach(make);
})();
