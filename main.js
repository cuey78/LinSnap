const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

// Diagnostic logging is on by default (userData/linsnap-debug.log).
// Set SNAPCHAT_DEBUG=0 to disable.
const DEBUG = process.env.SNAPCHAT_DEBUG !== '0';
function dbg(...parts) {
    if (!DEBUG) return;
    try {
        fs.appendFileSync(
            path.join(app.getPath('userData'), 'linsnap-debug.log'),
            new Date().toISOString() + ' ' + parts.join(' ') + '\n'
        );
    } catch { /* logging must never break the app */ }
}

// Only these (sub)domains may load inside the app window.
const ALLOWED_DOMAINS = [
    'snapchat.com',
    'snap.com',
    'bitmoji.com',
    'storyteller.com'
];

// Snapchat delivers chat snaps as HEVC blobs. On this machine the NVIDIA
// VA-API stack (Chromium's only HEVC path on Linux) produces corrupt frames,
// and Snap serves HEVC regardless of what the browser reports. So: keep
// VA-API off (no corrupt-frame decoding), and additionally transcode HEVC
// media responses to H.264 on the fly (see the snapx machinery below).
app.commandLine.appendSwitch('disable-features', 'VaapiVideoDecoder');

function isAllowedUrl(urlString) {
    try {
        const url = new URL(urlString);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') {
            return false;
        }
        const host = url.hostname.toLowerCase();
        return ALLOWED_DOMAINS.some(
            (domain) => host === domain || host.endsWith('.' + domain)
        );
    } catch {
        return false;
    }
}

// ---- snapx: HEVC -> H.264 media transcoder -----------------------------------
// The main-world wrapper (renderer-snapx.js) notices MP4 responses carrying
// HEVC and asks us to re-encode them. ffmpeg (bundled in the app's resources
// as resources/ffmpeg; falls back to the system one) decodes HEVC in pure
// software and encodes H.264, which Chromium decodes anywhere without GPU
// help. Results are cached per snap so replays are instant.
function findFfmpeg() {
    const candidates = [
        process.resourcesPath ? path.join(process.resourcesPath, 'ffmpeg') : null,
        path.join(__dirname, 'vendor', 'ffmpeg'),
        '/usr/bin/ffmpeg'
    ];
    for (const c of candidates) {
        try {
            if (c && fs.existsSync(c)) return c;
        } catch { /* ignore */ }
    }
    return null;
}

const xcode = { running: 0, max: 2, waiters: [] };
function xcodeSlot() {
    if (xcode.running < xcode.max) {
        xcode.running++;
        return Promise.resolve();
    }
    return new Promise((res) => xcode.waiters.push(res));
}
function xcodeRelease() {
    const w = xcode.waiters.shift();
    if (w) w();
    else xcode.running--;
}

function ffmpegTranscode(input) {
    return new Promise((resolve) => {
        const bin = findFfmpeg();
        if (!bin) {
            dbg('snapx: no ffmpeg found');
            resolve(null);
            return;
        }
        let settled = false;
        // Snap MP4s normally store mdat before moov. ffmpeg cannot rewind a
        // pipe to re-read samples after parsing moov ("partial file" error),
        // so the input always goes through a short-lived seekable temp file.
        let tmpIn = null;
        const done = (v) => {
            if (settled) return;
            settled = true;
            if (tmpIn) { try { fs.unlinkSync(tmpIn); } catch { /* ignore */ } }
            resolve(v);
        };

        try {
            const tmpDir = app.getPath('temp');
            tmpIn = path.join(tmpDir, 'snapx-in-' + crypto.randomBytes(8).toString('hex') + '.mp4');
            fs.writeFileSync(tmpIn, input);
        } catch (e) {
            dbg('snapx: tmp input failed', String(e && e.message || e).slice(0, 160));
            done(null);
            return;
        }

        let child;
        try {
            child = spawn(bin, [
                '-hide_banner', '-v', 'error',
                '-i', tmpIn,
                '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
                '-pix_fmt', 'yuv420p',
                '-c:a', 'copy',
                '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
                'pipe:1'
            ], { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
            dbg('snapx: spawn failed', String(e && e.message || e).slice(0, 120));
            done(null);
            return;
        }

        const out = [];
        let errText = '';
        child.stdout.on('data', (d) => out.push(d));
        child.stderr.on('data', (d) => { errText += d.toString(); if (errText.length > 4000) errText = errText.slice(-4000); });
        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
            dbg('snapx: ffmpeg timeout');
            done(null);
        }, 45000);
        child.on('error', (e) => { clearTimeout(timer); dbg('snapx: ffmpeg spawn error', String(e && e.message || e).slice(0, 160)); done(null); });
        child.on('close', (code) => {
            clearTimeout(timer);
            const buf = Buffer.concat(out);
            if (code === 0 && buf.length > 1000 && buf.includes('ftyp')) {
                done(buf);
            } else {
                dbg('snapx: ffmpeg exit', code, 'stderr:', errText.slice(0, 300));
                done(null);
            }
        });
    });
}

