const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, shell, screen, dialog, nativeImage } = require('electron');
const path = require('path'), fs = require('fs'), http = require('http'), crypto = require('crypto');

const { parse, decodeFile } = require('./subtitles');
const assets = name => path.join(__dirname, 'assets', name);

const REDIRECT = 'http://127.0.0.1:8888/callback';
const U = () => app.getPath('userData');
const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(U(), f), 'utf8')); } catch { return d; } };
const wr = (f, v) => fs.writeFileSync(path.join(U(), f), JSON.stringify(v, null, 2));
const key = (a, t) => `${a} - ${t}`.toLowerCase().trim();

let win, editor, tray, locked = true, track = null, lastId = null, lastRaw = '', backoff = 0, busy = false;
let cfg = {}, tokens = {}, settingsWin, previewUntil = 0;
let ignoreMouse = false, closePrompt = false, importing = false, quitting = false;
let trackRevision = 0;
const TOOLBAR_WIDTH = 171, TOOLBAR_HEIGHT = 55;
const DEFAULTS = { fontSize: 36, fontWeight: 700, fontFamily: 'Segoe UI', fontStyle: 'normal', align: 'center',
  sweepColor: '#aaff00', textColor: '#aba2c3', dimOpacity: 85, shadowColor: '#120e1c', shadowBlur: 12, shadowOpacity: 90,
  bgColor: '#160e2b', bgOpacity: 86, radius: 17, syncOffset: 0,
  showTrack: true, showSource: false, showPrevious: false, showNext: true, showProgress: false, showStatus: true };
let settings = { ...DEFAULTS };

// ---------- overlay window ----------
function createOverlay() {
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
  const w = Math.min(660, width), h = Math.min(224, height);
  win = new BrowserWindow({
    width: w, height: h, minWidth: 310, minHeight: 164,
    x: x + Math.round((width - w) / 2), y: Math.max(y, y + height - h - 38),
    transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
    icon: assets('icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.webContents.on('did-finish-load', () => { setLocked(locked); lastId = null; poll(); });
  win.on('close', event => {
    if (!quitting) { event.preventDefault(); confirmClose(); }
  });
  win.on('show', syncMouse);
  win.loadFile('index.html');
}

function syncMouse() {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  const bounds = win.getBounds();
  const pt = screen.getCursorScreenPoint();
  const inToolbar = pt.x >= bounds.x + bounds.width - TOOLBAR_WIDTH && pt.x < bounds.x + bounds.width
    && pt.y >= bounds.y && pt.y < bounds.y + TOOLBAR_HEIGHT;
  const shouldIgnore = locked && !inToolbar && !closePrompt && !importing;
  if (shouldIgnore === ignoreMouse) return;
  ignoreMouse = shouldIgnore;
  win.setIgnoreMouseEvents(shouldIgnore);
}

function setLocked(value) {
  locked = value;
  syncMouse();
  send('locked', value);
  buildTray();
}

function showOverlay() {
  if (!win.isVisible()) win.show();
  syncMouse();
}

function hideToTray() {
  for (const window of [win, settingsWin, editor]) {
    if (window && !window.isDestroyed()) window.hide();
  }
}

function toggleOverlay() {
  if (win.isVisible()) hideToTray();
  else showOverlay();
}

async function confirmClose() {
  if (closePrompt || importing || quitting) return;
  closePrompt = true;
  syncMouse();
  try {
    const { response } = await dialog.showMessageBox(win, {
      type: 'question', title: 'Lyrics Overlay', message: 'Hide Lyrics Overlay or exit completely?',
      detail: 'Hide keeps the app running in the Windows notification area. Open it again from its tray icon, under Hidden icons if Windows keeps it there.',
      buttons: ['Hide to tray', 'Exit completely', 'Cancel'], defaultId: 0, cancelId: 2, noLink: true
    });
    if (response === 0) hideToTray();
    if (response === 1) app.quit();
  } finally {
    closePrompt = false;
    syncMouse();
  }
}

let pendingImport = null;
function openEditor() {
  if (editor && !editor.isDestroyed()) { editor.show(); editor.focus(); return; }
  editor = new BrowserWindow({ width: 640, height: 700, title: 'Lyrics Overlay – Editor', icon: assets('icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js') } });
  editor.setMenu(null);
  editor.loadFile('editor.html');
}
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({ width: 440, height: 720, x: 20, y: 20, title: 'Lyrics Overlay – Appearance', icon: assets('icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js') } });
  settingsWin.setMenu(null);
  settingsWin.loadFile('settings.html');
}
function buildTray() {
  if (!tray) {
    const image = nativeImage.createFromPath(assets('icon.png')).resize({ width: 32, height: 32 });
    tray = new Tray(image);
    tray.on('click', showOverlay);
  }
  tray.setToolTip('Lyrics Overlay');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show / hide', click: toggleOverlay },
    { label: locked ? 'Unlock (move/resize)' : 'Lock (click-through)', click: () => setLocked(!locked) },
    { label: 'Import timed lyrics…', click: () => { showOverlay(); importLyrics(); } },
    { label: 'Add / edit lyrics…', click: openEditor },
    { label: 'Settings…', click: openSettings },
    { label: 'Connect Spotify', click: connect },
    { type: 'separator' }, { label: 'Exit completely', click: () => app.quit() }
  ]));
}

