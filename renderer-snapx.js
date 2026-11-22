// Runs in the page's main world (injected via executeJavaScript on dom-ready
// / did-navigate) before any snap media is requested. Snapchat fetches chat
// snaps as MP4 and hands them to <video> as blob: URLs. On this machine those
// files are HEVC, which Chromium cannot decode here (its only Linux HEVC path,
// VA-API, is broken on this GPU stack). So we intercept:
//
//   layer 1: window.fetch — if a response is an HEVC MP4, swap in the
//            main process's H.264 transcode before Snapchat packages it.
//   layer 2: HTMLMediaElement.src setter — catch-all: when the page assigns a
//            blob: URL to a media element we immediately assign a valid H.264
//            placeholder (so the element never fires an error the page could
//            react to), inspect the real bytes in the background, and replace
//            src with the transcoded twin (blob: stays CSP-legal) or restore
//            the original if it was not HEVC.
//
// Everything degrades gracefully: any failure returns the original response /
// element behaviour untouched.
(() => {
    if (window.__snapxWrapped) return;
    window.__snapxWrapped = true;

    let logs = 0;
    function log(m) {
        try {
            const b = window.__snapxInternal;
            if (logs++ < 140 && b && typeof b.log === 'function') b.log(String(m).slice(0, 400));
        } catch { /* ignore */ }
    }

    function viewOf(x) {
        if (x instanceof ArrayBuffer) return new Uint8Array(x);
        if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
        return null;
    }

    // hvcC / hvc1 / hev1 box markers anywhere in the bytes.
    function findHevc(x) {
        const u8 = viewOf(x);
        if (!u8) return false;
        const n = u8.length;
        for (let i = 0; i + 3 < n; i++) {
            if (u8[i] !== 0x68) continue; // 'h'
            const b = u8[i + 1], c = u8[i + 2], d = u8[i + 3];
            if (b === 0x76 && c === 0x63 && (d === 0x43 || d === 0x31)) return true; // hvcC|hvc1
            if (b === 0x65 && c === 0x76 && d === 0x31) return true; // hev1
        }
        return false;
    }

    function looksMediaUrl(u) {
        return /\.(mp4|m4v|mov)(\?|$)/i.test(u) || /media|snap|story|storyteller/i.test(u);
    }

    const MAX_BYTES = 40 * 1024 * 1024;
    const bridge = () => {
        const b = window.__snapxInternal;
        return b && typeof b.transcode === 'function' ? b : null;
    };

    // Tiny valid H.264 clip (480x854 black, 1 s, silent). A media element gets
    // this *synchronously* when the page assigns an unprocessed blob: URL, so
    // its load always succeeds and Snapchat never sees a MediaError from the
    // HEVC bytes; the real transcoded clip replaces it as soon as ffmpeg is
    // done. Built with: ffmpeg -f lavfi -i color=c=black:s=480x854:d=1:r=25
    //   -c:v libx264 -preset ultrafast -crf 30 -pix_fmt yuv420p -an \
    //   -f mp4 -movflags frag_keyframe+empty_moov+default_base_moof
    const PLACEHOLDER_B64 = 'AAAAHGZ0eXBpc281AAACAGlzbzVpc282bXA0MQAAAuhtb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAB63RyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAB4AAAA1YAAAAAAYdtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAADIAAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAEybWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAA8nN0YmwAAACmc3RzZAAAAAAAAAABAAAAlmF2YzEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAB4ANWAEgAAABIAAAAAAAAAAEUTGF2YzYxLjMuMTAwIGxpYngyNjQAAAAAAAAAAAAAAAAY//8AAAAwYXZjQwFCwB7/4QAZZ0LAHtoHgbfmwEQAAAMABAAAAwDIPFi6gAEABGjOBHIAAAAQcGFzcAAAAAEAAAABAAAAEHN0dHMAAAAAAAAAAAAAABBzdHNjAAAAAAAAAAAAAAAUc3RzegAAAAAAAAAAAAAAAAAAABBzdGNvAAAAAAAAAAAAAAAobXZleAAAACB0cmV4AAAAAAAAAAEAAAABAAAAAAAAAAAAAAAAAAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2MS4xLjEwMAAAAMxtb29mAAAAEG1maGQAAAAAAAAAAQAAALR0cmFmAAAAHHRmaGQAAgA4AAAAAQAAAgAAAAcsAQEAAAAAABR0ZmR0AQAAAAAAAAAAAAAAAAAAfHRydW4AAAIFAAAAGQAAANQCAAAAAAAHLAAAAAsAAAALAAAACwAAAAsAAAALAAAACwAAAAsAAAALAAAACwAAAAsAAAALAAAACwAAAAsAAAALAAAACwAAAAsAAAALAAAACwAAAAsAAAALAAAACwAAAAsAAAALAAAACwAACDxtZGF0AAACVQYF//9R3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzE5MSA0NjEzYWMzIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyNCAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTAgcmVmPTEgZGVibG9jaz0wOjA6MCBhbmFseXNlPTA6MCBtZT1kaWEgc3VibWU9MCBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0wIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MCA4eDhkY3Q9MCBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0wIHRocmVhZHM9MjcgbG9va2FoZWFkX3RocmVhZHM9NCBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0wIHdlaWdodHA9MCBrZXlpbnQ9MjUwIGtleWludF9taW49MjUgc2NlbmVjdXQ9MCBpbnRyYV9yZWZyZXNoPTAgcmM9Y3JmIG1idHJlZT0wIGNyZj0zMC4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTAAgAAABM9liIQ6JigACG/JycnJycnJycnJycnJycnJycnJycnJycnJycnJyddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddeAAAAB0GaICqADKsAAAAHQZpAKoAMqwAAAAdBmmAqgAyrAAAAB0GagC6ADKsAAAAHQZqgLoAMqwAAAAdBmsAugAyrAAAAB0Ga4C6ADKsAAAAHQZsALoAMqwAAAAdBmyAugAyrAAAAB0GbQC6ADKsAAAAHQZtgLoAMqwAAAAdBm4AugAyrAAAAB0GboC6ADKsAAAAHQZvALoAMqwAAAAdBm+AugAyrAAAAB0GaAC6ADKsAAAAHQZogLoAMqwAAAAdBmkAugAyrAAAAB0GaYC6ADKsAAAAHQZqALoAMqwAAAAdBmqAugAyrAAAAB0GawC6ADKsAAAAHQZrgLoAMqwAAAAdBmwAugAyrAAAAQ21mcmEAAAArdGZyYQEAAAAAAAABAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAMEAQEBAAAAEG1mcm8AAAAAAAAAQw==';

    function b64enc(buf) {
        const u8 = viewOf(buf);
        const CH = 0x8000;
        let out = '';
        for (let i = 0; i < u8.length; i += CH) {
            out += btoa(String.fromCharCode.apply(null, u8.subarray(i, i + CH)));
        }
        return out;
    }
    function b64dec(s) {
        const bin = atob(s);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        return u8;
    }

    // Upload media bytes to the transcoder: raw typed arrays first (verified
    // intact across contextBridge + invoke on this Electron); base64 string
    // only as a fallback if the typed call itself throws. A null return means
    // the main process declined or ffmpeg failed.
    async function transcodeUp(buf) {
        const b = bridge();
        if (!b) return null;
        try {
            const out = await b.transcode(new Uint8Array(buf));
            if (out === null || out === undefined) return null;
            const v = viewOf(out);
            if (v && v.length > 1000) return v;
            if (typeof out === 'string' && out.length > 1000) return b64dec(out);
            return null;
        } catch (e) {
            log('transcode typed call failed: ' + String(e).slice(0, 120));
        }
        try {
            const out = await b.transcode(b64enc(buf));
            if (out === null || out === undefined) return null;
            const v = viewOf(out);
            if (v && v.length > 1000) return v;
            if (typeof out === 'string' && out.length > 1000) return b64dec(out);
            return null;
        } catch (e) {
            log('transcode b64 fallback failed: ' + String(e).slice(0, 120));
            return null;
        }
    }

    // ---- layer 1: fetch wrapper ------------------------------------------------
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
        const p = origFetch.apply(window, arguments);
        const b = bridge();
        if (!b) return p;
        return p.then((res) => {
            try {
                if (!res || res.status !== 200 || res.type === 'opaque' || !res.url) return res;
                if (res.url.startsWith('blob:') || res.url.startsWith('data:')) return res;
                const ct = (res.headers.get('content-type') || '').toLowerCase();
                const mediaish =
                    ct.includes('video') || ct.includes('mp4') || ct.includes('octet') ||
                    (!ct && looksMediaUrl(res.url));
                if (!mediaish) return res;
                log('fetch media-ish ' + res.url.slice(0, 110) + ' ct=' + ct);
                return res
                    .clone()
                    .arrayBuffer()
                    .then((buf) => {
                        if (buf.byteLength < 16 || buf.byteLength > MAX_BYTES) return res;
                        if (!findHevc(buf)) return res;
                        log('fetch HEVC hit (' + buf.byteLength + ' B) ' + res.url.slice(0, 110));
                        return transcodeUp(buf)
                            .then((body) => {
                                if (!body) return res;
                                log('fetch swap ' + buf.byteLength + ' -> ' + body.length + ' B');
                                return new Response(body, {
                                    status: 200,
                                    statusText: 'OK',
                                    headers: new Headers({ 'content-type': 'video/mp4' })
                                });
                            })
                            .catch(() => res);
                    })
                    .catch(() => res);
            } catch (e) {
                return res;
            }
        });
    };

    // ---- layer 2: <video>.src setter -------------------------------------------
    // Snapchat builds blob: URLs from the (layer 1 missed) HEVC bytes and assigns
    // them to video.src. We let the assignment through, then asynchronously
    // replace the element's actual src with the transcoded blob. Replays hit the
    // in-memory map and are instant.
    const origDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    if (origDesc && origDesc.set) {
        const transcoded = new Map(); // old blob url -> new blob url
        const swappedOut = new Set(); // new blob urls we produced (skip re-processing)
        const inflight = new Map(); // old blob url -> Promise
        const assigned = new WeakMap(); // element -> url the page assigned
        const MAX_MAP = 64;

        let placeholderUrl = null;
        function getPlaceholder() {
            if (!placeholderUrl && PLACEHOLDER_B64.indexOf('@@') < 0) {
                try {
                    const bin = atob(PLACEHOLDER_B64);
                    const u8 = new Uint8Array(bin.length);
                    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
                    placeholderUrl = URL.createObjectURL(new Blob([u8], { type: 'video/mp4' }));
                    swappedOut.add(placeholderUrl);
                } catch { placeholderUrl = null; }
            }
            return placeholderUrl;
        }

        // play(): remember that the page wanted playback so a src swap can
        // resume it; a load() restart (src change) otherwise suspends playback
        // and stalls any pending play() promise.
        const origPlay = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function () {
            try {
                if (origDesc.get.call(this) === placeholderUrl) this.__snapxPlayWanted = 1;
            } catch { /* ignore */ }
            return origPlay.apply(this, arguments);
        };

        function resumeAfter(el) {
            try {
                if (!el.paused || el.__snapxPlayWanted) {
                    el.__snapxPlayWanted = 0;
                    Promise.resolve(origPlay.call(el)).catch(() => { /* ignore */ });
                }
            } catch { /* ignore */ }
        }

        // Telemetry: what Snapchat's own player handlers will observe around a
        // swap (kept tiny and rate-limited by log()).
        function elState(el, tag) {
            try {
                const real = origDesc.get.call(el) || '';
                log(tag + ' rs=' + el.readyState + ' paused=' + el.paused +
                    ' t=' + el.currentTime.toFixed(2) + ' dur=' + (el.duration > 0 ? el.duration.toFixed(2) : el.duration) +
                    ' err=' + (el.error ? el.error.code : 0) + ' dims=' + el.videoWidth + 'x' + el.videoHeight +
                    ' src=' + (swappedOut.has(real) ? real.slice(0, 14) : real.slice(0, 30)));
            } catch { /* ignore */ }
        }
        function watchEl(el) {
            if (el.__snapxWatch) return;
            el.__snapxWatch = 1;
            for (const ev of ['error', 'stalled', 'suspend', 'waiting', 'pause', 'playing', 'ended']) {
                el.addEventListener(ev, () => elState(el, 'ev ' + ev), true);
            }
        }

        Object.defineProperty(HTMLMediaElement.prototype, 'src', {
            configurable: true,
            enumerable: origDesc.enumerable,
            get() {
                // Report back exactly what the page assigned, even though the
                // element's real src may have been swapped for a transcoded twin.
                const a = assigned.get(this);
                if (a && transcoded.has(a)) return a;
                return origDesc.get.call(this);
            },
            set(v) {
                try {
                    if (this.__snapxBypass) { origDesc.set.call(this, v); return; }
                    const s = typeof v === 'string' ? v : String(v);
                    if (s.startsWith('blob:') && !swappedOut.has(s)) {
                        assigned.set(this, s);
                        const done = transcoded.get(s);
                        if (done) {
                            origDesc.set.call(this, done);
                            return;
                        }
                        // Placeholder first: the element's load starts on a
                        // valid H.264 clip, so the page never observes an
                        // error from the HEVC bytes. swapBlobSrc swaps in the
                        // real transcoded clip (or restores the original if
                        // it turns out not to be HEVC) once inspected.
                        const ph = getPlaceholder();
                        origDesc.set.call(this, ph || s);
                        log('arm setter ' + s.slice(0, 44));
                        startSwap(this, s);
                        return;
                    }
                } catch (e) { /* fall through to plain behaviour */ }
                origDesc.set.call(this, v);
            }
        });

        function startSwap(el, url) {
            try {
                if (!url || !url.startsWith('blob:') || swappedOut.has(url)) return;
                const done = transcoded.get(url);
                if (done) {
                    if (origDesc.get.call(el) === url) {
                        watchEl(el);
                        log('swap cache-hit applied');
                        origDesc.set.call(el, done);
                        resumeAfter(el);
                    }
                    return;
                }
                if (!inflight.has(url) && bridge()) {
                    inflight.set(url, swapBlobSrc(el, url));
                }
            } catch { /* ignore */ }
        }

        async function swapBlobSrc(el, url) {
            try {
                const r = await origFetch.call(window, url);
                const buf = await r.arrayBuffer();
                if (buf.byteLength < 16 || buf.byteLength > MAX_BYTES || !findHevc(buf)) {
                    // Not something we can/should transcode: give the element
                    // its real blob back and remember never to touch it again.
                    inflight.delete(url);
                    swappedOut.add(url);
                    // Restore only if the element is stuck on our placeholder.
                    if (assigned.get(el) === url && origDesc.get.call(el) !== url) {
                        log('restore non-hevc ' + buf.byteLength + ' B');
                        origDesc.set.call(el, url);
                        resumeAfter(el);
                    }
                    return;
                }
                watchEl(el);
                log('src HEVC hit (' + buf.byteLength + ' B) ' + url.slice(0, 60));
                const body = await transcodeUp(buf);
                if (!body) { inflight.delete(url); return; }
                const newUrl = URL.createObjectURL(new Blob([body], { type: 'video/mp4' }));
                if (transcoded.size >= MAX_MAP) {
                    const first = transcoded.keys().next().value;
                    try { URL.revokeObjectURL(transcoded.get(first)); } catch { /* ignore */ }
                    transcoded.delete(first);
                }
                transcoded.set(url, newUrl);
                swappedOut.add(newUrl);
                // Only swap if this element still points at this blob (either
                // via our placeholder or, for markup-assigned src, directly).
                const real = origDesc.get.call(el);
                if (real !== newUrl && (real === url || assigned.get(el) === url)) {
                    origDesc.set.call(el, newUrl);
                    resumeAfter(el);
                    log('src swap ' + buf.byteLength + ' -> ' + body.length + ' B');
                    for (const ms of [400, 1200, 2500]) setTimeout(() => elState(el, 'post+' + ms), ms);
                }
            } catch (e) {
                log('src swap failed: ' + String(e).slice(0, 140));
                inflight.delete(url);
            }
        }

        // React/JSX assigns video.src via setAttribute, which in Blink updates
        // the element through C++ attribute reflection and never touches the
        // JS accessor above. Route media-element src attributes through our
        // patched setter.
        try {
            const origSetAttr = Element.prototype.setAttribute;
            const origSetAttrNS = Element.prototype.setAttributeNS;
            const patchedDesc = () => Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
            Element.prototype.setAttribute = function (name, value) {
                try {
                    if (typeof name === 'string' && name.toLowerCase() === 'src' &&
                        this instanceof HTMLMediaElement && !this.__snapxBypass) {
                        patchedDesc().set.call(this, value);
                        return;
                    }
                } catch { /* ignore */ }
                return origSetAttr.apply(this, arguments);
            };
            Element.prototype.setAttributeNS = function (ns, name, value) {
                try {
                    if (typeof name === 'string' && name.toLowerCase() === 'src' &&
                        this instanceof HTMLMediaElement && !this.__snapxBypass) {
                        patchedDesc().set.call(this, value);
                        return;
                    }
                } catch { /* ignore */ }
                return origSetAttrNS.apply(this, arguments);
            };
        } catch { /* ignore */ }

        // Final catch-all: whenever any media element begins loading, inspect
        // the *real* src (covers markup templates and any other assignment
        // path we have not thought of).
        try {
            document.addEventListener('loadstart', (e) => {
                try {
                    const el = e.target;
                    if (!el || !(el instanceof HTMLMediaElement) || el.__snapxBypass) return;
                    const real = origDesc.get.call(el);
                    if (!real || !real.startsWith('blob:')) return;
                    if (swappedOut.has(real) || inflight.has(real)) return;
                    log('arm loadstart ' + real.slice(0, 44));
                    const done = transcoded.get(real);
                    if (done) { origDesc.set.call(el, done); return; }
                    startSwap(el, real);
                } catch { /* ignore */ }
            }, true);
        } catch { /* ignore */ }
    } else {
        log('no HTMLMediaElement.src descriptor found');
    }

    // ---- instrumentation: XHR media usage --------------------------------------
    try {
        const XO = XMLHttpRequest.prototype.open;
        const XS = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url) {
            try { this.__sx = { method: method, url: String(url) }; } catch { /* ignore */ }
            try {
                this.addEventListener('load', function () {
                    try {
                        const xhr = this;
                        const ct = (xhr.getResponseHeader('content-type') || '').toLowerCase();
                        const mediaish = ct.includes('video') || ct.includes('mp4') || ct.includes('octet') ||
                            looksMediaUrl(xhr.__sx ? xhr.__sx.url : '');
                        if (!mediaish) return;
                        let size = -1;
                        try {
                            if (xhr.responseType === 'blob' && xhr.response) size = xhr.response.size;
                            else if (xhr.responseType === 'arraybuffer' && xhr.response) size = xhr.response.byteLength;
                        } catch { /* ignore */ }
                        const hevc = xhr.responseType === 'arraybuffer' && xhr.response ? (findHevc(xhr.response) ? ' HEVC' : ' no-hevc') : '';
                        log('xhr load ' + (xhr.__sx ? xhr.__sx.url.slice(0, 100) : '?') +
                            ' rt=' + xhr.responseType + ' ct=' + ct + ' size=' + size + hevc);
                    } catch { /* ignore */ }
                });
            } catch { /* ignore */ }
            return XO.apply(this, arguments);
        };
        void XS;
    } catch { /* ignore */ }

    // ---- instrumentation: object URLs + MSE appendBuffer ------------------------
    try {
        const origCOU = URL.createObjectURL;
        URL.createObjectURL = function (obj) {
            try {
                const type = obj && obj.type ? obj.type : '';
                const size = obj && obj.size ? obj.size : -1;
                if (type.includes('video') || type.includes('octet') || looksMediaUrl(String(obj.name || ''))) {
                    log('createObjectURL type=' + type + ' size=' + size);
                }
            } catch { /* ignore */ }
            return origCOU.apply(URL, arguments);
        };
    } catch { /* ignore */ }

    try {
        if (window.SourceBuffer && SourceBuffer.prototype.appendBuffer) {
            const origAB = SourceBuffer.prototype.appendBuffer;
            SourceBuffer.prototype.appendBuffer = function (data) {
                try {
                    if (findHevc(data)) log('mse appendBuffer HEVC ' + (data.byteLength || data.length) + ' B');
                } catch { /* ignore */ }
                return origAB.apply(this, arguments);
            };
        }
    } catch { /* ignore */ }

    // Single-window app: Snapchat sometimes calls window.close() itself
    // (multi-tab dedupe, post-SSO cleanup). Suppress page-initiated closes and
    // log the culprit stack so we can see which flow triggered it.
    try {
        window.close = function () {
            let st = '';
            try { st = new Error().stack || ''; } catch { /* ignore */ }
            log('PAGE window.close intercepted @ ' + location.href.slice(0, 90) +
                ' stack=' + st.replace(/\n/g, ' | ').slice(0, 360));
        };
    } catch { /* ignore */ }

    log('snapx wrapper armed (fetch+src)');
})();