async function transcodeSnap(input) {
    const key = crypto.createHash('md5').update(input).digest('hex');
    let cacheFile = null;
    try {
        const dir = path.join(app.getPath('userData'), 'snapx-cache');
        fs.mkdirSync(dir, { recursive: true });
        cacheFile = path.join(dir, key + '.mp4');
        const hit = fs.readFileSync(cacheFile);
        if (hit.length > 1000) {
            dbg('snapx: cache hit', key.slice(0, 8));
            return hit;
        }
    } catch { /* cache miss or unavailable */ }

    await xcodeSlot();
    let out = null;
    try {
        out = await ffmpegTranscode(input);
    } finally {
        xcodeRelease();
    }
    if (out && cacheFile) {
        try { fs.writeFileSync(cacheFile, out); } catch { /* ignore */ }
    }
    return out;
}

function registerSnapx(win) {
    // Inject the fetch wrapper into the page's main world after each document
    // commits (before any snap media is requested: media only loads once the
    // user opens a chat). The wrapper is idempotent via __snapxWrapped, and it
    // calls window.__snapxInternal — the contextBridge exposure from our
    // isolated preload — to reach the transcoder here.
    const wrapperPath = path.join(__dirname, 'renderer-snapx.js');
    const wrapperSource = () => fs.readFileSync(wrapperPath, 'utf8');

    // Earliest possible hook: CDP evaluates this before any page script runs,
    // so even Snapchat's module-time cached references land on our patched
    // window.close / src setter. Falls back to dom-ready injection.
    try {
        win.webContents.debugger.attach('1.3');
        win.webContents.debugger
            .sendCommand('Page.enable')
            .then(() =>
                win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
                    source: wrapperSource()
                })
            )
            .then(() => dbg('snapx: CDP earliest injection armed'))
            .catch((e) => dbg('snapx: CDP inject failed', String(e && e.message || e).slice(0, 200)));
    } catch (e) {
        dbg('snapx: debugger attach failed', String(e && e.message || e).slice(0, 160));
    }

    const inject = () => {
        try {
            win.webContents.executeJavaScript(wrapperSource(), true).catch((e) => {
                dbg('snapx: inject failed', String(e && e.message || e).slice(0, 160));
            });
        } catch (e) {
            dbg('snapx: wrapper file missing', String(e && e.message || e).slice(0, 160));
        }
    };
    win.webContents.on('did-navigate', inject);
    win.webContents.on('dom-ready', inject);
    dbg('snapx: injection armed, ffmpeg=' + String(findFfmpeg()));
    // Page-side debug echo (renderer-snapx.js instrumentation).
    win.webContents.ipc.on('snapx-log', (event, msg) => {
        dbg('snapx-page', String(msg).slice(0, 400));
    });
    // Scoped to this window's webContents only.
    win.webContents.ipc.handle('snapx-transcode', async (event, payload) => {
        try {
            const frameUrl = event.senderFrame ? event.senderFrame.url : '';
            if (!isAllowedUrl(frameUrl) && process.env.SNAPCHAT_SELFTEST !== '1') {
                dbg('snapx: rejected sender', String(frameUrl).slice(0, 120));
                return null;
            }
            let input = null;
            if (typeof payload === 'string' && payload.length >= 32 && payload.length <= 56 * 1024 * 1024) {
                input = Buffer.from(payload, 'base64');
            } else if (payload instanceof ArrayBuffer) {
                input = Buffer.from(payload);
            } else if (ArrayBuffer.isView(payload)) {
                input = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
            }
            if (!input || input.length < 16 || input.length > 40 * 1024 * 1024) {
                dbg('snapx: upload rejected size=' + (input ? input.length : 'n/a'));
                return null;
            }
            const out = await transcodeSnap(input);
            dbg('snapx: transcode', out ? 'ok ' + input.length + ' -> ' + out.length + ' bytes' : 'FAILED (' + input.length + ' B in)');
            return out ? new Uint8Array(out.buffer, out.byteOffset, out.byteLength) : null;
        } catch (e) {
            dbg('snapx: ipc error', String(e && e.message || e).slice(0, 200));
            return null;
        }
    });
}

