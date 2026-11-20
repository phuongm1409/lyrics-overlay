# Lyrics Overlay

Lyrics Overlay is a Windows desktop overlay for Spotify. The current line fills in lime green as it plays. Lyrics with word timestamps use those timestamps. For line-only subtitles, the fill moves across each line over the cue's duration.

## Setup

1. Install Node.js 18+ and run `npm install` and `npm start`.
2. Create an app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard). Add `http://127.0.0.1:8888/callback` as a Web API redirect URI.
3. On the overlay, click **Settings** → **Lyrics editor / Spotify setup**. Paste your Spotify Client ID, then click **Connect Spotify** and approve in your browser.
4. Play a track. The app looks for your saved lyrics first, then uses LRCLIB and NetEase.

## Overlay controls

| Icon | Action |
|---|---|
| Lock / unlock | Click-through when locked, with the four toolbar icons still available. Unlock to drag the header or resize the window. |
| Upload | Import timed lyrics for the current track. If Spotify has no active track, enter its artist and title in the editor before saving. |
| Menu | Change background opacity, text and sweep colors, font, and sync offset. Toggle the previous or next lyric, track info, lyric source, playback progress, and status messages. |
| Close | Choose **Hide to tray**, **Exit completely**, or **Cancel**. To restore, click the app icon in the Windows notification area or its **Hidden icons** section. Right-click it for the tray menu. |

The app supports LRC (including enhanced LRC), SRT, WebVTT, SBV, timed TXT, ASS/SSA, TTML/DFXP, YouTube timed-text XML/JSON3, SAMI, and compatible JSON transcripts. The importer detects these formats by their contents. Plain lyrics can still be pasted into the editor.

The overlay works over borderless-windowed games. Exclusive fullscreen can cover it.

## Building the portable Windows app

Run `npm install` and `npm run dist` on Windows, or run **Build Windows exe** in GitHub Actions. The workflow attaches the portable executable as an artifact.

The toolbar uses the SVGs in the project root. The tray and Windows executable use `assets/icon.png`, generated from `icon.svg`.
