// NAME: Mood Shuffle
// AUTHOR: Nikhil Kumar
// DESCRIPTION: Pick a playlist, pick the artist you're in the mood for, and shuffle only that artist's songs from that playlist.

(async function moodShuffle() {
  while (!Spicetify?.Player || !Spicetify?.Platform || !document.body) {
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log("[Mood Shuffle] loaded");

  const SETTINGS_KEY = "moodShuffle:settings";
  const settings = Object.assign(
    { onlyMine: false, sort: "count" },
    JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")
  );
  const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

  const LIKED_URI = "spotify:collection:tracks";
  const CACHE_MS = 5 * 60 * 1000;
  const trackCache = new Map(); // playlist uri -> { time, tracks }

  // ---------- Reading playlists ----------

  function flattenRootlist(items, out = []) {
    for (const item of items || []) {
      if (item.type === "folder") flattenRootlist(item.items, out);
      else if (item.type === "playlist") out.push(item);
    }
    return out;
  }

  function isMine(pl) {
    const me = Spicetify.Platform.username;
    const owner = pl.owner?.username || pl.owner?.uri?.split(":").pop();
    return !owner || owner === me;
  }

  function pickImage(images) {
    const imgs = images || [];
    return (imgs.find((i) => i.label === "small" || i.width === 300) || imgs[imgs.length - 1] || imgs[0])?.url || null;
  }

  function normaliseTrack(t) {
    if (!t?.uri || !t.uri.startsWith("spotify:track:")) return null; // skip local files and podcasts
    if (t.isPlayable === false) return null;
    const artists = (t.artists || []).map((a) => ({ name: a.name, uri: a.uri }));
    return { uri: t.uri, name: t.name, artists, cover: pickImage(t.album?.images) };
  }

  async function listPlaylists() {
    const root = await Spicetify.Platform.RootlistAPI.getContents();
    let pls = flattenRootlist(root?.items);
    if (settings.onlyMine) pls = pls.filter(isMine);
    const out = pls.map((p) => ({
      uri: p.uri,
      name: p.name || "Untitled playlist",
      image: pickImage(p.images),
      count: p.totalLength ?? p.length ?? null,
    }));
    out.unshift({ uri: LIKED_URI, name: "Liked Songs", image: null, count: null, liked: true });
    return out;
  }

  async function getLikedTracks() {
    const api = Spicetify.Platform.LibraryAPI;
    if (!api?.getTracks) return [];
    const out = [];
    for (let offset = 0; ; offset += 500) {
      const res = await api.getTracks({ offset, limit: 500 });
      const items = res?.items || [];
      out.push(...items.map(normaliseTrack).filter(Boolean));
      if (items.length < 500) break;
    }
    return out;
  }

  async function getTracks(uri, force = false) {
    const hit = trackCache.get(uri);
    if (!force && hit && Date.now() - hit.time < CACHE_MS) return hit.tracks;
    let tracks;
    if (uri === LIKED_URI) tracks = await getLikedTracks();
    else {
      const res = await Spicetify.Platform.PlaylistAPI.getContents(uri, { limit: 9999 });
      tracks = (res?.items || []).map(normaliseTrack).filter(Boolean);
    }
    // de-duplicate tracks that appear twice in a playlist
    const seen = new Set();
    tracks = tracks.filter((t) => (seen.has(t.uri) ? false : seen.add(t.uri)));
    trackCache.set(uri, { time: Date.now(), tracks });
    return tracks;
  }

  function artistIndex(tracks) {
    const idx = new Map();
    for (const t of tracks) {
      for (const a of t.artists) {
        if (!a.name) continue;
        const key = a.name.toLowerCase();
        const e = idx.get(key) || { name: a.name, count: 0, covers: [] };
        e.count++;
        if (t.cover && e.covers.length < 4 && !e.covers.includes(t.cover)) e.covers.push(t.cover);
        idx.set(key, e);
      }
    }
    return [...idx.values()].sort((a, b) => b.count - a.count);
  }

  // The playlist you're looking at, or else the one that's playing
  function currentPlaylistUri() {
    const path = Spicetify.Platform.History?.location?.pathname || "";
    let m = path.match(/^\/playlist\/([A-Za-z0-9]+)/);
    if (m) return `spotify:playlist:${m[1]}`;
    if (path.startsWith("/collection/tracks")) return LIKED_URI;
    const ctx = Spicetify.Player.data?.context?.uri || Spicetify.Player.data?.context_uri || "";
    if (ctx.startsWith("spotify:playlist:") || ctx === LIKED_URI) return ctx;
    m = ctx.match(/^spotify:user:[^:]+:collection$/);
    if (m) return LIKED_URI;
    return null;
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
    try {
      await Spicetify.Platform.PlayerAPI.clearQueue();
    } catch (e) {
      console.warn("[Mood Shuffle] clearQueue failed", e);
    }
    try {
      if (Spicetify.Player.getShuffle()) Spicetify.Player.setShuffle(false);
    } catch (_) {}
    await Spicetify.Player.playUri(first);
    for (let i = 0; i < rest.length; i += 100) {
      await Spicetify.addToQueue(rest.slice(i, i + 100).map((uri) => ({ uri })));
    }
  }

  async function startMood(artist, tracks, playlistName) {
    const target = artist.name.toLowerCase();
    const matches = tracks.filter((t) => t.artists.some((a) => a.name?.toLowerCase() === target));
    if (!matches.length) return;
    closeModal();
    await playOnly(shuffle(matches.map((t) => t.uri)));
    Spicetify.showNotification(
      `Shuffling ${matches.length} song${matches.length > 1 ? "s" : ""} by ${artist.name} from ${playlistName}`
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
  
  .msx-back { flex:none; width:32px; height:32px; border-radius:50%; border:none; cursor:pointer; display:grid; place-items:center;
    background:rgba(255,255,255,.08); color:var(--spice-text, #fff); margin-top:2px; }
  .msx-back:hover { background:rgba(255,255,255,.16); }
  .msx-art.square { border-radius:8px; }
  .msx-art .liked { display:grid; place-items:center; background:linear-gradient(135deg,#450af5,#c4efd9); color:#fff; }
  .msx-card.current { outline:2px solid var(--spice-button, #1db954); }
  .msx-tag { display:inline-block; margin-left:6px; padding:1px 6px; border-radius:4px; font-size:10px; font-weight:700;
    background:var(--spice-button, #1db954); color:#000; vertical-align:middle; }
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

  // Popup size follows how many items there are: few -> small popup, many -> wide grid
  function layoutFor(n) {
    const cols = n <= 3 ? Math.max(n, 1) : n === 4 ? 2 : n <= 9 ? 3 : n <= 16 ? 4 : n <= 40 ? 5 : 6;
    const card = n <= 4 ? 170 : n <= 16 ? 150 : 132;
    const width = Math.max(470, cols * card + (cols - 1) * 14 + 48);
    return { cols, width };
  }

  const PLAY_SVG = `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M3 1.7v12.6a.7.7 0 0 0 1.05.6l10.7-6.3a.7.7 0 0 0 0-1.2L4.05 1.1A.7.7 0 0 0 3 1.7z"/></svg>`;
  const DICE_SVG = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M3 1h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2zm1.5 2a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm7 7a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM8 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/></svg>`;
  const BACK_SVG = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M11.03.47a.75.75 0 0 1 0 1.06L4.56 8l6.47 6.47a.75.75 0 1 1-1.06 1.06L2.44 8 9.97.47a.75.75 0 0 1 1.06 0z"/></svg>`;
  const HEART_SVG = `<svg viewBox="0 0 16 16" width="40%" height="40%" fill="currentColor"><path d="M15.72 4.5a4.2 4.2 0 0 0-7.72-2.2A4.2 4.2 0 0 0 .28 4.5c0 1.6.8 2.9 1.8 3.9L8 14.2l5.9-5.8c1-1 1.82-2.3 1.82-3.9z"/></svg>`;

  function initials(name, square) {
    const h = hueFor(name);
    return `<div class="msx-art${square ? " square" : ""}"><div class="init" style="background:linear-gradient(135deg,hsl(${h},55%,45%),hsl(${(h + 40) % 360},55%,25%))">${escapeHtml(name.charAt(0).toUpperCase())}</div></div>`;
  }
  function artistArt(a) {
    const c = a.covers || [];
    if (c.length >= 4) return `<div class="msx-art mosaic">${c.slice(0, 4).map((u) => `<img loading="lazy" src="${escapeHtml(u)}">`).join("")}</div>`;
    if (c.length) return `<div class="msx-art"><img loading="lazy" src="${escapeHtml(c[0])}"></div>`;
    return initials(a.name, false);
  }
  function playlistArt(p) {
    if (p.liked) return `<div class="msx-art square"><div class="liked">${HEART_SVG}</div></div>`;
    if (p.image) return `<div class="msx-art square"><img loading="lazy" src="${escapeHtml(p.image)}"></div>`;
    return initials(p.name, true);
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

  function openModal(startUri) {
    if (overlayEl) closeModal();
    ensureStyle();

    overlayEl = document.createElement("div");
    overlayEl.className = "msx-overlay";
    overlayEl.innerHTML = `
      <div class="msx-modal" role="dialog" aria-label="Mood Shuffle">
        <div class="msx-head">
          <button class="msx-back" title="Pick another playlist">${BACK_SVG}</button>
          <div class="msx-title"><h2></h2><p class="msx-status"></p></div>
          <button class="msx-x" title="Close">✕</button>
        </div>
        <div class="msx-bar">
          <div class="msx-seg">
            <button data-sort="count"></button>
            <button data-sort="az">A–Z</button>
          </div>
          <div class="msx-spacer"></div>
          <button class="msx-surprise" title="Pick a random artist">${DICE_SVG} Surprise me</button>
        </div>
        <div class="msx-letters"></div>
        <div class="msx-body"><div class="msx-grid"></div></div>
        <div class="msx-foot">
          <label class="msx-mine"><input type="checkbox"> Only playlists I created</label>
          <button class="msx-rescan">Refresh</button>
        </div>
      </div>`;
    document.body.appendChild(overlayEl);
    document.addEventListener("keydown", onEsc);

    const $ = (s) => overlayEl.querySelector(s);
    const modal = $(".msx-modal"), grid = $(".msx-grid"), letters = $(".msx-letters");
    const title = $(".msx-title h2"), status = $(".msx-status"), back = $(".msx-back");
    const surprise = $(".msx-surprise"), mine = $(".msx-mine"), body = $(".msx-body");

    overlayEl.addEventListener("mousedown", (e) => e.target === overlayEl && closeModal());
    $(".msx-x").onclick = closeModal;

    // view state
    let view = "playlists"; // or "artists"
    let playlists = [];
    let current = null; // { uri, name, ... }
    let tracks = [];
    let artists = [];
    let letterFilter = null;

    function applyLayout(n) {
      const { cols, width } = layoutFor(n);
      modal.style.width = width + "px";
      grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    }
    function skeleton(n = 8) {
      applyLayout(n);
      grid.innerHTML = Array.from({ length: n }, () => `<div class="msx-skel"></div>`).join("");
    }

    function renderLetters(items) {
      const sortMode = settings.sort;
      const show = sortMode === "az" && items.length > 12;
      letters.style.display = show ? "flex" : "none";
      if (!show) return;
      const present = new Set(items.map((x) => firstLetter(x.name)));
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

    function sorted(items, countKey) {
      let out = items.slice();
      if (settings.sort === "az") {
        out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
        if (letterFilter) out = out.filter((x) => firstLetter(x.name) === letterFilter);
      } else if (countKey) {
        out.sort((a, b) => (b[countKey] ?? -1) - (a[countKey] ?? -1));
      }
      return out;
    }

    function render() {
      overlayEl.querySelectorAll("[data-sort]").forEach((b) => b.classList.toggle("on", b.dataset.sort === settings.sort));
      if (view === "playlists") renderPlaylists();
      else renderArtists();
      body.scrollTop = 0;
    }

    function renderPlaylists() {
      title.textContent = "Pick a playlist";
      status.textContent = `${playlists.length} playlists in your library`;
      back.style.display = "none";
      surprise.style.display = "none";
      mine.style.display = "";
      $('[data-sort="count"]').textContent = "Your order";
      const items = settings.sort === "az" ? sorted(playlists) : playlists;
      renderLetters(playlists);
      applyLayout(playlists.length);
      grid.innerHTML = "";
      for (const p of items) {
        const card = document.createElement("button");
        card.className = "msx-card";
        card.title = p.name;
        card.innerHTML = `${playlistArt(p)}
          <div class="msx-name">${escapeHtml(p.name)}</div>
          <div class="msx-count">${p.liked ? "Your liked songs" : p.count != null ? `${p.count} songs` : "Playlist"}</div>`;
        card.onclick = () => openPlaylist(p);
        grid.appendChild(card);
      }
    }

    function renderArtists() {
      title.textContent = "Which artist are you in the mood for?";
      status.textContent = `${artists.length} artist${artists.length === 1 ? "" : "s"} in ${current.name} · ${tracks.length} songs`;
      back.style.display = "";
      mine.style.display = "none";
      surprise.style.display = artists.length > 1 ? "" : "none";
      $('[data-sort="count"]').textContent = "Most songs";
      renderLetters(artists);
      applyLayout(artists.length);
      if (!artists.length) {
        grid.innerHTML = `<div class="msx-empty" style="grid-column:1/-1">This playlist has no playable songs.</div>`;
        return;
      }
      grid.innerHTML = "";
      for (const a of sorted(artists, "count")) {
        const card = document.createElement("button");
        card.className = "msx-card";
        card.title = `Shuffle ${a.name} from ${current.name}`;
        card.innerHTML = `${artistArt(a)}
          <div class="msx-play">${PLAY_SVG}</div>
          <div class="msx-name">${escapeHtml(a.name)}</div>
          <div class="msx-count">${a.count} song${a.count > 1 ? "s" : ""}</div>`;
        card.onclick = () => startMood(a, tracks, current.name);
        grid.appendChild(card);
      }
    }

    async function showPlaylists(force) {
      view = "playlists";
      letterFilter = null;
      title.textContent = "Pick a playlist";
      status.textContent = "Loading your playlists…";
      back.style.display = "none";
      surprise.style.display = "none";
      skeleton();
      try {
        if (force || !playlists.length) playlists = await listPlaylists();
      } catch (e) {
        console.error("[Mood Shuffle]", e);
        status.textContent = "Couldn't load your playlists.";
        return;
      }
      if (overlayEl) render();
    }

    async function openPlaylist(p, force) {
      view = "artists";
      current = p;
      letterFilter = null;
      title.textContent = p.name;
      status.textContent = "Reading songs…";
      back.style.display = "";
      mine.style.display = "none";
      surprise.style.display = "none";
      skeleton(6);
      try {
        tracks = await getTracks(p.uri, force);
        artists = artistIndex(tracks);
      } catch (e) {
        console.error("[Mood Shuffle]", e);
        tracks = [];
        artists = [];
      }
      if (overlayEl && current === p) render();
    }

    back.onclick = () => showPlaylists(false);
    surprise.onclick = () => {
      if (artists.length) startMood(artists[Math.floor(Math.random() * artists.length)], tracks, current.name);
    };
    $(".msx-rescan").onclick = () => (view === "artists" ? openPlaylist(current, true) : showPlaylists(true));
    overlayEl.querySelectorAll("[data-sort]").forEach((b) => {
      b.onclick = () => {
        settings.sort = b.dataset.sort;
        letterFilter = null;
        saveSettings();
        render();
      };
    });
    const mineBox = mine.querySelector("input");
    mineBox.checked = settings.onlyMine;
    mineBox.onchange = () => {
      settings.onlyMine = mineBox.checked;
      saveSettings();
      showPlaylists(true);
    };

    // Start on the playlist you're viewing or playing; otherwise show the playlist picker
    const uri = startUri || currentPlaylistUri();
    if (uri) {
      (async () => {
        let p = null;
        try {
          playlists = await listPlaylists();
          p = playlists.find((x) => x.uri === uri);
        } catch (_) {}
        if (!p) {
          let name = "This playlist";
          try {
            const meta = await Spicetify.Platform.PlaylistAPI.getMetadata(uri);
            name = meta?.name || name;
          } catch (_) {}
          p = { uri, name, image: null, count: null, liked: uri === LIKED_URI };
          if (p.liked) p.name = "Liked Songs";
        }
        openPlaylist(p);
      })();
    } else {
      showPlaylists(false);
    }
  }

  // ---------- Entry points ----------

  const ICON = `<svg role="img" height="16" width="16" viewBox="0 0 16 16" fill="currentColor"><path d="M13.15 1.4a.75.75 0 0 1 1.06 0l1.4 1.4a.75.75 0 0 1 0 1.06l-1.4 1.4a.75.75 0 1 1-1.06-1.06l.12-.12h-.92a2.75 2.75 0 0 0-2.2 1.1L6.7 10.1a4.25 4.25 0 0 1-3.4 1.7H.75a.75.75 0 0 1 0-1.5H3.3a2.75 2.75 0 0 0 2.2-1.1l3.45-4.92a4.25 4.25 0 0 1 3.4-1.7h.92l-.12-.12a.75.75 0 0 1 0-1.06zM.75 4.2H3.3c1.03 0 2 .4 2.73 1.1l-.9 1.27A2.75 2.75 0 0 0 3.3 5.7H.75a.75.75 0 0 1 0-1.5zm9.1 5.6.9-1.27a2.75 2.75 0 0 0 1.6.97h.92l-.12-.12a.75.75 0 1 1 1.06-1.06l1.4 1.4a.75.75 0 0 1 0 1.06l-1.4 1.4a.75.75 0 1 1-1.06-1.06l.12-.12h-.92a4.25 4.25 0 0 1-2.5-.9z"/></svg>`;

  // 1) Right-click any playlist (or Liked Songs) -> "Mood Shuffle"
  try {
    if (Spicetify.ContextMenu?.Item) {
      new Spicetify.ContextMenu.Item(
        "Mood Shuffle",
        (uris) => openModal(uris[0]),
        (uris) => uris.length === 1 && (/^spotify:(user:[^:]+:)?playlist:/.test(uris[0]) || /collection(:tracks)?$/.test(uris[0])),
        ICON
      ).register();
    }
  } catch (e) {
    console.warn("[Mood Shuffle] Context menu failed", e);
  }

  // 2) Top bar button
  try {
    if (Spicetify.Topbar?.Button) new Spicetify.Topbar.Button("Mood Shuffle", ICON, () => openModal());
  } catch (e) {
    console.warn("[Mood Shuffle] Topbar button failed", e);
  }

  // 3) Profile menu item
  try {
    if (Spicetify.Menu?.Item) new Spicetify.Menu.Item("Mood Shuffle", false, () => openModal(), ICON).register();
  } catch (e) {
    console.warn("[Mood Shuffle] Menu item failed", e);
  }

  // 4) Floating button, bottom-right
  const fab = document.createElement("button");
  fab.title = "Mood Shuffle";
  fab.innerHTML = ICON.replace('height="16" width="16"', 'height="20" width="20"');
  Object.assign(fab.style, {
    position: "fixed", right: "24px", bottom: "110px", zIndex: 9999, width: "44px", height: "44px",
    borderRadius: "50%", border: "none", cursor: "pointer", display: "grid", placeItems: "center",
    background: "var(--spice-button, #1db954)", color: "#000", boxShadow: "0 4px 12px rgba(0,0,0,.5)",
  });
  fab.onclick = () => openModal();
  document.body.appendChild(fab);

  // 5) Keyboard shortcut: Cmd+Shift+M
  try {
    const mac = navigator.platform.includes("Mac");
    Spicetify.Keyboard?.registerShortcut?.({ key: "m", ctrl: !mac, meta: mac, shift: true }, () => openModal());
  } catch (_) {}
})();