function buildSelftestHtml(hevcB64) {
    // Local proof of the snapx pipeline: hand a <video> a HEVC blob (which this
    // Chromium cannot decode) and see whether layer 2 swaps in the transcoded
    // H.264 twin so it actually plays. The src assignment is delayed so the
    // dom-ready injection has armed the wrapper first — same as on Snapchat,
    // where media only loads seconds after boot.
    return `<!doctype html><meta charset="utf-8">
<title>snapx selftest</title>
<body style="background:#111;color:#eee;font-family:sans-serif">
<video id="a" width="320" autoplay muted></video>
<video id="b" width="320" autoplay muted></video>
<pre id="out"></pre>
<script>
const B64 = "${hevcB64}";
function dec(s){const bin=atob(s),u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return u;}
const bytes = dec(B64);
const out = document.getElementById('out');
function report(tag, v){ const line = tag + " dims=" + v.videoWidth + "x" + v.videoHeight +
    " rs=" + v.readyState + " t=" + v.currentTime.toFixed(2) + " err=" + (v.error ? v.error.code : 0);
    out.textContent += line + "\\n"; console.log("SELFTEST " + line); }
const a = document.getElementById('a'); // goes through snapx layer 2
const b = document.getElementById('b'); // control: same bytes, snapx disabled for it
for (const [tag, v] of [["swapped", a], ["control", b]]) {
    v.addEventListener("canplay", () => report(tag + " canplay", v));
    v.addEventListener("loadeddata", () => report(tag + " loadeddata", v));
    v.addEventListener("error", () => report(tag + " ERROR", v));
}
b.__snapxBypass = true; // control: wrapper skips elements flagged like this
setTimeout(() => {
    const u = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
    a.src = u;
    b.src = u;
    out.textContent += "assigned " + u.slice(0, 40) + " bytes=" + bytes.length + "\\n";
}, 2500);
setTimeout(() => { report("final a", a); report("final b", b); out.textContent += "DONE\\n"; }, 9000);
<\/script></body>`;
}

