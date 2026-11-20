const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const TOKEN = 'https://oauth2.googleapis.com/token';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const SCOPE = 'openid email ' + DRIVE_SCOPE;
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SUBTITLE_LIMIT = 8 * 1024 * 1024;

function hash(...parts) {
  const digest = crypto.createHash('sha256');
  for (const part of parts) digest.update(part);
  return digest.digest('hex');
}

function atomicWrite(file, data) {
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, data);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return fallback; throw err; }
}

function lyricsMap(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || !Object.values(value).every(text => typeof text === 'string')) {
    throw new Error('lyrics.json could not be read. Your files were kept.');
  }
  return value;
}

function mergeLyrics(base, local, remote) {
  const result = Object.create(null);
  const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
  const value = (map, key) => Object.hasOwn(map, key) ? map[key] : undefined;
  for (const key of [...keys].sort()) {
    const localText = value(local, key);
    const merged = localText !== value(base, key) ? localText : value(remote, key);
    if (merged !== undefined) result[key] = merged;
  }
  return result;
}

function equalLyrics(left, right) {
  return Object.keys(left).length === Object.keys(right).length
    && Object.keys(left).every(key => Object.hasOwn(right, key) && right[key] === left[key]);
}

function credentialsFrom(data) {
  const installed = data?.installed;
  if (typeof installed?.client_id !== 'string' || !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(installed.client_id)) {
    throw new Error('Choose the OAuth JSON for a Google Desktop app.');
  }
  return { id: installed.client_id, secret: typeof installed.client_secret === 'string' ? installed.client_secret : '' };
}

async function authorize(client, openExternal, exchange) {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const state = crypto.randomBytes(32).toString('base64url');
  let accept, reject, accepted = false;
  const result = new Promise((resolve, fail) => { accept = resolve; reject = fail; });
  void result.catch(() => {});
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/callback' || url.searchParams.get('state') !== state || accepted) {
      return res.writeHead(404).end();
    }
    accepted = true;
    const code = url.searchParams.get('code');
    if (!code) {
      res.writeHead(400).end('Google sign-in was cancelled. You can close this tab.');
      reject(new Error('Google sign-in was cancelled.'));
      return;
    }
    exchange({ code, redirect_uri: redirect, code_verifier: verifier, grant_type: 'authorization_code' })
      .then(tokens => {
        res.end('Google sign-in received. Return to Lyrics Overlay.');
        accept(tokens);
      }, error => {
        res.writeHead(400).end('Google sign-in could not be completed. Return to Lyrics Overlay.');
        reject(error);
      });
  });
  server.on('clientError', (_, socket) => socket.destroy());
  let redirect, timer;
  try {
    await new Promise((resolve, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', resolve);
    });
    redirect = 'http://127.0.0.1:' + server.address().port + '/callback';
    const params = new URLSearchParams({
      client_id: client.id, redirect_uri: redirect, response_type: 'code', scope: SCOPE,
      access_type: 'offline', prompt: 'consent select_account', state,
      code_challenge_method: 'S256', code_challenge: hashBase64(verifier)
    });
    timer = setTimeout(() => reject(new Error('Google sign-in timed out. Try again.')), 180000);
    await openExternal('https://accounts.google.com/o/oauth2/v2/auth?' + params);
    return await result;
  } finally {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }
}