// ---------- Spotify (PKCE, no client secret needed) ----------
async function tokenReq(body) {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, ...body })
  });
  if (!r.ok) return null;
  const j = await r.json();
  if (!j.access_token) return null;
  tokens = { access: j.access_token, refresh: j.refresh_token || tokens.refresh, exp: Date.now() + j.expires_in * 1000 - 30000 };
  wr('tokens.json', tokens);
  return tokens.access;
}
async function token() {
  if (!tokens.access) return null;
  return Date.now() < tokens.exp ? tokens.access : tokenReq({ grant_type: 'refresh_token', refresh_token: tokens.refresh });
}
let loginServer;
function connect() {
  if (!cfg.clientId) return openEditor();
  if (loginServer) return;
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(24).toString('base64url');
  const authId = cfg.clientId;
  const authUrl = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
    client_id: authId, response_type: 'code', redirect_uri: REDIRECT,
    scope: 'user-read-currently-playing user-read-playback-state',
    code_challenge_method: 'S256', code_challenge: challenge, state
  });
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, REDIRECT);
    if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
    if (url.searchParams.get('state') !== state) { res.writeHead(400).end('Invalid Spotify login session.'); return; }
    clearTimeout(expiry);
    const code = url.searchParams.get('code');
    let access = null;
    try {
      if (code && authId === cfg.clientId) {
        access = await tokenReq({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier });
      }
    } catch {}
    if (access) {
      res.end('Spotify connected. You can close this tab.');
      void poll();
    } else {
      res.writeHead(400).end('Spotify could not connect. Check the Client ID and redirect URI, then try again.');
    }
    srv.close();
  });
  const expiry = setTimeout(() => srv.close(), 180000);
  loginServer = srv;
  srv.once('close', () => { clearTimeout(expiry); loginServer = null; });
  srv.once('error', () => {
    clearTimeout(expiry);
    loginServer = null;
    send('notice', 'Spotify callback port 8888 is unavailable.');
  });
  srv.listen(8888, '127.0.0.1', () => shell.openExternal(authUrl).catch(() => {
    srv.close();
    send('notice', 'Could not open Spotify sign-in.');
  }));
}

// ---------- lyrics ----------
const clean = x => x.replace(/\s*[\(\[][^)\]]*(feat|ft\.|with|remaster|version|ver\.|edit|live|inst)[^)\]]*[\)\]]/gi, '')
  .replace(/\s+-\s+.*(remaster|version|edit|live|mono|stereo|single).*$/i, '').trim();
