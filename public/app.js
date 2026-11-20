(() => {
  "use strict";

  const CFG = window.WM_CONFIG;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
  const DAY = 86400000;
  const FIELDS = ["request_date", "request_by", "no_po", "customer", "project", "details", "cos", "posting_cos", "no_gp", "target_kirim", "alasan_tunda", "progres", "notes", "selesai", "nilai_po"];
  const SLA_HARI_KERJA = 5; // target kirim otomatis = Request date + 5 hari kerja (Sen–Jum)

  // ---------- Supabase (sesi di localStorage bila "Remember me", selain itu sessionStorage) ----------
  const REMEMBER_KEY = "wm-remember";
  const remember = () => { try { return localStorage.getItem(REMEMBER_KEY) !== "0"; } catch (_) { return true; } };
  const authStorage = {
    getItem(k) { try { return localStorage.getItem(k) ?? sessionStorage.getItem(k); } catch (_) { return null; } },
    setItem(k, v) {
      try {
        if (remember()) { localStorage.setItem(k, v); sessionStorage.removeItem(k); }
        else { sessionStorage.setItem(k, v); localStorage.removeItem(k); }
      } catch (_) { /* abaikan */ }
    },
    removeItem(k) { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch (_) { /* abaikan */ } },
  };
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY, {
    auth: { storage: authStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

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

  // Reminder pengiriman: aktif sampai Ceklis Selesai dicentang
  const KIRIM = {
    late:  { label: "Terlambat",        color: "#c62828", badge: "b-red" },
    today: { label: "Kirim hari ini",   color: "#d9730d", badge: "b-orange" },
    soon:  { label: "H-1 s/d H-3",      color: "#a68a00", badge: "b-yellow" },
    tunda: { label: "Ditunda (ada alasan)", color: "#7a3ff2", badge: "b-purple" },
    none:  { label: "Tanpa Request date", color: "#5f6b7a", badge: "b-gray" },
  };

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
    kirim: "",
    tab: "list",
    flags: new Set(),
    sort: { key: "request_date", dir: "desc" },
  };
  let me = null;          // profil pengguna yang login
  let sessionUserId = null;
  let editingId = null;   // null = tambah PO

  // =====================================================================
  // AUTH
  // =====================================================================
  function showScreen(name) {
    $("#authScreen").hidden = name !== "auth";
    $("#pendingScreen").hidden = name !== "pending";
    $("#app").hidden = name !== "app";
    document.body.classList.toggle("in-app", name === "app");
  }

  function showAuthForm(which) {
    $("#loginForm").hidden = which !== "login";
    $("#registerForm").hidden = which !== "register";
    $("#recoverForm").hidden = which !== "recover";
    ["#loginMsg", "#registerMsg", "#recoverMsg"].forEach((s) => msg(s, ""));
    const first = { login: "#loginUser", register: "#regNama", recover: "#newPass" }[which];
    setTimeout(() => $(first)?.focus(), 0);
  }

  function msg(sel, text, kind = "err") {
    const el = $(sel);
    el.textContent = text || "";
    el.className = `auth-msg ${text ? kind : ""}`;
  }

  function authError(err) {
    const m = (err && (err.message || err.error_description)) || String(err);
    if (/invalid login credentials/i.test(m)) return "Username/email atau password salah.";
    if (/email not confirmed/i.test(m)) return "Email belum dikonfirmasi. Buka link konfirmasi di inbox Anda.";
    if (/already registered|already exists/i.test(m)) return "Email ini sudah terdaftar. Silakan Sign in.";
    if (/password should be at least/i.test(m)) return "Password terlalu pendek.";
    if (/rate limit|too many/i.test(m)) return "Terlalu banyak percobaan. Coba lagi beberapa menit lagi.";
    if (/failed to fetch|network/i.test(m)) return "Tidak bisa terhubung ke server. Periksa koneksi internet.";
    return m;
  }

  const toEmail = (u) => {
    const v = u.trim().toLowerCase();
    return v.includes("@") ? v : `${v}@${CFG.USERNAME_DOMAIN}`;
  };

  async function onSession(session) {
    const uid = session?.user?.id || null;
    if (!uid) {
      sessionUserId = null; me = null;
      showScreen("auth"); showAuthForm("login");
      return;
    }
    if (uid === sessionUserId && me) return;
    sessionUserId = uid;
    const { data: prof, error } = await sb.from("profiles").select("*").eq("id", uid).maybeSingle();
    if (error || !prof) {
      me = null;
      setPending("Profil belum tersedia", error ? authError(error) : "Profil akun belum dibuat. Hubungi admin.");
      return;
    }
    if (prof.status !== "approved") {
      me = null;
      if (prof.status === "rejected") setPending("Akun ditolak", "Pendaftaran akun ini tidak disetujui admin. Hubungi admin bila ini keliru.");
      else setPending("Menunggu persetujuan admin", `Halo ${prof.nama}, akun Anda sudah terdaftar. Admin perlu menyetujui akun ini sebelum Anda bisa melihat data.`);
      return;
    }
    me = prof;
    $("#who").textContent = `${me.nama}${me.role === "admin" ? " · admin" : ""}`;
    $("#btnUsers").hidden = me.role !== "admin";
    showScreen("app");
    await load();
    if (me.role === "admin") {
      refreshPendingCount();
      clearInterval(pendingTimer);
      pendingTimer = setInterval(refreshPendingCount, 60000);
    }
  }

  function setPending(title, text) {
    $("#pendingTitle").textContent = title;
    $("#pendingText").textContent = text;
    showScreen("pending");
  }

  function bindAuth() {
    $$("[data-goto]").forEach((b) => b.addEventListener("click", () => showAuthForm(b.dataset.goto)));
    $$("[data-toggle]").forEach((b) => b.addEventListener("click", () => {
      const inp = $(`#${b.dataset.toggle}`);
      const show = inp.type === "password";
      inp.type = show ? "text" : "password";
      b.textContent = show ? "HIDE" : "SHOW";
    }));
    $("#remember").checked = remember();

    $("#loginForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const user = $("#loginUser").value, pass = $("#loginPass").value;
      if (!user.trim() || !pass) return msg("#loginMsg", "Isi username/email dan password.");
      try { localStorage.setItem(REMEMBER_KEY, $("#remember").checked ? "1" : "0"); } catch (_) { /* abaikan */ }
      const btn = $("#loginForm button[type=submit]"); btn.disabled = true;
      msg("#loginMsg", "");
      const { data, error } = await sb.auth.signInWithPassword({ email: toEmail(user), password: pass });
      btn.disabled = false;
      if (error) return msg("#loginMsg", authError(error));
      $("#loginPass").value = "";
      await onSession(data.session);
    });

    $("#btnForgot").addEventListener("click", async () => {
      const u = $("#loginUser").value.trim();
      if (!u || !u.includes("@")) return msg("#loginMsg", "Ketik email Anda di kolom Username / Email, lalu klik Lupa password. Akun username (mis. admin) direset oleh admin.");
      const { error } = await sb.auth.resetPasswordForEmail(u, { redirectTo: location.origin + location.pathname });
      if (error) return msg("#loginMsg", authError(error));
      msg("#loginMsg", "Link reset password sudah dikirim ke email Anda.", "ok");
    });

    $("#registerForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const nama = $("#regNama").value.trim();
      const email = $("#regEmail").value.trim().toLowerCase();
      const telepon = $("#regTelp").value.trim().replace(/\s+/g, " ");
      const telDigits = telepon.replace(/\D/g, "");
      const p1 = $("#regPass").value, p2 = $("#regPass2").value;
      if (!nama || !email || !telepon || !p1) return msg("#registerMsg", "Semua kolom wajib diisi.");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.endsWith(`@${CFG.USERNAME_DOMAIN}`)) return msg("#registerMsg", "Format email tidak valid.");
      if (!/^[+0-9][0-9\s().-]*$/.test(telepon) || telDigits.length < 8 || telDigits.length > 15) return msg("#registerMsg", "Nomor telepon tidak valid. Contoh: 0812 3456 7890 atau +62 812 3456 7890.");
      if (p1.length < 6) return msg("#registerMsg", "Password minimal 6 karakter.");
      if (p1 !== p2) return msg("#registerMsg", "Ulangi password tidak sama.");
      const btn = $("#registerForm button[type=submit]"); btn.disabled = true;
      const { data, error } = await sb.auth.signUp({
        email, password: p1,
        options: { data: { nama, telepon }, emailRedirectTo: location.origin + location.pathname },
      });
      btn.disabled = false;
      if (error) return msg("#registerMsg", authError(error));
      $("#registerForm").reset();
      if (data.session) return onSession(data.session);
      showAuthForm("login");
      $("#loginUser").value = email;
      msg("#loginMsg", "Pendaftaran berhasil. Akun Anda menunggu persetujuan admin. Setelah disetujui, Anda bisa langsung Sign in dengan email & password ini.", "ok");
    });

    $("#recoverForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const p = $("#newPass").value;
      if (p.length < 6) return msg("#recoverMsg", "Password minimal 6 karakter.");
      const { error } = await sb.auth.updateUser({ password: p });
      if (error) return msg("#recoverMsg", authError(error));
      $("#newPass").value = "";
      const { data } = await sb.auth.getSession();
      sessionUserId = null;
      await onSession(data.session);
      toast("Password berhasil diganti.");
    });

    $$("[data-logout]").forEach((b) => b.addEventListener("click", async () => {
      await sb.auth.signOut();
      state.rows = [];
      onSession(null);
    }));
    $("#btnPendingRefresh").addEventListener("click", async () => {
      const { data } = await sb.auth.getSession();
      sessionUserId = null;
      onSession(data.session);
    });
  }

  // =====================================================================
  // DATA
  // =====================================================================
  async function fetchAll() {
    const out = [];
    const page = 1000;
    for (let from = 0; ; from += page) {
      const { data, error } = await sb.from(CFG.TABLE).select("*").order("id", { ascending: true }).range(from, from + page - 1);
      if (error) throw error;
      out.push(...data);
      if (data.length < page) return out;
    }
  }

  async function load() {
    $("#listing tbody").innerHTML = `<tr><td colspan="11" class="loading">Memuat data…</td></tr>`;
    try {
      const data = await fetchAll();
      state.rows = data.map(enrich);
      $("#asOf").textContent = `${state.rows.length} PO · Supabase · dimuat ${fmtDateTime(new Date().toISOString())}`;
      buildOptions();
      render();
      const late = state.rows.filter((r) => r.kirim === "late").length;
      const today = state.rows.filter((r) => r.kirim === "today").length;
      if (late || today) toast(`🚚 ${late} PO terlambat kirim, ${today} PO harus dikirim hari ini.`, late ? "err" : "");
    } catch (err) {
      $("#listing tbody").innerHTML = `<tr><td colspan="11"><div class="error">Gagal memuat data: ${esc(authError(err))}</div></td></tr>`;
    }
  }

  const blank = (v) => v == null || !String(v).trim();
  const has = (v, re) => !blank(v) && re.test(v);

  // ATURAN status = sama dengan rumus tab "Selling PO - Aktif" di Google Sheet:
  //  - lengkap  : No PO, COS, dan No. GP terisi
  //  - aktif    : (No PO atau Customer terisi) DAN (Ceklis Selesai belum dicentang ATAU belum lengkap)
  //  - merah    : dicentang tapi belum lengkap
  //  - kuning   : progres mengandung "perlu cek"
  // REMINDER kirim: semua PO yang Ceklis Selesai belum dicentang (dan tidak canceled),
  //  dihitung dari Target kirim: terlambat / hari ini / H-1..H-3 / > H-3 / belum ada target.
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

    const today = startOfToday();
    const d = r.request_date ? new Date(r.request_date + "T00:00:00") : null;
    const age = aktif && d ? Math.floor((today - d) / DAY) : null;
    const month = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}` : "";

    const autoTarget = r.request_date ? addWorkdays(r.request_date, SLA_HARI_KERJA) : null;
    const target = r.target_kirim || autoTarget;
    const targetAuto = !r.target_kirim && !!autoTarget;
    const tunda = !blank(r.alasan_tunda);
    let kirim = "", sisa = null;
    if (listed && !r.selesai && !canceled) {
      if (!target) kirim = "none";
      else {
        sisa = Math.round((new Date(target + "T00:00:00") - today) / DAY);
        kirim = sisa < 0 ? "late" : sisa === 0 ? "today" : sisa <= 3 ? "soon" : "later";
      }
    }

    let tone = "";
    if (ditolak) tone = "row-red";
    else if (aktif && cek) tone = "row-yellow";

    const hay = [r.request_by, r.no_po, r.customer, r.project, r.details, r.cos, r.posting_cos, r.no_gp, r.progres, r.notes, status,
      target ? fmtDate(target) : "", r.alasan_tunda]
      .filter(Boolean).join(" \u0001 ").toLowerCase();

    const nilai = r.nilai_po == null || r.nilai_po === "" ? null : Number(r.nilai_po);
    return { ...r, nilai_po: nilai, status, aktif, ditolak, noPo, noCos, noPosting, noGp, cek, cekNote, indent, canceled, age, month, kirim, sisa, target, targetAuto, autoTarget, tunda, tone, hay, _d: d };
  }

  function startOfToday() { const t = new Date(); t.setHours(0, 0, 0, 0); return t; }

  // Tambah n hari kerja (lewati Sabtu & Minggu). Libur nasional belum dihitung.
  function addWorkdays(iso, n) {
    const d = new Date(iso + "T00:00:00");
    let left = n;
    while (left > 0) {
      d.setDate(d.getDate() + 1);
      const w = d.getDay();
      if (w !== 0 && w !== 6) left--;
    }
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function kirimText(r) {
    if (!r.kirim) return "";
    if (r.kirim === "none") return "Tanpa Request date";
    if (r.kirim === "late") return `Terlambat ${-r.sisa} hr`;
    if (r.kirim === "today") return "Hari ini";
    return `H-${r.sisa}`;
  }
  function kirimBadge(r) {
    if (!r.kirim) return "";
    if (r.kirim === "later") return `<span class="badge b-blue">H-${r.sisa}</span>`;
    return `<span class="badge ${KIRIM[r.kirim].badge}">${kirimText(r)}</span>`;
  }

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
      if (state.kirim === "tunda" ? !(r.kirim && r.tunda) : state.kirim && r.kirim !== state.kirim) return false;
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
      if (key === "nilai_po") return r.nilai_po ?? -1;
      if (key === "target") return r.target ?? "";
      return (r[key] ?? "").toString().toLowerCase();
    };
    return [...rows].sort((a, b) => {
      const x = val(a), y = val(b);
      if (x === y) return (a.id - b.id) * m;
      if (x === "" || x == null) return 1;
      if (y === "" || y == null) return -1;
      return (x > y ? 1 : -1) * m;
    });
  }

  // =====================================================================
  // RENDER
  // =====================================================================
  function render() {
    const rows = filtered();
    renderKpis();
    renderReminder();
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
    const all = state.rows;
    const aktif = all.filter((r) => r.aktif);
    const aktifCust = aktif.filter((r) => !blank(r.customer));
    const k = [
      { key: "aktif", label: "Total aktif", value: aktifCust.length, accent: "#1f5eff" },
      { key: "noCos", label: "Belum ada COS", value: aktifCust.filter((r) => r.noCos).length, accent: "#d9730d" },
      { key: "noPosting", label: "Belum posting COS", value: aktifCust.filter((r) => r.noPosting).length, accent: "#f2a541" },
      { key: "noGp", label: "Belum ada No. GP", value: aktifCust.filter((r) => r.noGp).length, accent: "#e8890c" },
      { key: "cek", label: "Perlu cek", value: aktif.filter((r) => r.cek).length, accent: "#a68a00" },
      { key: "red", label: "Dicentang blm lengkap", value: all.filter((r) => r.ditolak).length, accent: "#c62828" },
      { key: "old", label: "Umur > 30 hari", value: aktif.filter((r) => r.age != null && r.age > 30).length, accent: "#8b1d1d" },
      { key: "all", label: "Total PO", value: all.length, accent: "#5f6b7a" },
      { key: "nilai", label: "Nilai PO aktif (Rp)", value: fmtRpShort(sumNilai(aktifCust)).replace(/^Rp /, ""), title: `Total nilai PO aktif: ${fmtRp(sumNilai(aktifCust))} (${aktifCust.filter((r) => r.nilai_po != null).length} dari ${aktifCust.length} PO sudah ada nilainya)`, accent: "#0e9aa7" },
    ];
    const activeKey = currentKpiKey();
    $("#kpis").innerHTML = k.map((x) => `
      <button class="kpi ${activeKey === x.key ? "active" : ""}" data-kpi="${x.key}" style="--accent:${x.accent}" title="${esc(x.title || x.label)}">
        <div class="label">${x.label}</div>
        <div class="value">${x.value}</div>
      </button>`).join("");
  }

  function currentKpiKey() {
    const f = [...state.flags];
    const noOther = !state.by && !state.customer && !state.month && !state.q && !state.from && !state.to && !state.kirim;
    if (!noOther) return "";
    if (state.view === "all" && !f.length && state.status === "Dicentang belum lengkap") return "red";
    if (state.status) return "";
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
    else if (key === "nilai") { state.view = "aktif"; state.sort = { key: "nilai_po", dir: "desc" }; }
    else { state.view = "aktif"; state.flags.add(key); }
    state.tab = "list";
    render();
  }

  // ---------- Reminder pengiriman ----------
  function renderReminder() {
    const open = state.rows.filter((r) => r.kirim);
    const count = (k) => (k === "tunda" ? open.filter((r) => r.tunda).length : open.filter((r) => r.kirim === k).length);
    $("#remTiles").innerHTML = ["late", "today", "soon", "tunda"].map((k) => `
      <button class="rem-tile ${state.kirim === k ? "on" : ""}" data-kirim="${k}" style="--c:${KIRIM[k].color}">
        <div class="n">${count(k)}</div><div class="t">${KIRIM[k].label}</div>
      </button>`).join("");

    const urgent = open.filter((r) => ["late", "today", "soon"].includes(r.kirim)).sort((a, b) => a.sisa - b.sisa || a.id - b.id);
    const later = open.filter((r) => r.kirim === "later").sort((a, b) => a.sisa - b.sisa);
    const item = (r) => {
      const c = r.kirim === "later" ? "#1f5eff" : KIRIM[r.kirim].color;
      return `<button class="rem-item" data-id="${r.id}" style="--c:${c}">
        <div class="top"><span class="po">${esc(r.no_po || "No PO belum ada")}</span>${kirimBadge(r)}</div>
        <div class="cust">${esc(r.customer || "–")}${r.project ? ` · ${esc(r.project)}` : ""}</div>
        <div class="cust">Target: ${r.target ? fmtDate(r.target) : "–"}${r.targetAuto ? " (otomatis)" : ""} · ${esc(r.status)}</div>
        ${r.tunda ? `<div class="cust tunda">⏸ ${esc(r.alasan_tunda)}</div>` : ""}
      </button>`;
    };
    let html = "";
    if (urgent.length) html += `<div class="rem-group">Perlu tindakan (${urgent.length})</div>` + urgent.map(item).join("");
    if (later.length) html += `<div class="rem-group">Terjadwal (${later.length})</div>` + later.slice(0, 15).map(item).join("");
    const none = count("none");
    if (none) html += `<div class="rem-empty">${none} PO aktif belum punya Request date, jadi target kirim tidak bisa dihitung. Lengkapi lewat ✎ Edit.</div>`;
    if (!open.length) html = `<div class="rem-empty">Tidak ada PO yang menunggu pengiriman. 🎉</div>`;
    $("#remList").innerHTML = html;
  }

  // ---------- Charts ----------
  function donut(el, items, { total, centerLabel, onPick, selected }) {
    const size = 116, r = 44, w = 18, c = size / 2;
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
    if (onPick) $$("[data-i]", el).forEach((n) => n.addEventListener("click", () => onPick(items[+n.dataset.i])));
  }

  function renderStatusChart(rows) {
    const counts = countBy(rows, (r) => r.status);
    const items = Object.keys(STATUS).filter((k) => counts[k]).map((k) => ({ key: k, label: k, value: counts[k], color: STATUS[k].color }));
    donut($("#chartStatus"), items, {
      centerLabel: "PO", selected: state.status,
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
      centerLabel: "PO", selected: state.by,
      onPick: (it) => { if (it.key === "__rest") return; state.by = state.by === it.key ? "" : it.key; render(); },
    });
  }

  function renderDocsChart(rows) {
    const aktif = rows.filter((r) => r.aktif);
    donut($("#chartDocs"), [
      { key: "ok", label: "COS & No. GP lengkap", value: aktif.filter((r) => !r.noCos && !r.noGp).length, color: "#1e8e4f" },
      { key: "noCos", label: "Belum ada COS", value: aktif.filter((r) => r.noCos).length, color: "#d9730d" },
      { key: "noGp", label: "COS ada, No. GP belum", value: aktif.filter((r) => !r.noCos && r.noGp).length, color: "#f2a541" },
    ], {
      centerLabel: "aktif",
      selected: [...state.flags].find((f) => f === "noCos" || f === "noGp") || "",
      onPick: (it) => { state.flags.delete("noCos"); state.flags.delete("noGp"); if (it.key !== "ok") state.flags.add(it.key); render(); },
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
        <div class="stack" style="height:${Math.max(4, h)}px"><div class="seg-done" style="flex:${done}"></div><div class="seg-open" style="flex:${open}"></div></div>
        <span class="m">${MONTHS[+m - 1]} ${y.slice(2)}</span>
      </div>`;
    }).join("");
    if (!$("#barsLegend")) {
      el.insertAdjacentHTML("afterend", `<div class="bars-legend" id="barsLegend"><span><i style="background:#d9730d"></i>Aktif</span><span><i style="background:#9db7ff"></i>Selesai / canceled</span></div>`);
    }
    $$(".bar", el).forEach((b) => b.addEventListener("click", () => { state.month = state.month === b.dataset.m ? "" : b.dataset.m; render(); }));
  }

  function renderSummary(rows) {
    const groups = {};
    rows.forEach((r) => {
      const k = r.request_by || "(kosong)";
      groups[k] ??= { total: 0, aktif: 0, selesai: 0, noCos: 0, noGp: 0, late: 0, nilai: 0, ages: [] };
      const g = groups[k];
      g.total++;
      if (r.aktif) g.aktif++;
      if (r.status === "Selesai") g.selesai++;
      if (r.aktif && r.noCos) g.noCos++;
      if (r.aktif && r.noGp) g.noGp++;
      if (r.kirim === "late") g.late++;
      if (r.nilai_po != null) g.nilai += r.nilai_po;
      if (r.age != null) g.ages.push(r.age);
    });
    const list = Object.entries(groups).sort((a, b) => b[1].aktif - a[1].aktif || b[1].total - a[1].total);
    const maxAktif = Math.max(1, ...list.map(([, g]) => g.aktif));
    const tot = list.reduce((t, [, g]) => {
      ["total", "aktif", "selesai", "noCos", "noGp", "late", "nilai"].forEach((f) => (t[f] += g[f]));
      t.ages.push(...g.ages);
      return t;
    }, { total: 0, aktif: 0, selesai: 0, noCos: 0, noGp: 0, late: 0, nilai: 0, ages: [] });
    const avg = (a) => (a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : "–");
    const mx = (a) => (a.length ? Math.max(...a) : "–");
    const hr = (a) => (a.length ? " hr" : "");

    $("#summaryTable").innerHTML = `
      <thead><tr>
        <th>Request by</th><th class="num">Total</th><th class="num">Aktif</th><th class="num">Selesai</th>
        <th class="num">Belum COS</th><th class="num">Belum GP</th><th class="num">Terlambat kirim</th><th class="num">Nilai PO</th>
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
          <td class="num ${g.late ? "missing" : ""}">${g.late}</td>
          <td class="num" title="${fmtRp(g.nilai)}">${g.nilai ? fmtRpShort(g.nilai) : "–"}</td>
          <td class="num">${avg(g.ages)}${hr(g.ages)}</td>
          <td class="num">${mx(g.ages)}${hr(g.ages)}</td>
        </tr>`).join("")}
      </tbody>
      <tfoot><tr>
        <td>Total</td><td class="num">${tot.total}</td><td class="num">${tot.aktif}</td><td class="num">${tot.selesai}</td>
        <td class="num">${tot.noCos}</td><td class="num">${tot.noGp}</td><td class="num">${tot.late}</td><td class="num" title="${fmtRp(tot.nilai)}">${tot.nilai ? fmtRpShort(tot.nilai) : "–"}</td>
        <td class="num">${avg(tot.ages)}${hr(tot.ages)}</td><td class="num">${mx(tot.ages)}${hr(tot.ages)}</td>
      </tr></tfoot>`;
    $$("#summaryTable tbody tr").forEach((tr) => tr.addEventListener("click", () => {
      state.by = state.by === tr.dataset.by ? "" : tr.dataset.by; render();
    }));
  }

  const ICON = {
    view: `<svg viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>`,
    edit: `<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
    del: `<svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>`,
  };
  const dash = `<span class="muted">–</span>`;

  function renderTable(rows) {
    const tot = sumNilai(rows);
    $("#rowCount").textContent = `(${rows.length}${tot ? ` · ${fmtRpShort(tot)}` : ""})`;
    $("#rowCount").title = tot ? `Total nilai PO sesuai filter: ${fmtRp(tot)}` : "";
    $("#empty").hidden = rows.length > 0;
    const isAdmin = me?.role === "admin";
    $("#listing tbody").innerHTML = rows.map((r) => {
      const tags = [
        r.indent ? `<span class="badge b-purple">Indent</span>` : "",
        r.cek || r.cekNote ? `<span class="badge b-yellow">Perlu cek</span>` : "",
      ].join("");
      const prog = [r.progres, r.notes].filter((v) => !blank(v)).join(" · ");
      const docOrange = r.aktif && (r.noCos || r.noGp || r.noPosting);
      return `<tr class="${r.tone}" data-id="${r.id}">
        <td>${r.request_date ? fmtDateShort(r.request_date) : `<span class="missing">–</span>`}</td>
        <td><span class="ell" title="${esc(r.request_by)}">${blank(r.request_by) ? dash : esc(r.request_by)}</span></td>
        <td class="po"><span class="ell" title="${esc(r.no_po)}">${r.noPo ? `<span class="missing">Belum ada</span>` : esc(r.no_po)}</span></td>
        <td><span class="ell" title="${esc(r.customer)}">${blank(r.customer) ? dash : esc(r.customer)}</span>
            <span class="ell sub2" title="${esc(r.project)}">${esc(r.project || "")}</span></td>
        <td class="num" title="${r.nilai_po != null ? fmtRp(r.nilai_po) : "Nilai PO belum diisi"}">${r.nilai_po != null ? fmtNum(r.nilai_po) : dash}</td>
        <td class="${docOrange ? "cell-orange" : ""}">
            <span class="ell" title="COS ${esc(r.cos)}${r.posting_cos ? ` · posting ${esc(r.posting_cos)}` : ""}">${r.noCos ? `<span class="missing">COS belum</span>` : esc(r.cos)}</span>
            <span class="ell sub2" title="No. GP ${esc(r.no_gp)}">${r.noGp ? `<span class="missing">GP belum</span>` : `GP ${esc(r.no_gp)}`}</span></td>
        <td class="c-prog"><div class="clip2" title="${esc(prog)}">${prog ? esc(prog) : dash}</div></td>
        <td title="${r.targetAuto ? `Otomatis: Request date + ${SLA_HARI_KERJA} hari kerja` : r.tunda ? `Ditunda: ${esc(r.alasan_tunda)}` : "Target manual"}">${r.target ? fmtDateShort(r.target) : dash}${r.targetAuto ? `<span class="sub2"> auto</span>` : ""}${r.kirim ? `<div>${kirimBadge(r)}${r.tunda ? ` <span class="badge b-purple">Ditunda</span>` : ""}</div>` : ""}</td>
        <td><span class="badge ${STATUS[r.status].badge}">${r.status}</span>${tags ? `<div class="tags">${tags}</div>` : ""}</td>
        <td class="num ${r.age > 30 ? "age-old" : ""}">${r.age != null ? `${r.age}hr` : dash}</td>
        <td class="no-print"><div class="acts">
          <button class="act view" data-act="view" title="View">${ICON.view}</button>
          <button class="act edit" data-act="edit" title="Edit">${ICON.edit}</button>
          ${isAdmin ? `<button class="act del" data-act="del" title="Hapus">${ICON.del}</button>` : ""}
        </div></td>
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
    if (state.kirim) parts.push(`Kirim: ${KIRIM[state.kirim].label}`);
    const flagNames = { noCos: "Belum ada COS", noPosting: "Belum posting COS", noGp: "Belum ada No. GP", indent: "Unit indent", cek: "Perlu cek", old: "Umur > 30 hari" };
    state.flags.forEach((f) => parts.push(flagNames[f]));
    if (state.q) parts.push(`Cari: "${state.q}"`);
    $("#printMeta").textContent = `${parts.join(" · ")} — ${rows.length} PO · dicetak ${fmtDateTime(new Date().toISOString())}`;
  }

  // =====================================================================
  // CONTROLS
  // =====================================================================
  function buildOptions() {
    const uniq = (f) => [...new Set(state.rows.map(f).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    fill("#fStatus", Object.keys(STATUS), "Semua status");
    fill("#fBy", uniq((r) => r.request_by || "(kosong)"), "Semua request by");
    fill("#fCustomer", uniq((r) => r.customer), "Semua customer");
    const months = [...new Set(state.rows.map((r) => r.month).filter(Boolean))].sort().reverse();
    $("#fMonth").innerHTML = `<option value="">Semua bulan</option>` +
      months.map((m) => { const [y, mm] = m.split("-"); return `<option value="${m}">${MONTHS[+mm - 1]} ${y}</option>`; }).join("");
    $("#dlBy").innerHTML = uniq((r) => r.request_by).map((v) => `<option value="${esc(v)}">`).join("");
    $("#dlCustomer").innerHTML = uniq((r) => r.customer).map((v) => `<option value="${esc(v)}">`).join("");
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
    $$(".tab").forEach((t) => t.classList.toggle("on", t.dataset.tab === state.tab));
    $("#paneList").hidden = state.tab !== "list";
    $("#paneAnalytics").hidden = state.tab !== "analytics";
    $("#legendList").hidden = state.tab !== "list";
    saveState();
  }

  function resetFilters(doRender = true) {
    Object.assign(state, { view: "aktif", q: "", status: "", by: "", customer: "", month: "", from: "", to: "", kirim: "" });
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
    $$(".tab").forEach((tb) => tb.addEventListener("click", () => { state.tab = tb.dataset.tab; render(); }));

    $("#remTiles").addEventListener("click", (e) => {
      const k = e.target.closest("[data-kirim]"); if (!k) return;
      const v = k.dataset.kirim;
      state.kirim = state.kirim === v ? "" : v;
      if (state.kirim) { state.view = "aktif"; state.status = ""; state.tab = "list"; state.sort = { key: "target", dir: "asc" }; }
      render();
    });
    $("#remList").addEventListener("click", (e) => { const it = e.target.closest("[data-id]"); if (it) openDrawer(+it.dataset.id); });

    $$("#listing thead th[data-sort]").forEach((th) => th.addEventListener("click", () => {
      const key = th.dataset.sort;
      state.sort = { key, dir: state.sort.key === key && state.sort.dir === "asc" ? "desc" : "asc" };
      renderTable(sorted(filtered()));
      saveState();
    }));
    $("#listing tbody").addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-id]"); if (!tr) return;
      const id = +tr.dataset.id;
      const act = e.target.closest("[data-act]")?.dataset.act || "view";
      if (act === "edit") openForm(id);
      else if (act === "del") deletePo(id);
      else openDrawer(id);
    });

    $("#drawer").addEventListener("click", (e) => { if (e.target.id === "drawer") closeDrawer(); });
    $("#drawerClose").addEventListener("click", closeDrawer);
    $("#drawerBody").addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]"); if (!b) return;
      const id = +b.dataset.id;
      closeDrawer();
      if (b.dataset.act === "edit") openForm(id); else deletePo(id);
    });

    $$(".modal").forEach((m) => {
      m.addEventListener("click", (e) => { if (e.target === m || e.target.closest("[data-close]")) m.hidden = true; });
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { closeDrawer(); $$(".modal").forEach((m) => (m.hidden = true)); }
      const tag = document.activeElement?.tagName;
      if (e.key === "/" && !$("#app").hidden && !["INPUT", "TEXTAREA", "SELECT"].includes(tag)) { e.preventDefault(); $("#q").focus(); }
    });

    $("#btnAdd").addEventListener("click", () => openForm(null));
    $("#poForm").addEventListener("submit", savePo);
    $("#btnPrint").addEventListener("click", () => { renderPrintMeta(filtered()); window.print(); });
    $("#btnCsv").addEventListener("click", exportCsv);
    $("#btnRefresh").addEventListener("click", load);
    $("#btnUsers").addEventListener("click", openUsers);
    $("#pendingBannerBtn").addEventListener("click", openUsers);
    $("#usersTable").addEventListener("click", onUserAction);
  }

  // ---------- View ----------
  function openDrawer(id) {
    const r = state.rows.find((x) => x.id === id);
    if (!r) return;
    const f = (label, v) => `<dt>${label}</dt><dd>${blank(v) ? dash : esc(v)}</dd>`;
    $("#drawerBody").innerHTML = `
      <h2>${esc(r.no_po || "No PO belum ada")}</h2>
      <span class="badge ${STATUS[r.status].badge}">${r.status}</span>
      ${kirimBadge(r)}
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
        ${f("Nilai PO", r.nilai_po != null ? fmtRp(r.nilai_po) : "")}
        ${f("Target kirim", r.target ? `${fmtDate(r.target)}${r.targetAuto ? ` (otomatis, ${SLA_HARI_KERJA} hari kerja)` : " (manual)"}${r.kirim ? ` · ${kirimText(r)}` : ""}` : "")}
        ${f("Alasan belum bisa kirim", r.alasan_tunda)}
        ${f("Progres / Unit indent", r.progres)}
        ${f("Notes", r.notes)}
        ${f("Ceklis Selesai", r.selesai ? "✔ Selesai (dicentang)" : "Belum")}
        ${f("Umur PO", r.age != null ? `${r.age} hari` : "")}
        ${f("Terakhir diubah", fmtDateTime(r.updated_at))}
      </dl>
      <div class="drawer-actions">
        <button class="btn primary" data-act="edit" data-id="${r.id}">✎ Edit</button>
        ${me?.role === "admin" ? `<button class="btn danger" data-act="del" data-id="${r.id}">🗑 Hapus</button>` : ""}
      </div>`;
    $("#drawer").classList.add("open");
    $("#drawer").setAttribute("aria-hidden", "false");
  }
  function closeDrawer() { $("#drawer").classList.remove("open"); $("#drawer").setAttribute("aria-hidden", "true"); }

  // ---------- Tambah / Edit ----------
  function openForm(id) {
    editingId = id;
    const r = id ? state.rows.find((x) => x.id === id) : null;
    const form = $("#poForm");
    form.reset();
    FIELDS.forEach((k) => {
      const el = form.elements[k];
      if (!el) return;
      if (el.type === "checkbox") el.checked = !!r?.[k];
      else if (k === "nilai_po") el.value = r?.nilai_po != null ? fmtNum(r.nilai_po) : "";
      else el.value = r ? (r[k] ?? "") : (k === "request_date" ? isoToday() : "");
    });
    $("#poModalTitle").textContent = r ? `Edit PO ${r.no_po || ""}`.trim() : "Tambah PO";
    msg("#poMsg", "");
    $("#poModal").hidden = false;
    setTimeout(() => form.elements[r ? "target_kirim" : "no_po"].focus(), 0);
  }

  async function savePo(e) {
    e.preventDefault();
    const form = $("#poForm");
    const rec = {};
    FIELDS.forEach((k) => {
      const el = form.elements[k];
      if (el.type === "checkbox") rec[k] = el.checked;
      else { const v = el.value.trim(); rec[k] = v === "" ? null : v; }
    });
    if (!rec.no_po && !rec.customer) return msg("#poMsg", "Isi minimal No PO atau Customer.");
    if (rec.nilai_po != null) {
      const n = parseNilai(rec.nilai_po);
      if (n == null) return msg("#poMsg", "Nilai PO tidak valid. Contoh: 12.500.000 atau 12,5 jt.");
      rec.nilai_po = n;
    }
    const auto = rec.request_date ? addWorkdays(rec.request_date, SLA_HARI_KERJA) : null;
    if (rec.target_kirim && auto && rec.target_kirim > auto && !rec.alasan_tunda) {
      return msg("#poMsg", `Target kirim melewati ${SLA_HARI_KERJA} hari kerja (maks. ${fmtDate(auto)}). Isi "Alasan belum bisa dikirim".`);
    }
    if (rec.selesai && (!rec.no_po || !rec.cos || !rec.no_gp)) {
      if (!confirm("No PO / COS / No. GP belum lengkap. Tetap centang Selesai? (PO akan tampil merah: Dicentang belum lengkap)")) return;
    }
    const btn = $("#poSave"); btn.disabled = true;
    const wasEdit = !!editingId;
    const q = wasEdit
      ? sb.from(CFG.TABLE).update(rec).eq("id", editingId).select().single()
      : sb.from(CFG.TABLE).insert(rec).select().single();
    const { data, error } = await q;
    btn.disabled = false;
    if (error) return msg("#poMsg", `Gagal menyimpan: ${authError(error)}`);
    const row = enrich(data);
    const i = state.rows.findIndex((x) => x.id === row.id);
    if (i >= 0) state.rows[i] = row; else state.rows.push(row);
    $("#poModal").hidden = true;
    buildOptions();
    render();
    toast(wasEdit ? "PO berhasil diperbarui." : "PO baru berhasil ditambahkan.");
  }

  async function deletePo(id) {
    const r = state.rows.find((x) => x.id === id);
    if (!r || me?.role !== "admin") return;
    if (!confirm(`Hapus PO ${r.no_po || "(tanpa No PO)"} – ${r.customer || ""}?\nData yang dihapus tidak bisa dikembalikan.`)) return;
    const { data, error } = await sb.from(CFG.TABLE).delete().eq("id", id).select("id");
    if (error) return toast(`Gagal menghapus: ${authError(error)}`, "err");
    if (!data?.length) return toast("PO tidak terhapus (tidak ada izin atau sudah dihapus).", "err");
    state.rows = state.rows.filter((x) => x.id !== id);
    buildOptions();
    render();
    toast("PO dihapus.");
  }

  // ---------- Pengguna (admin) ----------
  let pendingTimer;
  async function refreshPendingCount() {
    if (me?.role !== "admin") return;
    const { count } = await sb.from("profiles").select("id", { count: "exact", head: true }).eq("status", "pending");
    $("#pendingCount").hidden = !count;
    $("#pendingCount").textContent = count || "";
    $("#pendingBanner").hidden = !count;
    $("#pendingBannerText").textContent = count ? `${count} akun baru menunggu persetujuan Anda.` : "";
  }

  async function openUsers() {
    $("#usersModal").hidden = false;
    $("#usersTable").innerHTML = `<tbody><tr><td class="loading">Memuat…</td></tr></tbody>`;
    const { data: rows, error } = await sb.from("profiles").select("*").order("created_at", { ascending: false });
    const order = { pending: 0, approved: 1, rejected: 2 };
    const data = (rows || []).sort((a, b) => order[a.status] - order[b.status]);
    if (error) { $("#usersTable").innerHTML = `<tbody><tr><td><div class="error">${esc(authError(error))}</div></td></tr></tbody>`; return; }
    const st = { pending: "b-orange", approved: "b-green", rejected: "b-gray" };
    const stLabel = { pending: "Menunggu", approved: "Disetujui", rejected: "Ditolak" };
    $("#usersTable").innerHTML = `
      <thead><tr><th>Nama</th><th>Email / Username</th><th>Telepon</th><th>Daftar</th><th>Status</th><th>Peran</th><th>Aksi</th></tr></thead>
      <tbody>${data.map((u) => {
        const self = u.id === me.id;
        const btns = [];
        if (u.status !== "approved") btns.push(`<button class="btn primary" data-u="${u.id}" data-do="approve">✓ Approve</button>`);
        if (u.status !== "rejected" && !self) btns.push(`<button class="btn light" data-u="${u.id}" data-do="reject">✕ Tolak</button>`);
        if (u.status === "approved" && !self) btns.push(u.role === "admin"
          ? `<button class="btn light" data-u="${u.id}" data-do="user">Jadikan user</button>`
          : `<button class="btn light" data-u="${u.id}" data-do="admin">Jadikan admin</button>`);
        return `<tr class="${u.status === "pending" ? "row-yellow" : ""}">
          <td><strong>${esc(u.nama)}</strong>${self ? ` <span class="muted">(Anda)</span>` : ""}</td>
          <td>${esc(u.username || u.email)}</td>
          <td>${esc(u.telepon || "–")}</td>
          <td>${fmtDateTime(u.created_at)}</td>
          <td><span class="badge ${st[u.status]}">${stLabel[u.status]}</span></td>
          <td>${u.role === "admin" ? "Admin" : "User"}</td>
          <td><div class="acts">${btns.join("") || dash}</div></td>
        </tr>`;
      }).join("")}</tbody>`;
  }

  async function onUserAction(e) {
    const b = e.target.closest("[data-do]"); if (!b) return;
    if (b.dataset.do === "reject" && !confirm("Tolak akun ini? Pemilik akun tidak bisa masuk ke dashboard.")) return;
    b.disabled = true;
    const { error } = await sb.rpc("admin_set_user", { p_id: b.dataset.u, p_action: b.dataset.do });
    if (error) { b.disabled = false; return toast(`Gagal: ${authError(error)}`, "err"); }
    toast({ approve: "Akun disetujui. User sudah bisa Sign in.", reject: "Akun ditolak.", admin: "Akun dijadikan admin.", user: "Akun dijadikan user." }[b.dataset.do]);
    openUsers();
    refreshPendingCount();
  }

  // ---------- CSV ----------
  function exportCsv() {
    const rows = sorted(filtered());
    const cols = [
      ["request_date", "Request Date"], ["request_by", "Request by"], ["no_po", "No PO"], ["customer", "Customer"],
      ["project", "Project"], ["details", "Details"], ["cos", "COS"], ["posting_cos", "Nomor Posting COS"],
      ["no_gp", "No. GP"], ["target", "Target kirim"], ["targetSrc", "Sumber target"], ["kirimText", "Reminder kirim"], ["alasan_tunda", "Alasan belum bisa kirim"], ["nilai_po", "Nilai PO (Rp)"], ["progres", "Progres / Unit indent"], ["notes", "Notes"],
      ["selesai", "Selesai (Admin)"], ["status", "Status"], ["age", "Umur (hari)"],
    ];
    const q = (v) => { const s = v == null ? "" : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const val = (r, k) => (k === "selesai" ? (r.selesai ? "Ya" : "Tidak") : k === "kirimText" ? kirimText(r) : k === "targetSrc" ? (r.target ? (r.targetAuto ? "Otomatis 5 hari kerja" : "Manual") : "") : r[k]);
    const csv = [cols.map((c) => c[1]).join(","), ...rows.map((r) => cols.map(([k]) => q(val(r, k))).join(","))].join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `selling-po-${isoToday()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- Utils ----------
  let toastTimer;
  function toast(text, kind = "") {
    const el = $("#toast");
    el.textContent = text;
    el.className = `toast ${kind}`;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), kind === "err" ? 6000 : 3500);
  }
  function countBy(rows, f) { return rows.reduce((m, r) => { const k = f(r); m[k] = (m[k] || 0) + 1; return m; }, {}); }
  function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function sumNilai(rows) { return rows.reduce((s, r) => s + (r.nilai_po || 0), 0); }
  function fmtNum(n) { return Math.round(n).toLocaleString("id-ID"); }
  function fmtRp(n) { return `Rp ${(n || 0).toLocaleString("id-ID", { maximumFractionDigits: 2 })}`; }
  function fmtRpShort(n) {
    if (!n) return "Rp 0";
    const a = Math.abs(n);
    if (a >= 1e12) return `Rp ${(n / 1e12).toLocaleString("id-ID", { maximumFractionDigits: 2 })} T`;
    if (a >= 1e9) return `Rp ${(n / 1e9).toLocaleString("id-ID", { maximumFractionDigits: 2 })} M`;
    if (a >= 1e6) return `Rp ${(n / 1e6).toLocaleString("id-ID", { maximumFractionDigits: 1 })} jt`;
    return fmtRp(n);
  }
  // "Rp 12.500.000", "12,500,000.00", "12.500.000,50", "12,5 jt", "1,2 M" -> angka (sama dengan public.parse_nilai)
  function parseNilai(t) {
    let s = String(t).trim().toLowerCase().replace(/^(rp\.?|idr)\s*/, "");
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
  function isoToday() { const t = new Date(); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`; }
  function fmtDate(iso) { const [y, m, d] = iso.slice(0, 10).split("-"); return `${+d} ${MONTHS[+m - 1]} ${y}`; }
  function fmtDateShort(iso) { const [y, m, d] = iso.slice(0, 10).split("-"); return `${+d} ${MONTHS[+m - 1]} ${y.slice(2)}`; }
  function fmtDateTime(iso) {
    if (!iso) return "–";
    const d = new Date(iso);
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  function saveState() {
    try {
      localStorage.setItem("wm-selling-po", JSON.stringify({ ...state, rows: undefined, flags: [...state.flags] }));
    } catch (_) { /* abaikan */ }
  }
  function restoreState() {
    try {
      const s = JSON.parse(localStorage.getItem("wm-selling-po") || "null");
      if (!s) return;
      ["view", "status", "by", "customer", "month", "from", "to", "sort", "kirim", "tab"].forEach((k) => { if (s[k] !== undefined) state[k] = s[k]; });
      state.flags = new Set(s.flags || []);
    } catch (_) { /* abaikan */ }
  }

  // ---------- Start ----------
  restoreState();
  bindAuth();
  bind();
  sb.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") { showScreen("auth"); showAuthForm("recover"); return; }
    if (event === "SIGNED_OUT") { onSession(null); return; }
    if (event === "INITIAL_SESSION") setTimeout(() => onSession(session), 0);
  });
})();
