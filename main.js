const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, shell, screen } = require('electron');
const path = require('path'), fs = require('fs'), http = require('http'), crypto = require('crypto');

const REDIRECT = 'http://127.0.0.1:8888/callback';
const U = () => app.getPath('userData');
const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(U(), f), 'utf8')); } catch { return d; } };
const wr = (f, v) => fs.writeFileSync(path.join(U(), f), JSON.stringify(v, null, 2));
const key = (a, t) => `${a} - ${t}`.toLowerCase().trim();

let win, editor, tray, locked = true, track = null, lastId = null, lastRaw = '', backoff = 0, busy = false;
let cfg = {}, tokens = {}, settingsWin, previewUntil = 0;
const DEFAULTS = { fontSize: 34, fontWeight: 900, fontFamily: 'Segoe UI', fontStyle: 'normal', align: 'center',
  activeColor: '#ffffff', textColor: '#ffffff', dimOpacity: 40, shadowColor: '#000000', shadowBlur: 10, shadowOpacity: 100,
  bgColor: '#0a0a0e', bgOpacity: 28, radius: 18 };
let settings = { ...DEFAULTS };

// ---------- overlay window ----------
function createOverlay() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: 800, height: 300, x: Math.round((width - 800) / 2), y: height - 340,
    transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile('index.html');
  win.webContents.on('did-finish-load', () => setLocked(true));
}
function setLocked(v) {
  locked = v;
  win.setIgnoreMouseEvents(v, { forward: true });
  win.webContents.send('locked', v);
  buildTray();
}
function openEditor() {
  if (editor && !editor.isDestroyed()) return editor.focus();
  editor = new BrowserWindow({ width: 640, height: 700, title: 'Lyrics Overlay – Editor',
    webPreferences: { preload: path.join(__dirname, 'preload.js') } });
  editor.setMenu(null);
  editor.loadFile('editor.html');
}
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) return settingsWin.focus();
  settingsWin = new BrowserWindow({ width: 440, height: 720, x: 20, y: 20, title: 'Lyrics Overlay – Appearance',
    webPreferences: { preload: path.join(__dirname, 'preload.js') } });
  settingsWin.setMenu(null);
  settingsWin.loadFile('settings.html');
}
function buildTray() {
  if (!tray) tray = new Tray(path.join(__dirname, 'icon.png'));
  tray.setToolTip('Lyrics Overlay');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: locked ? 'Unlock (move/resize)' : 'Lock (click-through)', click: () => setLocked(!locked) },
    { label: 'Add / edit lyrics…', click: openEditor },
    { label: 'Appearance…', click: openSettings },
    { label: 'Connect Spotify', click: connect },
    { label: 'Show / hide', click: () => win.isVisible() ? win.hide() : win.show() },
    { type: 'separator' }, { label: 'Quit', click: () => app.quit() }
  ]));
}

// ---------- Spotify (PKCE, no client secret needed) ----------
async function tokenReq(body) {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, ...body })
  });
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
function connect() {
  if (!cfg.clientId) return openEditor();
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, REDIRECT);
    if (u.pathname !== '/callback') return res.end();
    res.end('Spotify connected! You can close this tab.');
    srv.close();
    const code = u.searchParams.get('code');
    if (code) await tokenReq({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier });
  }).listen(8888, '127.0.0.1');
  shell.openExternal('https://accounts.spotify.com/authorize?' + new URLSearchParams({
    client_id: cfg.clientId, response_type: 'code', redirect_uri: REDIRECT,
    scope: 'user-read-currently-playing user-read-playback-state',
    code_challenge_method: 'S256', code_challenge: challenge
  }));
}

// ---------- lyrics ----------
function parse(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const txt = line.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)) out.push({ t: (+m[1] * 60 + +m[2]) * 1000, text: txt });
  }
  out.sort((a, b) => a.t - b.t);
  return out.length ? { lines: out, plain: '' } : { lines: [], plain: text.trim() };
}
const clean = x => x.replace(/\s*[\(\[][^)\]]*(feat|ft\.|with|remaster|version|ver\.|edit|live|inst)[^)\]]*[\)\]]/gi, '')
  .replace(/\s+-\s+.*(remaster|version|edit|live|mono|stereo|single).*$/i, '').trim();