const dist = (x, t) => Math.abs((x.duration || 0) - t.duration / 1000);
const HL = { headers: { 'User-Agent': 'LyricsOverlay/1.0' } };
const jget = async (url, opt) => { try { const r = await fetch(url, { ...opt, signal: AbortSignal.timeout(4000) }); return r.ok ? await r.json() : null; } catch { return null; } };
const isSynced = x => /\[\d+:\d+/.test(x || '');

async function fromLrclib(t) {
  let plain = '';
  for (const name of [...new Set([t.title, clean(t.title)])]) {
    const j = await jget('https://lrclib.net/api/get?' + new URLSearchParams({ artist_name: t.artist, track_name: name, album_name: t.album, duration: Math.round(t.duration / 1000) }), HL);
    if (j && j.syncedLyrics) return j.syncedLyrics;
    if (j && j.plainLyrics && !plain) plain = j.plainLyrics;
  }
  for (const [q, tol] of [[`${t.artist} ${clean(t.title)}`, 5], [clean(t.title), 3]]) {
    const a = (await jget('https://lrclib.net/api/search?' + new URLSearchParams({ q }), HL)) || [];
    const ok = a.filter(x => dist(x, t) <= tol).sort((x, y) => dist(x, t) - dist(y, t));
    const s = ok.find(x => x.syncedLyrics);
    if (s) return s.syncedLyrics;
    if (!plain) plain = (ok.find(x => x.plainLyrics) || {}).plainLyrics || '';
  }
  return plain;
}
// Unofficial public endpoint; may stop working at any time.
async function fromNetease(t) {
  const H2 = { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com' } };
  const s = await jget('https://music.163.com/api/search/get/web?' + new URLSearchParams({ s: `${t.artist} ${clean(t.title)}`, type: 1, offset: 0, limit: 10 }), H2);
  const songs = (s && s.result && s.result.songs) || [];
  const best = songs.map(x => ({ id: x.id, d: x.duration ? Math.abs(x.duration - t.duration) : 2000 })).sort((a, b) => a.d - b.d)[0];
  if (!best || best.d > 4000) return '';
  const l = await jget(`https://music.163.com/api/song/lyric?id=${best.id}&lv=1&kv=1&tv=-1`, H2);
  return (l && l.lrc && l.lrc.lyric) || '';
}

async function loadLyrics(t) {
  let raw = '', source = 'none';
  const custom = rd('lyrics.json', {})[key(t.artist, t.title)];
  if (custom) { raw = custom; source = 'custom'; }
  else {
    let plainRaw = '', plainSrc = '';
    for (const [name, fn] of [['lrclib', fromLrclib], ['netease', fromNetease]]) {
      let r = ''; try { r = await fn(t); } catch {}
      if (isSynced(r)) { raw = r; source = name; break; }
      if (r && r.length > 30 && !plainRaw) { plainRaw = r; plainSrc = name; }
    }
    if (!raw && plainRaw) { raw = plainRaw; source = plainSrc; }
  }
  return { ...parse(raw), raw, source };
}

// ---------- polling ----------
const send = (c, d) => win && !win.isDestroyed() && win.webContents.send(c, d);
const status = message => {
  if (track || lastId !== null) ++trackRevision;
  lastId = null;
  track = null;
  lastRaw = '';
  send('status', message);
};

async function refreshLyrics(info, revision) {
  try {
    const { raw, ...lyrics } = await loadLyrics(info);
    if (revision !== trackRevision) return;
    lastRaw = raw;
    send('track', { ...info, ...lyrics });
  } catch {
    if (revision === trackRevision) send('notice', 'Lyrics could not be loaded.');
  }
}

async function poll() {
  if (busy || Date.now() < backoff || Date.now() < previewUntil) return;
  busy = true;
  try {
    const t = await token();
    if (!t) return status('Connect Spotify from Settings to start.');
    const sent = Date.now();
    const r = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { Authorization: 'Bearer ' + t }, signal: AbortSignal.timeout(7000)
    });
    if (Date.now() < previewUntil) return;
    if (r.status === 204) return status('Nothing playing');
    if (r.status === 429) { backoff = Date.now() + (+r.headers.get('retry-after') || 5) * 1000; return; }
    if (!r.ok) return status('Spotify error ' + r.status);
    const j = await r.json(), it = j.item;
    if (!it || j.currently_playing_type !== 'track') return status('No music track playing');
    const info = { id: it.id ?? key(it.artists[0].name, it.name), title: it.name,
      artist: it.artists[0].name, album: it.album.name, duration: it.duration_ms };
    if (info.id !== lastId) {
      lastId = info.id;
      track = info;
      lastRaw = '';
      send('track', { ...info, lines: [], plain: '', source: 'loading' });
      void refreshLyrics(info, ++trackRevision);
    }
    send('progress', { ms: (j.progress_ms ?? 0) + (j.is_playing ? (Date.now() - sent) / 2 : 0), playing: j.is_playing });
  } catch {
    status('Spotify is unavailable. Retrying…');
  } finally {
    busy = false;
  }
}

