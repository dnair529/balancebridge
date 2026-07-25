/* Balance Bridge Portal — minimal vanilla JS. No frameworks, no inline scripts. */
(function () {
  'use strict';

  // ---------- Flash dismissal ----------
  document.querySelectorAll('[data-dismiss]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var flash = btn.closest('.flash');
      if (flash) flash.remove();
    });
  });

  // ---------- Textarea autosize ----------
  document.querySelectorAll('textarea[data-autosize]').forEach(function (ta) {
    var grow = function () {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight + 2, 420) + 'px';
    };
    ta.addEventListener('input', grow);
    grow();
  });

  // ---------- Confirm-before-submit (delete forms) ----------
  document.querySelectorAll('form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      if (!window.confirm(form.getAttribute('data-confirm'))) e.preventDefault();
    });
  });

  // ---------- Task checkbox: instant visual feedback, then POST ----------
  document.querySelectorAll('form[data-task-toggle]').forEach(function (form) {
    form.addEventListener('submit', function () {
      var box = form.querySelector('.checkbox');
      if (box) box.classList.toggle('checked');
      var btn = form.querySelector('button');
      if (btn) btn.disabled = true; // prevent double-submit
    });
  });

  // ---------- Drag & drop upload ----------
  var dropzone = document.getElementById('dropzone');
  var fileInput = document.getElementById('file-input');
  var fileName = document.getElementById('file-name');
  if (dropzone && fileInput) {
    var showName = function () {
      if (fileName && fileInput.files.length) {
        fileName.textContent = 'Ready: ' + fileInput.files[0].name;
      }
    };
    fileInput.addEventListener('change', showName);

    ['dragenter', 'dragover'].forEach(function (evt) {
      dropzone.addEventListener(evt, function (e) {
        e.preventDefault();
        dropzone.classList.add('dragover');
      });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
      dropzone.addEventListener(evt, function (e) {
        e.preventDefault();
        dropzone.classList.remove('dragover');
      });
    });
    dropzone.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files.length) {
        fileInput.files = e.dataTransfer.files;
        showName();
      }
    });
  }
})();
