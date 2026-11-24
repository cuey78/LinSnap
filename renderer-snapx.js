// Runs in the page's main world (injected via CDP at document start). Snapchat
// hands chat snaps to <video> as blob: URLs containing HEVC, which this
// Chromium cannot decode. The bridge:
//
//   * when a blob: URL lands on a media element, inspect it in the background;
//   * if it contains HEVC, fetch a transcode from the main process (ffmpeg)
//     and swap the element's src for the H.264 twin (blob: stays CSP-legal);
//   * if it is already playable, leave it completely untouched;
//   * while a transcode is pending, hide the inevitable MediaError from the
//     page's handlers so Snapchat never shows its red "can't play" card.
//
// No fetch/XHR wrapping: Snapchat's reel and API traffic must stay untouched.
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

    const MAX_BYTES = 40 * 1024 * 1024;
    const bridge = () => {
        const b = window.__snapxInternal;
        return b && typeof b.transcode === 'function' ? b : null;
    };

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

    // Typed arrays survive contextBridge + ipcRenderer.invoke intact on this
    // Electron; base64 is only a fallback if the typed call itself throws.
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

    // ---- media element src layer -----------------------------------------------
    const origDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    if (!origDesc || !origDesc.set) return;

    const origFetch = window.fetch;
    const transcoded = new Map();     // original blob url -> H.264 blob url
    const swappedOut = new Set();     // urls we produced (never re-inspect)
    const inflight = new Map();       // original blob url -> Promise
    const assigned = new WeakMap();   // element -> url the page assigned
    const pendingEls = new WeakSet(); // elements with a transcode in progress
    const errorOwn = new WeakMap();   // element -> own 'error' descriptor we hid
    const MAX_MAP = 128;

    // The page may poll video.error instead of listening for 'error'. Hide
    // that too while our transcode is pending, then restore it afterwards.
    function hideError(el) {
        try {
            if (errorOwn.has(el)) return;
            errorOwn.set(el, Object.getOwnPropertyDescriptor(el, 'error') || null);
            Object.defineProperty(el, 'error', { configurable: true, get: () => null });
        } catch { /* ignore */ }
    }
    function unhideError(el) {
        try {
            if (!errorOwn.has(el)) return;
            const own = errorOwn.get(el);
            errorOwn.delete(el);
            if (own) Object.defineProperty(el, 'error', own);
            else delete el.error;
        } catch { /* ignore */ }
    }

    // Registered at document start, so this capture listener beats any
    // handler Snapchat attaches to the element itself later.
    document.addEventListener('error', (e) => {
        try {
            const t = e.target;
            const el = t instanceof HTMLMediaElement ? t : (t && t.parentElement);
            if (!el || !(el instanceof HTMLMediaElement) || !pendingEls.has(el)) return;
            log('suppressed media error ' + (t.error ? t.error.code : '?'));
            e.stopImmediatePropagation();
            e.preventDefault();
            hideError(el);
        } catch { /* ignore */ }
    }, true);

    // Preserve the page's intent to play across a src swap: a load() restart
    // suspends playback and can strand a pending play() promise.
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
        try { if (pendingEls.has(this)) this.__snapxPlayWanted = 1; } catch { /* ignore */ }
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

    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        configurable: true,
        enumerable: origDesc.enumerable,
        get() { return origDesc.get.call(this); },
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
                    // Give the element exactly what the page asked for. For
                    // reels/other playable media this is the only src change
                    // we ever make. For HEVC we suppress its error until the
                    // H.264 twin is ready.
                    origDesc.set.call(this, s);
                    startSwap(this, s);
                    return;
                }
            } catch (e) { /* fall through to plain behaviour */ }
            origDesc.set.call(this, v);
        }
    });

    function finish(el, url, delay) {
        inflight.delete(url);
        setTimeout(() => {
            try { pendingEls.delete(el); unhideError(el); } catch { /* ignore */ }
        }, delay);
    }

    function startSwap(el, url) {
        try {
            if (!url || !url.startsWith('blob:') || swappedOut.has(url)) return;
            const done = transcoded.get(url);
            if (done) {
                if (origDesc.get.call(el) === url) {
                    origDesc.set.call(el, done);
                    resumeAfter(el);
                }
                return;
            }
            if (!inflight.has(url) && bridge()) {
                pendingEls.add(el);
                hideError(el);
                inflight.set(url, swapBlobSrc(el, url));
            }
        } catch { /* ignore */ }
    }

    async function swapBlobSrc(el, url) {
        try {
            const r = await origFetch.call(window, url);
            const buf = await r.arrayBuffer();
            if (buf.byteLength < 16 || buf.byteLength > MAX_BYTES) {
                log('blob skipped (' + buf.byteLength + ' B)');
                finish(el, url, 0);
                return;
            }
            if (!findHevc(buf)) {
                // Already playable: do NOT touch the element or its src.
                log('plain blob ' + buf.byteLength + ' B (untouched)');
                finish(el, url, 0);
                return;
            }
            log('src HEVC hit (' + buf.byteLength + ' B) ' + url.slice(0, 52));
            const body = await transcodeUp(buf);
            if (!body) {
                log('src transcode failed');
                finish(el, url, 0);
                return;
            }
            const newUrl = URL.createObjectURL(new Blob([body], { type: 'video/mp4' }));
            if (transcoded.size >= MAX_MAP) {
                const first = transcoded.keys().next().value;
                transcoded.delete(first); // never revoke: elements may still use it
            }
            transcoded.set(url, newUrl);
            swappedOut.add(newUrl);
            const real = origDesc.get.call(el);
            if (real === url || assigned.get(el) === url) {
                origDesc.set.call(el, newUrl);
                log('src swap ' + buf.byteLength + ' -> ' + body.length + ' B');
                resumeAfter(el);
            }
            finish(el, url, 300);
        } catch (e) {
            log('src swap failed: ' + String(e).slice(0, 140));
            finish(el, url, 0);
        }
    }

    // React/JSX can set src via setAttribute, which bypasses the JS accessor.
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

    // Catch-all for markup templates / any assignment path we did not patch.
    document.addEventListener('loadstart', (e) => {
        try {
            const el = e.target;
            if (!el || !(el instanceof HTMLMediaElement) || el.__snapxBypass) return;
            const real = origDesc.get.call(el);
            if (!real || !real.startsWith('blob:') || swappedOut.has(real) || inflight.has(real)) return;
            startSwap(el, real);
        } catch { /* ignore */ }
    }, true);

    // Diagnostic only: log if a page uses srcObject (MSE/streams) for media.
    try {
        const od = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
        if (od && od.set) {
            Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
                configurable: true, enumerable: od.enumerable,
                get() { return od.get.call(this); },
                set(v) {
                    try { log('srcObject ' + (v && v.constructor ? v.constructor.name : String(v))); } catch { /* ignore */ }
                    od.set.call(this, v);
                }
            });
        }
    } catch { /* ignore */ }
})();
