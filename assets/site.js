/* Search + topic filter on listing pages; share / copy buttons on quiz pages. */
(function () {
  "use strict";

  var search = document.getElementById("q");
  var grid = document.getElementById("grid");
  var chips = document.querySelectorAll("[data-filter]");
  var tag = "";

  function applyFilter() {
    if (!grid) return;
    var words = (search && search.value || "").toLowerCase().split(/\s+/).filter(Boolean);
    var shown = 0;
    grid.querySelectorAll(".card").forEach(function (card) {
      var text = card.dataset.search;
      var ok = words.every(function (w) { return text.indexOf(w) !== -1; }) &&
        (!tag || (" " + card.dataset.tags + " ").indexOf(" " + tag + " ") !== -1);
      card.hidden = !ok;
      if (ok) shown++;
    });
    var none = document.getElementById("no-results");
    if (none) none.hidden = shown > 0;
  }
  if (search) search.addEventListener("input", applyFilter);
  chips.forEach(function (chip) {
    chip.addEventListener("click", function () {
      tag = chip.dataset.filter;
      chips.forEach(function (c) { c.classList.toggle("is-active", c === chip); });
      applyFilter();
    });
  });

  // Show "Edit this quiz" only on devices connected on the Manage page.
  try {
    if (localStorage.getItem("qm-upload-token")) {
      document.querySelectorAll("[data-owner-only]").forEach(function (el) { el.hidden = false; });
    }
  } catch (e) { /* storage blocked */ }

  function flash(btn, text) {
    var label = btn.querySelector("span") || btn;
    var old = label.textContent;
    label.textContent = text;
    setTimeout(function () { label.textContent = old; }, 1600);
  }

  document.querySelectorAll("[data-copy]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      if (!navigator.clipboard) return;
      navigator.clipboard.writeText(btn.dataset.copy).then(function () { flash(btn, "Copied!"); });
    });
  });

  document.querySelectorAll("[data-share]").forEach(function (btn) {
    if (!navigator.share) { btn.hidden = true; return; }
    btn.addEventListener("click", function () {
      navigator.share({ title: btn.dataset.title, text: btn.dataset.title + " — a quiz on QM Prayag", url: btn.dataset.url })
        .catch(function () {});
    });
  });
})();