// Dev-only (SNAPCHAT_AUTOTEST=1): simulate opening a chat snap — inventory the
// page, synthetic-click a conversation + snap card, then log every <video>'s
// state and any "can't play"-style UI text, so we can see exactly what the
// player and Snapchat's own handlers observe around a snapx swap.
function buildAutotestScript() {
    return `(async () => {
  const out = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const st = (v) => ({ rs: v.readyState, p: v.paused, t: +v.currentTime.toFixed(2),
    d: isFinite(v.duration) ? +v.duration.toFixed(2) : 'X', e: v.error ? v.error.code : 0,
    w: v.videoWidth, h: v.videoHeight, cs: (v.currentSrc || '').slice(5, 12) });
  const fire = (el) => { ['pointerover','pointerdown','mousedown','pointerup','mouseup','click'].forEach((tp) => {
    try { el.dispatchEvent(new PointerEvent(tp, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true })); }
    catch (e) { try { el.dispatchEvent(new MouseEvent(tp.replace('pointer', 'mouse'), { bubbles: true, cancelable: true })); } catch (e2) {} } }); };
  try {
    const ids = new Map();
    document.querySelectorAll('[data-testid]').forEach((el) => { const k = el.getAttribute('data-testid'); ids.set(k, (ids.get(k) || 0) + 1); });
    out.push('TESTIDS ' + Array.from(ids.entries()).sort((a, b) => b[1] - a[1]).slice(0, 45).map((kv) => kv[0] + ':' + kv[1]).join(' '));
  } catch (e) { out.push('TESTIDS err ' + e); }
  const convSels = ['[data-testid="conversations-list-item"]', '[data-testid="selected-conversation-item"]', '[data-testid*="conversation"]', 'div[role="listitem"]', 'a[href*="chat"]'];
  let clicked = false;
  for (const s of convSels) { const els = document.querySelectorAll(s); if (els.length) { out.push('CLICK conv ' + s + ' n=' + els.length); fire(els[0]); clicked = true; break; } }
  if (!clicked) out.push('CLICK conv none');
  await sleep(2600);
  const snapSels = ['[data-testid*="snap"]', '[data-testid*="story"]', '[aria-label*="snap" i]', '[data-testid*="media"]'];
  let snapClicked = false;
  for (const s of snapSels) { const els = document.querySelectorAll(s); if (els.length) { out.push('CLICK snap ' + s + ' n=' + els.length); fire(els[0]); snapClicked = true; break; } }
  if (!snapClicked) { const v0 = document.querySelector('video'); if (v0) { out.push('CLICK snap fallback video'); fire(v0); } }
  for (let i = 0; i < 34; i++) {
    await sleep(800);
    try {
      const vids = Array.from(document.querySelectorAll('video')).map(st);
      out.push('V' + i + ' ' + JSON.stringify(vids.slice(0, 12)));
      const m = (document.body.innerText || '').match(/[^.\\n]{0,60}(can.?t play|can not play|unable to play|couldn.?t|failed)[^.\\n]{0,40}/i);
      if (m) out.push('TEXT ' + m[0].slice(0, 130));
    } catch (e) { out.push('scan err ' + String(e).slice(0, 80)); }
  }
  return out.join('\\n');
})()`;
}

// Lifecycle: track app-initiated quits so SNAPCHAT_KEEP_OPEN only vetoes
// closes that come from the page side (Snapchat's own close flow).
let appQuitting = false;
app.on('before-quit', () => {
    appQuitting = true;
    dbg('app:before-quit');
});

// Anything Snapchat legitimately opens via window.open (SSO popups etc.) must
// become a REAL child window: if window.open returns null (deny), Snapchat's
// popup-cleanup code calls window.close() on the main window instead.
const openExternally = (url) => {
    dbg('guard: opening externally', String(url).slice(0, 200));
    shell.openExternal(url).catch(() => {});
};

function applyChromeUA(wc) {
    // Snapchat's web app requires a "latest Chrome/Edge/Safari" user agent;
    // Electron's own UA token gets a "Browser not supported" wall. Present a
    // clean Chrome UA matching the bundled Chromium version.
    // SNAPCHAT_UA=win|mac switches the platform token (used to test whether
    // Snapchat serves H.264 instead of HEVC to non-Windows clients).
    const uaOS = process.env.SNAPCHAT_UA === 'win' ? 'Windows NT 10.0; Win64; x64'
        : process.env.SNAPCHAT_UA === 'mac' ? 'Macintosh; Intel Mac OS X 10_15_7'
        : 'X11; Linux x86_64';
    wc.setUserAgent(
        'Mozilla/5.0 (' + uaOS + ') AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/' + process.versions.chrome + ' Safari/537.36'
    );
}

