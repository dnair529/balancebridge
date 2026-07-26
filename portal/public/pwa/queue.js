/* ------------------------------------------------------------------
   Balance Bridge — the offline capture queue.

   OMNICHANNEL-CAPTURE.md §2 calls sync-on-reconnect "the killer feature
   for trades". This file is that feature. It is loaded twice, on
   purpose, into two different global scopes:

     * by the page, before capture.js, so a capture can be queued and
       flushed even where service workers are unavailable (iOS private
       browsing, first load before the worker activates, unsupported
       browsers);
     * by sw.js via importScripts(), so Background Sync can drain the
       same queue with the tab closed.

   One implementation, one IndexedDB schema, two callers. Both use
   `self`, which is the window in a page and the worker global in a
   worker, so nothing here touches the DOM.

   ## Why a replay is safe

   Every capture gets a stable `captureId` at the moment the photo is
   taken. /api/pwa/upload uses it as the idempotency key
   (`intake_external_uq` on channel + external id), so a phone that has
   been out of signal all afternoon can replay its whole queue — and
   replay it twice — and still produce one document per photo. That is
   what makes an aggressive retry policy correct rather than dangerous.

   `capturedAt` travels with the record for the same reason: the
   expense happened on the job, not in the parking lot with LTE.
------------------------------------------------------------------- */

