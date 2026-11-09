// Playlist Tidy for YouTube Music
// Runs in the page (MAIN world) on music.youtube.com so it can call YouTube
// Music's own web API with the signed-in session. No data leaves the page
// except requests to music.youtube.com itself.
(() => {
  'use strict';
  if (window.__playlistTidy) return;
  window.__playlistTidy = true;

  const ORIGIN = 'https://music.youtube.com';
  const SYSTEM_IDS = new Set(['LM', 'SE']); // Liked Music, Episodes for Later

  // ───────────────────────── small utilities ─────────────────────────
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
  const plural = (n, one, many = one + 's') => `${n.toLocaleString()} ${n === 1 ? one : many}`;
  const coll = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

  class TidyError extends Error {
    constructor(message, detail, status) { super(message); this.detail = detail; this.status = status; }
  }
  class Cancelled extends Error {}

  async function pool(items, n, fn) {
    let i = 0;
    const worker = async () => { while (i < items.length) { const idx = i++; await fn(items[idx], idx); } };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  }

  function getCookie(name) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + esc + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  const settings = (() => {
    const d = { loose: false };
    try { return Object.assign(d, JSON.parse(localStorage.getItem('playlistTidy.settings') || '{}')); } catch { return d; }
  })();
  const saveSettings = () => { try { localStorage.setItem('playlistTidy.settings', JSON.stringify(settings)); } catch {} };

  // ───────────────────────── YouTube Music web API ─────────────────────────
  function ytcfg(key) {
    const y = window.ytcfg;
    if (!y) return undefined;
    try { if (typeof y.get === 'function') { const v = y.get(key); if (v !== undefined) return v; } } catch {}
    return y.data_ ? y.data_[key] : undefined;
  }

  async function sha1(str) {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function authorization() {
    const sapisid = getCookie('SAPISID') || getCookie('__Secure-3PAPISID');
    if (!sapisid) throw new TidyError('You’re not signed in', 'Sign in to YouTube Music in this tab, then open Playlist Tidy again.');
    const ts = Math.floor(Date.now() / 1000);
    const parts = [`SAPISIDHASH ${ts}_${await sha1(`${ts} ${sapisid} ${ORIGIN}`)}`];
    const p1 = getCookie('__Secure-1PAPISID');
    if (p1) parts.push(`SAPISID1PHASH ${ts}_${await sha1(`${ts} ${p1} ${ORIGIN}`)}`);
    const p3 = getCookie('__Secure-3PAPISID');
    if (p3) parts.push(`SAPISID3PHASH ${ts}_${await sha1(`${ts} ${p3} ${ORIGIN}`)}`);
    return parts.join(' ');
  }

  function clientVersion() {
    const v = ytcfg('INNERTUBE_CLIENT_VERSION');
    if (v) return v;
    const d = new Date();
    return `1.${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.01.00`;
  }

  function apiContext() {
    const c = ytcfg('INNERTUBE_CONTEXT');
    if (c) return JSON.parse(JSON.stringify(c));
    return { client: { clientName: 'WEB_REMIX', clientVersion: clientVersion(), hl: document.documentElement.lang || 'en' }, user: {} };
  }

  async function api(endpoint, body = {}, query = '') {
    const key = ytcfg('INNERTUBE_API_KEY');
    const url = `${ORIGIN}/youtubei/v1/${endpoint}?prettyPrint=false${key ? '&key=' + encodeURIComponent(key) : ''}${query}`;
    for (let attempt = 0; ; attempt++) {
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': await authorization(),
        'X-Origin': ORIGIN,
        'X-Goog-AuthUser': String(ytcfg('SESSION_INDEX') ?? 0),
        'X-Youtube-Client-Name': String(ytcfg('INNERTUBE_CONTEXT_CLIENT_NAME') ?? 67),
        'X-Youtube-Client-Version': clientVersion(),
      };
      const pageId = ytcfg('DELEGATED_SESSION_ID');
      if (pageId) headers['X-Goog-PageId'] = String(pageId);
      const visitor = ytcfg('VISITOR_DATA');
      if (visitor) headers['X-Goog-Visitor-Id'] = String(visitor);

      let res;
      try {
        res = await fetch(url, { method: 'POST', credentials: 'include', headers, body: JSON.stringify({ context: apiContext(), ...body }) });
      } catch (e) {
        if (attempt < 3) { await sleep(800 * 2 ** attempt); continue; }
        throw new TidyError('Couldn’t reach YouTube Music', String(e && e.message || e));
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 4) { await sleep(1500 * 2 ** attempt); continue; }
      const raw = await res.text();
      let json = null;
      try { json = JSON.parse(raw); } catch {}
      if (!res.ok) {
        const msg = (json && json.error && json.error.message) || `HTTP ${res.status}`;
        if (res.status === 401 || res.status === 403) throw new TidyError('YouTube Music didn’t allow that', msg, res.status);
        throw new TidyError(`YouTube Music returned an error`, msg, res.status);
      }
      return json || {};
    }
  }

  // Response helpers. YouTube Music's JSON layout shifts over time, so these
  // look renderers up by name instead of relying on fixed paths.
  function findAll(obj, key, out = []) {
    if (!obj || typeof obj !== 'object') return out;
    if (Array.isArray(obj)) { for (const x of obj) findAll(x, key, out); return out; }
    for (const k in obj) {
      if (k === key) { out.push(obj[k]); continue; }
      findAll(obj[k], key, out);
    }
    return out;
  }
  const findFirst = (obj, key) => findAll(obj, key)[0];
  const txt = (t) => !t ? '' : typeof t === 'string' ? t : t.simpleText != null ? t.simpleText : Array.isArray(t.runs) ? t.runs.map((r) => r.text).join('') : '';

  function findContinuation(scope) {
    for (const c of findAll(scope, 'continuationItemRenderer')) {
      const tok = findFirst(c, 'continuationCommand');
      if (tok && tok.token) return { token: tok.token, style: 'body' };
    }
    for (const n of findAll(scope, 'nextContinuationData')) {
      if (n && n.continuation) return { token: n.continuation, style: 'query' };
    }
    return null;
  }

  function continuationRequest(cont) {
    if (cont.style === 'query') {
      const t = encodeURIComponent(cont.token);
      return api('browse', {}, `&ctoken=${t}&continuation=${t}&type=next`);
    }
    return api('browse', { continuation: cont.token });
  }
  const continuationScope = (res) => res.continuationContents || res.onResponseReceivedActions || res.onResponseReceivedCommands || res;

  function pickThumb(thumbs) {
    if (!Array.isArray(thumbs) || !thumbs.length) return '';
    const sorted = [...thumbs].sort((a, b) => (a.width || 0) - (b.width || 0));
    return (sorted.find((t) => (t.width || 0) >= 80) || sorted[sorted.length - 1]).url || '';
  }

  function parseCount(runs) {
    for (let i = runs.length - 1; i >= 1; i--) {
      const m = String(runs[i].text).match(/(\d[\d.,]*)\s*([KkMm])?\s*\p{L}/u);
      if (!m) continue;
      let n = parseFloat(m[1].replace(/,/g, ''));
      if (m[2]) return { n: Math.round(n * (/k/i.test(m[2]) ? 1e3 : 1e6)), approx: true };
      n = parseInt(m[1].replace(/[.,]/g, ''), 10);
      return Number.isFinite(n) ? { n, approx: false } : null;
    }
    return null;
  }

  function parseLibraryItem(r, kind) {
    const be = findFirst([r.navigationEndpoint, r.title, r.flexColumns], 'browseEndpoint');
    const browseId = be && be.browseId;
    if (!browseId || !browseId.startsWith('VL')) return null;
    const id = browseId.slice(2);
    const col = (i) => r.flexColumns && r.flexColumns[i] && r.flexColumns[i].musicResponsiveListItemFlexColumnRenderer && r.flexColumns[i].musicResponsiveListItemFlexColumnRenderer.text;
    const title = kind === 'two' ? txt(r.title) : txt(col(0));
    const subRuns = (kind === 'two' ? r.subtitle && r.subtitle.runs : col(1) && col(1).runs) || [];
    const menu = JSON.stringify(r.menu || {});
    let owner = 'unknown';
    if (SYSTEM_IDS.has(id)) owner = 'system';
    else if (/"iconType":"DELETE"|[dD]eletePlaylist|playlistDelete|playlistEditorEndpoint/.test(menu)) owner = 'mine';
    else if (/LIBRARY_(SAVED|REMOVE)|"likeEndpoint"/.test(menu)) owner = 'saved';
    const count = parseCount(subRuns);
    return {
      id,
      title: title || '(untitled)',
      subtitle: subRuns.map((x) => x.text).join(''),
      count: count ? count.n : null,
      countApprox: count ? count.approx : false,
      thumb: pickThumb(findFirst(r.thumbnailRenderer || r.thumbnail, 'thumbnails')),
      owner,
      scan: null,
    };
  }

  async function fetchLibrary(onProgress) {
    const out = [];
    const seen = new Set();
    const add = (scope) => {
      for (const r of findAll(scope, 'musicTwoRowItemRenderer')) push(parseLibraryItem(r, 'two'));
      for (const r of findAll(scope, 'musicResponsiveListItemRenderer')) push(parseLibraryItem(r, 'list'));
    };
    const push = (p) => { if (p && !seen.has(p.id)) { seen.add(p.id); out.push(p); } };
    const first = await api('browse', { browseId: 'FEmusic_liked_playlists' });
    const scope = findFirst(first, 'gridRenderer') || findFirst(first, 'musicShelfRenderer') || findFirst(first, 'sectionListRenderer') || first;
    add(scope);
    let cont = findContinuation(scope);
    for (let guard = 0; cont && guard < 200; guard++) {
      onProgress && onProgress(out.length);
      const res = continuationScope(await continuationRequest(cont));
      const before = out.length;
      add(res);
      cont = findContinuation(res);
      if (out.length === before && !cont) break;
    }
    return out;
  }

  function parseDuration(s) {
    if (!s || !/^\d+(:\d{1,2}){1,2}$/.test(s.trim())) return null;
    return s.trim().split(':').reduce((acc, p) => acc * 60 + parseInt(p, 10), 0);
  }

  function pageType(run) {
    const be = run && run.navigationEndpoint && run.navigationEndpoint.browseEndpoint;
    if (!be) return '';
    const pt = be.browseEndpointContextSupportedConfigs && be.browseEndpointContextSupportedConfigs.browseEndpointContextMusicConfig && be.browseEndpointContextSupportedConfigs.browseEndpointContextMusicConfig.pageType;
    if (pt) return pt;
    if (/^UC/.test(be.browseId || '')) return 'MUSIC_PAGE_TYPE_ARTIST';
    if (/^MPRE/.test(be.browseId || '')) return 'MUSIC_PAGE_TYPE_ALBUM';
    return '';
  }

  function parseTrack(r, index) {
    const pid = r.playlistItemData || {};
    let videoId = pid.videoId || null;
    let setVideoId = pid.playlistSetVideoId || null;
    if (!setVideoId) {
      for (const ep of findAll(r.menu, 'playlistEditEndpoint')) {
        const a = (ep.actions || []).find((x) => x.setVideoId);
        if (a) { setVideoId = a.setVideoId; videoId = videoId || a.removedVideoId || null; break; }
      }
    }
    if (!videoId) {
      const w = findFirst([r.overlay, r.flexColumns && r.flexColumns[0]], 'watchEndpoint');
      videoId = (w && w.videoId) || null;
    }
    const cols = (r.flexColumns || []).map((c) => c.musicResponsiveListItemFlexColumnRenderer && c.musicResponsiveListItemFlexColumnRenderer.text);
    const runs1 = (cols[1] && cols[1].runs) || [];
    const artistRuns = runs1.filter((x) => /ARTIST|USER_CHANNEL/.test(pageType(x)));
    const artist = artistRuns.length ? artistRuns.map((x) => x.text).join(', ') : runs1.map((x) => x.text).join('').split(' • ')[0];
    let album = '';
    for (const c of cols) for (const run of (c && c.runs) || []) if (/ALBUM/.test(pageType(run))) album = run.text;
    const fixed = r.fixedColumns && r.fixedColumns[0] && r.fixedColumns[0].musicResponsiveListItemFixedColumnRenderer;
    const duration = txt(fixed && fixed.text);
    return {
      index,
      videoId,
      setVideoId,
      title: txt(cols[0]) || '(untitled)',
      artist: artist || '',
      album,
      duration,
      seconds: parseDuration(duration),
      unavailable: r.musicItemRendererDisplayPolicy === 'MUSIC_ITEM_RENDERER_DISPLAY_POLICY_GREY_OUT' || !videoId,
      thumb: pickThumb(findFirst(r.thumbnail, 'thumbnails')),
    };
  }

  async function fetchPlaylist(playlistId, onProgress) {
    const first = await api('browse', { browseId: 'VL' + playlistId });
    const owned = !!findFirst(first, 'musicEditablePlaylistDetailHeaderRenderer');
    const tracks = [];
    const add = (scope) => { for (const r of findAll(scope, 'musicResponsiveListItemRenderer')) tracks.push(parseTrack(r, tracks.length)); };
    const shelf = findFirst(first, 'musicPlaylistShelfRenderer');
    let cont = null;
    if (shelf) { add(shelf.contents); cont = findContinuation(shelf); }
    for (let guard = 0; cont && guard < 1000; guard++) {
      onProgress && onProgress(tracks.length);
      const res = continuationScope(await continuationRequest(cont));
      const before = tracks.length;
      add(res);
      cont = findContinuation(res);
      if (tracks.length === before && !cont) break;
    }
    return { owned, tracks, at: Date.now() };
  }

  async function editPlaylist(playlistId, actions) {
    const res = await api('browse/edit_playlist', { playlistId, actions });
    if (res.status && !/SUCCEEDED/.test(String(res.status))) throw new TidyError('YouTube Music didn’t accept the change', String(res.status));
    return res;
  }

  async function removeTracks(playlistId, tracks, job) {
    const editable = tracks.filter((t) => t.setVideoId);
    for (const part of chunk(editable, 50)) {
      job && job.check();
      await editPlaylist(playlistId, part.map((t) => {
        const a = { action: 'ACTION_REMOVE_VIDEO', setVideoId: t.setVideoId };
        if (t.videoId) a.removedVideoId = t.videoId;
        return a;
      }));
      job && job.tick(part.length);
      await sleep(250);
    }
    return editable.length;
  }

  async function createPlaylist(title, videoIds, privacy = 'PRIVATE', description = '', job) {
    const res = await api('playlist/create', { title: title.slice(0, 150), description, privacyStatus: privacy, videoIds: videoIds.slice(0, 100) });
    const id = res.playlistId;
    if (!id) throw new TidyError('Couldn’t create the playlist', 'YouTube Music didn’t return a playlist ID.');
    job && job.tick(Math.min(100, videoIds.length));
    for (const part of chunk(videoIds.slice(100), 100)) {
      job && job.check();
      await sleep(300);
      await editPlaylist(id, part.map((v) => ({ action: 'ACTION_ADD_VIDEO', addedVideoId: v, dedupeOption: 'DEDUPE_OPTION_SKIP' })));
      job && job.tick(part.length);
    }
    return id;
  }

  const deletePlaylist = (id) => api('playlist/delete', { playlistId: id });
  const removeFromLibrary = (id) => api('like/removelike', { target: { playlistId: id } });

  // ───────────────────────── analysis ─────────────────────────
  function norm(s) {
    return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[([][^)\]]*[)\]]/g, ' ')
      .replace(/\s(feat|ft)\.?\s.*$/, ' ')
      .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
  }

  function analyze(tracks, loose) {
    const seen = new Map();
    const dupes = [];
    const unavailable = [];
    for (const t of tracks) {
      if (t.unavailable) { unavailable.push(t); continue; }
      const keys = ['v:' + t.videoId];
      const nt = norm(t.title);
      if (loose && nt) keys.push('n:' + nt + '|' + norm(t.artist));
      const hit = keys.find((k) => seen.has(k));
      if (hit) dupes.push({ track: t, of: seen.get(hit) });
      else keys.forEach((k) => seen.set(k, t));
    }
    return { dupes, unavailable };
  }

  function an(p) {
    if (!p.scan) return null;
    if (!p._an || p._an.loose !== settings.loose || p._an.at !== p.scan.at) {
      p._an = { loose: settings.loose, at: p.scan.at, res: analyze(p.scan.tracks, settings.loose) };
    }
    return p._an.res;
  }
  const trackCount = (p) => p.scan ? p.scan.tracks.length : p.count;
  const fixable = (p) => p.owner === 'mine';

  function setScan(p, scan) {
    p.scan = scan;
    if (p.owner !== 'system') p.owner = scan.owned ? 'mine' : 'saved';
    p.count = scan.tracks.length;
    p.countApprox = false;
  }

  // Minimal reorder: keep the longest run already in target order, move the rest.
  function lisKeep(seq) {
    const tails = [], tailIdx = [], prev = new Array(seq.length).fill(-1);
    for (let i = 0; i < seq.length; i++) {
      let lo = 0, hi = tails.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < seq[i]) lo = mid + 1; else hi = mid; }
      tails[lo] = seq[i]; tailIdx[lo] = i; prev[i] = lo > 0 ? tailIdx[lo - 1] : -1;
    }
    const keep = new Set();
    for (let k = tails.length ? tailIdx[tails.length - 1] : -1; k >= 0; k = prev[k]) keep.add(k);
    return keep;
  }
  function planMoves(currentIds, targetIds) {
    const pos = new Map(currentIds.map((id, i) => [id, i]));
    const keep = lisKeep(targetIds.map((id) => pos.get(id)));
    const moves = [];
    for (let i = targetIds.length - 1; i >= 0; i--) if (!keep.has(i)) moves.push({ id: targetIds[i], before: targetIds[i + 1] || null });
    return moves;
  }

  const SORTS = {
    title: { label: 'Title (A–Z)', cmp: (a, b) => coll.compare(a.title, b.title) || coll.compare(a.artist, b.artist) },
    title_desc: { label: 'Title (Z–A)', cmp: (a, b) => coll.compare(b.title, a.title) || coll.compare(a.artist, b.artist) },
    artist: { label: 'Artist (A–Z)', cmp: (a, b) => coll.compare(a.artist, b.artist) || coll.compare(a.album, b.album) || coll.compare(a.title, b.title) },
    album: { label: 'Album (A–Z)', cmp: (a, b) => coll.compare(a.album, b.album) || coll.compare(a.artist, b.artist) || coll.compare(a.title, b.title) },
    duration: { label: 'Shortest first', cmp: (a, b) => (a.seconds ?? Infinity) - (b.seconds ?? Infinity) },
    duration_desc: { label: 'Longest first', cmp: (a, b) => (b.seconds ?? -1) - (a.seconds ?? -1) },
    reverse: { label: 'Reverse current order' },
    shuffle: { label: 'Shuffle' },
  };
  function sortedTracks(tracks, key) {
    if (key === 'reverse') return [...tracks].reverse();
    if (key === 'shuffle') {
      const a = [...tracks];
      for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
      return a;
    }
    const cmp = SORTS[key].cmp;
    return [...tracks].sort((a, b) => cmp(a, b) || a.index - b.index);
  }

  // ───────────────────────── backup files ─────────────────────────
  function backupEntry(p) {
    return {
      id: p.id,
      title: p.title,
      owner: p.owner === 'mine' ? 'you' : 'someone else',
      url: `${ORIGIN}/playlist?list=${p.id}`,
      tracks: (p.scan ? p.scan.tracks : []).map((t) => ({ videoId: t.videoId, title: t.title, artist: t.artist, album: t.album, duration: t.duration, unavailable: t.unavailable || undefined })),
    };
  }
  function downloadFile(name, text, type = 'application/json') {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = h('a', { href: url, download: name, style: { display: 'none' } });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  function downloadBackup(playlists, label = 'backup') {
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    const data = { app: 'playlist-tidy', version: 1, exportedAt: d.toISOString(), playlists: playlists.map(backupEntry) };
    downloadFile(`ytmusic-playlists-${label}-${stamp}.json`, JSON.stringify(data, null, 2));
  }

  // ───────────────────────── DOM helpers (no innerHTML: YouTube enforces Trusted Types) ─────────────────────────
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (typeof v !== 'string' && k in el) el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
    return el;
  }
  const clear = (el) => { while (el.firstChild) el.firstChild.remove(); return el; };
  const put = (el, ...kids) => { el.append(...kids.flat(Infinity).filter((k) => k != null && k !== false)); return el; };

  const PATHS = {
    wand: 'M7.5 5.6 10 7 8.6 4.5 10 2 7.5 3.4 5 2l1.4 2.5L5 7zm12 9.8L17 14l1.4 2.5L17 19l2.5-1.4L22 19l-1.4-2.5L22 14zM22 2l-2.5 1.4L17 2l1.4 2.5L17 7l2.5-1.4L22 7l-1.4-2.5zm-7.63 5.29a.996.996 0 0 0-1.41 0L1.29 18.96a.996.996 0 0 0 0 1.41l2.34 2.34c.39.39 1.02.39 1.41 0L16.7 11.05a.996.996 0 0 0 0-1.41l-2.33-2.35zm-1.03 5.49-2.12-2.12 2.44-2.44 2.12 2.12-2.44 2.44z',
    close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    back: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
    chevron: 'M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z',
    trash: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
    download: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z',
    upload: 'M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z',
    merge: 'M17 20.41 18.41 19 15 15.59 13.59 17 17 20.41zM7.5 8H11v5.59L5.59 19 7 20.41l6-6V8h3.5L12 3.5 7.5 8z',
    sort: 'M3 18h6v-2H3v2zM3 6v2h18V6H3zm0 7h12v-2H3v2z',
    search: 'M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
    refresh: 'M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
    music: 'M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z',
    check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
  };
  function icon(name, cls = 'ic') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', cls);
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', PATHS[name]);
    svg.append(path);
    return svg;
  }
  const iconBtn = (name, title, onclick, cls = '') => h('button', { class: 'ibtn ' + cls, title, 'aria-label': title, onclick }, icon(name));
  const btn = (label, onclick, cls = '', iconName) => h('button', { class: 'btn ' + cls, onclick }, iconName ? icon(iconName) : null, label);
  function thumbEl(src) {
    if (!src) return h('div', { class: 'thumb ph' }, icon('music'));
    return h('img', { class: 'thumb', src, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' });
  }

  // ───────────────────────── styles ─────────────────────────
  const CSS = `
  :host { all: initial; }
  .theme {
    --bg: #131313; --raise: #1c1c1c; --raise2: #262626; --line: #2c2c2c; --line2: #3a3a3a;
    --text: #f2f2f2; --muted: #a3a3a3; --faint: #6f6f6f;
    --accent: #62e3b4; --accent-ink: #052b1d; --danger: #ff6f6f; --warn: #f3b552; --dupe: #93b8ff;
    font: 400 13px/1.45 Roboto, "Helvetica Neue", Arial, sans-serif; color: var(--text);
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  button { font: inherit; color: inherit; }
  .ic { width: 18px; height: 18px; fill: currentColor; flex: none; }

  .launcher { position: fixed; right: 24px; bottom: 92px; z-index: 2147483000; display: flex; align-items: center; gap: 8px;
    height: 40px; padding: 0 16px 0 12px; border-radius: 20px; border: 1px solid rgba(255,255,255,.14); background: #1f1f1f;
    color: #fff; font-weight: 500; font-size: 14px; cursor: pointer; box-shadow: 0 8px 28px rgba(0,0,0,.5); transition: background .15s, transform .15s; }
  .launcher:hover { background: #2a2a2a; transform: translateY(-1px); }
  .launcher .ic { color: var(--accent); }

  .panel { position: fixed; top: 72px; right: 16px; bottom: 88px; width: min(460px, calc(100vw - 32px)); z-index: 2147483001;
    display: flex; flex-direction: column; background: var(--bg); border: 1px solid var(--line); border-radius: 16px;
    box-shadow: 0 28px 80px rgba(0,0,0,.65); overflow: hidden; }
  .hd { display: flex; align-items: center; gap: 6px; padding: 12px 10px 10px 16px; border-bottom: 1px solid var(--line); }
  .brand { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 500; letter-spacing: .1px; }
  .brand .ic { color: var(--accent); }
  .grow { flex: 1; }
  .ibtn { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 50%; border: 0; background: transparent; color: var(--muted); cursor: pointer; }
  .ibtn:hover { background: var(--raise2); color: var(--text); }
  .btn { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 14px; border-radius: 16px; border: 1px solid var(--line2);
    background: transparent; color: var(--text); font-weight: 500; cursor: pointer; white-space: nowrap; }
  .btn .ic { width: 16px; height: 16px; }
  .btn:hover { background: var(--raise2); }
  .btn:disabled { opacity: .45; cursor: default; background: transparent; }
  .btn.primary { background: var(--text); color: #0b0b0b; border-color: var(--text); }
  .btn.primary:hover { background: #fff; }
  .btn.accent { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
  .btn.danger { color: var(--danger); border-color: rgba(255,111,111,.45); }
  .btn.danger:hover { background: rgba(255,111,111,.12); }
  .btn.danger.solid { background: var(--danger); color: #2a0505; border-color: var(--danger); }
  .btn.sm { height: 28px; padding: 0 11px; font-size: 12px; }
  .link { border: 0; background: none; padding: 0; color: var(--accent); cursor: pointer; font-weight: 500; }
  .link:hover { text-decoration: underline; }

  .banner { display: flex; align-items: center; gap: 10px; padding: 8px 16px; background: rgba(98,227,180,.08); border-bottom: 1px solid var(--line); color: var(--muted); font-size: 12px; }
  .banner b { color: var(--text); font-weight: 500; }

  .view { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 10px 16px; }
  .searchbox { flex: 1; display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 12px; border-radius: 8px; background: var(--raise); border: 1px solid var(--line); color: var(--faint); }
  .searchbox:focus-within { border-color: var(--line2); color: var(--muted); }
  .searchbox input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--text); font: inherit; }
  select { height: 34px; border-radius: 8px; border: 1px solid var(--line); background: var(--raise); color: var(--text); font: inherit; padding: 0 8px; cursor: pointer; }

  .card { margin: 0 16px 8px; padding: 12px 14px; border-radius: 12px; background: var(--raise); border: 1px solid var(--line); }
  .card .row { display: flex; align-items: center; gap: 12px; }
  .card .lead { flex: 1; color: var(--muted); }
  .card .lead b { display: block; color: var(--text); font-weight: 500; font-size: 13px; margin-bottom: 1px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 11px; border-radius: 14px; border: 1px solid var(--line2);
    background: transparent; color: var(--text); cursor: pointer; font-size: 12px; }
  .chip:hover { background: var(--raise2); }
  .chip .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .chip.on { background: var(--text); color: #0b0b0b; border-color: var(--text); }
  .chip.c-empty .dot { color: var(--faint); } .chip.c-dupes .dot { color: var(--dupe); } .chip.c-unav .dot { color: var(--warn); } .chip.c-saved .dot { color: var(--muted); }
  .chip.on .dot { color: #0b0b0b; }
  .meta { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 10px; color: var(--faint); font-size: 12px; }
  .switch { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; color: var(--muted); user-select: none; }
  .switch input { accent-color: var(--accent); margin: 0; }
  .prog { height: 4px; border-radius: 2px; background: var(--raise2); overflow: hidden; margin-top: 10px; }
  .prog > i { display: block; height: 100%; background: var(--accent); transition: width .2s; }
  .ok { color: var(--accent); display: flex; align-items: center; gap: 8px; }

  .selrow { display: flex; align-items: center; gap: 10px; padding: 6px 16px 6px 18px; color: var(--muted); font-size: 12px; border-bottom: 1px solid var(--line); }
  input[type=checkbox] { width: 16px; height: 16px; margin: 0; accent-color: var(--accent); cursor: pointer; flex: none; }
  input[type=checkbox]:disabled { cursor: default; opacity: .3; }
  .list { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 4px 0 8px; scrollbar-width: thin; scrollbar-color: #3a3a3a transparent; }
  .item { display: flex; align-items: center; gap: 12px; padding: 7px 10px 7px 18px; cursor: pointer; }
  .item:hover { background: var(--raise); }
  .item.sel { background: rgba(98,227,180,.07); }
  .thumb { width: 40px; height: 40px; border-radius: 4px; object-fit: cover; background: var(--raise2); flex: none; }
  .thumb.ph { display: grid; place-items: center; color: var(--faint); }
  .body { flex: 1; min-width: 0; }
  .t1 { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 14px; }
  .t2 { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--muted); font-size: 12px; }
  .tags { display: flex; gap: 4px; flex: none; }
  .tag { height: 20px; padding: 0 7px; border-radius: 10px; font-size: 11px; line-height: 20px; white-space: nowrap; background: var(--raise2); color: var(--muted); }
  .tag.dupe { background: rgba(147,184,255,.14); color: var(--dupe); }
  .tag.unav { background: rgba(243,181,82,.14); color: var(--warn); }
  .tag.empty { background: transparent; border: 1px solid var(--line2); line-height: 18px; color: var(--muted); }
  .chev { color: var(--faint); }
  .item:hover .chev { color: var(--text); }
  .empty-state { padding: 40px 24px; text-align: center; color: var(--muted); }
  .empty-state b { display: block; color: var(--text); font-size: 14px; font-weight: 500; margin-bottom: 4px; }
  .spinner { width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--line2); border-top-color: var(--accent); animation: spin .8s linear infinite; margin: 0 auto 12px; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .dhead { display: flex; align-items: center; gap: 10px; padding: 10px 16px 6px 8px; }
  .dhead .body .t1 { font-size: 16px; font-weight: 500; }
  .tabs { display: flex; gap: 4px; padding: 6px 16px 8px; border-bottom: 1px solid var(--line); }
  .tab { height: 28px; padding: 0 12px; border-radius: 14px; border: 0; background: transparent; color: var(--muted); cursor: pointer; font-size: 12px; }
  .tab:hover { background: var(--raise2); color: var(--text); }
  .tab.on { background: var(--raise2); color: var(--text); }
  .track { display: flex; align-items: center; gap: 10px; padding: 6px 12px 6px 18px; }
  .track:hover { background: var(--raise); }
  .track.sel { background: rgba(98,227,180,.07); }
  .track.unav .t1, .track.unav .t2 { opacity: .5; }
  .num { width: 26px; text-align: right; color: var(--faint); font-size: 12px; font-variant-numeric: tabular-nums; flex: none; }
  .dur { color: var(--faint); font-size: 12px; font-variant-numeric: tabular-nums; flex: none; }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .sortrow { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
  .sortrow select { flex: 1; height: 32px; }

  .ft { display: flex; align-items: center; gap: 6px; padding: 10px 12px 12px 16px; border-top: 1px solid var(--line); background: var(--bg); }
  .ft .count { font-weight: 500; white-space: nowrap; }
  .ft .hint { flex: 1; min-width: 0; color: var(--faint); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ft .spacer { flex: 1; }
  .ft .btn.sm { padding: 0 10px; }

  .toast { position: absolute; left: 16px; right: 16px; bottom: 70px; display: flex; align-items: center; gap: 12px; padding: 11px 14px;
    border-radius: 10px; background: #f2f2f2; color: #111; box-shadow: 0 10px 30px rgba(0,0,0,.5); font-size: 13px; z-index: 3; }
  .toast .grow { flex: 1; }
  .toast .link { color: #0a6e4a; }

  .overlay { position: absolute; inset: 0; background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center; padding: 20px; z-index: 4; }
  .dialog { width: 100%; max-height: 100%; overflow: auto; background: #1d1d1d; border: 1px solid var(--line2); border-radius: 14px; padding: 18px 18px 14px; box-shadow: 0 20px 60px rgba(0,0,0,.6); }
  .dialog h3 { margin: 0 0 8px; font-size: 16px; font-weight: 500; }
  .dialog p { margin: 0 0 10px; color: var(--muted); }
  .dialog ul { margin: 0 0 12px; padding: 0 0 0 18px; color: var(--text); max-height: 140px; overflow: auto; }
  .dialog li { margin: 2px 0; }
  .dialog .opt { display: flex; align-items: flex-start; gap: 10px; margin: 8px 0; color: var(--text); cursor: pointer; }
  .dialog .opt input { margin-top: 2px; }
  .dialog .opt small { display: block; color: var(--faint); font-size: 12px; }
  .dialog .field { display: block; margin: 8px 0 12px; }
  .dialog .field span { display: block; color: var(--muted); font-size: 12px; margin-bottom: 4px; }
  .dialog .field input, .dialog .field select { width: 100%; height: 36px; border-radius: 8px; border: 1px solid var(--line2); background: var(--bg); color: var(--text); padding: 0 10px; font: inherit; outline: 0; }
  .dialog .field input:focus { border-color: var(--accent); }
  .dialog .checklist { max-height: 220px; overflow: auto; border: 1px solid var(--line); border-radius: 8px; padding: 4px 10px; margin-bottom: 12px; }
  .dialog .err { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: var(--faint); background: var(--bg); padding: 8px 10px; border-radius: 6px; white-space: pre-wrap; word-break: break-word; }
  .dialog .btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
  .job { width: 100%; background: #1d1d1d; border: 1px solid var(--line2); border-radius: 14px; padding: 18px; }
  .job h3 { margin: 0 0 4px; font-size: 15px; font-weight: 500; }
  .job p { margin: 0; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .job .prog { height: 6px; border-radius: 3px; margin: 14px 0; }
  .job .btns { display: flex; justify-content: space-between; align-items: center; color: var(--faint); font-size: 12px; }
  `;

  // ───────────────────────── state ─────────────────────────
  const state = {
    open: false,
    loaded: false,
    loading: false,
    error: null,
    playlists: [],
    selected: new Set(),
    query: '',
    sort: 'library',
    filter: null,
    scan: null,       // { done, total } while scanning
    scannedAt: null,
    detail: null,     // { id, loading, error, filter, selected:Set, sortKey }
    job: null,
    changed: false,
  };
  const byId = (id) => state.playlists.find((p) => p.id === id);

  // ───────────────────────── mount ─────────────────────────
  let shadow, panel, launcher, viewEl, footEl, toastEl, overlayEl, bannerEl;
  let libRefs = null; // { scanCard, list, selAll, selLabel, rows: Map }
  let lastClicked = null;

  function mount() {
    const host = h('div', { id: 'playlist-tidy-host' });
    // Keep YouTube Music's keyboard shortcuts (space, j/k, /) from firing while typing in the panel.
    for (const t of ['keydown', 'keyup', 'keypress']) host.addEventListener(t, (e) => {
      if (t === 'keydown' && e.key === 'Escape') onEscape();
      e.stopPropagation();
    });
    shadow = host.attachShadow({ mode: 'open' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      shadow.adoptedStyleSheets = [sheet];
    } catch {
      const style = document.createElement('style');
      style.textContent = CSS;
      shadow.append(style);
    }
    launcher = h('button', { class: 'launcher', title: 'Tidy your playlists (Alt+Shift+T)', onclick: () => setOpen(true) }, icon('wand'), 'Tidy');
    panel = h('section', { class: 'panel', hidden: true, role: 'dialog', 'aria-label': 'Playlist Tidy' },
      h('header', { class: 'hd' },
        h('div', { class: 'brand' }, icon('wand'), h('span', {}, 'Playlist Tidy')),
        h('div', { class: 'grow' }),
        iconBtn('refresh', 'Reload library', () => { if (!state.job) loadLibrary(); }),
        iconBtn('close', 'Close', () => setOpen(false))),
      bannerEl = h('div', { class: 'banner', hidden: true },
        h('span', { class: 'grow' }, h('b', {}, 'Changes saved. '), 'Refresh YouTube Music to see them there.'),
        h('button', { class: 'link', onclick: () => location.reload() }, 'Refresh')),
      viewEl = h('div', { class: 'view' }),
      footEl = h('footer', { class: 'ft' }),
      toastEl = h('div', { class: 'toast', hidden: true }),
      overlayEl = h('div', { class: 'overlay', hidden: true }));
    shadow.append(h('div', { class: 'theme' }, launcher, panel));
    (document.body || document.documentElement).append(host);
  }

  // The floating button only appears where it's useful: library and playlist pages.
  const launcherWanted = () => /^\/(library|playlist)/.test(location.pathname);
  function syncLauncher() { if (launcher) launcher.hidden = state.open || !launcherWanted(); }
  setInterval(syncLauncher, 1000);

  function setOpen(open) {
    state.open = open;
    panel.hidden = !open;
    syncLauncher();
    if (open && !state.loaded && !state.loading) loadLibrary();
    else if (open) render();
  }
  function onEscape() {
    if (state.job) return;
    if (!overlayEl.hidden && overlayEl._resolve) { overlayEl._resolve(null); return; }
    if (state.detail) { closeDetail(); return; }
    setOpen(false);
  }

  window.addEventListener('playlist-tidy:toggle', () => setOpen(!state.open));
  window.addEventListener('playlist-tidy:open', () => setOpen(true));

  // ───────────────────────── loading ─────────────────────────
  async function loadLibrary() {
    state.loading = true;
    state.error = null;
    render();
    try {
      if (ytcfg('LOGGED_IN') === false) throw new TidyError('You’re not signed in', 'Sign in to YouTube Music, then open Playlist Tidy again.');
      const fresh = await fetchLibrary((n) => { state.loadingCount = n; if (!state.playlists.length) render(); });
      const old = new Map(state.playlists.map((p) => [p.id, p]));
      for (const p of fresh) {
        const prev = old.get(p.id);
        if (prev && prev.scan) { setScan(p, prev.scan); if (prev.thumb && !p.thumb) p.thumb = prev.thumb; }
      }
      state.playlists = fresh;
      for (const id of [...state.selected]) if (!byId(id)) state.selected.delete(id);
      state.loaded = true;
    } catch (e) {
      state.error = e;
    } finally {
      state.loading = false;
      state.loadingCount = 0;
      render();
    }
  }

  async function scanLibrary() {
    const targets = state.playlists.filter((p) => p.owner !== 'system');
    state.scan = { done: 0, total: targets.length, failed: 0 };
    renderScanCard();
    await pool(targets, 3, async (p) => {
      try { setScan(p, await fetchPlaylist(p.id)); } catch { state.scan.failed++; }
      state.scan.done++;
      renderScanCard();
    });
    const failed = state.scan.failed;
    state.scan = null;
    state.scannedAt = Date.now();
    render();
    if (failed) toast(`Couldn’t read ${plural(failed, 'playlist')}. Try scanning again.`);
  }

  // ───────────────────────── rendering ─────────────────────────
  function render() {
    if (!panel || panel.hidden) return;
    // A filter whose chip has disappeared (e.g. all empty playlists were deleted) would leave a blank list.
    if (state.filter && !state.playlists.some(FILTERS[state.filter].test)) state.filter = null;
    bannerEl.hidden = !state.changed;
    if (state.detail) renderDetail(); else renderLibrary();
    renderFooter();
  }

  const FILTERS = {
    empty: { label: (n) => plural(n, 'empty playlist'), cls: 'c-empty', test: (p) => p.owner !== 'system' && p.owner !== 'saved' && trackCount(p) === 0 },
    dupes: { label: (n, x) => `${plural(x, 'duplicate')} · ${plural(n, 'playlist')}`, cls: 'c-dupes', test: (p) => fixable(p) && !!an(p) && an(p).dupes.length > 0, extra: (p) => an(p).dupes.length },
    unav: { label: (n, x) => `${x.toLocaleString()} unavailable · ${plural(n, 'playlist')}`, cls: 'c-unav', test: (p) => fixable(p) && !!an(p) && an(p).unavailable.length > 0, extra: (p) => an(p).unavailable.length },
    saved: { label: (n) => `${n.toLocaleString()} saved from others`, cls: 'c-saved', test: (p) => p.owner === 'saved' },
  };

  function visiblePlaylists() {
    let list = state.playlists;
    const q = state.query.trim().toLowerCase();
    if (q) list = list.filter((p) => p.title.toLowerCase().includes(q) || p.subtitle.toLowerCase().includes(q));
    if (state.filter) list = list.filter(FILTERS[state.filter].test);
    if (state.sort === 'name') list = [...list].sort((a, b) => coll.compare(a.title, b.title));
    else if (state.sort === 'most') list = [...list].sort((a, b) => (trackCount(b) ?? -1) - (trackCount(a) ?? -1));
    else if (state.sort === 'fewest') list = [...list].sort((a, b) => (trackCount(a) ?? Infinity) - (trackCount(b) ?? Infinity));
    return list;
  }

  function stateBlock(kind, title, detail, action) {
    return h('div', { class: 'empty-state' },
      kind === 'loading' ? h('div', { class: 'spinner' }) : null,
      h('b', {}, title),
      detail ? h('div', {}, detail) : null,
      action ? h('div', { style: { marginTop: '14px' } }, action) : null);
  }

  function renderLibrary() {
    const prevScroll = libRefs && libRefs.list ? libRefs.list.scrollTop : (state.libScroll || 0);
    state.libScroll = 0;
    clear(viewEl);
    libRefs = null;
    if (!state.loaded) {
      if (state.error) put(viewEl, stateBlock('error', state.error.message, state.error.detail, btn('Try again', () => loadLibrary(), 'primary')));
      else put(viewEl, stateBlock('loading', 'Loading your library…', state.loadingCount ? `${plural(state.loadingCount, 'playlist')} so far` : null));
      return;
    }
    const sortSel = h('select', { title: 'Order', onchange: (e) => { state.sort = e.target.value; renderList(); } },
      [['library', 'Library order'], ['name', 'Name'], ['most', 'Most songs'], ['fewest', 'Fewest songs']].map(([v, l]) => h('option', { value: v, selected: state.sort === v }, l)));
    const search = h('input', { type: 'search', placeholder: `Search ${plural(state.playlists.length, 'playlist')}`, value: state.query,
      oninput: (e) => { state.query = e.target.value; renderList(); } });
    const selAll = h('input', { type: 'checkbox', title: 'Select all shown', onchange: (e) => {
      const vis = visiblePlaylists().filter((p) => p.owner !== 'system');
      if (e.target.checked) vis.forEach((p) => state.selected.add(p.id)); else vis.forEach((p) => state.selected.delete(p.id));
      syncSelection();
    } });
    const selLabel = h('span', { class: 'grow' });
    const list = h('div', { class: 'list' });
    const scanCard = h('div');
    put(viewEl, 
      h('div', { class: 'bar' }, h('label', { class: 'searchbox' }, icon('search'), search), sortSel),
      scanCard,
      h('div', { class: 'selrow' }, selAll, selLabel),
      list);
    libRefs = { scanCard, list, selAll, selLabel, rows: new Map() };
    renderScanCard();
    renderList();
    list.scrollTop = prevScroll;
    if (state.error) toast(state.error.message + (state.error.detail ? ' — ' + state.error.detail : ''));
  }

  function renderScanCard() {
    if (!libRefs) return;
    const el = clear(libRefs.scanCard);
    if (state.scan) {
      const pct = state.scan.total ? (state.scan.done / state.scan.total) * 100 : 0;
      el.append(h('div', { class: 'card' },
        h('div', { class: 'row' }, h('div', { class: 'lead' }, h('b', {}, 'Scanning your playlists…'), `${state.scan.done} of ${state.scan.total} checked`)),
        h('div', { class: 'prog' }, h('i', { style: { width: pct + '%' } }))));
      return;
    }
    if (!state.scannedAt) {
      const quickEmpty = state.playlists.filter(FILTERS.empty.test).length;
      el.append(h('div', { class: 'card' },
        h('div', { class: 'row' },
          h('div', { class: 'lead' }, h('b', {}, 'Find what needs tidying'), 'Checks every playlist for duplicate songs, unavailable songs and empty playlists.'),
          btn('Scan', () => scanLibrary(), 'accent', 'wand')),
        quickEmpty || state.playlists.some(FILTERS.saved.test) ? h('div', { class: 'chips', style: { marginTop: '10px' } }, chips(['empty', 'saved'])) : null));
      return;
    }
    const any = ['empty', 'dupes', 'unav'].some((k) => state.playlists.some(FILTERS[k].test));
    const hasSaved = state.playlists.some(FILTERS.saved.test);
    el.append(h('div', { class: 'card' },
      any ? h('div', { class: 'chips' }, chips(['empty', 'dupes', 'unav', 'saved']))
        : h('div', { class: 'ok' }, icon('check'), 'All tidy — no duplicates, unavailable songs or empty playlists.'),
      !any && hasSaved ? h('div', { class: 'chips', style: { marginTop: '10px' } }, chips(['saved'])) : null,
      h('div', { class: 'meta' },
        h('label', { class: 'switch', title: 'Also flags the same song uploaded twice, e.g. the album version and the single' },
          h('input', { type: 'checkbox', checked: settings.loose, onchange: (e) => { settings.loose = e.target.checked; saveSettings(); render(); } }),
          'Match same title & artist'),
        h('button', { class: 'link', onclick: () => scanLibrary() }, 'Scan again'))));
  }

  function chips(keys) {
    return keys.map((k) => {
      const f = FILTERS[k];
      const hits = state.playlists.filter(f.test);
      if (!hits.length) return null;
      const extra = f.extra ? hits.reduce((s, p) => s + f.extra(p), 0) : 0;
      return h('button', {
        class: `chip ${f.cls}${state.filter === k ? ' on' : ''}`,
        title: state.filter === k ? 'Show all playlists' : 'Show and select these',
        onclick: () => {
          if (state.filter === k) { state.filter = null; state.selected.clear(); }
          else { state.filter = k; state.selected = new Set(hits.map((p) => p.id)); }
          renderScanCard(); renderList(); renderFooter();
        },
      }, h('span', { class: 'dot' }), f.label(hits.length, extra));
    });
  }

  function playlistTags(p) {
    const tags = [];
    if (p.owner === 'system') tags.push(h('span', { class: 'tag' }, 'Auto'));
    if (p.owner === 'saved') tags.push(h('span', { class: 'tag' }, 'Saved'));
    if (p.owner !== 'system' && p.owner !== 'saved' && trackCount(p) === 0) tags.push(h('span', { class: 'tag empty' }, 'Empty'));
    const a = an(p);
    if (a && fixable(p)) {
      if (a.dupes.length) tags.push(h('span', { class: 'tag dupe', title: 'Duplicate songs' }, `${a.dupes.length} dup${a.dupes.length === 1 ? 'e' : 'es'}`));
      if (a.unavailable.length) tags.push(h('span', { class: 'tag unav', title: 'Unavailable songs' }, `${a.unavailable.length} unavail.`));
    }
    return tags;
  }

  function playlistSubtitle(p) {
    if (p.scan) {
      const who = p.owner === 'mine' ? 'Your playlist' : p.owner === 'saved' ? (p.subtitle.split(' • ')[0] || 'Saved') : p.subtitle.split(' • ')[0];
      return `${who} • ${plural(p.scan.tracks.length, 'song')}`;
    }
    return p.subtitle;
  }

  function renderList() {
    if (!libRefs) return;
    const { list, rows } = libRefs;
    clear(list);
    rows.clear();
    const vis = visiblePlaylists();
    if (!vis.length) {
      list.append(stateBlock('none', state.playlists.length ? 'No matching playlists' : 'Your library has no playlists yet',
        state.filter ? h('button', { class: 'link', onclick: () => { state.filter = null; render(); } }, 'Show all') : null));
    }
    for (const p of vis) {
      const locked = p.owner === 'system';
      const cb = h('input', { type: 'checkbox', disabled: locked, title: locked ? 'Automatic playlists can’t be changed' : 'Select', checked: state.selected.has(p.id),
        onclick: (e) => { e.stopPropagation(); onRowCheck(p.id, e.target.checked, e.shiftKey); } });
      const row = h('div', { class: 'item' + (state.selected.has(p.id) ? ' sel' : ''), title: 'Open', onclick: () => openDetail(p.id) },
        cb, thumbEl(p.thumb),
        h('div', { class: 'body' }, h('div', { class: 't1' }, p.title), h('div', { class: 't2' }, playlistSubtitle(p))),
        h('div', { class: 'tags' }, playlistTags(p)),
        icon('chevron', 'ic chev'));
      rows.set(p.id, { row, cb });
      list.append(row);
    }
    syncSelection();
  }

  function onRowCheck(id, checked, shift) {
    const vis = visiblePlaylists().filter((p) => p.owner !== 'system').map((p) => p.id);
    if (shift && lastClicked && vis.includes(lastClicked)) {
      const [a, b] = [vis.indexOf(lastClicked), vis.indexOf(id)].sort((x, y) => x - y);
      for (const x of vis.slice(a, b + 1)) checked ? state.selected.add(x) : state.selected.delete(x);
    } else {
      checked ? state.selected.add(id) : state.selected.delete(id);
    }
    lastClicked = id;
    syncSelection();
  }

  function syncSelection() {
    if (libRefs) {
      for (const [id, { row, cb }] of libRefs.rows) { const on = state.selected.has(id); cb.checked = on; row.classList.toggle('sel', on); }
      const vis = visiblePlaylists().filter((p) => p.owner !== 'system');
      const n = vis.filter((p) => state.selected.has(p.id)).length;
      libRefs.selAll.checked = vis.length > 0 && n === vis.length;
      libRefs.selAll.indeterminate = n > 0 && n < vis.length;
      libRefs.selLabel.textContent = state.selected.size ? `${state.selected.size.toLocaleString()} selected` : `${plural(vis.length, 'playlist')}`;
    }
    renderFooter();
  }

  function renderFooter() {
    clear(footEl);
    if (!state.loaded) { footEl.hidden = true; return; }
    footEl.hidden = false;
    if (state.detail) return renderDetailFooter();
    const ids = [...state.selected];
    if (state.scan) { put(footEl, h('span', { class: 'hint' }, 'Scanning… actions are available when it finishes.')); return; }
    if (!ids.length) {
      put(footEl, 
        h('span', { class: 'hint' }, 'Tick playlists to clean, merge or delete.'),
        btn('Restore', () => restoreFlow(), 'sm', 'upload'),
        btn('Back up all', () => backupFlow(state.playlists.filter((p) => p.owner !== 'system').map((p) => p.id)), 'sm', 'download'));
      return;
    }
    const sel = ids.map(byId).filter(Boolean);
    const canFix = sel.some((p) => p.owner !== 'saved');
    put(footEl, 
      h('span', { class: 'count' }, `${sel.length.toLocaleString()} selected`),
      h('button', { class: 'link', onclick: () => { state.selected.clear(); state.filter = null; render(); } }, 'Clear'),
      h('span', { class: 'spacer' }),
      canFix ? btn('Clean up', () => fixFlow(ids), 'sm', 'wand') : null,
      sel.length > 1 ? btn('Merge', () => mergeFlow(ids), 'sm') : null,
      btn('Back up', () => backupFlow(ids), 'sm'),
      btn('Delete', () => deleteFlow(ids), 'sm danger', 'trash'));
  }

  // ───────────────────────── playlist detail ─────────────────────────
  async function openDetail(id) {
    if (libRefs && libRefs.list) state.libScroll = libRefs.list.scrollTop;
    state.detail ={ id, loading: true, error: null, filter: 'all', selected: new Set(), sortKey: 'title', lastClicked: null };
    render();
    const p = byId(id);
    try {
      setScan(p, await fetchPlaylist(id, (n) => { if (state.detail && state.detail.id === id) { state.detail.progress = n; render(); } }));
    } catch (e) {
      if (state.detail && state.detail.id === id) state.detail.error = e;
    }
    if (state.detail && state.detail.id === id) { state.detail.loading = false; render(); }
  }
  function closeDetail() { state.detail = null; render(); }

  function renderDetail() {
    const d = state.detail;
    const p = byId(d.id);
    const prevList = viewEl.querySelector('.list');
    const prevScroll = prevList && viewEl.dataset.detail === d.id ? prevList.scrollTop : 0;
    clear(viewEl);
    viewEl.dataset.detail = d.id;
    libRefs = null;
    if (!p) { closeDetail(); return; }
    const sub = p.owner === 'mine' ? 'Your playlist' : p.owner === 'saved' ? 'Saved from someone else · read-only' : p.owner === 'system' ? 'Automatic playlist · read-only' : '';
    put(viewEl, h('div', { class: 'dhead' },
      iconBtn('back', 'Back to library', closeDetail),
      thumbEl(p.thumb),
      h('div', { class: 'body' }, h('div', { class: 't1' }, p.title), h('div', { class: 't2' }, [sub, p.scan ? plural(p.scan.tracks.length, 'song') : null].filter(Boolean).join(' · ')))));
    if (d.loading) { put(viewEl, stateBlock('loading', 'Loading songs…', d.progress ? `${plural(d.progress, 'song')} so far` : null)); return; }
    if (d.error) { put(viewEl, stateBlock('error', d.error.message, d.error.detail, btn('Try again', () => openDetail(d.id), 'primary'))); return; }

    const tracks = p.scan.tracks;
    const a = an(p);
    const editable = p.owner === 'mine';
    const dupeOf = new Map(a.dupes.map((x) => [x.track, x.of]));
    const unav = new Set(a.unavailable);

    if (editable && tracks.length) {
      const sortSel = h('select', { onchange: (e) => { d.sortKey = e.target.value; } },
        Object.entries(SORTS).map(([k, v]) => h('option', { value: k, selected: d.sortKey === k }, v.label)));
      put(viewEl, h('div', { class: 'card', style: { marginTop: '6px' } },
        a.dupes.length || a.unavailable.length
          ? h('div', { class: 'actions', style: { marginTop: 0 } },
              a.dupes.length ? btn(`Remove ${plural(a.dupes.length, 'duplicate')}`, () => removeFlow(p, a.dupes.map((x) => x.track), 'duplicate'), 'sm', 'wand') : null,
              a.unavailable.length ? btn(`Remove ${a.unavailable.length.toLocaleString()} unavailable`, () => removeFlow(p, a.unavailable, 'unavailable song'), 'sm', 'wand') : null)
          : h('div', { class: 'ok' }, icon('check'), 'No duplicates or unavailable songs.'),
        h('div', { class: 'sortrow' }, icon('sort'), sortSel, btn('Sort playlist', () => sortFlow(p, d.sortKey), 'sm')),
        h('div', { class: 'meta' },
          h('label', { class: 'switch' },
            h('input', { type: 'checkbox', checked: settings.loose, onchange: (e) => { settings.loose = e.target.checked; saveSettings(); render(); } }),
            'Match same title & artist'),
          null)));
    }

    const counts = { all: tracks.length, dupes: a.dupes.length, unav: a.unavailable.length };
    put(viewEl, h('div', { class: 'tabs' },
      [['all', 'All'], ['dupes', 'Duplicates'], ['unav', 'Unavailable']].map(([k, l]) =>
        (k === 'all' || counts[k]) ? h('button', { class: 'tab' + (d.filter === k ? ' on' : ''), onclick: () => { d.filter = k; render(); } }, `${l} ${counts[k].toLocaleString()}`) : null)));

    const shown = d.filter === 'dupes' ? a.dupes.map((x) => x.track) : d.filter === 'unav' ? a.unavailable : tracks;
    const list = h('div', { class: 'list' });
    if (!shown.length) list.append(stateBlock('none', tracks.length ? 'Nothing here' : 'This playlist is empty', tracks.length ? null : (editable ? 'Delete it from the library view.' : null)));
    const rows = [];
    for (const t of shown) {
      const of = dupeOf.get(t);
      const cb = editable ? h('input', { type: 'checkbox', checked: d.selected.has(t), title: 'Select', onclick: (e) => {
        const ids = shown;
        if (e.shiftKey && d.lastClicked && ids.includes(d.lastClicked)) {
          const [x, y] = [ids.indexOf(d.lastClicked), ids.indexOf(t)].sort((m, n) => m - n);
          for (const tt of ids.slice(x, y + 1)) e.target.checked ? d.selected.add(tt) : d.selected.delete(tt);
        } else e.target.checked ? d.selected.add(t) : d.selected.delete(t);
        d.lastClicked = t;
        rows.forEach(([tt, r, c]) => { const on = d.selected.has(tt); c.checked = on; r.classList.toggle('sel', on); });
        renderFooter();
      } }) : null;
      const row = h('div', { class: 'track' + (unav.has(t) ? ' unav' : '') + (d.selected.has(t) ? ' sel' : '') },
        cb, h('span', { class: 'num' }, t.index + 1),
        h('div', { class: 'body' }, h('div', { class: 't1' }, t.title), h('div', { class: 't2' }, [t.artist, t.album].filter(Boolean).join(' • ') || '—')),
        of ? h('span', { class: 'tag dupe', title: `Same as #${of.index + 1}: ${of.title}` }, `dup of #${of.index + 1}`) : null,
        unav.has(t) ? h('span', { class: 'tag unav' }, 'unavailable') : null,
        h('span', { class: 'dur' }, t.duration || ''));
      if (cb) rows.push([t, row, cb]);
      list.append(row);
    }
    put(viewEl, list);
    list.scrollTop = prevScroll;
  }

  function renderDetailFooter() {
    const d = state.detail;
    const p = byId(d.id);
    if (!p || d.loading || d.error) { footEl.hidden = true; return; }
    if (d.selected.size) {
      put(footEl, 
        h('span', { class: 'count' }, `${d.selected.size.toLocaleString()} selected`),
        h('button', { class: 'link', onclick: () => { d.selected.clear(); render(); } }, 'Clear'),
        h('span', { class: 'spacer' }),
        btn('Remove from playlist', () => removeFlow(p, [...d.selected], 'song'), 'sm danger', 'trash'));
      return;
    }
    put(footEl, 
      h('span', { class: 'hint' }, p.owner === 'mine' ? 'Tick songs to remove them.' : ''),
      btn('Back up', () => backupFlow([p.id]), 'sm', 'download'),
      p.owner !== 'system' ? btn(p.owner === 'saved' ? 'Remove from library' : 'Delete playlist', () => deleteFlow([p.id]), 'sm danger', 'trash') : null);
  }

  // ───────────────────────── dialogs, jobs, toasts ─────────────────────────
  function dialog({ title, body = [], options = [], fields = [], checklist = null, confirm = 'OK', cancel = 'Cancel', danger = false }) {
    return new Promise((resolve) => {
      const values = {};
      const optEls = options.map((o) => {
        const input = h('input', { type: 'checkbox', checked: !!o.checked, onchange: (e) => { values[o.key] = e.target.checked; o.onchange && o.onchange(e.target.checked, values); } });
        values[o.key] = !!o.checked;
        return h('label', { class: 'opt', 'data-key': o.key, hidden: !!o.hidden }, input, h('span', {}, o.label, o.hint ? h('small', {}, o.hint) : null));
      });
      const fieldEls = fields.map((f) => {
        values[f.key] = f.value || '';
        const input = f.options
          ? h('select', { onchange: (e) => { values[f.key] = e.target.value; } }, f.options.map(([v, l]) => h('option', { value: v, selected: v === f.value }, l)))
          : h('input', { type: 'text', value: f.value || '', maxLength: 150, oninput: (e) => { values[f.key] = e.target.value; } });
        return h('label', { class: 'field' }, h('span', {}, f.label), input);
      });
      let checkEls = null;
      if (checklist) {
        values.checked = new Set(checklist.items.map((x) => x.key));
        checkEls = h('div', { class: 'checklist' }, checklist.items.map((x) =>
          h('label', { class: 'opt' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => { e.target.checked ? values.checked.add(x.key) : values.checked.delete(x.key); } }),
            h('span', {}, x.label, x.hint ? h('small', {}, x.hint) : null))));
      }
      const done = (v) => { overlayEl._resolve = null; overlayEl.hidden = true; clear(overlayEl); resolve(v); };
      const okBtn = confirm ? btn(confirm, () => done(values), danger ? 'danger solid' : 'primary') : null;
      overlayEl._resolve = done;
      clear(overlayEl).append(h('div', { class: 'dialog', role: 'alertdialog' },
        h('h3', {}, title),
        body.map((b) => typeof b === 'string' ? h('p', {}, b) : b),
        fieldEls, checkEls, optEls,
        h('div', { class: 'btns' }, cancel ? btn(cancel, () => done(null)) : null, okBtn)));
      overlayEl.hidden = false;
      const first = overlayEl.querySelector('.field input');
      (first || okBtn || overlayEl.querySelector('button')).focus();
    });
  }
  const listOf = (names, max = 8) => h('ul', {}, names.slice(0, max).map((n) => h('li', {}, n)), names.length > max ? h('li', { style: { color: 'var(--faint)' } }, `and ${names.length - max} more`) : null);

  function showError(e) {
    return dialog({ title: e.message || 'Something went wrong', body: [e.detail ? h('div', { class: 'err' }, String(e.detail)) : 'Please try again.'], confirm: 'OK', cancel: null });
  }

  let toastTimer;
  function toast(message, action) {
    clearTimeout(toastTimer);
    clear(toastEl).append(...[h('span', { class: 'grow' }, message), action ? h('button', { class: 'link', onclick: () => { toastEl.hidden = true; action.run(); } }, action.label) : null,
      h('button', { class: 'link', style: { color: '#555' }, title: 'Dismiss', onclick: () => { toastEl.hidden = true; } }, '✕')].filter(Boolean));
    toastEl.hidden = false;
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 7000);
  }

  async function runJob(title, total, fn) {
    const job = {
      title, label: '', done: 0, total, cancelled: false,
      tick(n = 1) { this.done += n; draw(); },
      say(label) { this.label = label; draw(); },
      grow(n) { this.total += n; draw(); },
      check() { if (this.cancelled) throw new Cancelled(); },
    };
    const label = h('p'), bar = h('i', { style: { width: '0%' } }), stat = h('span');
    const cancelBtn = btn('Stop', () => { job.cancelled = true; cancelBtn.disabled = true; cancelBtn.textContent = 'Stopping…'; }, 'sm');
    function draw() {
      label.textContent = job.label || ' ';
      bar.style.width = (job.total ? Math.min(100, (job.done / job.total) * 100) : 0) + '%';
      stat.textContent = job.total ? `${Math.min(job.done, job.total).toLocaleString()} / ${job.total.toLocaleString()}` : '';
    }
    clear(overlayEl).append(h('div', { class: 'job', role: 'status' }, h('h3', {}, title), label, h('div', { class: 'prog' }, bar), h('div', { class: 'btns' }, stat, cancelBtn)));
    overlayEl._resolve = null;
    overlayEl.hidden = false;
    draw();
    state.job = job;
    try {
      return await fn(job);
    } catch (e) {
      overlayEl.hidden = true;
      if (e instanceof Cancelled) toast('Stopped. Anything already done has been saved.');
      else { console.warn('[Playlist Tidy]', e); await showError(e instanceof TidyError ? e : new TidyError('Something went wrong', String(e && e.stack || e))); }
      return undefined;
    } finally {
      state.job = null;
      if (overlayEl.querySelector('.job')) { overlayEl.hidden = true; clear(overlayEl); }
      render();
    }
  }

  function markChanged() { state.changed = true; }

  // ───────────────────────── flows ─────────────────────────
  async function deleteFlow(ids) {
    const items = ids.map(byId).filter((p) => p && p.owner !== 'system');
    if (!items.length) return;
    const mine = items.filter((p) => p.owner === 'mine');
    const saved = items.filter((p) => p.owner === 'saved');
    const unknown = items.filter((p) => p.owner === 'unknown');
    const n = items.length;
    const body = [];
    if (mine.length) body.push(`${plural(mine.length, 'playlist')} you made will be deleted permanently.`);
    if (saved.length) body.push(`${plural(saved.length, 'playlist')} saved from others will be removed from your library (they still exist for their owners).`);
    if (unknown.length) body.push(`${plural(unknown.length, 'playlist')} will be checked first: deleted if yours, otherwise removed from your library.`);
    const res = await dialog({
      title: n === 1 ? (saved.length ? `Remove “${items[0].title}” from your library?` : `Delete “${items[0].title}”?`) : `Delete ${n.toLocaleString()} playlists?`,
      body: [n > 1 ? listOf(items.map((p) => p.title)) : null, ...body].filter(Boolean),
      options: mine.length || unknown.length ? [{ key: 'backup', label: 'Download a backup first', hint: 'A JSON file with every song, so you can restore them later.', checked: true }] : [],
      confirm: n === 1 && saved.length ? 'Remove' : `Delete${n > 1 ? ' ' + n.toLocaleString() : ''}`,
      danger: true,
    });
    if (!res) return;
    const needFetch = items.filter((p) => p.owner === 'unknown' || (res.backup && p.owner === 'mine'));
    const removed = [];
    await runJob(n === 1 ? 'Deleting playlist' : 'Deleting playlists', needFetch.length + n, async (job) => {
      for (const p of needFetch) {
        job.check();
        job.say(`Reading “${p.title}”`);
        setScan(p, await fetchPlaylist(p.id));
        job.tick();
      }
      if (res.backup) {
        const toSave = items.filter((p) => p.owner === 'mine');
        if (toSave.length) downloadBackup(toSave, 'deleted');
      }
      for (const p of items) {
        job.check();
        job.say(`${p.owner === 'mine' ? 'Deleting' : 'Removing'} “${p.title}”`);
        if (p.owner === 'mine') await deletePlaylist(p.id); else await removeFromLibrary(p.id);
        removed.push(p.id);
        markChanged();
        job.tick();
        await sleep(200);
      }
    }).finally(() => {
      if (!removed.length) return;
      state.playlists = state.playlists.filter((p) => !removed.includes(p.id));
      removed.forEach((id) => state.selected.delete(id));
      if (state.detail && removed.includes(state.detail.id)) state.detail = null;
      render();
    });
    if (removed.length === n) toast(`${n === 1 ? 'Done' : plural(n, 'playlist') + ' removed'}.${res.backup && mine.length + unknown.length ? ' Backup saved to your downloads.' : ''}`);
  }

  async function removeFlow(p, tracks, noun) {
    const n = tracks.length;
    const res = await dialog({
      title: `Remove ${plural(n, noun)}?`,
      body: [`From “${p.title}”. ${noun === 'duplicate' ? 'The first copy of each song stays.' : ''}`,
        listOf(tracks.map((t) => `${t.title}${t.artist ? ' — ' + t.artist : ''}`), 6)],
      confirm: 'Remove',
      danger: true,
    });
    if (!res) return;
    const ok = await runJob(`Cleaning “${p.title}”`, n, async (job) => {
      job.say(`Removing ${plural(n, noun)}`);
      await removeTracks(p.id, tracks, job);
      markChanged();
      job.say('Checking the result');
      setScan(p, await fetchPlaylist(p.id));
      return true;
    });
    if (!ok) { try { setScan(p, await fetchPlaylist(p.id)); } catch {} }
    if (state.detail) state.detail.selected.clear();
    render();
    if (ok) toast(`Removed ${plural(n, noun)} from “${p.title}”.`);
  }

  async function fixFlow(ids) {
    const items = ids.map(byId).filter((p) => p && p.owner !== 'system' && p.owner !== 'saved');
    const skipped = ids.length - items.length;
    if (!items.length) { toast('Only playlists you made can be cleaned up.'); return; }
    const scanned = items.filter((p) => p.scan);
    const dupN = scanned.reduce((s, p) => s + an(p).dupes.length, 0);
    const unavN = scanned.reduce((s, p) => s + an(p).unavailable.length, 0);
    const res = await dialog({
      title: `Clean up ${plural(items.length, 'playlist')}?`,
      body: [
        scanned.length === items.length ? `Last scan found ${plural(dupN, 'duplicate')} and ${unavN.toLocaleString()} unavailable ${unavN === 1 ? 'song' : 'songs'}. Each playlist is re-checked before anything is removed.` : 'Each playlist is checked, then the songs you choose below are removed.',
        skipped ? `${plural(skipped, 'playlist')} saved from others will be skipped.` : null,
      ].filter(Boolean),
      options: [
        { key: 'dupes', label: 'Remove duplicate songs', hint: 'Keeps the first copy of each song.', checked: true },
        { key: 'loose', label: 'Count same title & artist as a duplicate', hint: 'Catches the same song uploaded twice.', checked: settings.loose },
        { key: 'unav', label: 'Remove unavailable songs', hint: 'Songs that are greyed out and can’t be played.', checked: true },
      ],
      confirm: 'Clean up',
    });
    if (!res || (!res.dupes && !res.unav)) return;
    if (res.loose !== settings.loose) { settings.loose = res.loose; saveSettings(); }
    let totalDupes = 0, totalUnav = 0, touched = 0, notMine = 0;
    await runJob('Cleaning up', items.length, async (job) => {
      for (const p of items) {
        job.check();
        job.say(`Checking “${p.title}”`);
        setScan(p, await fetchPlaylist(p.id));
        if (p.owner !== 'mine') { notMine++; job.tick(); continue; }
        const a = analyze(p.scan.tracks, res.loose);
        const remove = [...(res.dupes ? a.dupes.map((x) => x.track) : []), ...(res.unav ? a.unavailable : [])];
        if (remove.length) {
          job.say(`Removing ${plural(remove.length, 'song')} from “${p.title}”`);
          await removeTracks(p.id, remove);
          markChanged();
          totalDupes += res.dupes ? a.dupes.length : 0;
          totalUnav += res.unav ? a.unavailable.length : 0;
          touched++;
          setScan(p, await fetchPlaylist(p.id));
        }
        job.tick();
      }
    });
    render();
    const parts = [];
    if (totalDupes) parts.push(plural(totalDupes, 'duplicate'));
    if (totalUnav) parts.push(`${totalUnav.toLocaleString()} unavailable`);
    toast(parts.length ? `Removed ${parts.join(' and ')} from ${plural(touched, 'playlist')}.` : `Nothing to remove${notMine ? '' : ' — already tidy'}.`);
  }

  async function mergeFlow(ids) {
    const items = ids.map(byId).filter(Boolean);
    const res = await dialog({
      title: `Merge ${items.length} playlists`,
      body: [listOf(items.map((p) => p.title), 6), 'Songs are combined into a new playlist in this order, with duplicates and unavailable songs left out.'],
      fields: [
        { key: 'title', label: 'New playlist name', value: items.map((p) => p.title).slice(0, 2).join(' + ') + (items.length > 2 ? ' + more' : '') },
        { key: 'privacy', label: 'Visibility', value: 'PRIVATE', options: [['PRIVATE', 'Private'], ['UNLISTED', 'Unlisted'], ['PUBLIC', 'Public']] },
      ],
      options: [{ key: 'deleteOriginals', label: 'Delete the original playlists afterwards', hint: 'Only ones you made. A backup is downloaded first.', checked: false }],
      confirm: 'Merge',
    });
    if (!res) return;
    const title = (res.title || '').trim() || 'Merged playlist';
    let newCount = 0, deleted = 0;
    const ok = await runJob('Merging playlists', items.length, async (job) => {
      const seen = new Set();
      const ids2 = [];
      for (const p of items) {
        job.check();
        job.say(`Reading “${p.title}”`);
        setScan(p, await fetchPlaylist(p.id));
        const a = analyze(p.scan.tracks, settings.loose);
        const skip = new Set([...a.dupes.map((x) => x.track), ...a.unavailable]);
        for (const t of p.scan.tracks) {
          if (skip.has(t)) continue;
          const keys = ['v:' + t.videoId];
          if (settings.loose && norm(t.title)) keys.push('n:' + norm(t.title) + '|' + norm(t.artist));
          if (keys.some((k) => seen.has(k))) continue;
          keys.forEach((k) => seen.add(k));
          ids2.push(t.videoId);
        }
        job.tick();
      }
      job.grow(ids2.length);
      job.say(`Creating “${title}” with ${plural(ids2.length, 'song')}`);
      await createPlaylist(title, ids2, res.privacy || 'PRIVATE', `Merged from: ${items.map((p) => p.title).join(', ')}`.slice(0, 1000), job);
      newCount = ids2.length;
      markChanged();
      if (res.deleteOriginals) {
        const mine = items.filter((p) => p.owner === 'mine');
        if (mine.length) {
          downloadBackup(mine, 'merged-originals');
          job.grow(mine.length);
          for (const p of mine) {
            job.check();
            job.say(`Deleting “${p.title}”`);
            await deletePlaylist(p.id);
            deleted++;
            job.tick();
            await sleep(200);
          }
        }
      }
      return true;
    });
    state.selected.clear();
    state.filter = null;
    await loadLibrary();
    if (ok) toast(`Created “${title}” with ${plural(newCount, 'song')}.${deleted ? ` Deleted ${plural(deleted, 'original')}.` : ''}`);
  }

  async function backupFlow(ids) {
    const items = ids.map(byId).filter(Boolean);
    if (!items.length) return;
    let ok = false;
    await runJob(items.length === 1 ? 'Backing up playlist' : `Backing up ${plural(items.length, 'playlist')}`, items.length, async (job) => {
      let done = 0;
      await pool(items, 3, async (p) => {
        job.check();
        job.say(`Reading “${p.title}”`);
        setScan(p, await fetchPlaylist(p.id));
        job.tick();
        done++;
      });
      downloadBackup(items, items.length === 1 ? items[0].title.replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 40) : 'backup');
      ok = true;
    });
    if (ok) toast(`Backup of ${plural(items.length, 'playlist')} saved to your downloads.`);
  }

  async function restoreFlow() {
    const input = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
    shadow.append(input);
    const file = await new Promise((resolve) => {
      input.addEventListener('change', () => resolve(input.files && input.files[0]), { once: true });
      input.addEventListener('cancel', () => resolve(null), { once: true });
      input.click();
    });
    input.remove();
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
      if (!data || !Array.isArray(data.playlists)) throw new Error('missing playlists');
    } catch {
      await showError(new TidyError('That isn’t a Playlist Tidy backup', 'Choose a .json file made with “Back up” or “Download a backup first”.'));
      return;
    }
    const lists = data.playlists.filter((p) => p && Array.isArray(p.tracks));
    if (!lists.length) { toast('That backup has no playlists in it.'); return; }
    const res = await dialog({
      title: 'Restore from backup',
      body: [`Each playlist you pick is created again as a new private playlist.${data.exportedAt ? ' Backup from ' + new Date(data.exportedAt).toLocaleString() + '.' : ''}`],
      checklist: { items: lists.map((p, i) => ({ key: i, label: p.title || 'Untitled', hint: plural(p.tracks.filter((t) => t.videoId && !t.unavailable).length, 'song') })) },
      confirm: 'Restore',
    });
    if (!res || !res.checked.size) return;
    const pick = lists.filter((_, i) => res.checked.has(i));
    const total = pick.reduce((s, p) => s + Math.max(1, p.tracks.length), 0);
    let made = 0;
    await runJob('Restoring playlists', total, async (job) => {
      for (const p of pick) {
        job.check();
        job.say(`Creating “${p.title}”`);
        const vids = [...new Set(p.tracks.filter((t) => t.videoId && !t.unavailable).map((t) => t.videoId))];
        await createPlaylist(String(p.title || 'Restored playlist'), vids, 'PRIVATE', 'Restored with Playlist Tidy', job);
        job.tick(Math.max(1, p.tracks.length) - vids.length);
        made++;
        markChanged();
        await sleep(300);
      }
    });
    await loadLibrary();
    if (made) toast(`Restored ${plural(made, 'playlist')}.`);
  }

  async function sortFlow(p, key) {
    const current = p.scan.tracks;
    if (current.some((t) => !t.setVideoId)) { await showError(new TidyError('This playlist can’t be reordered', 'YouTube Music didn’t provide the IDs needed to move songs. Try reloading the page.')); return; }
    const target = sortedTracks(current, key);
    const moves = planMoves(current.map((t) => t.setVideoId), target.map((t) => t.setVideoId));
    if (!moves.length) { toast(`“${p.title}” is already in that order.`); return; }
    const secs = Math.ceil(moves.length * 0.4);
    const res = await dialog({
      title: `Sort “${p.title}”?`,
      body: [`${SORTS[key].label}. This moves ${plural(moves.length, 'song')} and takes about ${secs < 60 ? secs + ' seconds' : Math.ceil(secs / 60) + ' minutes'}.`],
      confirm: 'Sort',
    });
    if (!res) return;
    let finished = false;
    await runJob(`Sorting “${p.title}”`, moves.length, async (job) => {
      job.say(SORTS[key].label);
      for (const m of moves) {
        job.check();
        const action = { action: 'ACTION_MOVE_VIDEO_BEFORE', setVideoId: m.id };
        if (m.before) action.movedSetVideoIdSuccessor = m.before;
        await editPlaylist(p.id, [action]);
        markChanged();
        job.tick();
        await sleep(120);
      }
      job.say('Checking the result');
      setScan(p, await fetchPlaylist(p.id));
      finished = true;
    });
    if (!finished) { try { setScan(p, await fetchPlaylist(p.id)); } catch {} render(); return; }
    const want = target.map((t) => t.setVideoId).join('|');
    const got = p.scan.tracks.map((t) => t.setVideoId).join('|');
    render();
    if (want === got || key === 'shuffle' || key === 'reverse') toast(`Sorted “${p.title}”.`);
    else toast('Sorted, but a few songs may be out of place. Sorting again usually fixes it.');
  }

  // ───────────────────────── start ─────────────────────────
  function start() {
    if (!document.body) { requestAnimationFrame(start); return; }
    mount();
    syncLauncher();
    if (/[#&]tidy\b/.test(location.hash)) setOpen(true);
  }
  start();

  // Exposed for automated tests only; harmless in normal use.
  window.__playlistTidyInternals = { analyze, planMoves, sortedTracks, parseCount, norm };
})();
