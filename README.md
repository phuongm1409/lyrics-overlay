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
| Lock / unlock | The overlay passes clicks through outside the four icons in both modes. To reposition it, unlock and drag the lock icon. Shift-drag the same icon to resize. Click it again to lock the position. |
| Upload | Import timed lyrics for the current track. If Spotify has no active track, enter its artist and title in the editor before saving. |
| Menu | Change background opacity, text and sweep colors, font, and sync offset. Toggle the previous or next lyric, track info, lyric source, playback progress, and status messages. |
| Close | Choose **Hide to tray**, **Exit completely**, or **Cancel**. To restore, click the app icon in the Windows notification area or its **Hidden icons** section. Right-click it for the tray menu. |

The app supports LRC (including enhanced LRC), SRT, WebVTT, SBV, timed TXT, ASS/SSA, TTML/DFXP, YouTube timed-text XML/JSON3, SAMI, and compatible JSON transcripts. The importer detects these formats by their contents. Plain lyrics can still be pasted into the editor.

The overlay works over borderless-windowed games. Exclusive fullscreen can cover it.

## Building the portable Windows app

Run `npm install` and `npm run dist` on Windows, or run **Build Windows exe** in GitHub Actions. The workflow attaches the portable executable as an artifact.

The toolbar uses the SVGs in the project root. The tray and Windows executable use `assets/icon.png`, generated from `icon.svg`.


## Local lyrics storage

On Windows, imported lyrics are stored in `%APPDATA%\lyrics-overlay\lyrics.json` by the current portable build. The file maps each artist and song title to the imported subtitle text, including timestamps. Each new import also keeps a byte-for-byte copy in the local `original-subtitles` folder. The selected source file stays where it was. Spotify tokens and appearance settings are stored separately.


## Google Drive sync

The app uses your Google account to store a `Lyrics Overlay` folder in My Drive. It contains `lyrics.json` and an `Original subtitles` folder. Sign in using the same Google account and OAuth project on each device to sync your saved lyrics. The original files can also be downloaded from Drive. The app continues to use a local copy when offline. When both copies changed the same song since the previous sync, this device’s edit takes precedence.

1. In [Google Cloud Console](https://console.cloud.google.com/), enable the Google Drive API in your project and configure the OAuth consent screen. If your app is in Testing, add yourself under Test users.
2. Create an OAuth client of type **Desktop app** in Google Auth Platform → Clients. Download its OAuth JSON. Use the same project and client file on every device.
3. In Lyrics Overlay, open **Settings → Google Drive → Sign in with Google**. Select that JSON file on first setup and finish sign-in in your browser.
4. The app syncs on sign-in, after edits, and periodically while connected. Use **Sync now** to sync immediately, or **Open Drive folder** to inspect the saved files.

Subtitles imported before this release exist in the old `lyrics.json` as text only. Re-import the original file if you also want a byte-for-byte Drive backup of it. Disconnecting Google pauses sync and keeps existing files in Drive and on the device. Choosing another Google account explicitly syncs the library already on this device with that account.
