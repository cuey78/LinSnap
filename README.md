# LinSnap

LinSnap is a personal Linux desktop wrapper for [Snapchat](https://web.snapchat.com) built on
Electron, packaged as an AppImage.

## Why

Snapchat's web app serves chat videos as **HEVC/H.265**, which the bundled Chromium cannot
decode on many Linux GPU stacks (its only Linux HEVC path, VA-API, is broken on common
setups). Videos therefore failed with a "can't play media" error.

LinSnap fixes this with an in-app transcode bridge (**snapx**):

1. Every media assignment Snapchat makes to a `<video>` element is intercepted.
2. The element instantly receives a tiny valid H.264 placeholder, so the page never sees a
   decode error (no red "can't play" cards).
3. The real bytes are checked for HEVC markers in the background; if present, the bundled
   `ffmpeg` transcodes them to H.264 (fragmented MP4) in a few hundred milliseconds and the
   transcoded clip is swapped in seamlessly.
4. Transcodes are cached (`~/.config/linsnap/snapx-cache/`), so replays are instant.

If bytes turn out not to be HEVC, the original source is restored untouched — the bridge is
transparent for everything else.

## Security hardening

The shipped binary has Electron fuses applied:

| Fuse | State |
| --- | --- |
| `runAsNode` | disabled |
| `enableCookieEncryption` | enabled |
| `enableEmbeddedAsarIntegrityValidation` | enabled |
| `onlyLoadAppFromAsar` | enabled |
| `enableNodeOptionsEnvironmentVariable` | disabled |
| `enableNodeCliInspectArguments` | disabled |
| V8 snapshot browser load | disabled |
| `grantFileProtocolExtraPrivileges` | disabled |

Navigation and popups are restricted to an allowlist of Snapchat domains; everything else is
opened in the system browser. The app runs with `contextIsolation`, no `nodeIntegration`,
sandboxed renderer, and a persistent session partition.

## Build

```bash
npm install
npm run build        # electron-builder -> dist/LinSnap-1.0.0.AppImage
```

A static `ffmpeg` binary is expected at `vendor/ffmpeg` (it is bundled into the AppImage as
`resources/ffmpeg`; it is not read by the Node code, only executed).

## Environment flags (diagnostics, all off by default)

- `SNAPCHAT_DEBUG=0` — disable the debug log (`~/.config/linsnap/linsnap-debug.log`)
- `SNAPCHAT_DIAG=1` — heavy page diagnostics (video-state dumps, screenshots)
- `SNAPCHAT_AUTOTEST=1` — dev-only UI probe (dev builds only)
- `SNAPCHAT_SELFTEST=1` + `SNAPCHAT_SELFTEST_FILE=<hevc.mp4>` — end-to-end transcode selftest
- `SNAPCHAT_KEEP_OPEN=1` — veto page-initiated window closes (dev convenience)
- `SNAPCHAT_UA=win|mac` — switch the user-agent platform token

## Caveats

- Unofficial client. Snapchat is a trademark of Snap Inc.; this project is for personal use
  only and is not affiliated with or endorsed by Snap Inc.
- No webcam passthrough: viewing and text/photo snaps work, camera capture does not.
- Violating Snapchat's terms may get your account flagged; use at your own risk.
- Bundled `ffmpeg` is GPL/LGPL — see <https://ffmpeg.org/legal.html>.

## License

MIT for the wrapper code in this repository. Snapchat, its name and ghost logo belong to
Snap Inc.
