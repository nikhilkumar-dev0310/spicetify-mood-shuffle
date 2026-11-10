// NAME: Mood Shuffle
// AUTHOR: Nikhil Kumar
// DESCRIPTION: Ask which artist you're in the mood for, then shuffle only that artist's songs from your own playlists (and Liked Songs).

(async function moodShuffle() {
  // Wait only for what the button needs, so it always shows up
  while (!Spicetify?.Player || !document.body) {
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log("[Mood Shuffle] loaded");

  const SETTINGS_KEY = "moodShuffle:settings";
  const settings = Object.assign(
    { onlyMine: true, includeLiked: true, sort: "count" },
    JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")
  );
  const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

  // trackUri -> { uri, name, artists: [{name, uri}] }
  let libraryCache = null;
  let cacheTime = 0;
  const CACHE_MS = 10 * 60 * 1000; // rescan library every 10 minutes at most

  // ---------- Reading your library ----------

  function flattenRootlist(items, out = []) {
    for (const item of items || []) {
      if (item.type === "folder") flattenRootlist(item.items, out);
      else if (item.type === "playlist") out.push(item);
    }
    return out;
  }

  function isMine(playlist) {
    const me = Spicetify.Platform.username;
    const owner = playlist.owner?.username || playlist.owner?.uri?.split(":").pop();
    return !owner || owner === me;
  }

  function normaliseTrack(t) {
    if (!t?.uri || !t.uri.startsWith("spotify:track:")) return null; // skip local files / podcasts
    if (t.isPlayable === false) return null;
    const artists = (t.artists || []).map((a) => ({ name: a.name, uri: a.uri }));
    const imgs = t.album?.images || [];
    const cover = (imgs.find((i) => i.label === "small" || i.width === 300) || imgs[imgs.length - 1] || imgs[0])?.url || null;
    return { uri: t.uri, name: t.name, artists, cover };
  }

  async function getPlaylistTracks(uri) {
    const res = await Spicetify.Platform.PlaylistAPI.getContents(uri, { limit: 9999 });
    return (res?.items || []).map(normaliseTrack).filter(Boolean);
  }

  async function getLikedTracks() {
    const api = Spicetify.Platform.LibraryAPI;
    if (!api?.getTracks) return [];
    const out = [];
    let offset = 0;
    const limit = 500;
    while (true) {
      const res = await api.getTracks({ offset, limit });
      const items = res?.items || [];
      out.push(...items.map(normaliseTrack).filter(Boolean));
      if (items.length < limit) break;
      offset += limit;
    }
    return out;
  }

  async function scanLibrary(force = false, onProgress = () => {}) {
    if (!force && libraryCache && Date.now() - cacheTime < CACHE_MS) return libraryCache;

    const map = new Map();
    const root = await Spicetify.Platform.RootlistAPI.getContents();
    let playlists = flattenRootlist(root?.items);
    if (settings.onlyMine) playlists = playlists.filter(isMine);

    let done = 0;
    for (const pl of playlists) {
      try {
        for (const t of await getPlaylistTracks(pl.uri)) map.set(t.uri, t);
      } catch (e) {
        console.warn("[Mood Shuffle] Could not read playlist", pl.name, e);
      }
      onProgress(`Reading playlists… ${++done}/${playlists.length}`);
    }

    if (settings.includeLiked) {
      onProgress("Reading Liked Songs…");
      try {
        for (const t of await getLikedTracks()) map.set(t.uri, t);
      } catch (e) {
        console.warn("[Mood Shuffle] Could not read Liked Songs", e);
      }
    }

    libraryCache = map;
    cacheTime = Date.now();
    return map;
  }

  function artistIndex(map) {
    // artist name (lowercase) -> { name, count, covers }
    const idx = new Map();
    for (const t of map.values()) {
      for (const a of t.artists) {
        if (!a.name) continue;
        const key = a.name.toLowerCase();
        const entry = idx.get(key) || { name: a.name, count: 0, covers: [] };
        entry.count++;
        if (t.cover && entry.covers.length < 4 && !entry.covers.includes(t.cover)) entry.covers.push(t.cover);
        idx.set(key, entry);
      }
    }
    return [...idx.values()].sort((a, b) => b.count - a.count);
  }

  // ---------- Shuffling & playing ----------

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  async function playOnly(trackUris) {
    const [first, ...rest] = trackUris;

    // Clear whatever was queued before so other artists don't sneak in
    try {
      await Spicetify.Platform.PlayerAPI.clearQueue();
    } catch (e) {
      console.warn("[Mood Shuffle] clearQueue failed", e);
    }

    // Turn off Spotify's shuffle so it doesn't reorder our own shuffle
    try {
      if (Spicetify.Player.getShuffle()) Spicetify.Player.setShuffle(false);
    } catch (_) {}

    await Spicetify.Player.playUri(first);

    if (rest.length) {
      // add in chunks so very large mixes don't fail
      for (let i = 0; i < rest.length; i += 100) {
        await Spicetify.addToQueue(rest.slice(i, i + 100).map((uri) => ({ uri })));
      }
    }
  }

  async function startMood(artistName) {
    const target = artistName.trim().toLowerCase();
    if (!target) return;

    const map = await scanLibrary();
    const matches = [...map.values()].filter((t) =>
      t.artists.some((a) => a.name?.toLowerCase() === target)
    );

    if (!matches.length) {
      Spicetify.showNotification(`No songs by "${artistName}" in your playlists`, true);
      return;
    }

    const shuffled = shuffle(matches.map((t) => t.uri));
    await playOnly(shuffled);
    closeModal();
    Spicetify.showNotification(
      `Shuffling ${shuffled.length} song${shuffled.length > 1 ? "s" : ""} by ${matches[0].artists.find((a) => a.name.toLowerCase() === target).name}`
    );
  }

  // ---------- UI ----------

  const STYLE_ID = "mood-shuffle-style";
  const CSS = `
  .msx-overlay { position:fixed; inset:0; z-index:10000; display:flex; align-items:center; justify-content:center;
    background:rgba(0,0,0,.55); backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px);
    animation:msx-fade .15s ease-out; }
  @keyframes msx-fade { from { opacity:0 } to { opacity:1 } }
  @keyframes msx-pop { from { transform:translateY(8px) scale(.98); opacity:0 } to { transform:none; opacity:1 } }
  .msx-modal { box-sizing:border-box; max-width:92vw; max-height:86vh; display:flex; flex-direction:column;
    background:var(--spice-main, #181818); color:var(--spice-text, #fff); border-radius:16px;
    box-shadow:0 24px 64px rgba(0,0,0,.6); overflow:hidden; animation:msx-pop .18s ease-out;
    transition:width .2s ease; }
  .msx-modal * { box-sizing:border-box; }
  .msx-head { padding:22px 24px 14px; display:flex; align-items:flex-start; gap:16px; }
  .msx-title { flex:1; min-width:0; }
  .msx-title h2 { margin:0; font-size:22px; font-weight:800; line-height:1.2; }
  .msx-title p { margin:4px 0 0; font-size:13px; color:var(--spice-subtext, #b3b3b3); }
  .msx-x { flex:none; width:32px; height:32px; border-radius:50%; border:none; cursor:pointer; display:grid; place-items:center;
    background:transparent; color:var(--spice-subtext, #b3b3b3); font-size:20px; }
  .msx-x:hover { background:rgba(255,255,255,.08); color:var(--spice-text, #fff); }
  .msx-bar { padding:0 24px 12px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .msx-seg { display:flex; background:rgba(255,255,255,.06); border-radius:999px; padding:3px; }
  .msx-seg button { border:none; background:transparent; color:var(--spice-subtext, #b3b3b3); cursor:pointer;
    padding:6px 14px; border-radius:999px; font-size:13px; font-weight:600; }
  .msx-seg button.on { background:var(--spice-text, #fff); color:var(--spice-main, #000); }
  .msx-spacer { flex:1; }
  .msx-surprise { border:none; cursor:pointer; border-radius:999px; padding:8px 16px; font-size:13px; font-weight:700;
    background:var(--spice-button, #1db954); color:#000; display:flex; align-items:center; gap:6px; }
  .msx-surprise:hover { filter:brightness(1.1); transform:scale(1.03); }
  .msx-letters { padding:0 24px 10px; display:flex; flex-wrap:wrap; gap:4px; }
  .msx-letters button { border:none; cursor:pointer; min-width:26px; padding:4px 7px; border-radius:6px; font-size:12px; font-weight:600;
    background:transparent; color:var(--spice-subtext, #b3b3b3); }
  .msx-letters button:hover:not(:disabled) { background:rgba(255,255,255,.08); color:var(--spice-text, #fff); }
  .msx-letters button.on { background:var(--spice-button, #1db954); color:#000; }
  .msx-letters button:disabled { opacity:.25; cursor:default; }
  .msx-body { flex:1; min-height:0; overflow-y:auto; padding:4px 24px 16px; }
  .msx-grid { display:grid; gap:14px; }
  .msx-card { position:relative; border:none; cursor:pointer; text-align:left; padding:10px; border-radius:10px;
    background:rgba(255,255,255,.04); color:inherit; transition:background .15s; min-width:0; }
  .msx-card:hover { background:rgba(255,255,255,.1); }
  .msx-art { position:relative; width:100%; aspect-ratio:1; border-radius:50%; overflow:hidden; margin-bottom:10px;
    background:#333; box-shadow:0 8px 20px rgba(0,0,0,.4); display:grid; }
  .msx-art.mosaic { grid-template-columns:1fr 1fr; grid-template-rows:1fr 1fr; }
  .msx-art img { width:100%; height:100%; object-fit:cover; display:block; }
  .msx-art .init { display:grid; place-items:center; font-size:32px; font-weight:800; color:#fff; }
  .msx-play { position:absolute; right:12px; bottom:58px; width:40px; height:40px; border-radius:50%; display:grid; place-items:center;
    background:var(--spice-button, #1db954); color:#000; box-shadow:0 6px 14px rgba(0,0,0,.5);
    opacity:0; transform:translateY(6px); transition:all .15s; }
  .msx-card:hover .msx-play { opacity:1; transform:none; }
  .msx-name { font-weight:700; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .msx-count { font-size:12px; color:var(--spice-subtext, #b3b3b3); margin-top:2px; }
  .msx-foot { padding:12px 24px 16px; border-top:1px solid rgba(255,255,255,.08); display:flex; align-items:center; gap:18px; flex-wrap:wrap;
    font-size:13px; color:var(--spice-subtext, #b3b3b3); }
  .msx-foot label { display:flex; align-items:center; gap:7px; cursor:pointer; }
  .msx-foot input { accent-color:var(--spice-button, #1db954); width:15px; height:15px; }
  .msx-rescan { margin-left:auto; border:1px solid rgba(255,255,255,.25); background:transparent; color:inherit; cursor:pointer;
    border-radius:999px; padding:6px 14px; font-size:12px; font-weight:600; }
  .msx-rescan:hover { border-color:var(--spice-text, #fff); color:var(--spice-text, #fff); }
  .msx-empty { padding:40px 0; text-align:center; color:var(--spice-subtext, #b3b3b3); font-size:14px; }
  .msx-skel { border-radius:10px; background:rgba(255,255,255,.05); aspect-ratio:.8; animation:msx-pulse 1.2s infinite ease-in-out; }
  @keyframes msx-pulse { 50% { opacity:.45 } }
  `;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement("style");
    st.id = STYLE_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const firstLetter = (name) => {
    const ch = name.trim().charAt(0).toUpperCase();
    return /[A-Z]/.test(ch) ? ch : "#";
  };

  const hueFor = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

  // Size the popup from how many artists there are:
  // few artists -> small, tight popup; many -> wide grid, capped to the window.
  function layoutFor(n) {
    const cols = n <= 3 ? Math.max(n, 1) : n === 4 ? 2 : n <= 9 ? 3 : n <= 16 ? 4 : n <= 40 ? 5 : 6;
    const card = n <= 4 ? 170 : n <= 16 ? 150 : 132;
    const gap = 14, pad = 48;
    const width = Math.max(470, cols * card + (cols - 1) * gap + pad);
    return { cols, width };
  }

  let overlayEl = null;
  function closeModal() {
    overlayEl?.remove();
    overlayEl = null;
    document.removeEventListener("keydown", onEsc);
  }
  function onEsc(e) {
    if (e.key === "Escape") closeModal();
  }

  const PLAY_SVG = `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M3 1.7v12.6a.7.7 0 0 0 1.05.6l10.7-6.3a.7.7 0 0 0 0-1.2L4.05 1.1A.7.7 0 0 0 3 1.7z"/></svg>`;
  const DICE_SVG = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M3 1h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2zm1.5 2a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm7 7a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM8 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/></svg>`;

  function artHtml(a) {
    const covers = a.covers || [];
    if (covers.length >= 4) {
      return `<div class="msx-art mosaic">${covers.slice(0, 4).map((u) => `<img loading="lazy" src="${escapeHtml(u)}">`).join("")}</div>`;
    }
    if (covers.length) return `<div class="msx-art"><img loading="lazy" src="${escapeHtml(covers[0])}"></div>`;
    const h = hueFor(a.name);
    return `<div class="msx-art"><div class="init" style="background:linear-gradient(135deg,hsl(${h},55%,45%),hsl(${(h + 40) % 360},55%,25%))">${escapeHtml(a.name.charAt(0).toUpperCase())}</div></div>`;
  }

  function openModal() {
    if (overlayEl) return;
    ensureStyle();

    overlayEl = document.createElement("div");
    overlayEl.className = "msx-overlay";
    overlayEl.innerHTML = `
      <div class="msx-modal" role="dialog" aria-label="Mood Shuffle">
        <div class="msx-head">
          <div class="msx-title">
            <h2>Which artist are you in the mood for?</h2>
            <p class="msx-status">Reading your library…</p>
          </div>
          <button class="msx-x" title="Close">✕</button>
        </div>
        <div class="msx-bar">
          <div class="msx-seg">
            <button data-sort="count">Most songs</button>
            <button data-sort="az">A–Z</button>
          </div>
          <div class="msx-spacer"></div>
          <button class="msx-surprise" title="Pick a random artist">${DICE_SVG} Surprise me</button>
        </div>
        <div class="msx-letters"></div>
        <div class="msx-body"><div class="msx-grid"></div></div>
        <div class="msx-foot">
          <label><input type="checkbox" data-opt="onlyMine"> Only playlists I created</label>
          <label><input type="checkbox" data-opt="includeLiked"> Include Liked Songs</label>
          <button class="msx-rescan">Rescan</button>
        </div>
      </div>`;
    document.body.appendChild(overlayEl);
    document.addEventListener("keydown", onEsc);

    const $ = (sel) => overlayEl.querySelector(sel);
    const modal = $(".msx-modal");
    const grid = $(".msx-grid");
    const letters = $(".msx-letters");
    const status = $(".msx-status");
    const surprise = $(".msx-surprise");

    overlayEl.addEventListener("mousedown", (e) => {
      if (e.target === overlayEl) closeModal();
    });
    $(".msx-x").onclick = closeModal;

    let artists = [];
    let letterFilter = null;

    function applyLayout(n) {
      const { cols, width } = layoutFor(n);
      modal.style.width = width + "px";
      grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    }

    function showSkeleton() {
      applyLayout(8);
      grid.innerHTML = Array.from({ length: 8 }, () => `<div class="msx-skel"></div>`).join("");
    }

    function render() {
      const sortMode = settings.sort || "count";
      overlayEl.querySelectorAll("[data-sort]").forEach((b) => b.classList.toggle("on", b.dataset.sort === sortMode));

      // Letter bar only when it's useful (A–Z mode and enough artists)
      const showLetters = sortMode === "az" && artists.length > 12;
      letters.style.display = showLetters ? "flex" : "none";
      if (showLetters) {
        const present = new Set(artists.map((a) => firstLetter(a.name)));
        letters.innerHTML = "";
        ["All", "#", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].forEach((L) => {
          const b = document.createElement("button");
          b.textContent = L;
          b.disabled = L !== "All" && !present.has(L);
          b.classList.toggle("on", (L === "All" && !letterFilter) || L === letterFilter);
          b.onclick = () => {
            letterFilter = L === "All" ? null : L;
            render();
          };
          letters.appendChild(b);
        });
      }

      let shown = artists.slice();
      if (sortMode === "az") {
        shown.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
        if (letterFilter) shown = shown.filter((a) => firstLetter(a.name) === letterFilter);
      }

      // Popup size follows the whole library's artist count, so it doesn't jump around while filtering
      applyLayout(artists.length);
      surprise.style.display = artists.length > 1 ? "" : "none";

      if (!artists.length) {
        grid.innerHTML = `<div class="msx-empty" style="grid-column:1/-1">No songs found. Try ticking "Include Liked Songs" or unticking "Only playlists I created".</div>`;
        return;
      }

      grid.innerHTML = "";
      for (const a of shown) {
        const card = document.createElement("button");
        card.className = "msx-card";
        card.title = `Shuffle ${a.name}`;
        card.innerHTML = `${artHtml(a)}
          <div class="msx-play">${PLAY_SVG}</div>
          <div class="msx-name">${escapeHtml(a.name)}</div>
          <div class="msx-count">${a.count} song${a.count > 1 ? "s" : ""}</div>`;
        card.onclick = () => startMood(a.name);
        grid.appendChild(card);
      }
      $(".msx-body").scrollTop = 0;
    }

    async function refresh(force) {
      showSkeleton();
      status.textContent = "Reading your library…";
      try {
        const map = await scanLibrary(force, (s) => (status.textContent = s));
        artists = artistIndex(map);
        status.textContent = `${artists.length} artist${artists.length === 1 ? "" : "s"} · ${map.size} songs in your library`;
      } catch (e) {
        console.error("[Mood Shuffle]", e);
        artists = [];
        status.textContent = "Couldn't read your library. Check the console.";
      }
      render();
    }

    overlayEl.querySelectorAll("[data-sort]").forEach((b) => {
      b.onclick = () => {
        settings.sort = b.dataset.sort;
        letterFilter = null;
        saveSettings();
        render();
      };
    });

    surprise.onclick = () => {
      if (!artists.length) return;
      const pick = artists[Math.floor(Math.random() * artists.length)];
      startMood(pick.name);
    };

    $(".msx-rescan").onclick = () => refresh(true);

    overlayEl.querySelectorAll("[data-opt]").forEach((cb) => {
      const key = cb.dataset.opt;
      cb.checked = settings[key];
      cb.onchange = () => {
        settings[key] = cb.checked;
        saveSettings();
        refresh(true);
      };
    });

    refresh(false);
  }

  const ICON = `<svg role="img" height="16" width="16" viewBox="0 0 16 16" fill="currentColor"><path d="M13.15 1.4a.75.75 0 0 1 1.06 0l1.4 1.4a.75.75 0 0 1 0 1.06l-1.4 1.4a.75.75 0 1 1-1.06-1.06l.12-.12h-.92a2.75 2.75 0 0 0-2.2 1.1L6.7 10.1a4.25 4.25 0 0 1-3.4 1.7H.75a.75.75 0 0 1 0-1.5H3.3a2.75 2.75 0 0 0 2.2-1.1l3.45-4.92a4.25 4.25 0 0 1 3.4-1.7h.92l-.12-.12a.75.75 0 0 1 0-1.06zM.75 4.2H3.3c1.03 0 2 .4 2.73 1.1l-.9 1.27A2.75 2.75 0 0 0 3.3 5.7H.75a.75.75 0 0 1 0-1.5zm9.1 5.6.9-1.27a2.75 2.75 0 0 0 1.6.97h.92l-.12-.12a.75.75 0 1 1 1.06-1.06l1.4 1.4a.75.75 0 0 1 0 1.06l-1.4 1.4a.75.75 0 1 1-1.06-1.06l.12-.12h-.92a4.25 4.25 0 0 1-2.5-.9z"/></svg>`;

  // 1) Top bar button
  try {
    if (Spicetify.Topbar?.Button) new Spicetify.Topbar.Button("Mood Shuffle", ICON, openModal);
  } catch (e) {
    console.warn("[Mood Shuffle] Topbar button failed", e);
  }

  // 2) Profile menu item (click your avatar, top right)
  try {
    if (Spicetify.Menu?.Item) new Spicetify.Menu.Item("Mood Shuffle", false, openModal, ICON).register();
  } catch (e) {
    console.warn("[Mood Shuffle] Menu item failed", e);
  }

  // 3) Floating button in the bottom-right corner (always visible fallback)
  const fab = document.createElement("button");
  fab.title = "Mood Shuffle";
  fab.innerHTML = ICON.replace('height="16" width="16"', 'height="20" width="20"');
  Object.assign(fab.style, {
    position: "fixed", right: "24px", bottom: "110px", zIndex: 9999, width: "44px", height: "44px",
    borderRadius: "50%", border: "none", cursor: "pointer", display: "grid", placeItems: "center",
    background: "var(--spice-button, #1db954)", color: "#000", boxShadow: "0 4px 12px rgba(0,0,0,.5)",
  });
  fab.onclick = openModal;
  document.body.appendChild(fab);

  // Keyboard shortcut: Cmd+Shift+M (Ctrl+Shift+M on Windows/Linux)
  Spicetify.Keyboard?.registerShortcut?.(
    { key: "m", ctrl: !navigator.platform.includes("Mac"), meta: navigator.platform.includes("Mac"), shift: true },
    openModal
  );

  // Warm the cache in the background so the first open is fast
  setTimeout(() => scanLibrary().catch(() => {}), 5000);
})();
