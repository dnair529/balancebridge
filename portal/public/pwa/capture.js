/* ------------------------------------------------------------------
   Balance Bridge — snap a receipt.

   The flow, in the order it happens on a phone:

     1. `<input type="file" accept="image/*" capture="environment">`
        hands the job to the OS camera. Deliberately not getUserMedia:
        the portal ships `Permissions-Policy: camera=()`, which blocks
        the camera *API* but not the OS camera app — and the native
        capture UI is better than anything we would build anyway.
     2. Every photo is downscaled in the browser before it leaves. A
        modern phone camera produces 4–8MB per shot; 2000px on the long
        edge at q0.82 is comfortably enough for OCR and roughly a tenth
        the bytes. On a job site that is the difference between sending
        and not.
     3. The result goes into IndexedDB *first* (queue.js), then uploads.
        Never the other way round.
     4. Each item shows its own state — queued, sending, sent, failed —
        because "the reason clients abandon capture tools is silence"
        (OMNICHANNEL-CAPTURE.md §3).

   Previews are data: URLs rather than blob: URLs on purpose: the CSP is
   `img-src 'self' data:`, and loosening it for a thumbnail would be a
   bad trade.
------------------------------------------------------------------- */

(function () {
  'use strict';

  var MAX_EDGE = 2000; // px on the long edge — plenty for OCR
  var THUMB_EDGE = 320;
  var JPEG_QUALITY = 0.82;
  var THUMB_QUALITY = 0.6;

  var Q = self.BBQueue;
  if (!Q) return;

  var root = document.querySelector('[data-bb-capture-root]');
  if (!root) return;

  var endpoint = root.getAttribute('data-endpoint') || '/api/pwa/upload';
  var csrfEl = document.getElementById('bb-csrf');
  var csrf = csrfEl ? csrfEl.value : '';
  var listEl = document.getElementById('bb-queue');
  var headEl = document.getElementById('bb-queue-head');
  var hintEl = document.getElementById('bb-capture-hint');
  var retryEl = document.getElementById('bb-queue-retry');

  /* ================================================================ */
  /* Service worker                                                    */
  /* ================================================================ */

  /**
   * Registered from /sw.js so its scope is the whole origin. A worker under
   * /assets could not control /m, which is the page people install.
   */
  function registerWorker() {
    if (!('serviceWorker' in navigator)) return Promise.resolve(null);
    return navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () {
      return null; // an unavailable worker degrades to page-side flushing
    });
  }

  /** Ask the worker to drain the queue in the background if it can. */
  function requestBackgroundSync() {
    if (!('serviceWorker' in navigator)) return Promise.resolve(false);
    return navigator.serviceWorker.ready
      .then(function (reg) {
        if (!reg.sync) return false;
        return reg.sync.register('bb-capture-flush').then(function () { return true; });
      })
      .catch(function () { return false; });
  }

  /* ================================================================ */
  /* Downscaling                                                       */
  /* ================================================================ */

  function loadBitmap(file) {
    // `imageOrientation: 'from-image'` applies the EXIF rotation, so a photo
    // taken sideways is not filed sideways.
    if (self.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(function () {
        return loadViaImgElement(file);
      });
    }
    return loadViaImgElement(file);
  }

  function loadViaImgElement(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('unreadable image')); };
      img.src = url;
    });
  }

  function drawTo(source, maxEdge) {
    var w = source.width;
    var h = source.height;
    var scale = Math.min(1, maxEdge / Math.max(w, h));
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    var ctx = canvas.getContext('2d');
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  function canvasToBlob(canvas, quality) {
    return new Promise(function (resolve) {
      if (canvas.toBlob) canvas.toBlob(function (b) { resolve(b); }, 'image/jpeg', quality);
      else resolve(null);
    });
  }

  /**
   * Returns { blob, thumb, filename, mime }. Anything that is not an image —
   * a PDF statement picked from Files, say — passes through untouched.
   */
  function prepare(file) {
    if (!/^image\//.test(file.type)) {
      return Promise.resolve({
        blob: file,
        thumb: null,
        filename: file.name || 'upload',
        mime: file.type || 'application/octet-stream',
      });
    }

    return loadBitmap(file).then(function (source) {
      var full = drawTo(source, MAX_EDGE);
      var thumbCanvas = drawTo(source, THUMB_EDGE);
      var thumb = thumbCanvas.toDataURL('image/jpeg', THUMB_QUALITY);
      return canvasToBlob(full, JPEG_QUALITY).then(function (blob) {
        if (source.close) source.close();
        // If the re-encode somehow grew the file, keep the original.
        var useOriginal = !blob || blob.size >= file.size;
        return {
          blob: useOriginal ? file : blob,
          thumb: thumb,
          filename: stampName(file.name),
          mime: useOriginal ? file.type || 'image/jpeg' : 'image/jpeg',
        };
      });
    }).catch(function () {
      return {
        blob: file,
        thumb: null,
        filename: stampName(file.name),
        mime: file.type || 'image/jpeg',
      };
    });
  }

  function stampName(original) {
    var stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    var ext = /\.(jpe?g|png|heic|heif|webp|pdf)$/i.exec(original || '');
    return 'capture-' + stamp + (ext ? ext[0].toLowerCase().replace('.jpeg', '.jpg') : '.jpg');
  }

  /* ================================================================ */
  /* Rendering the queue                                               */
  /* ================================================================ */

  var STATE_TEXT = {
    queued: 'Waiting for signal',
    sending: 'Sending…',
    sent: 'Sent — we’ve got it',
    failed: 'Didn’t send',
    blocked: 'Sign in to finish sending',
  };

  function render() {
    if (!listEl) return Promise.resolve();
    return Q.all().then(function (rows) {
      listEl.textContent = '';
      if (headEl) headEl.hidden = rows.length === 0;

      rows.forEach(function (rec) {
        var li = document.createElement('li');
        li.className = 'm-qitem state-' + rec.state;

        if (rec.thumb) {
          var img = document.createElement('img');
          img.className = 'm-qthumb';
          img.src = rec.thumb; // data: URL — allowed by img-src 'self' data:
          img.alt = '';
          li.appendChild(img);
        }

        var body = document.createElement('div');
        body.className = 'm-qbody';

        var name = document.createElement('p');
        name.className = 'm-qname';
        name.textContent = rec.note || rec.filename;
        body.appendChild(name);

        var state = document.createElement('p');
        state.className = 'm-qstate';
        var text = STATE_TEXT[rec.state] || rec.state;
        if (rec.state === 'sent' && rec.duplicate) text = 'Already had this one';
        if ((rec.state === 'failed' || rec.state === 'blocked') && rec.lastError) {
          text = rec.lastError;
        }
        state.textContent = text;
        body.appendChild(state);

        li.appendChild(body);

        if (rec.state === 'failed' || rec.state === 'blocked') {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'm-qretry';
          btn.textContent = 'Retry';
          btn.addEventListener('click', function () {
            flush({ force: true });
          });
          li.appendChild(btn);
        }

        listEl.appendChild(li);
      });
    });
  }

  function updateHint() {
    if (!hintEl) return Promise.resolve();
    return Q.pendingCount().then(function (n) {
      if (!navigator.onLine) {
        hintEl.textContent = n
          ? n + ' capture' + (n === 1 ? '' : 's') + ' waiting — they’ll send themselves when you’re back online.'
          : 'You’re offline. Snap away — photos queue up and send themselves when you’re back online.';
        hintEl.classList.add('is-offline');
      } else {
        hintEl.textContent =
          'Works with no signal — photos queue up and send themselves when you’re back online.';
        hintEl.classList.remove('is-offline');
      }
    });
  }

  /* ================================================================ */
  /* Flushing                                                          */
  /* ================================================================ */

  var flushing = false;
  var flushAgain = false;

  function flush(opts) {
    opts = opts || {};
    if (flushing) { flushAgain = true; return Promise.resolve(); }
    flushing = true;

    return Q.flush({ endpoint: endpoint, csrf: csrf, force: opts.force })
      .then(render)
      .then(updateHint)
      .catch(function () { /* a failed flush is already recorded per item */ })
      .then(function () {
        flushing = false;
        if (flushAgain) { flushAgain = false; return flush(); }
        return undefined;
      });
  }

  /* ================================================================ */
  /* Taking a photo                                                    */
  /* ================================================================ */

  function handleFiles(files, note) {
    var list = Array.prototype.slice.call(files);
    if (list.length === 0) return Promise.resolve();

    // Queue every page first, render immediately, then upload. The person
    // holding the phone sees their photos land before any network happens.
    return list
      .reduce(function (chain, file) {
        return chain
          .then(function () { return prepare(file); })
          .then(function (prepared) {
            return Q.enqueue({
              blob: prepared.blob,
              thumb: prepared.thumb,
              filename: prepared.filename,
              mime: prepared.mime,
              note: note || null,
              capturedAt: new Date(file.lastModified || Date.now()).toISOString(),
            });
          })
          .then(render);
      }, Promise.resolve())
      .then(function () { return requestBackgroundSync(); })
      .then(function () { return flush(); });
  }

  function bindInputs() {
    var inputs = document.querySelectorAll('input[data-bb-capture]');
    Array.prototype.forEach.call(inputs, function (input) {
      input.addEventListener('change', function () {
        var note = input.getAttribute('data-note');
        var files = input.files;
        handleFiles(files, note).then(function () {
          input.value = ''; // let the same receipt be re-taken if they retry
        });
      });
    });
  }

  /* ================================================================ */
  /* Wiring                                                            */
  /* ================================================================ */

  bindInputs();

  if (retryEl) {
    retryEl.addEventListener('click', function () { flush({ force: true }); });
  }

  // Store the live CSRF token so a Background Sync wake-up with no page open
  // has something to send. It rotates with the session, so refresh it on every
  // page load — that is also what un-blocks items held after a re-login.
  Q.setMeta('csrf', csrf)
    .then(function () { return Q.all(); })
    .then(function (rows) {
      // A fresh token means anything blocked on the old one is worth another go.
      var blocked = rows.filter(function (r) { return r.state === 'blocked'; });
      return Promise.all(blocked.map(function (r) {
        return Q.patch(r.id, { state: 'queued', attempts: 0, nextAttemptAt: 0, lastError: null });
      }));
    })
    .then(render)
    .then(updateHint)
    .then(function () { return registerWorker(); })
    .then(function () { return flush(); });

  window.addEventListener('online', function () { updateHint(); flush(); });
  window.addEventListener('offline', function () { updateHint(); });

  // Coming back to a backgrounded tab is the most common "am I sent yet?"
  // moment, so re-check then too.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) flush();
  });

  // The worker tells us when it drained the queue behind our back.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function (event) {
      if (event.data && event.data.type === 'bb-queue-changed') {
        render();
        updateHint();
      }
    });
  }
})();
