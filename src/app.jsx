const { useState, useEffect, useRef, useCallback, useMemo } = React;

/* ---------- constants & helpers ---------- */
const STORE_KEY = "weekly-habits:v1";
const BG_LOCAL_KEY = "weekly-habits:bg-local";
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const THEMES = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "dusk", label: "Dusk" },
  { id: "custom", label: "Custom" },
];
const CUSTOM_VARS = ["--bg", "--surface", "--surface-strong", "--ink", "--muted", "--line", "--accent", "--accent-ink", "--accent-soft"];

const defaultSettings = () => ({ theme: null, customColor: "#c8a96b", bgSource: "", bgUrl: "", bgAssetId: "", dim: 0.45 });
const defaultProfile = () => ({ name: "", photoSource: "", photoAssetId: "" });
const emptyState = () => ({ habits: [], checks: {}, settings: defaultSettings(), profile: defaultProfile() });

const pad = (n) => String(n).padStart(2, "0");
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const startOfWeek = (d) => {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
};
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const newId = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const clampTarget = (t) => { const n = Number(t); return Number.isFinite(n) ? Math.min(7, Math.max(1, Math.round(n))) : 7; };

function normalize(s) {
  const base = emptyState();
  if (!s || typeof s !== "object") return base;
  const habits = Array.isArray(s.habits)
    ? s.habits.filter((h) => h && h.id && typeof h.name === "string")
        .map((h) => ({ id: String(h.id), name: h.name.slice(0, 80), target: clampTarget(h.target), ...(typeof h.createdAt === "string" ? { createdAt: h.createdAt } : {}) }))
    : [];
  const checks = s.checks && typeof s.checks === "object" ? s.checks : {};
  const dim = Number(s.settings && s.settings.dim);
  const pr = s.profile && typeof s.profile === "object" ? s.profile : {};
  const profile = { name: typeof pr.name === "string" ? pr.name.slice(0, 40) : "", photoSource: pr.photoSource === "asset" || pr.photoSource === "local" ? pr.photoSource : "", photoAssetId: typeof pr.photoAssetId === "string" ? pr.photoAssetId : "" };
  return { habits, checks, profile, settings: { ...base.settings, ...(s.settings || {}), dim: Number.isFinite(dim) ? Math.min(0.85, Math.max(0, dim)) : base.settings.dim } };
}
function readLocal() {
  try { const raw = localStorage.getItem(STORE_KEY); return raw ? normalize(JSON.parse(raw)) : null; } catch { return null; }
}
function writeLocal(s) { try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch {} }
function readLocalBg() { try { return localStorage.getItem(BG_LOCAL_KEY) || ""; } catch { return ""; } }

async function getCapability(name) {
  try { return window.claude && typeof window.claude.use === "function" ? await window.claude.use(name) : null; }
  catch { return null; }
}