function hashBase64(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

class GoogleDrive {
  constructor({ directory, safeStorage, openExternal, onStatus, onLyricsChanged, request = fetch }) {
    this.directory = directory;
    this.safeStorage = safeStorage;
    this.openExternal = openExternal;
    this.onStatus = onStatus;
    this.onLyricsChanged = onLyricsChanged;
    this.request = request;
    this.client = null;
    this.account = null;
    this.accessToken = null;
    this.busy = false;
    this.lastSynced = null;
    this.folder = null;
    this.message = '';
  }

  get state() {
    return { configured: !!this.client, email: this.account?.email ?? '', busy: this.busy,
      lastSynced: this.lastSynced, message: this.message, folder: this.folder };
  }

  notify() { this.onStatus(this.state); }

  get credentialsFile() { return path.join(this.directory, 'google-drive.dat'); }
  get lyricsFile() { return path.join(this.directory, 'lyrics.json'); }
  get originalsDirectory() { return path.join(this.directory, 'original-subtitles'); }

  start() {
    try {
      if (fs.existsSync(this.credentialsFile)) {
        this.requireEncryption();
        const data = JSON.parse(this.safeStorage.decryptString(fs.readFileSync(this.credentialsFile)));
        this.client = data.client;
        this.account = data.account;
        this.schedule(0);
      }
    } catch {
      this.message = 'Saved Google sign-in could not be opened. Sign in again.';
    }
    this.notify();
  }

  requireEncryption() {
    if (!this.safeStorage.isEncryptionAvailable() || this.safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
      throw new Error('Google sign-in needs encrypted credential storage on this device.');
    }
  }

  saveCredentials(client, account) {
    this.requireEncryption();
    atomicWrite(this.credentialsFile, this.safeStorage.encryptString(JSON.stringify({ client, account })));
  }

  configure(data) {
    if (this.busy || this.account) throw new Error('Disconnect Google before changing the OAuth file.');
    const client = credentialsFrom(data);
    this.saveCredentials(client, null);
    this.client = client;
    this.message = 'OAuth file loaded.';
    this.notify();
  }

  async tokenRequest(client, parameters) {
    const response = await this.request(TOKEN, {
      method: 'POST', signal: AbortSignal.timeout(20000),
      body: new URLSearchParams({ client_id: client.id, ...(client.secret ? { client_secret: client.secret } : {}), ...parameters })
    });
    const data = await response.json();
    if (data.error === 'invalid_grant' && parameters.grant_type === 'refresh_token') {
      this.disconnect();
      throw new Error('Google sign-in expired. Sign in again to resume sync.');
    }
    if (!response.ok || !data.access_token) throw new Error('Google authorization failed. Check your Desktop OAuth file and try again.');
    return data;
  }

  async signIn() {
    if (this.busy || this.account) return;
    if (!this.client) throw new Error('Load your Google Desktop OAuth JSON first.');
    await this.withStatus('Waiting for Google sign-in…', async () => {
      const tokens = await authorize(this.client, this.openExternal, parameters => this.tokenRequest(this.client, parameters));
      if (tokens.scope && !tokens.scope.split(/\s+/).includes(DRIVE_SCOPE)) {
        throw new Error('Google Drive permission was not granted. Sign in again and allow Drive access.');
      }
      if (!tokens.refresh_token) throw new Error('Google did not grant offline access. Sign in and grant Drive access again.');
      const response = await this.request('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: 'Bearer ' + tokens.access_token }, signal: AbortSignal.timeout(20000)
      });
      if (!response.ok) throw new Error('Could not read the signed-in Google account.');
      const { sub, email } = await response.json();
      if (!sub || !email) throw new Error('Google did not return an account email.');
      const account = { sub, email, refreshToken: tokens.refresh_token };
      this.saveCredentials(this.client, account);
      this.account = account;
      this.setAccess(tokens);
      this.message = 'Google account connected.';
    });
    this.schedule(0);
  }

  setAccess(tokens) {
    this.accessToken = { value: tokens.access_token, expires: Date.now() + Number(tokens.expires_in ?? 3600) * 1000 - 30000 };
  }

  disconnect() {
    clearTimeout(this.timer);
    this.saveCredentials(this.client, null);
    this.account = null;
    this.accessToken = null;
    this.folder = null;
    this.lastSynced = null;
    this.message = 'Google Drive disconnected. Your local lyrics remain available.';
    this.notify();
  }

  async driveRequest(url, options = {}, retry = true) {
    if (!this.accessToken || this.accessToken.expires <= Date.now()) {
      const tokens = await this.tokenRequest(this.client, { grant_type: 'refresh_token', refresh_token: this.account.refreshToken });
      if (tokens.refresh_token && tokens.refresh_token !== this.account.refreshToken) {
        const account = { ...this.account, refreshToken: tokens.refresh_token };
        this.saveCredentials(this.client, account);
        this.account = account;
      }
      this.setAccess(tokens);
    }
    const response = await this.request(url, {
      ...options, headers: { ...options.headers, Authorization: 'Bearer ' + this.accessToken.value },
      signal: AbortSignal.timeout(45000)
    });
    if (response.status === 401 && retry) {
      this.accessToken = null;
      return this.driveRequest(url, options, false);
    }
    if (!response.ok) {
      const reason = (await response.json().catch(() => null))?.error?.errors?.[0]?.reason;
      if (reason === 'accessNotConfigured') throw new Error('Enable the Google Drive API in your Google Cloud project.');
      throw new Error('Google Drive returned HTTP ' + response.status + '.');
    }
    return response;
  }

  async list(query, fields) {
    const files = [];
    let pageToken;
    do {
      const params = new URLSearchParams({
        q: 'trashed = false and ' + query, fields: 'nextPageToken,files(' + fields + ')', pageSize: '1000',
        ...(pageToken ? { pageToken } : {})
      });
      const data = await (await this.driveRequest(API + '?' + params)).json();
      files.push(...(data.files ?? []));
      pageToken = data.nextPageToken;
    } while (pageToken);
    return files;
  }

  async getFolder(role, name, parent) {
    const query = "mimeType = '" + FOLDER_MIME + "' and appProperties has { key='lyricsOverlayRole' and value='" + role + "' }";
    const [existing] = await this.list(query + (parent ? " and '" + parent + "' in parents" : ''), 'id');
    if (existing) return existing.id;
    const body = { name, mimeType: FOLDER_MIME, appProperties: { lyricsOverlayRole: role }, ...(parent ? { parents: [parent] } : {}) };
    const response = await this.driveRequest(API + '?fields=id', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    return (await response.json()).id;
  }

  async upload(body, media, mime, id) {
    const endpoint = UPLOAD + (id ? '/' + encodeURIComponent(id) : '') + '?uploadType=resumable&fields=id';
    const response = await this.driveRequest(endpoint, {
      method: id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(media.length) },
      body: JSON.stringify(body)
    });
    const location = response.headers.get('location');
    if (!location || new URL(location).origin !== new URL(UPLOAD).origin) throw new Error('Google Drive did not return an upload URL.');
    await this.driveRequest(location, { method: 'PUT', headers: { 'Content-Type': mime }, body: media });
  }

  keepOriginal(name, bytes) {
    const key = hash(name, '\0', bytes);
    const directory = path.join(this.originalsDirectory, key);
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, name);
    if (!fs.existsSync(file)) atomicWrite(file, bytes);
  }

  async sendOriginals(folder) {
    if (!fs.existsSync(this.originalsDirectory)) return;
    const directories = fs.readdirSync(this.originalsDirectory, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name));
    if (!directories.length) return;
    const parent = await this.getFolder('originals-v1', 'Original subtitles', folder);
    const files = await this.list("'" + parent + "' in parents", 'appProperties');
    const uploaded = new Set(files.map(file => file.appProperties?.lyricsOverlayOriginal));
    for (const { name: key } of directories) {
      if (uploaded.has(key)) continue;
      const directory = path.join(this.originalsDirectory, key);
      const [source] = fs.readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isFile() && !/\.[a-f0-9-]{36}\.tmp$/.test(entry.name));
      if (!source) continue;
      const bytes = fs.readFileSync(path.join(directory, source.name));
      if (hash(source.name, '\0', bytes) !== key) throw new Error('A local subtitle backup could not be read.');
      const mime = 'application/octet-stream';
      await this.upload({ name: source.name, mimeType: mime, parents: [parent], appProperties: { lyricsOverlayOriginal: key } }, bytes, mime);
    }
  }

  async listLyrics(folder) {
    return (await this.list("'" + folder + "' in parents and appProperties has { key='lyricsOverlayRole' and value='lyrics-v1' }", 'id,version'))[0];
  }

  async sync() {
    if (this.busy || !this.account) return;
    await this.withStatus('Syncing with Google Drive…', async () => {
      const key = hash(this.client.id, ':', this.account.sub);
      const baselineFile = path.join(this.directory, 'google-drive-' + key + '.json');
      const base = lyricsMap(readJson(baselineFile, {}));
      this.folder = await this.getFolder('library-v1', 'Lyrics Overlay');
      await this.sendOriginals(this.folder);
      const local = lyricsMap(readJson(this.lyricsFile, {}));
      const file = await this.listLyrics(this.folder);
      const remote = file ? lyricsMap(await (await this.driveRequest(API + '/' + encodeURIComponent(file.id) + '?alt=media')).json()) : {};
      // A missing cloud archive should be rebuilt from this device rather than treated as many deletions.
      const merged = mergeLyrics(file ? base : {}, local, remote);
      if (!file || !equalLyrics(remote, merged)) {
        const current = await this.listLyrics(this.folder);
        if (current?.id !== file?.id || current?.version !== file?.version) {
          throw new Error('Your Drive library changed during sync. The app will retry.');
        }
        const metadata = file ? {} : {
          name: 'lyrics.json', mimeType: 'application/json', parents: [this.folder], appProperties: { lyricsOverlayRole: 'lyrics-v1' }
        };
        await this.upload(metadata, Buffer.from(JSON.stringify(merged, null, 2)), 'application/json', file?.id);
      }
      const newest = lyricsMap(readJson(this.lyricsFile, {}));
      const mergedWithPendingEdits = mergeLyrics(local, newest, merged);
      if (!equalLyrics(newest, mergedWithPendingEdits)) {
        atomicWrite(this.lyricsFile, JSON.stringify(mergedWithPendingEdits, null, 2));
        this.onLyricsChanged();
      }
      atomicWrite(baselineFile, JSON.stringify(merged));
      this.lastSynced = new Date().toISOString();
      this.message = 'Synced to Google Drive.';
    });
    this.schedule(this.needsSync ? 2000 : 60000);
    this.needsSync = false;
  }

  schedule(delay = 2000) {
    if (!this.account) return;
    if (this.busy) { this.needsSync = true; return; }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.sync(), delay);
    this.timer.unref();
  }

  async withStatus(message, work) {
    this.busy = true;
    this.message = message;
    this.notify();
    try { await work(); }
    catch (err) {
      this.message = err instanceof TypeError || err.name === 'TimeoutError'
        ? 'Google Drive is unavailable. Your local lyrics are safe.' : err.message;
    } finally {
      this.busy = false;
      this.notify();
    }
  }
}

module.exports = { GoogleDrive, SUBTITLE_LIMIT, atomicWrite, lyricsMap, mergeLyrics, readJson };
