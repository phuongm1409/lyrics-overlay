# Lyrics Overlay

## Setup
1. Install Node.js 18+ then run `npm install` and `npm start`.
2. Go to https://developer.spotify.com/dashboard → Create app → add Redirect URI `http://127.0.0.1:8888/callback` (Web API).
3. Copy the app's Client ID. Press Ctrl+Alt+E, paste it, click "Connect Spotify", and approve in the browser.
4. Play a song in Spotify. Lyrics appear and follow along.

## Controls
| Shortcut | Action |
|---|---|
| Ctrl+Alt+L | Lock (click-through) / unlock (drag to move, resize edges) |
| Ctrl+Alt+H | Show / hide |
| Ctrl+Alt+E | Add / edit lyrics |
| Ctrl+Alt+Left / Right | Shift sync -/+ 250 ms |

Also available from the tray icon. Games must run in borderless-windowed mode; true exclusive fullscreen hides all overlays.

Lyrics come from LRCLIB (synced when available). Your own lyrics are saved locally and always take priority.

## Getting an .exe without installing Node
Upload this folder to a GitHub repo. The "Build Windows exe" workflow (Actions tab) builds `LyricsOverlay-1.0.0.exe` as a downloadable artifact.
