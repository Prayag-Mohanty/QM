/* Search + topic filter on listing pages; menus, share and copy buttons on quiz pages. */
(function () {
  "use strict";

  // ---- search & topic filter (home page) -----------------------------------
  var search = document.getElementById("q");
  var grid = document.getElementById("grid");
  var chips = document.querySelectorAll("[data-filter]");
  var tag = "";

  function applyFilter() {
    if (!grid) return;
    var words = (search && search.value || "").toLowerCase().split(/\s+/).filter(Boolean);
    var shown = 0, total = 0;
    grid.querySelectorAll(".card").forEach(function (card) {
      var text = card.dataset.search;
      var ok = words.every(function (w) { return text.indexOf(w) !== -1; }) &&
        (!tag || (" " + card.dataset.tags + " ").indexOf(" " + tag + " ") !== -1);
      card.hidden = !ok;
      total++;
      if (ok) shown++;
    });
    var filtering = words.length > 0 || !!tag;
    document.querySelectorAll(".topic-shelf").forEach(function (s) { s.hidden = filtering; });
    var none = document.getElementById("no-results");
    if (none) none.hidden = shown > 0;
    var count = document.getElementById("result-count");
    if (count) {
      count.hidden = !filtering;
      count.textContent = shown + " of " + total + " quizzes";
    }
    var heading = document.getElementById("quizzes-h");
    if (heading) heading.textContent = filtering ? "Results" : "Latest quizzes";
  }

  if (grid && search) {
    // The header search box filters instantly on the home page.
    var params = new URLSearchParams(location.search);
    if (params.get("q")) search.value = params.get("q");
    search.addEventListener("input", function () {
      applyFilter();
      var url = new URL(location.href);
      if (search.value) url.searchParams.set("q", search.value); else url.searchParams.delete("q");
      history.replaceState(null, "", url);
    });
    search.form.addEventListener("submit", function (e) {
      e.preventDefault();
      document.getElementById("quizzes").scrollIntoView({ behavior: "smooth" });
    });
    applyFilter();
  }
  chips.forEach(function (chip) {
    chip.addEventListener("click", function () {
      tag = chip.dataset.filter;
      chips.forEach(function (c) { c.classList.toggle("is-active", c === chip); });
      applyFilter();
    });
  });

  // ---- owner-only links ----------------------------------------------------
  try {
    if (localStorage.getItem("qm-upload-token")) {
      document.querySelectorAll("[data-owner-only]").forEach(function (el) { el.hidden = false; });
    }
  } catch (e) { /* storage blocked */ }

  // ---- dropdown menus (Download / Share) -----------------------------------
  var menus = document.querySelectorAll("details.menu");
  menus.forEach(function (m) {
    m.addEventListener("toggle", function () {
      if (m.open) menus.forEach(function (o) { if (o !== m) o.open = false; });
    });
  });
  document.addEventListener("click", function (e) {
    menus.forEach(function (m) { if (m.open && !m.contains(e.target)) m.open = false; });
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") menus.forEach(function (m) { m.open = false; });
  });

  // ---- copy & share --------------------------------------------------------
  function flash(btn, text) {
    var label = btn.querySelector("span") || btn;
    var old = label.textContent;
    label.textContent = text;
    setTimeout(function () { label.textContent = old; }, 1600);
  }
  function copy(btn, text) {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(function () { flash(btn, "Copied!"); });
  }
  document.querySelectorAll("[data-copy]").forEach(function (btn) {
    btn.addEventListener("click", function () { copy(btn, btn.dataset.copy); });
  });
  document.querySelectorAll("[data-copy-from]").forEach(function (btn) {
    btn.addEventListener("click", function () { copy(btn, document.getElementById(btn.dataset.copyFrom).value); });
  });
  document.querySelectorAll("[data-share]").forEach(function (btn) {
    if (!navigator.share) { btn.hidden = true; return; }
    btn.addEventListener("click", function () {
      navigator.share({ title: btn.dataset.title, text: btn.dataset.title + " — a quiz on QM Prayag", url: btn.dataset.url })
        .catch(function () {});
    });
  });

  // ---- transcript "show more" ----------------------------------------------
  document.querySelectorAll("[data-expand]").forEach(function (btn) {
    var box = document.getElementById(btn.dataset.expand);
    if (!box) return;
    if (box.querySelectorAll(".slides-text li").length <= 4) { box.classList.remove("is-collapsed"); btn.hidden = true; return; }
    btn.addEventListener("click", function () {
      var collapsed = box.classList.toggle("is-collapsed");
      btn.textContent = collapsed ? "Show full transcript" : "Show less";
      if (collapsed) box.scrollIntoView({ block: "start" });
    });
  });
  // Jumping to a slide from the transcript expands it first.
  if (/^#text-\d+/.test(location.hash)) {
    var t = document.getElementById("transcript");
    if (t) t.classList.remove("is-collapsed");
  }
})();