function attachGuards(w) {
    w.webContents.setWindowOpenHandler(({ url }) => {
        const allowed = isAllowedUrl(url);
        dbg('window-open', allowed ? 'allow-child' : 'external', String(url).slice(0, 200));
        if (!allowed) openExternally(url);
        return { action: allowed ? 'allow' : 'deny' };
    });

    w.webContents.on('will-navigate', (event, url) => {
        if (!isAllowedUrl(url)) {
            dbg('guard: navigation blocked', String(url).slice(0, 200));
            event.preventDefault();
            openExternally(url);
        }
    });
}

const configuredWindows = new WeakSet();

function configureSnapWindow(w) {
    if (configuredWindows.has(w)) return;
    configuredWindows.add(w);
    applyChromeUA(w.webContents);
    registerSnapx(w);
    attachGuards(w);
    try { w.removeMenu(); } catch { /* ignore */ }
    w.webContents.on('did-navigate', (e, url) => {
        dbg('child did-navigate', String(url).slice(0, 200));
    });
    w.on('closed', () => dbg('snap window closed'));
}

function createWindow() {
    const win = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1000,
        minHeight: 700,
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            // Use persistent session
            partition: 'persist:snapchat'
        }
    });

    configureSnapWindow(win);
    if (process.env.SNAPCHAT_SELFTEST) {
        const hevcFile = process.env.SNAPCHAT_SELFTEST_FILE || '/tmp/opencode/codec-test/test_hevc.mp4';
        const b64 = fs.readFileSync(hevcFile).toString('base64');
        const selfPage = path.join(app.getPath('userData'), 'selftest.html');
        fs.writeFileSync(selfPage, buildSelftestHtml(b64));
        dbg('selftest: hevc file', hevcFile, 'b64len=' + b64.length);
        win.loadFile(selfPage);
    } else {
        win.loadURL('https://web.snapchat.com');
    }

    // Lifecycle evidence for the mystery self-exit.
    win.on('close', (event) => {
        dbg('win:close');
        if (process.env.SNAPCHAT_KEEP_OPEN === '1' && !appQuitting) {
            dbg('win:close prevented (SNAPCHAT_KEEP_OPEN)');
            event.preventDefault();
        }
    });
    win.on('closed', () => dbg('win:closed'));
    win.on('blur', () => dbg('win:blur'));
    win.on('hide', () => dbg('win:hide'));

    if (process.env.SNAPCHAT_AUTOTEST === '1' && !process.env.SNAPCHAT_SELFTEST) {
        setTimeout(() => {
            win.webContents.executeJavaScript(buildAutotestScript(), true)
                .then((r) => { for (const line of String(r).split('\n')) dbg('autotest ' + line); })
                .catch((e) => dbg('autotest failed', String(e).slice(0, 200)));
        }, 18000);
    }

    if (DEBUG) {
        const wc = win.webContents;
        wc.on('console-message', (e, level, message, line, sourceId) => {
            dbg('console[' + level + ']', String(message).slice(0, 400), '@', String(sourceId).split('/').pop() + ':' + line);
        });
        wc.on('did-fail-load', (e, code, description, validatedUrl) => {
            dbg('did-fail-load', code, description, String(validatedUrl).slice(0, 200));
        });
        wc.on('did-navigate', (e, url) => dbg('did-navigate', String(url).slice(0, 200)));
        wc.on('did-navigate-in-page', (e, url) => dbg('nav-in-page', String(url).slice(0, 200)));
        wc.on('render-process-gone', (e, details) => dbg('render-process-gone', JSON.stringify(details)));
        wc.on('media-started-playing', () => dbg('media-started-playing'));
        wc.on('media-paused', () => dbg('media-paused'));
        wc.on('did-finish-load', () => dbg('did-finish-load', wc.getURL()));
        dbg('startup: app=' + app.getVersion(), 'electron=' + process.versions.electron);

        // Heavy visual diagnostics (video-state dumps + window screenshots)
        // are opt-in only: SNAPCHAT_DIAG=1. Normal debug logging stays on.
        if (process.env.SNAPCHAT_DIAG === '1') {
        // Media diagnostics: every 6s for the first 3 minutes, dump the state
        // of every <video> on the page, its codec support answers, and the
        // first bytes of its source so we can see which codec Snapchat serves.
        const diag = setInterval(async () => {
            try {
                const dump = await win.webContents.executeJavaScript(`(async () => {
                    const vids = [...document.querySelectorAll('video')].map(v => ({
                        src: (v.currentSrc || v.src || '').slice(0, 100),
                        err: v.error ? v.error.code : null,
                        readyState: v.readyState, time: v.currentTime,
                        dims: v.videoWidth + 'x' + v.videoHeight, paused: v.paused
                    }));
                    const codecs = {};
                    const v0 = document.createElement('video');
                    for (const c of ['video/mp4; codecs="hvc1.1.6.L123.B0"', 'video/mp4; codecs="hev1.1.6.L123.B0"', 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"'])
                        codecs[c] = v0.canPlayType(c) || 'no';
                    let hevcCaps = 'n/a';
                    try {
                        const ci = await navigator.mediaCapabilities.decodingInfo({
                            type: 'playback',
                            video: { contentType: 'video/mp4; codecs="hvc1.1.6.L123.B0"', size: 10000000, width: 1920, height: 1080, bitrate: 2000000 }
                        });
                        hevcCaps = JSON.stringify({ supported: ci.supported, smooth: ci.smooth, powerEfficient: ci.powerEfficient });
                    } catch (e) { hevcCaps = 'err: ' + String(e); }
                    const blobSniff = [];
                    for (const vb of [...document.querySelectorAll('video')].slice(0, 4)) {
                        const u = vb.currentSrc || vb.src || '';
                        if (!u) continue;
                        try {
                            const r = await fetch(u);
                            const buf = await r.arrayBuffer();
                            const head = new Uint8Array(buf.slice(0, 65536));
                            let ascii = '';
                            for (let i = 0; i < head.length; i++) ascii += (head[i] >= 32 && head[i] < 127) ? String.fromCharCode(head[i]) : '.';
                            const toks = (ascii.match(/ftyp.{4}/g) || []).concat(ascii.match(/avc1|hev1|hvc1|av01|vp09|mp4a|sbrt|btrt|colr/g) || []).slice(0, 12);
                            blobSniff.push({ src: u.slice(0, 60), bytes: buf.byteLength, codecsFound: [...new Set(toks)] });
                        } catch (e) { blobSniff.push({ src: u.slice(0, 60), fail: String(e).slice(0, 60) }); }
                    }
                    const snapx = {
                        wrapped: !!window.__snapxWrapped,
                        bridge: !!(window.__snapxInternal && window.__snapxInternal.transcode),
                        fetchPatched: !window.fetch.toString().includes('[native code]')
                    };
                    return { url: location.href.slice(0, 100), nVids: vids.length, vids: vids.slice(0, 6), codecs, hevcCaps, blobSniff, snapx };
                })()`);
                dbg('PAGE-DUMP ' + JSON.stringify(dump));
            } catch (e) { dbg('page-dump-error', String(e).slice(0, 150)); }
        }, 6000);
        setTimeout(() => clearInterval(diag), 180000);

        // Visual evidence: eight window snapshots, 8s apart, saved as
        // capture-NN.png in the app data dir (overwritten each launch).
        let shots = 0;
        const shotIv = setInterval(async () => {
            try {
                const img = await win.webContents.capturePage();
                fs.writeFileSync(
                    path.join(app.getPath('userData'), 'capture-' + String(shots + 1).padStart(2, '0') + '.png'),
                    img.toPNG()
                );
                dbg('capture saved', shots + 1);
            } catch { /* ignore */ }
            if (++shots >= 8) clearInterval(shotIv);
        }, 8000);
        }
    }
}

app.whenReady().then(() => {
    // Give every child window Snapchat opens the same preload/UA/guards/snapx
    // treatment (Electron copies the opener's webPreferences, so the preload
    // and persist:snapchat partition carry over automatically).
    app.on('browser-window-created', (event, w) => {
        dbg('browser-window-created');
        configureSnapWindow(w);
    });
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    dbg('app:window-all-closed');
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
