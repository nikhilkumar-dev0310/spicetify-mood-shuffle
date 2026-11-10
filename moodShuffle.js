// NAME: Mood Shuffle
// AUTHOR: Nikhil Kumar
// DESCRIPTION: Ask which artist you're in the mood for, then shuffle only that artist's songs from your own playlists (and Liked Songs).

(async function moodShuffle() {
  // Wait until Spicetify is fully loaded
  while (
    !Spicetify?.Platform?.RootlistAPI ||
    !Spicetify?.Platform?.PlaylistAPI ||
    !Spicetify?.Player ||
    !Spicetify?.PopupModal ||
    !Spicetify?.Topbar
  ) {
    await new Promise((r) => setTimeout(r, 300));
  }

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
    return { uri: t.uri, name: t.name, artists };
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
    // artist name (lowercase) -> { name, count }
    const idx = new Map();
    for (const t of map.values()) {
      for (const a of t.artists) {
        if (!a.name) continue;
        const key = a.name.toLowerCase();
        const entry = idx.get(key) || { name: a.name, count: 0 };
        entry.count++;
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
    Spicetify.PopupModal.hide();
    Spicetify.showNotification(
      `Shuffling ${shuffled.length} song${shuffled.length > 1 ? "s" : ""} by ${matches[0].artists.find((a) => a.name.toLowerCase() === target).name}`
    );
  }

  // ---------- UI ----------

  const STYLE = `
    .ms-wrap { display:flex; flex-direction:column; gap:12px; width:min(560px, 80vw); }
    .ms-bar { display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; }
    .ms-status { font-size:12px; color:var(--spice-subtext, #b3b3b3); }
    .ms-seg { display:flex; gap:4px; }
    .ms-seg button, .ms-letters button { border:none; cursor:pointer; border-radius:999px; font-size:12px;
      background:var(--spice-card, #282828); color:var(--spice-text, #fff); padding:6px 12px; }
    .ms-seg button.active, .ms-letters button.active { background:var(--spice-button, #1db954); color:#000; font-weight:700; }
    .ms-letters { display:flex; flex-wrap:wrap; gap:4px; }
    .ms-letters button { padding:4px 8px; min-width:26px; }
    .ms-letters button:disabled { opacity:.3; cursor:default; }
    .ms-list { display:grid; grid-template-columns:repeat(auto-fill, minmax(160px, 1fr)); gap:8px;
      max-height:46vh; overflow-y:auto; padding-right:4px; }
    .ms-artist { display:flex; flex-direction:column; align-items:flex-start; gap:2px; text-align:left;
      padding:10px 12px; border-radius:8px; border:2px solid transparent; cursor:pointer;
      background:var(--spice-card, #282828); color:var(--spice-text, #fff); }
    .ms-artist:hover { border-color:var(--spice-button, #1db954); }
    .ms-artist .n { font-weight:700; font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:100%; }
    .ms-artist .c { font-size:11px; color:var(--spice-subtext, #b3b3b3); }
    .ms-opts { display:flex; gap:16px; flex-wrap:wrap; font-size:12px; color:var(--spice-subtext, #b3b3b3); }
    .ms-opts label { display:flex; align-items:center; gap:6px; cursor:pointer; }
    .ms-rescan { border:1px solid var(--spice-subtext, #555); background:transparent; color:var(--spice-subtext, #b3b3b3);
      border-radius:999px; padding:6px 12px; font-size:12px; cursor:pointer; }
  `;

  const escapeHtml = (s) =>
    s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const firstLetter = (name) => {
    const ch = name.trim().charAt(0).toUpperCase();
    return /[A-Z]/.test(ch) ? ch : "#";
  };

  function buildModal() {
    const wrap = document.createElement("div");
    wrap.className = "ms-wrap";
    wrap.innerHTML = `
      <style>${STYLE}</style>
      <div class="ms-bar">
        <span class="ms-status">Loading your library…</span>
        <div class="ms-seg">
          <button data-sort="count">Most songs</button>
          <button data-sort="az">A–Z</button>
        </div>
      </div>
      <div class="ms-letters"></div>
      <div class="ms-list"></div>
      <div class="ms-bar">
        <div class="ms-opts">
          <label><input type="checkbox" data-opt="onlyMine" /> Only playlists I created</label>
          <label><input type="checkbox" data-opt="includeLiked" /> Include Liked Songs</label>
        </div>
        <button class="ms-rescan">Rescan</button>
      </div>
    `;

    const status = wrap.querySelector(".ms-status");
    const list = wrap.querySelector(".ms-list");
    const letters = wrap.querySelector(".ms-letters");
    const setStatus = (s) => (status.textContent = s);

    let artists = [];
    let letterFilter = null;

    function render() {
      const sortMode = settings.sort || "count";
      wrap.querySelectorAll("[data-sort]").forEach((b) => b.classList.toggle("active", b.dataset.sort === sortMode));

      // letter bar only in A–Z mode
      letters.style.display = sortMode === "az" ? "flex" : "none";
      if (sortMode === "az") {
        const present = new Set(artists.map((a) => firstLetter(a.name)));
        letters.innerHTML = "";
        ["All", "#", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].forEach((L) => {
          const b = document.createElement("button");
          b.textContent = L;
          b.disabled = L !== "All" && !present.has(L);
          b.classList.toggle("active", (L === "All" && !letterFilter) || L === letterFilter);
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

      list.innerHTML = "";
      for (const a of shown) {
        const btn = document.createElement("button");
        btn.className = "ms-artist";
        btn.innerHTML = `<span class="n">${escapeHtml(a.name)}</span><span class="c">${a.count} song${a.count > 1 ? "s" : ""}</span>`;
        btn.title = `Shuffle ${a.name}`;
        btn.onclick = () => startMood(a.name);
        list.appendChild(btn);
      }
      list.scrollTop = 0;
    }

    async function refresh(force) {
      setStatus("Loading your library…");
      list.innerHTML = "";
      const map = await scanLibrary(force, setStatus);
      artists = artistIndex(map);
      setStatus(`${artists.length} artists · ${map.size} songs`);
      render();
    }

    wrap.querySelectorAll("[data-sort]").forEach((b) => {
      b.onclick = () => {
        settings.sort = b.dataset.sort;
        letterFilter = null;
        saveSettings();
        render();
      };
    });

    wrap.querySelector(".ms-rescan").onclick = () => refresh(true);

    wrap.querySelectorAll("[data-opt]").forEach((cb) => {
      const key = cb.dataset.opt;
      cb.checked = settings[key];
      cb.onchange = () => {
        settings[key] = cb.checked;
        saveSettings();
        refresh(true);
      };
    });

    refresh(false).catch((e) => {
      console.error("[Mood Shuffle]", e);
      setStatus("Couldn't read your library. Check the console (Cmd+Option+I).");
    });

    return wrap;
  }

  function openModal() {
    Spicetify.PopupModal.display({
      title: "Which artist are you in the mood for?",
      content: buildModal(),
    });
  }

  // Top bar button
  new Spicetify.Topbar.Button(
    "Mood Shuffle",
    `<svg role="img" height="16" width="16" viewBox="0 0 16 16" fill="currentColor">
      <path d="M13.15 1.4a.75.75 0 0 1 1.06 0l1.4 1.4a.75.75 0 0 1 0 1.06l-1.4 1.4a.75.75 0 1 1-1.06-1.06l.12-.12h-.92a2.75 2.75 0 0 0-2.2 1.1L6.7 10.1a4.25 4.25 0 0 1-3.4 1.7H.75a.75.75 0 0 1 0-1.5H3.3a2.75 2.75 0 0 0 2.2-1.1l3.45-4.92a4.25 4.25 0 0 1 3.4-1.7h.92l-.12-.12a.75.75 0 0 1 0-1.06zM.75 4.2H3.3c1.03 0 2 .4 2.73 1.1l-.9 1.27A2.75 2.75 0 0 0 3.3 5.7H.75a.75.75 0 0 1 0-1.5zm9.1 5.6.9-1.27a2.75 2.75 0 0 0 1.6.97h.92l-.12-.12a.75.75 0 1 1 1.06-1.06l1.4 1.4a.75.75 0 0 1 0 1.06l-1.4 1.4a.75.75 0 1 1-1.06-1.06l.12-.12h-.92a4.25 4.25 0 0 1-2.5-.9z"/>
    </svg>`,
    openModal
  );

  // Keyboard shortcut: Cmd+Shift+M (Ctrl+Shift+M on Windows/Linux)
  Spicetify.Keyboard?.registerShortcut?.(
    { key: "m", ctrl: !navigator.platform.includes("Mac"), meta: navigator.platform.includes("Mac"), shift: true },
    openModal
  );

  // Warm the cache in the background so the first open is fast
  setTimeout(() => scanLibrary().catch(() => {}), 5000);
})();