const dist = (x, t) => Math.abs((x.duration || 0) - t.duration / 1000);
const HL = { headers: { 'User-Agent': 'LyricsOverlay/1.0' } };
const jget = async (url, opt) => { try { const r = await fetch(url, opt); return r.ok ? await r.json() : null; } catch { return null; } };
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
  lastRaw = raw;
  return { ...parse(raw), source };
}

// ---------- polling ----------
const send = (c, d) => win && !win.isDestroyed() && win.webContents.send(c, d);
const status = s => { lastId = null; send('status', s); };
async function poll() {
  if (busy || Date.now() < backoff || Date.now() < previewUntil) return;
  busy = true;
  try {
    const t = await token();
    if (!t) return status('Not connected – tray icon → Connect Spotify');
    const t0 = Date.now();
    const r = await fetch('https://api.spotify.com/v1/me/player/currently-playing', { headers: { Authorization: 'Bearer ' + t } });
    if (r.status === 204) return status('Nothing playing');
    if (r.status === 429) { backoff = Date.now() + (+r.headers.get('retry-after') || 5) * 1000; return; }
    if (!r.ok) return status('Spotify error ' + r.status);
    const j = await r.json(), it = j.item;
    if (!it || j.currently_playing_type !== 'track') return status('Not a music track');
    const info = { id: it.id, title: it.name, artist: it.artists[0].name, album: it.album.name, duration: it.duration_ms };
    if (info.id !== lastId) { lastId = info.id; track = info; send('track', { ...info, ...(await loadLyrics(info)) }); }
    send('progress', { ms: j.progress_ms + (Date.now() - t0) / 2, playing: j.is_playing });
  } catch {} finally { busy = false; }
}

// ---------- editor IPC ----------
ipcMain.handle('editor:init', () => ({ track, text: lastRaw, clientId: cfg.clientId || '', connected: !!tokens.access }));
ipcMain.handle('editor:save', (_, { artist, title, text }) => {
  const db = rd('lyrics.json', {}), k = key(artist, title);
  if (text.trim()) db[k] = text; else delete db[k];
  wr('lyrics.json', db);
  if (track && key(track.artist, track.title) === k) lastId = null; // force reload
  return true;
});
ipcMain.handle('editor:clientId', (_, id) => { cfg.clientId = id.trim(); wr('config.json', cfg); return true; });
ipcMain.handle('editor:connect', () => connect());

ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_, patch) => { settings = { ...settings, ...patch }; wr('settings.json', settings); send('settings', settings); return settings; });
ipcMain.handle('settings:reset', () => { settings = { ...DEFAULTS }; wr('settings.json', settings); send('settings', settings); return settings; });
ipcMain.handle('settings:preview', () => {
  const texts = ['This is how your lyrics will look', 'Adjust the sliders and watch it change', 'The current line is big and bright',
    'Other lines fade into the background', 'Pick any colors you like', 'Shadows keep text readable', 'Try changing the background opacity',
    'Bold fonts look great on busy screens', 'Take your time', 'Almost there', 'Looking good', 'Enjoy the music'];
  previewUntil = Date.now() + 50000; lastId = null;
  send('track', { id: 'preview', title: 'Sample', artist: 'Preview', album: '', duration: 50000, source: 'preview', plain: '',
    lines: texts.map((text, i) => ({ t: i * 4000, text })) });
  send('progress', { ms: 0, playing: true });
});

app.whenReady().then(() => {
  cfg = rd('config.json', { clientId: process.env.SPOTIFY_CLIENT_ID || '' });
  tokens = rd('tokens.json', {});
  settings = { ...DEFAULTS, ...rd('settings.json', {}) };
  createOverlay();
  const gs = (k, f) => globalShortcut.register(k, f);
  gs('CommandOrControl+Alt+L', () => setLocked(!locked));
  gs('CommandOrControl+Alt+H', () => win.isVisible() ? win.hide() : win.show());
  gs('CommandOrControl+Alt+I', openEditor);
  gs('CommandOrControl+Alt+S', openSettings);
  gs('CommandOrControl+Alt+Left', () => send('offset', -250));
  gs('CommandOrControl+Alt+Right', () => send('offset', 250));
  setInterval(poll, 2000); poll();
});
app.on('window-all-closed', e => e.preventDefault());
app.on('will-quit', () => globalShortcut.unregisterAll());