/* ---------- colour maths for the custom theme ---------- */
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return { r: 58, g: 134, b: 255 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function rgbToHue({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 0;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return Math.round((h * 60 + 360) % 360);
}
function luminance({ r, g, b }) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function customThemeVars(hex) {
  const rgb = hexToRgb(hex);
  const h = rgbToHue(rgb);
  const lum = luminance(rgb);
  const accentInk = lum > 0.33 ? "#101512" : "#ffffff";
  const soft = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.16)`;
  if (lum < 0.12) {
    // dark accent → light base so the accent stays visible
    return {
      "--bg": `hsl(${h} 30% 94%)`, "--surface": `hsla(${h}, 35%, 99%, 0.8)`, "--surface-strong": `hsla(${h}, 35%, 99%, 0.94)`,
      "--ink": `hsl(${h} 30% 12%)`, "--muted": `hsl(${h} 12% 36%)`, "--line": `hsla(${h}, 30%, 12%, 0.15)`,
      "--accent": hex, "--accent-ink": accentInk, "--accent-soft": soft,
    };
  }
  return {
    "--bg": `hsl(${h} 28% 11%)`, "--surface": `hsla(${h}, 26%, 15%, 0.78)`, "--surface-strong": `hsla(${h}, 26%, 14%, 0.95)`,
    "--ink": `hsl(${h} 25% 95%)`, "--muted": `hsl(${h} 14% 70%)`, "--line": `hsla(${h}, 25%, 95%, 0.14)`,
    "--accent": hex, "--accent-ink": accentInk, "--accent-soft": soft,
  };
}

/* ---------- storage hook: db when available, this device otherwise ---------- */
function useTrackerStore() {
  const [state, setState] = useState(() => readLocal() || emptyState());
  const [sync, setSync] = useState("connecting");
  const latest = useRef(state);
  const docRef = useRef(null);
  const dirty = useRef(false);
  const timer = useRef(null);
  const chain = useRef(Promise.resolve());
  const lastWritten = useRef(null);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    chain.current = chain.current.then(async () => {
      const ref = docRef.current;
      if (!ref) { dirty.current = false; return; }
      const snap = latest.current;
      if (snap === lastWritten.current) return;
      setSync("saving");
      const body = JSON.parse(JSON.stringify(snap));
      try {
        try { await ref.set(body); }
        catch (e) {
          if (e && e.code === "unavailable") {
            await new Promise((r) => setTimeout(r, 700 + Math.random() * 900));
            await ref.set(body);
          } else throw e;
        }
        lastWritten.current = snap;
        if (latest.current === snap) { dirty.current = false; setSync("synced"); }
      } catch (e) {
        if (latest.current === snap) dirty.current = false;
        setSync(e && e.code === "revoked" ? "local" : "error");
      }
    });
  }, []);

  useEffect(() => {
    let unsub = null, cancelled = false;
    (async () => {
      const db = await getCapability("db");
      if (cancelled) return;
      if (!db) { setSync("local"); return; }
      const ref = db.doc("tracker/main");
      docRef.current = ref;
      let first = true;
      unsub = ref.onSnapshot(
        (snap) => {
          if (dirty.current || snap.metadata.hasPendingWrites) return;
          if (snap.exists) {
            const next = normalize(snap.data());
            latest.current = next;
            lastWritten.current = next;
            setState(next);
            writeLocal(next);
          } else if (first && latest.current.habits.length) {
            // first visit with the shared store: carry over what this device already had
            dirty.current = true;
            flush();
          }
          first = false;
          if (!snap.metadata.fromCache) setSync("synced");
        },
        (err) => setSync(err && err.code === "revoked" ? "local" : "error")
      );
    })();
    const onHide = () => { if (dirty.current) flush(); };
    window.addEventListener("pagehide", onHide);
    return () => { cancelled = true; if (unsub) unsub(); window.removeEventListener("pagehide", onHide); };
  }, [flush]);

  const update = useCallback((fn) => {
    const next = fn(latest.current);
    if (next === latest.current) return;
    latest.current = next;
    setState(next);
    writeLocal(next);
    dirty.current = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 450);
  }, [flush]);

  return { state, update, sync };
}

/* ---------- small pieces ---------- */
const CheckIcon = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
    <path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const GearIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
    <circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
    <path d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2L5.5 5.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

const SYNC_TEXT = {
  connecting: "Loading…",
  saving: "Saving…",
  synced: "All changes saved",
  local: "Saved on this device",
  error: "Couldn't sync — changes kept on this device",
};

function formatRange(start) {
  const end = addDays(start, 6);
  const m = (d) => d.toLocaleDateString(undefined, { month: "long" });
  if (start.getMonth() === end.getMonth()) return `${start.getDate()}–${end.getDate()} ${m(end)} ${end.getFullYear()}`;
  if (start.getFullYear() === end.getFullYear()) return `${start.getDate()} ${m(start)} – ${end.getDate()} ${m(end)} ${end.getFullYear()}`;
  return `${start.getDate()} ${m(start)} ${start.getFullYear()} – ${end.getDate()} ${m(end)} ${end.getFullYear()}`;
}

/* ---------- habit row ---------- */
function HabitRow({ habit, days, todayKey, checks, onToggle, onSave, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [name, setName] = useState(habit.name);
  const [target, setTarget] = useState(habit.target);
  const done = days.filter((d) => checks[d.key]).length;
  const met = done >= habit.target;

  const startEdit = () => { setName(habit.name); setTarget(habit.target); setConfirmDelete(false); setEditing(true); };
  const save = () => {
    const n = name.trim();
    if (!n) return;
    onSave({ ...habit, name: n, target: clampTarget(target) });
    setEditing(false);
  };

  if (editing) {
    return (
      <tr className="row editing">
        <td colSpan={9}>
          <div className="edit-box">
            {confirmDelete ? (
              <>
                <p className="edit-msg">Delete “{habit.name}”? Its check-ins are removed too.</p>
                <div className="edit-actions">
                  <button className="btn danger" onClick={() => onDelete(habit.id)}>Delete habit</button>
                  <button className="btn ghost" onClick={() => setConfirmDelete(false)}>Keep it</button>
                </div>
              </>
            ) : (
              <>
                <label className="field grow">
                  <span>Habit name</span>
                  <input autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }} />
                </label>
                <label className="field">
                  <span>Days per week</span>
                  <select value={target} onChange={(e) => setTarget(e.target.value)}>
                    {[1, 2, 3, 4, 5, 6, 7].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
                <div className="edit-actions">
                  <button className="btn primary" onClick={save} disabled={!name.trim()}>Save changes</button>
                  <button className="btn ghost" onClick={() => setEditing(false)}>Cancel</button>
                  <button className="btn text-danger" onClick={() => setConfirmDelete(true)}>Delete</button>
                </div>
              </>
            )}
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr className="row">
      <th scope="row" className="habit-cell">
        <button className="habit-name" onClick={startEdit} title="Edit habit">
          <span className="name-text">{habit.name}</span>
        </button>
      </th>
      {days.map((d) => {
        const on = !!checks[d.key];
        const future = d.key > todayKey;
        return (
          <td key={d.key} className={d.key === todayKey ? "day today" : "day"}>
            <button
              className={on ? "check on" : "check"}
              aria-pressed={on}
              disabled={future}
              aria-label={`${habit.name}, ${d.long}`}
              onClick={() => onToggle(habit.id, d.key)}
            >
              {on && <CheckIcon />}
            </button>
          </td>
        );
      })}
      <td className="progress-cell">
        <div className={met ? "progress met" : "progress"}>
          <span className="count">{done}/{habit.target}</span>
          <span className="bar" aria-hidden="true"><i style={{ width: `${Math.min(100, (done / habit.target) * 100)}%` }} /></span>
        </div>
      </td>
    </tr>
  );
}

/* ---------- add habit ---------- */
function AddHabit({ onAdd, inputRef }) {
  const [name, setName] = useState("");
  const [target, setTarget] = useState(7);
  const submit = () => {
    const n = name.trim();
    if (!n) return;
    onAdd(n, clampTarget(target));
    setName("");
    setTarget(7);
    inputRef.current && inputRef.current.focus();
  };
  return (
    <div className="add-habit">
      <label className="field grow">
        <span>New habit</span>
        <input ref={inputRef} value={name} maxLength={80} placeholder="What do you want to do each day?"
          onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
      </label>
      <label className="field">
        <span>Days per week</span>
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          {[1, 2, 3, 4, 5, 6, 7].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <button className="btn primary" onClick={submit} disabled={!name.trim()}>Add habit</button>
    </div>
  );
}

/* ---------- settings drawer ---------- */
function Settings({ open, onClose, settings, setSettings, assets, bgLocal, setBgLocal, profileProps }) {
  const panelRef = useRef(null);
  const fileRef = useRef(null);
  const [url, setUrl] = useState(settings.bgSource === "url" ? settings.bgUrl : "");
  const [status, setStatus] = useState(null); // {kind, text}
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (panelRef.current) panelRef.current.inert = !open; }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const first = panelRef.current && panelRef.current.querySelector("button, input");
    first && first.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const clearOldAsset = async () => {
    if (settings.bgSource === "asset" && settings.bgAssetId && assets) {
      try { await assets.delete(settings.bgAssetId); } catch {}
    }
  };
  const clearLocal = () => { try { localStorage.removeItem(BG_LOCAL_KEY); } catch {} setBgLocal(""); };

  const applyUrl = () => {
    const u = url.trim();
    if (!/^https?:\/\/\S+$/i.test(u)) { setStatus({ kind: "error", text: "Paste a full image link starting with https://" }); return; }
    setBusy(true);
    setStatus({ kind: "info", text: "Checking the image…" });
    const img = new Image();
    let finished = false;
    const done = async (ok) => {
      if (finished) return;
      finished = true;
      setBusy(false);
      if (!ok) {
        setStatus({ kind: "error", text: window.claude
          ? "That image didn't load. Check the link points straight to an image file. If it does, this hosted page is blocking images from other sites — use Upload image instead."
          : "That image didn't load. Check you're online and the link points straight to an image file, or use Upload image instead." });
        return;
      }
      await clearOldAsset();
      clearLocal();
      setSettings({ bgSource: "url", bgUrl: u, bgAssetId: "" });
      setStatus({ kind: "ok", text: "Background updated." });
    };
    img.onload = () => done(true);
    img.onerror = () => done(false);
    setTimeout(() => done(false), 10000);
    img.src = u;
  };

  const onFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (!/^image\//.test(file.type)) { setStatus({ kind: "error", text: "Choose an image file (JPG, PNG, WebP or GIF)." }); return; }
    setBusy(true);
    setStatus({ kind: "info", text: "Uploading…" });
    if (assets) {
      try {
        const res = await assets.upload(file);
        await clearOldAsset();
        clearLocal();
        setSettings({ bgSource: "asset", bgAssetId: res.id, bgUrl: "" });
        setUrl("");
        setStatus({ kind: "ok", text: "Background updated." });
      } catch (err) {
        const code = err && err.code;
        setStatus({ kind: "error", text: code === "quota_exceeded" || code === "too_large" || code === "payload_too_large"
          ? "That image is too large to store. Try a smaller file."
          : "Upload failed. Try again, or try a different image." });
      }
      setBusy(false);
      return;
    }
    if (file.size > 3 * 1024 * 1024) { setBusy(false); setStatus({ kind: "error", text: "Images over 3 MB can't be kept on this device. Choose a smaller file." }); return; }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        localStorage.setItem(BG_LOCAL_KEY, reader.result);
        setBgLocal(reader.result);
        setSettings({ bgSource: "local", bgUrl: "", bgAssetId: "" });
        setUrl("");
        setStatus({ kind: "ok", text: "Background updated on this device." });
      } catch {
        setStatus({ kind: "error", text: "Not enough space on this device for that image. Choose a smaller file." });
      }
      setBusy(false);
    };
    reader.onerror = () => { setBusy(false); setStatus({ kind: "error", text: "Couldn't read that file." }); };
    reader.readAsDataURL(file);
  };

  const removeBg = async () => {
    await clearOldAsset();
    clearLocal();
    setSettings({ bgSource: "", bgUrl: "", bgAssetId: "" });
    setUrl("");
    setStatus({ kind: "ok", text: "Background removed." });
  };

  const hasBg = !!settings.bgSource;

  return (
    <div className={open ? "drawer-wrap open" : "drawer-wrap"} aria-hidden={!open}>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Settings" ref={panelRef}>
        <div className="drawer-head">
          <h2>Settings</h2>
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>

        <ProfileSettings {...profileProps} />

        <section className="setting">
          <h3>Theme</h3>
          <div className="segmented" role="radiogroup" aria-label="Theme">
            {THEMES.map((t) => (
              <button key={t.id} role="radio" aria-checked={settings.theme === t.id}
                className={settings.theme === t.id ? "seg on" : "seg"}
                onClick={() => setSettings({ theme: t.id })}>
                <span className={`swatch sw-${t.id}`} style={t.id === "custom" ? { background: settings.customColor } : undefined} />
                {t.label}
              </button>
            ))}
          </div>
          {settings.theme === null && <p className="hint">Following your device's light or dark setting until you pick one.</p>}
          {settings.theme === "custom" && (
            <label className="color-row">
              <input type="color" value={settings.customColor} onChange={(e) => setSettings({ customColor: e.target.value })} />
              <span>Accent colour <code>{settings.customColor}</code></span>
            </label>
          )}
        </section>

        <section className="setting">
          <h3>Background image</h3>
          <label className="field">
            <span>Image link</span>
            <input type="url" inputMode="url" value={url} placeholder="https://…"
              onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !busy && applyUrl()} />
          </label>
          <div className="row-actions">
            <button className="btn primary" onClick={applyUrl} disabled={busy || !url.trim()}>Use this link</button>
            <button className="btn ghost" onClick={() => fileRef.current && fileRef.current.click()} disabled={busy}>Upload image</button>
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={onFile} />
          </div>
          {status && <p className={`status ${status.kind}`} role="status">{status.text}</p>}

          {hasBg && (
            <>
              <label className="field">
                <span>Dim the image: {Math.round(settings.dim * 100)}%</span>
                <input type="range" min="0" max="0.85" step="0.05" value={settings.dim}
                  onChange={(e) => setSettings({ dim: Number(e.target.value) })} />
              </label>
              <button className="btn text-danger" onClick={removeBg}>Remove background</button>
            </>
          )}
          {settings.bgSource === "local" && !bgLocal && (
            <p className="hint">This background was uploaded on another device. Upload it here to see it.</p>
          )}
        </section>
      </aside>
    </div>
  );
}

/* ---------- analysis ---------- */
const RANGES = [
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "all", label: "All time" },
];
const parseKey = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
const pct = (x) => (x == null ? "–" : `${Math.round(x * 100)}%`);
const weekdayIndex = (d) => (d.getDay() + 6) % 7;
function keysBetween(a, b) {
  const out = [];
  for (let d = new Date(a); d <= b; d = addDays(d, 1)) out.push(dateKey(d));
  return out;
}
// A habit counts from the day it was added, or its earliest check-in if that's earlier.
function habitStartKey(h, checks, todayKey) {
  let s = h.createdAt || todayKey;
  const mine = checks[h.id] || {};
  for (const k in mine) if (mine[k] && k < s) s = k;
  return s > todayKey ? todayKey : s;
}

function computeAnalysis(habits, checks, range, now) {
  const todayKey = dateKey(now);
  const today = parseKey(todayKey);
  const starts = {};
  habits.forEach((h) => { starts[h.id] = habitStartKey(h, checks, todayKey); });

  let from;
  if (range === "week") from = startOfWeek(today);
  else if (range === "month") from = new Date(today.getFullYear(), today.getMonth(), 1);
  else from = parseKey(habits.reduce((m, h) => (starts[h.id] < m ? starts[h.id] : m), todayKey));
  const fromKey = dateKey(from);

  // Completion = check-ins vs. expected (weekly target scaled to the days covered), capped per habit.
  const period = (aKey, bKey) => {
    let got = 0, exp = 0, total = 0;
    const per = habits.map((h) => {
      const s = starts[h.id] > aKey ? starts[h.id] : aKey;
      if (s > bKey) return { habit: h, active: 0, checks: 0, expected: 0, pct: null };
      const keys = keysBetween(parseKey(s), parseKey(bKey));
      const mine = checks[h.id] || {};
      const c = keys.filter((k) => mine[k]).length;
      const e = (h.target * keys.length) / 7;
      got += Math.min(c, e); exp += e; total += c;
      return { habit: h, active: keys.length, checks: c, expected: e, pct: e ? Math.min(1, c / e) : null };
    });
    return { per, pct: exp ? got / exp : null, checks: total };
  };

  const daily = keysBetween(from, today).map((k) => {
    const live = habits.filter((h) => starts[h.id] <= k);
    const c = live.filter((h) => (checks[h.id] || {})[k]).length;
    return { key: k, wd: weekdayIndex(parseKey(k)), n: live.length, c, rate: live.length ? c / live.length : null };
  });
  const dailyMap = {};
  daily.forEach((d) => { dailyMap[d.key] = d; });

  let trend, trendTitle, trendNote;
  if (range === "week") {
    trendTitle = "Daily check-in rate";
    trendNote = "Share of your habits checked off each day.";
    trend = daily.map((d) => ({ label: DAY_NAMES[d.wd], value: d.rate, title: `${d.c} of ${d.n} habits` }));
  } else {
    const weeks = [];
    for (let w = startOfWeek(from); w <= today; w = addDays(w, 7)) weeks.push(w);
    const monthly = range === "all" && weeks.length > 26;
    const buckets = [];
    if (monthly) {
      for (let m = new Date(from.getFullYear(), from.getMonth(), 1); m <= today; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
        const end = new Date(m.getFullYear(), m.getMonth() + 1, 0);
        buckets.push({ label: m.toLocaleDateString(undefined, { month: "short", year: "2-digit" }), a: m < from ? from : m, b: end > today ? today : end });
      }
    } else {
      weeks.forEach((w) => {
        const end = addDays(w, 6);
        buckets.push({ label: w.toLocaleDateString(undefined, { day: "numeric", month: "short" }), a: w < from ? from : w, b: end > today ? today : end });
      });
    }
    trendTitle = monthly ? "Monthly completion" : "Weekly completion";
    trendNote = `Check-ins against your targets, ${monthly ? "month" : "week"} by ${monthly ? "month" : "week"}.`;
    trend = buckets.map((b) => {
      const p = period(dateKey(b.a), dateKey(b.b));
      return { label: b.label, value: p.pct, title: `${p.checks} ${p.checks === 1 ? "check-in" : "check-ins"}` };
    });
  }

  const weekday = DAY_NAMES.map((name, i) => {
    let n = 0, c = 0;
    daily.forEach((d) => { if (d.wd === i) { n += d.n; c += d.c; } });
    return { name, rate: n ? c / n : null, c, n };
  });

  const heat = [];
  for (let w = startOfWeek(from); w <= today; w = addDays(w, 7)) {
    const cells = DAY_NAMES.map((_, i) => {
      const d = addDays(w, i);
      const k = dateKey(d);
      return { key: k, date: d, day: k >= fromKey && k <= todayKey ? dailyMap[k] || null : null };
    });
    const firstOfMonth = cells.find((c) => c.date.getDate() === 1);
    heat.push({ key: dateKey(w), cells, monthLabel: heat.length === 0 || firstOfMonth ? (firstOfMonth || cells[0]).date.toLocaleDateString(undefined, { month: "short" }) : "" });
  }

  return { from, today, days: daily.length, summary: period(fromKey, todayKey), trend, trendTitle, trendNote, weekday, heat };
}

function Ring({ value }) {
  const r = 52, c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 128 128" className="ring" role="img" aria-label={`Overall completion ${pct(value)}`}>
      <circle cx="64" cy="64" r={r} className="ring-track" />
      <circle cx="64" cy="64" r={r} className="ring-fill" strokeDasharray={c}
        strokeDashoffset={c * (1 - (value || 0))} transform="rotate(-90 64 64)" />
      <text x="64" y="66" className="ring-text" textAnchor="middle" dominantBaseline="middle">{pct(value)}</text>
    </svg>
  );
}

function HabitBars({ per }) {
  const rows = per.filter((p) => p.active > 0);
  if (!rows.length) return <p className="hint">No habits were active in this period.</p>;
  return (
    <ul className="hbars">
      {rows.map((p) => (
        <li key={p.habit.id}>
          <div className="hbar-top">
            <span className="hbar-name">{p.habit.name}</span>
            <span className="hbar-val">{pct(p.pct)}</span>
          </div>
          <span className="hbar-track"><i className={p.pct >= 1 ? "met" : ""} style={{ width: `${(p.pct || 0) * 100}%` }} /></span>
          <span className="hbar-sub">{p.checks} of {Math.round(p.expected * 10) / 10} expected check-ins</span>
        </li>
      ))}
    </ul>
  );
}

function LineChart({ points, label }) {
  const W = 640, H = 230, L = 44, R = 16, T = 16, B = 34;
  const n = points.length;
  const x = (i) => (n === 1 ? (L + W - R) / 2 : L + (i * (W - L - R)) / (n - 1));
  const y = (v) => T + (1 - v) * (H - T - B);
  let d = "", open = false;
  points.forEach((p, i) => {
    if (p.value == null) { open = false; return; }
    d += `${open ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)} `;
    open = true;
  });
  const every = Math.max(1, Math.ceil(n / 8));
  return (
    <div className="chart-scroll">
      <svg viewBox={`0 0 ${W} ${H}`} className="line-chart" role="img" aria-label={label}>
        {[0, 0.5, 1].map((g) => (
          <g key={g}>
            <line x1={L} x2={W - R} y1={y(g)} y2={y(g)} className="grid-line" />
            <text x={L - 8} y={y(g)} className="axis-text" textAnchor="end" dominantBaseline="middle">{g * 100}%</text>
          </g>
        ))}
        <path d={d} className="trend-line" />
        {points.map((p, i) => p.value != null && (
          <circle key={i} cx={x(i)} cy={y(p.value)} r="4.5" className="trend-dot">
            <title>{`${p.label}: ${pct(p.value)} (${p.title})`}</title>
          </circle>
        ))}
        {points.map((p, i) => (i % every === 0 || i === n - 1) && (
          <text key={`l${i}`} x={x(i)} y={H - 10} className="axis-text" textAnchor="middle">{p.label}</text>
        ))}
      </svg>
    </div>
  );
}

function WeekdayBars({ data }) {
  return (
    <div className="vbars">
      {data.map((d) => (
        <div key={d.name} className="vbar" title={d.n ? `${d.c} of ${d.n} habit-days` : "No data yet"}>
          <span className="vbar-val">{pct(d.rate)}</span>
          <span className="vbar-track"><i style={{ height: `${(d.rate || 0) * 100}%` }} /></span>
          <span className="vbar-name">{d.name}</span>
        </div>
      ))}
    </div>
  );
}

function Heatmap({ weeks, size }) {
  return (
    <div className="chart-scroll">
      <div className="heatmap" style={{ "--cell": `${size}px` }}>
        <div className="hm-col hm-days" aria-hidden="true">
          <span className="hm-month" />
          {DAY_NAMES.map((n, i) => <span key={n} className="hm-daylabel">{i % 2 === 0 ? n : ""}</span>)}
        </div>
        {weeks.map((w) => (
          <div key={w.key} className="hm-col">
            <span className="hm-month">{w.monthLabel}</span>
            {w.cells.map((c) => {
              const label = c.date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
              if (!c.day) return <span key={c.key} className="hm-cell out" />;
              const cls = c.day.rate == null ? "hm-cell out" : c.day.rate === 0 ? "hm-cell zero" : "hm-cell fill";
              const text = c.day.n ? `${label}: ${c.day.c} of ${c.day.n} habits` : `${label}: no habits yet`;
              return <span key={c.key} className={cls} style={c.day.rate ? { "--a": 0.25 + 0.75 * c.day.rate } : undefined} title={text} aria-label={text} role="img" />;
            })}
          </div>
        ))}
      </div>
      <div className="hm-legend" aria-hidden="true">
        <span>Fewer</span>
        <span className="hm-cell zero" />
        {[0.25, 0.5, 0.75, 1].map((r) => <span key={r} className="hm-cell fill" style={{ "--a": 0.25 + 0.75 * r }} />)}
        <span>All habits</span>
      </div>
    </div>
  );
}

function Analysis({ habits, checks, range, setRange, now }) {
  const a = useMemo(() => computeAnalysis(habits, checks, range, now), [habits, checks, range, now]);
  const rangeSwitch = (
    <div className="segmented inline" role="radiogroup" aria-label="Analysis period">
      {RANGES.map((r) => (
        <button key={r.id} role="radio" aria-checked={range === r.id} className={range === r.id ? "seg on" : "seg"} onClick={() => setRange(r.id)}>{r.label}</button>
      ))}
    </div>
  );

  if (!habits.length) {
    return (
      <main className="panel">
        <div className="empty">
          <h2>Nothing to analyse yet</h2>
          <p>Add a habit on the Tracker tab and check off a few days. Your completion rates and graphs appear here.</p>
        </div>
      </main>
    );
  }

  const s = a.summary;
  const best = s.per.filter((p) => p.pct != null).sort((x, y) => y.pct - x.pct)[0];
  return (
    <div className="analysis">
      <section className="panel overview">
        <div className="overview-head">
          {rangeSwitch}
        </div>
        <div className="overview-body">
          <Ring value={s.pct} />
          <div className="overview-stats">
            <p className="big-stat">{pct(s.pct)} <span>complete</span></p>
            <p>{s.checks} {s.checks === 1 ? "check-in" : "check-ins"} over {a.days} {a.days === 1 ? "day" : "days"}</p>
            {best && habits.length > 1 && <p>Strongest: <strong>{best.habit.name}</strong> at {pct(best.pct)}</p>}
          </div>
        </div>
      </section>

      <section className="panel card">
        <h2>Completion by habit</h2>
        <p className="hint">Check-ins against each habit's weekly target.</p>
        <HabitBars per={s.per} />
      </section>

      <section className="panel card">
        <h2>{a.trendTitle}</h2>
        <p className="hint">{a.trendNote}</p>
        <LineChart points={a.trend} label={a.trendTitle} />
      </section>

      <div className="two-up">
        <section className="panel card">
          <h2>By weekday</h2>
          <p className="hint">How often habits get checked on each day of the week.</p>
          <WeekdayBars data={a.weekday} />
        </section>
        <section className="panel card">
          <h2>Check-in calendar</h2>
          <p className="hint">Darker days mean more habits done.</p>
          <Heatmap weeks={a.heat} size={range === "week" ? 34 : range === "month" ? 26 : 14} />
        </section>
      </div>
    </div>
  );
}

/* ---------- profile ---------- */
const PHOTO_LOCAL_KEY = "weekly-habits:photo-local";

function readFileAsDataUrl(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error("read"));
    r.readAsDataURL(file);
  });
}
// Crop to a centred square and shrink, so the photo stays small and fast.
async function preparePhoto(file, size = 320) {
  if (!/^image\//.test(file.type)) throw new Error("type");
  const src = await readFileAsDataUrl(file);
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  const s = Math.min(img.naturalWidth, img.naturalHeight);
  const out = Math.min(size, s);
  const c = document.createElement("canvas");
  c.width = c.height = out;
  c.getContext("2d").drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, out, out);
  const dataUrl = c.toDataURL("image/jpeg", 0.86);
  const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.86));
  return { dataUrl, blob };
}

function Avatar({ src, name, size = 40 }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  const initial = (name || "?").trim().charAt(0).toUpperCase() || "?";
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.42 }}>
      {src && !broken ? <img src={src} alt="" onError={() => setBroken(true)} /> : <span aria-hidden="true">{initial}</span>}
    </span>
  );
}

function PhotoPicker({ src, name, busy, onPick, onRemove }) {
  const ref = useRef(null);
  return (
    <div className="photo-picker">
      <Avatar src={src} name={name} size={84} />
      <div className="row-actions">
        <button type="button" className="btn ghost" disabled={busy} onClick={() => ref.current && ref.current.click()}>
          {src ? "Change photo" : "Choose photo"}
        </button>
        {src && <button type="button" className="btn text-danger" disabled={busy} onClick={onRemove}>Remove photo</button>}
        <input ref={ref} type="file" accept="image/*" hidden
          onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ""; if (f) onPick(f); }} />
      </div>
    </div>
  );
}

function Onboarding({ onFinish }) {
  const [name, setName] = useState("");
  const [photo, setPhoto] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current && inputRef.current.focus(); }, []);

  const pick = async (file) => {
    setError("");
    try { setPhoto(await preparePhoto(file)); }
    catch { setError("That file couldn't be used. Choose a JPG, PNG or WebP image."); }
  };
  const finish = async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    setError("");
    const err = await onFinish(n, photo);
    if (err) { setError(err); setBusy(false); }
  };

  return (
    <div className="onboard-wrap" role="dialog" aria-modal="true" aria-labelledby="onboard-title">
      <div className="onboard">
        <h1 id="onboard-title">Welcome</h1>
        <p className="onboard-lead">Set up your tracker. Your name and photo show at the top of the app.</p>
        <PhotoPicker src={photo && photo.dataUrl} name={name} busy={busy} onPick={pick} onRemove={() => setPhoto(null)} />
        <label className="field">
          <span>Your name</span>
          <input ref={inputRef} value={name} maxLength={40} autoComplete="given-name"
            onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && finish()} />
        </label>
        {error && <p className="status error" role="alert">{error}</p>}
        <button className="btn primary wide" disabled={!name.trim() || busy} onClick={finish}>
          {busy ? "Saving…" : "Get started"}
        </button>
        <p className="hint">The photo is optional. You can change both later in Settings.</p>
      </div>
    </div>
  );
}

function ProfileSettings({ profile, photoSrc, setProfile, savePhoto, removePhoto }) {
  const [name, setName] = useState(profile.name);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setName(profile.name), [profile.name]);

  const saveName = () => {
    const n = name.trim();
    if (!n) { setStatus({ kind: "error", text: "Enter a name." }); return; }
    if (n === profile.name) return;
    setProfile({ name: n });
    setStatus({ kind: "ok", text: "Name saved." });
  };
  const pick = async (file) => {
    setBusy(true);
    setStatus({ kind: "info", text: "Saving photo…" });
    const err = await savePhoto(file);
    setStatus(err ? { kind: "error", text: err } : { kind: "ok", text: "Photo saved." });
    setBusy(false);
  };
  const remove = async () => {
    setBusy(true);
    await removePhoto();
    setStatus({ kind: "ok", text: "Photo removed." });
    setBusy(false);
  };

  return (
    <section className="setting">
      <h3>Your profile</h3>
      <PhotoPicker src={photoSrc} name={profile.name} busy={busy} onPick={pick} onRemove={remove} />
      {profile.photoSource === "local" && !photoSrc && <p className="hint">Your photo was added on another device. Choose it again here to see it.</p>}
      <div className="name-row">
        <label className="field grow">
          <span>Name</span>
          <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && saveName()} />
        </label>
        <button className="btn primary" onClick={saveName} disabled={!name.trim() || name.trim() === profile.name}>Save name</button>
      </div>
      {status && <p className={`status ${status.kind}`} role="status">{status.text}</p>}
    </section>
  );
}

/* ---------- app ---------- */
function App() {
  const { state, update, sync } = useTrackerStore();
  const { habits, checks, settings, profile } = state;
  const [weekOffset, setWeekOffset] = useState(0);
  const [tab, setTab] = useState("tracker");
  const [range, setRange] = useState("week");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [assets, setAssets] = useState(null);
  const [bgLocal, setBgLocal] = useState(readLocalBg);
  const [photoLocal, setPhotoLocal] = useState(() => { try { return localStorage.getItem(PHOTO_LOCAL_KEY) || ""; } catch { return ""; } });
  const [now, setNow] = useState(() => new Date());
  const addRef = useRef(null);

  useEffect(() => { let alive = true; getCapability("assets").then((a) => alive && setAssets(a)); return () => { alive = false; }; }, []);

  // roll over at midnight / when the tab comes back
  useEffect(() => {
    const tick = () => setNow((prev) => { const n = new Date(); return dateKey(n) === dateKey(prev) ? prev : n; });
    const id = setInterval(tick, 60000);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", tick); };
  }, []);

  // theme
  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme) root.setAttribute("data-theme", settings.theme);
    else root.removeAttribute("data-theme");
    CUSTOM_VARS.forEach((v) => root.style.removeProperty(v));
    if (settings.theme === "custom") {
      const vars = customThemeVars(settings.customColor);
      Object.entries(vars).forEach(([k, v]) => root.style.setProperty(k, v));
    }
  }, [settings.theme, settings.customColor]);

  const todayKey = dateKey(now);
  const weekStart = useMemo(() => addDays(startOfWeek(now), weekOffset * 7), [now, weekOffset]);
  const days = useMemo(() => DAY_NAMES.map((name, i) => {
    const d = addDays(weekStart, i);
    return { key: dateKey(d), name, date: d.getDate(), long: d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }) };
  }), [weekStart]);

  const setProfile = useCallback((patch) => update((s) => ({ ...s, profile: { ...s.profile, ...patch } })), [update]);
  const clearLocalPhoto = () => { try { localStorage.removeItem(PHOTO_LOCAL_KEY); } catch {} setPhotoLocal(""); };
  const dropOldAsset = async () => {
    if (profile.photoSource === "asset" && profile.photoAssetId && assets) { try { await assets.delete(profile.photoAssetId); } catch {} }
  };
  // Stores a prepared photo; returns a profile patch, or throws a user-facing message.
  const storePhoto = async (prep) => {
    if (assets) {
      let res;
      try { res = await assets.upload(prep.blob); }
      catch { throw new Error("The photo couldn't be uploaded. Try again or pick a different image."); }
      await dropOldAsset();
      clearLocalPhoto();
      return { photoSource: "asset", photoAssetId: res.id };
    }
    try { localStorage.setItem(PHOTO_LOCAL_KEY, prep.dataUrl); }
    catch { throw new Error("Not enough space on this device for that photo."); }
    setPhotoLocal(prep.dataUrl);
    return { photoSource: "local", photoAssetId: "" };
  };
  const savePhoto = async (file) => {
    try {
      let prep;
      try { prep = await preparePhoto(file); } catch { return "That file couldn't be used. Choose a JPG, PNG or WebP image."; }
      setProfile(await storePhoto(prep));
      return "";
    } catch (e) { return e.message; }
  };
  const removePhoto = async () => {
    await dropOldAsset();
    clearLocalPhoto();
    setProfile({ photoSource: "", photoAssetId: "" });
  };
  const finishOnboarding = async (name, prep) => {
    let patch = { name };
    if (prep) {
      try { patch = { ...patch, ...(await storePhoto(prep)) }; }
      catch (e) { return `${e.message} You can also continue without a photo.`; }
    }
    setProfile(patch);
    return "";
  };
  const photoSrc = profile.photoSource === "asset" && profile.photoAssetId ? `/_blob/${profile.photoAssetId}`
    : profile.photoSource === "local" ? photoLocal : "";

  const setSettings = useCallback((patch) => update((s) => ({ ...s, settings: { ...s.settings, ...patch } })), [update]);
  const addHabit = (name, target) => update((s) => ({ ...s, habits: [...s.habits, { id: newId(), name, target, createdAt: todayKey }] }));
  const saveHabit = (h) => update((s) => ({ ...s, habits: s.habits.map((x) => (x.id === h.id ? h : x)) }));
  const deleteHabit = (id) => update((s) => {
    const checksNext = { ...s.checks };
    delete checksNext[id];
    return { ...s, habits: s.habits.filter((h) => h.id !== id), checks: checksNext };
  });
  const toggle = (habitId, key) => {
    if (key > todayKey) return;
    update((s) => {
      const mine = { ...(s.checks[habitId] || {}) };
      if (mine[key]) delete mine[key]; else mine[key] = true;
      return { ...s, checks: { ...s.checks, [habitId]: mine } };
    });
  };

  const onTarget = habits.filter((h) => days.filter((d) => (checks[h.id] || {})[d.key]).length >= h.target).length;

  const bgImage = settings.bgSource === "url" ? settings.bgUrl
    : settings.bgSource === "asset" && settings.bgAssetId ? `/_blob/${settings.bgAssetId}`
    : settings.bgSource === "local" ? bgLocal : "";

  const title = weekOffset === 0 ? "This week" : weekOffset === -1 ? "Last week" : weekOffset === 1 ? "Next week"
    : `Week of ${weekStart.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;

  const analysisRange = useMemo(() => {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const fmt = (d) => d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
    if (range === "week") return `${fmt(startOfWeek(today))} – today`;
    if (range === "month") return today.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    if (!habits.length) return "All time";
    const tk = dateKey(today);
    const first = habits.reduce((m, h) => { const k = habitStartKey(h, checks, tk); return k < m ? k : m; }, tk);
    return `Since ${fmt(parseKey(first))}`;
  }, [range, now, habits, checks]);

  return (
    <>
      <div className="backdrop" aria-hidden="true">
        {bgImage && <div className="bg-img" style={{ backgroundImage: `url("${bgImage.replace(/"/g, "%22")}")` }} />}
        {bgImage && <div className="bg-dim" style={{ opacity: settings.dim }} />}
      </div>

      <div className="shell">
        <header className="top">
          <div className="title-block">
            {profile.name && (
              <div className="hello">
                <Avatar src={photoSrc} name={profile.name} size={38} />
                <span>Hi, {profile.name}</span>
              </div>
            )}
            <h1>{tab === "tracker" ? title : "Analysis"}</h1>
            <p className="range">{tab === "tracker" ? formatRange(weekStart) : analysisRange}</p>
          </div>
          <div className="top-actions">
            <div className="tabs" role="tablist" aria-label="View">
              <button role="tab" aria-selected={tab === "tracker"} className={tab === "tracker" ? "tab on" : "tab"} onClick={() => setTab("tracker")}>Tracker</button>
              <button role="tab" aria-selected={tab === "analysis"} className={tab === "analysis" ? "tab on" : "tab"} onClick={() => setTab("analysis")}>Analysis</button>
            </div>
            {tab === "tracker" && <div className="week-nav" role="group" aria-label="Change week">
              <button className="btn ghost" onClick={() => setWeekOffset((w) => w - 1)} aria-label="Previous week">‹</button>
              {weekOffset !== 0 && <button className="btn ghost" onClick={() => setWeekOffset(0)}>Today</button>}
              <button className="btn ghost" onClick={() => setWeekOffset((w) => w + 1)} aria-label="Next week">›</button>
            </div>}
            <button className="btn ghost icon" onClick={() => setSettingsOpen(true)} aria-label="Settings"><GearIcon /></button>
          </div>
        </header>

        {tab === "analysis" ? (
          <Analysis habits={habits} checks={checks} range={range} setRange={setRange} now={now} />
        ) : (
        <main className="panel">
          <div className="panel-head">
            <p className="summary">
              {habits.length
                ? <><strong>{onTarget}</strong> of {habits.length} {habits.length === 1 ? "habit" : "habits"} on target</>
                : "No habits yet"}
            </p>
            <p className={`sync ${sync}`} role="status">{SYNC_TEXT[sync]}</p>
          </div>

          {habits.length === 0 ? (
            <div className="empty">
              <h2>Add your first habit</h2>
              <p>Name it, choose how many days a week you're aiming for, then tick it off each day below.</p>
            </div>
          ) : (
            <div className="grid-scroll">
              <table className="grid">
                <thead>
                  <tr>
                    <th scope="col" className="habit-col">Habit</th>
                    {days.map((d) => (
                      <th key={d.key} scope="col" className={d.key === todayKey ? "day-head today" : "day-head"}>
                        <span className="dname">{d.name}</span>
                        <span className="dnum">{d.date}</span>
                      </th>
                    ))}
                    <th scope="col" className="progress-col">Week</th>
                  </tr>
                </thead>
                <tbody>
                  {habits.map((h) => (
                    <HabitRow key={h.id} habit={h} days={days} todayKey={todayKey} checks={checks[h.id] || {}}
                      onToggle={toggle} onSave={saveHabit} onDelete={deleteHabit} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <AddHabit onAdd={addHabit} inputRef={addRef} />
        </main>
        )}
      </div>

      <Settings open={settingsOpen} onClose={() => setSettingsOpen(false)} settings={settings}
        setSettings={setSettings} assets={assets} bgLocal={bgLocal} setBgLocal={setBgLocal}
        profileProps={{ profile, photoSrc, setProfile, savePhoto, removePhoto }} />

      {!profile.name && sync !== "connecting" && <Onboarding onFinish={finishOnboarding} />}
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
