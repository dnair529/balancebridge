/* ------------------------------------------------------------------
   Balance Bridge — staff workspace keyboard driver.

   Vanilla, no framework, no inline script (the CSP is script-src 'self').

   "One keyboard-driven flow. Accept / reject / next, like triaging an
   inbox." — STAFF-WORKSPACE.md §1. Mouse-driven UI caps throughput, so
   every action on these screens has a key, the focused row carries a
   visible ring, and every move is announced to a live region so the
   keyboard flow works for a screen reader too.

   Progressive enhancement: with JS off, every row is a real link and
   every action is a real form. This file only makes them faster.
------------------------------------------------------------------- */
(function () {
  'use strict';

  var list = document.querySelector('[data-ws-list]');
  var help = document.getElementById('ws-help');
  var live = document.getElementById('ws-live');
  var mode = list ? list.getAttribute('data-ws-list') : null;
  var items = list ? Array.prototype.slice.call(list.querySelectorAll('[data-ws-item]')) : [];
  var index = -1;

  /* ---------- Announcements ---------- */

  function announce(text) {
    if (!live) return;
    // Re-setting identical text does not re-announce; nudge it.
    live.textContent = '';
    window.setTimeout(function () {
      live.textContent = text;
    }, 10);
  }

  function describe(el, position) {
    var label = el.getAttribute('data-label') || el.textContent.replace(/\s+/g, ' ').trim().slice(0, 160);
    return label + '. ' + position + ' of ' + items.length + '.';
  }

  /* ---------- Focus movement ---------- */

  function active() {
    return index >= 0 && index < items.length ? items[index] : null;
  }

  function focusAt(next, silent) {
    if (items.length === 0) return;
    var wrapped = Math.max(0, Math.min(items.length - 1, next));
    var current = active();
    if (current) current.classList.remove('is-focused');
    index = wrapped;
    var el = items[index];
    el.classList.add('is-focused');
    if (typeof el.focus === 'function') {
      if (!el.hasAttribute('tabindex') && el.tagName !== 'A' && el.tagName !== 'BUTTON') {
        el.setAttribute('tabindex', '-1');
      }
      el.focus({ preventScroll: true });
    }
    if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    if (!silent) announce(describe(el, index + 1));
  }

  function move(delta) {
    if (items.length === 0) return;
    focusAt(index < 0 ? 0 : index + delta);
  }

  /* ---------- Actions ---------- */

  function openItem(el) {
    var href = el.getAttribute('data-href');
    if (href) {
      window.location.href = href;
      return true;
    }
    var link = el.querySelector('a[href]');
    if (link) {
      window.location.href = link.getAttribute('href');
      return true;
    }
    return false;
  }

  function submitAction(el, name) {
    var form = el.querySelector('form[data-ws-action="' + name + '"]');
    if (!form) return false;
    announce(name + ' — submitting.');
    form.submit();
    return true;
  }

  /** Approve the AI suggestion for a categorisation group. */
  function approveGroup(form) {
    var button = form.querySelector('[data-ws-approve]');
    if (!button) {
      announce('No suggestion to approve on this group — pick a category with 1 to 9 first.');
      return false;
    }
    announce('Approving the suggestion for this group.');
    if (typeof form.requestSubmit === 'function') form.requestSubmit(button);
    else button.click();
    return true;
  }

  /** Number keys pick the Nth category on the focused group. */
  function pickCategory(form, n) {
    var select = form.querySelector('[data-ws-category]');
    if (!select) return false;
    // Option 0 is the "Pick a category…" placeholder, so 1 maps to index 1.
    if (n < 1 || n >= select.options.length) {
      announce('No category ' + n + ' on this client.');
      return false;
    }
    select.selectedIndex = n;
    announce('Picked ' + select.options[n].textContent.replace(/^\d+\s*·\s*/, '') + '. Press enter to apply.');
    return true;
  }

  function skipGroup(el) {
    el.classList.add('is-skipped');
    announce('Skipped.');
    var remaining = items.filter(function (item) {
      return !item.classList.contains('is-skipped');
    });
    if (remaining.length === 0) {
      announce('Every group skipped.');
      return;
    }
    // Move to the next unskipped group after this one, wrapping to the first.
    for (var i = index + 1; i < items.length; i += 1) {
      if (!items[i].classList.contains('is-skipped')) {
        focusAt(i);
        return;
      }
    }
    focusAt(items.indexOf(remaining[0]));
  }

  /* ---------- Help panel ---------- */

  function toggleHelp(force) {
    if (!help) return;
    var show = typeof force === 'boolean' ? force : help.hidden;
    help.hidden = !show;
    announce(show ? 'Keyboard shortcuts shown.' : 'Keyboard shortcuts hidden.');
  }

  /* ---------- Key handling ---------- */

  function typing(target) {
    if (!target) return false;
    var tag = target.tagName;
    return (
      tag === 'INPUT' ||
      tag === 'SELECT' ||
      tag === 'TEXTAREA' ||
      target.isContentEditable === true
    );
  }

  document.addEventListener('keydown', function (event) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (typing(event.target)) return;

    var key = event.key;

    if (key === '?') {
      event.preventDefault();
      toggleHelp();
      return;
    }
    if (key === 'Escape') {
      if (help && !help.hidden) {
        event.preventDefault();
        toggleHelp(false);
      }
      return;
    }
    if (items.length === 0) return;

    if (key === 'j' || key === 'ArrowDown') {
      event.preventDefault();
      move(1);
      return;
    }
    if (key === 'k' || key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
      return;
    }
    if (key === 'g') {
      event.preventDefault();
      focusAt(0);
      return;
    }

    var el = active();
    if (!el) {
      // First real action with nothing focused focuses the top item instead of
      // acting on something the user cannot see.
      if ('aserx123456789'.indexOf(key) !== -1 || key === 'Enter') {
        event.preventDefault();
        focusAt(0);
      }
      return;
    }

    if (mode === 'queue') {
      if (key === 'Enter') {
        event.preventDefault();
        openItem(el);
      } else if (key === 'a') {
        event.preventDefault();
        if (!submitAction(el, 'assign')) announce('Already assigned to you.');
      } else if (key === 's') {
        event.preventDefault();
        submitAction(el, 'snooze');
      }
      return;
    }

    if (mode === 'categorize') {
      if (key === 'Enter') {
        event.preventDefault();
        approveGroup(el);
      } else if (key === 'x') {
        event.preventDefault();
        skipGroup(el);
      } else if (key >= '1' && key <= '9') {
        event.preventDefault();
        pickCategory(el, Number(key));
      }
    }
  });

  /* ---------- Mouse parity ---------- */

  if (mode === 'queue') {
    items.forEach(function (el, i) {
      el.addEventListener('click', function (event) {
        var t = event.target;
        // Let real links, buttons and form controls do their own job.
        while (t && t !== el) {
          var tag = t.tagName;
          if (tag === 'A' || tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'LABEL') return;
          t = t.parentNode;
        }
        focusAt(i, true);
        openItem(el);
      });
      el.addEventListener('focus', function () {
        if (index !== i) focusAt(i, true);
      });
    });
  }

  if (mode === 'categorize') {
    items.forEach(function (el, i) {
      el.addEventListener('focusin', function () {
        if (index !== i) focusAt(i, true);
      });
      var skip = el.querySelector('[data-ws-skip]');
      if (skip) {
        skip.addEventListener('click', function () {
          focusAt(i, true);
          skipGroup(el);
        });
      }
    });
  }

  /* ---------- Filter selects submit themselves ---------- */

  document.querySelectorAll('[data-ws-autosubmit]').forEach(function (select) {
    select.addEventListener('change', function () {
      if (select.form) select.form.submit();
    });
  });

  /* ---------- Start focused, quietly ---------- */

  if (items.length > 0) {
    focusAt(0, true);
    announce(items.length + ' items. Press question mark for keyboard shortcuts.');
  }
})();