function saveLyrics({ artist, title, text }) {
  if (!artist.trim() || !title.trim()) throw new Error('Enter the artist and song title first.');
  const db = rd('lyrics.json', {}), k = key(artist, title);
  if (text.trim()) db[k] = text; else delete db[k];
  wr('lyrics.json', db);
  pendingImport = null;
  if (track && key(track.artist, track.title) === k && Date.now() >= previewUntil) {
    void refreshLyrics(track, ++trackRevision);
  }
  return true;
}

async function importLyrics() {
  if (importing || closePrompt) return;
  importing = true;
  syncMouse();
  const selectedTrack = track;
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Import timed lyrics', properties: ['openFile'],
      filters: [
        { name: 'Timed lyrics and subtitles', extensions: ['txt', 'lrc', 'srt', 'vtt', 'sbv', 'ass', 'ssa', 'ttml', 'dfxp', 'xml', 'json', 'json3', 'srv1', 'srv2', 'srv3', 'smi', 'sami'] },
        { name: 'All files', extensions: ['*'] }
      ]
    });
    if (canceled) return;
    const file = filePaths[0];
    if ((await fs.promises.stat(file)).size > 8 * 1024 * 1024) throw new Error('Choose a lyrics file under 8 MB.');
    const raw = decodeFile(await fs.promises.readFile(file));
    const { lines } = parse(raw);
    if (!lines.some(line => line.text)) throw new Error('No timestamped lyrics found. Try LRC, SRT, VTT, SBV, or a TXT file with timestamps.');
    if (!selectedTrack) {
      pendingImport = { track: null, text: raw };
      if (editor && !editor.isDestroyed()) editor.webContents.send('editor:import', pendingImport);
      openEditor();
      return;
    }
    saveLyrics({ artist: selectedTrack.artist, title: selectedTrack.title, text: raw });
    send('notice', 'Imported ' + lines.length + ' timed lines for ' + selectedTrack.title);
  } catch (err) {
    await dialog.showMessageBox(win, { type: 'warning', title: 'Import timed lyrics', message: err.message, buttons: ['OK'] });
  } finally {
    importing = false;
    syncMouse();
  }
}

ipcMain.handle('overlay:lock', () => setLocked(!locked));
ipcMain.handle('overlay:close', () => confirmClose());
ipcMain.handle('overlay:upload', () => importLyrics());
ipcMain.handle('overlay:menu', () => { openSettings(); });
ipcMain.handle('editor:open', () => { openEditor(); });
ipcMain.handle('editor:init', () => ({ track, text: lastRaw, ...pendingImport, clientId: cfg.clientId || '', connected: !!tokens.access }));
ipcMain.handle('editor:save', (_, data) => saveLyrics(data));
ipcMain.handle('editor:clientId', (_, id) => {
  const next = id.trim();
  if (next !== cfg.clientId) { tokens = {}; wr('tokens.json', tokens); }
  cfg.clientId = next;
  wr('config.json', cfg);
  return true;
});
ipcMain.handle('editor:connect', () => { connect(); });

ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_, patch) => { settings = { ...settings, ...patch }; wr('settings.json', settings); send('settings', settings); return settings; });
ipcMain.handle('settings:reset', () => { settings = { ...DEFAULTS }; wr('settings.json', settings); send('settings', settings); return settings; });
ipcMain.handle('settings:preview', () => {
  const texts = ['This is how your lyrics will look', 'Adjust the sliders and watch it change', 'The current line is big and bright',
    'Other lines fade into the background', 'Pick any colors you like', 'Shadows keep text readable', 'Try changing the background opacity',
    'Bold fonts look great on busy screens', 'Take your time', 'Almost there', 'Looking good', 'Enjoy the music'];
  showOverlay();
  previewUntil = Date.now() + 50000; lastId = null; ++trackRevision;
  send('track', { id: 'preview', title: 'Sample', artist: 'Preview', album: '', duration: 50000, source: 'preview', plain: '',
    lines: texts.map((text, i) => ({ t: i * 4000, end: (i + 1) * 4000, text, marks: [] })) });
  send('progress', { ms: 0, playing: true });
});

app.whenReady().then(() => {
  cfg = rd('config.json', { clientId: process.env.SPOTIFY_CLIENT_ID || '' });
  tokens = rd('tokens.json', {});
  settings = { ...DEFAULTS, ...rd('settings.json', {}) };
  createOverlay();
  buildTray();
  setInterval(syncMouse, 25);
  setInterval(poll, 2000);
});
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => {});