(function (scope) {
  'use strict';

  var DB_NAME = 'bb-capture';
  var DB_VERSION = 1;
  var STORE = 'captures';
  var META = 'meta';

  /** Terminal-ish states, in the order the UI should show them. */
  var STATE = {
    QUEUED: 'queued',
    SENDING: 'sending',
    SENT: 'sent',
    FAILED: 'failed',
    /** Session expired or signed out — held, never dropped. */
    BLOCKED: 'blocked',
  };

  var SENT_TTL_MS = 10 * 60 * 1000; // keep "Sent" visible for a while, then prune
  var SENDING_STALE_MS = 2 * 60 * 1000; // a crashed flush must not wedge an item
  var MAX_ATTEMPTS = 12;

  var dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = scope.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('state', 'state', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(META)) {
          db.createObjectStore(META, { keyPath: 'k' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  /**
   * Run `fn` inside one transaction and resolve when the transaction commits,
   * not when the request fires — an IDB request's result is only trustworthy
   * once the transaction has completed. Return `request(store.get(...))` from
   * `fn` to resolve with that request's result; return anything else to
   * resolve with it verbatim.
   */
  var REQ = '__bbReq';

  function request(r) {
    var wrapper = {};
    wrapper[REQ] = r;
    return wrapper;
  }

  function tx(storeName, mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(storeName, mode);
        var store = t.objectStore(storeName);
        var out;
        try {
          out = fn(store);
        } catch (err) {
          reject(err);
          return;
        }
        t.oncomplete = function () {
          resolve(out && typeof out === 'object' && out[REQ] ? out[REQ].result : out);
        };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
      });
    });
  }

  /* ---------------------------------------------------------------- */
  /* CRUD                                                              */
  /* ---------------------------------------------------------------- */

  function put(record) {
    record.updatedAt = Date.now();
    return tx(STORE, 'readwrite', function (store) {
      store.put(record);
      return record;
    }).then(function () { return record; });
  }

  function all() {
    return tx(STORE, 'readonly', function (store) {
      return request(store.getAll());
    }).then(function (rows) {
      return (rows || []).sort(function (a, b) { return a.createdAt - b.createdAt; });
    });
  }

  function get(id) {
    return tx(STORE, 'readonly', function (store) {
      return request(store.get(id));
    });
  }

  function remove(id) {
    return tx(STORE, 'readwrite', function (store) { store.delete(id); return true; });
  }

  function patch(id, changes) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, 'readwrite');
        var store = t.objectStore(STORE);
        var r = store.get(id);
        r.onsuccess = function () {
          var rec = r.result;
          if (!rec) { resolve(null); return; }
          for (var k in changes) {
            if (Object.prototype.hasOwnProperty.call(changes, k)) rec[k] = changes[k];
          }
          rec.updatedAt = Date.now();
          store.put(rec);
          resolve(rec);
        };
        r.onerror = function () { reject(r.error); };
        t.onerror = function () { reject(t.error); };
      });
    });
  }

  function setMeta(k, v) {
    return tx(META, 'readwrite', function (store) { store.put({ k: k, v: v }); return true; });
  }

  function getMeta(k) {
    return tx(META, 'readonly', function (store) {
      return request(store.get(k));
    }).then(function (row) { return row ? row.v : null; });
  }

  /* ---------------------------------------------------------------- */
  /* Enqueue                                                           */
  /* ---------------------------------------------------------------- */

  function newId() {
    if (scope.crypto && scope.crypto.randomUUID) return scope.crypto.randomUUID();
    return 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  /**
   * Queue a capture. The blob is stored first and uploaded second, always —
   * even with five bars of signal. A capture that only exists in a fetch
   * promise is a capture you lose when the screen locks.
   */
  function enqueue(input) {
    var record = {
      id: input.id || newId(),
      filename: input.filename || 'capture.jpg',
      mime: input.mime || 'image/jpeg',
      blob: input.blob,
      bytes: input.blob ? input.blob.size : 0,
      thumb: input.thumb || null,
      note: input.note || null,
      capturedAt: input.capturedAt || new Date().toISOString(),
      createdAt: Date.now(),
      state: STATE.QUEUED,
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
    };
    return put(record);
  }

  /* ---------------------------------------------------------------- */
  /* Flush                                                             */
  /* ---------------------------------------------------------------- */

  function backoffMs(attempts) {
    // 2s, 4s, 8s … capped at 5 minutes.
    return Math.min(5 * 60 * 1000, 2000 * Math.pow(2, Math.max(0, attempts - 1)));
  }

  function isSendable(rec, now) {
    if (rec.state === STATE.SENT) return false;
    if (rec.state === STATE.SENDING) return now - rec.updatedAt > SENDING_STALE_MS;
    if (rec.attempts >= MAX_ATTEMPTS) return false;
    return (rec.nextAttemptAt || 0) <= now;
  }

  /**
   * Upload one record. Resolves with the record's new state; never rejects,
   * because a flush must survive one bad item.
   */
  function send(rec, endpoint, csrf) {
    var form = new FormData();
    form.append('_csrf', csrf);
    form.append('captureId', rec.id);
    form.append('capturedAt', rec.capturedAt);
    if (rec.note) form.append('note', rec.note);
    form.append('file', rec.blob, rec.filename);

    return patch(rec.id, { state: STATE.SENDING })
      .then(function () {
        return scope.fetch(endpoint, {
          method: 'POST',
          body: form,
          credentials: 'same-origin',
          headers: { 'X-Requested-With': 'bb-pwa' },
        });
      })
      .then(function (res) {
        var ct = res.headers.get('content-type') || '';
        // requireAuth redirects a signed-out browser to /login, which fetch
        // follows into an HTML page. That is not a failure of the capture —
        // it is a failure of the session, so hold the item, never drop it.
        if (res.redirected || ct.indexOf('application/json') === -1) {
          return patch(rec.id, {
            state: STATE.BLOCKED,
            lastError: 'Sign in again to finish sending this.',
          }).then(function () { return STATE.BLOCKED; });
        }
        if (res.status === 403) {
          return patch(rec.id, {
            state: STATE.BLOCKED,
            lastError: 'Session expired — open the app to finish sending.',
          }).then(function () { return STATE.BLOCKED; });
        }
        // Permanent rejections: retrying cannot help, so stop burning battery.
        if (res.status === 413 || res.status === 415 || res.status === 400) {
          return patch(rec.id, {
            state: STATE.FAILED,
            attempts: MAX_ATTEMPTS,
            lastError: res.status === 413 ? 'Too large to send (25MB limit).' : 'This file type can’t be sent.',
          }).then(function () { return STATE.FAILED; });
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json().then(function (body) {
          if (!body || body.ok !== true) throw new Error(body && body.error ? body.error : 'upload rejected');
          // `duplicate: true` is a success: the idempotency key did its job.
          return patch(rec.id, {
            state: STATE.SENT,
            sentAt: Date.now(),
            duplicate: !!body.duplicate,
            serverStatus: body.status || null,
            lastError: null,
            blob: null, // the bytes are on the server now; stop hoarding them
          }).then(function () { return STATE.SENT; });
        });
      })
      .catch(function (err) {
        var attempts = (rec.attempts || 0) + 1;
        return patch(rec.id, {
          state: STATE.FAILED,
          attempts: attempts,
          nextAttemptAt: Date.now() + backoffMs(attempts),
          lastError: (err && err.message) || 'Could not reach Balance Bridge.',
        }).then(function () { return STATE.FAILED; });
      });
  }

  /**
   * Drain the queue. Serial on purpose: a phone on one bar does better with
   * one request at a time than with eight competing for the same radio.
   *
   * `csrf` is optional — when omitted (a Background Sync wake-up with no page
   * open) the last token the page stored is used. If it has rotated the item
   * comes back BLOCKED and is retried on the next page load with a fresh one.
   */
  function flush(opts) {
    opts = opts || {};
    var endpoint = opts.endpoint || '/api/pwa/upload';

    return Promise.all([all(), opts.csrf ? Promise.resolve(opts.csrf) : getMeta('csrf')])
      .then(function (parts) {
        var rows = parts[0];
        var csrf = parts[1];
        var now = Date.now();

        if (!csrf) {
          return { sent: 0, failed: 0, skipped: rows.length, reason: 'no csrf token stored' };
        }

        var pending = rows.filter(function (r) {
          // `force` is the user tapping Retry: ignore backoff and attempt caps.
          return opts.force ? r.state !== STATE.SENT : isSendable(r, now);
        });

        var result = { sent: 0, failed: 0, blocked: 0, skipped: rows.length - pending.length };

        return pending
          .reduce(function (chain, rec) {
            return chain.then(function () {
              if (opts.force) {
                return patch(rec.id, { attempts: 0, nextAttemptAt: 0 }).then(function (fresh) {
                  return send(fresh || rec, endpoint, csrf);
                });
              }
              return send(rec, endpoint, csrf);
            }).then(function (state) {
              if (state === STATE.SENT) result.sent += 1;
              else if (state === STATE.BLOCKED) result.blocked += 1;
              else result.failed += 1;
            });
          }, Promise.resolve())
          .then(function () { return prune(); })
          .then(function () { return result; });
      });
  }

  /** Drop sent records once they have been visible long enough to reassure. */
  function prune() {
    var cutoff = Date.now() - SENT_TTL_MS;
    return all().then(function (rows) {
      var stale = rows.filter(function (r) {
        return r.state === STATE.SENT && (r.sentAt || r.updatedAt) < cutoff;
      });
      return Promise.all(stale.map(function (r) { return remove(r.id); }));
    });
  }

  /** How many captures are still waiting. Drives the badge and the hint text. */
  function pendingCount() {
    return all().then(function (rows) {
      return rows.filter(function (r) { return r.state !== STATE.SENT; }).length;
    });
  }

  scope.BBQueue = {
    STATE: STATE,
    open: openDb,
    enqueue: enqueue,
    put: put,
    patch: patch,
    all: all,
    get: get,
    remove: remove,
    flush: flush,
    prune: prune,
    pendingCount: pendingCount,
    setMeta: setMeta,
    getMeta: getMeta,
    newId: newId,
  };
})(typeof self !== 'undefined' ? self : this);
