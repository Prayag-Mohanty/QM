/* QM Prayag slide viewer — renders the quiz PDF one slide at a time with PDF.js. */
(function () {
  "use strict";
  var viewer = document.getElementById("viewer");
  if (!viewer) return;

  var stage = viewer.querySelector(".stage");
  var cover = viewer.querySelector(".stage-cover");
  var canvas = viewer.querySelector(".stage-canvas");
  var status = viewer.querySelector(".stage-status");
  var input = viewer.querySelector("[data-page]");
  var prevBtns = viewer.querySelectorAll("[data-prev]");
  var nextBtns = viewer.querySelectorAll("[data-next]");
  var bar = viewer.querySelector(".vprogress span");
  var total = parseInt(viewer.dataset.pages, 10) || 1;
  var title = viewer.dataset.title || "";

  var pdf = null, current = 1, task = null, pending = null;

  function pageFromHash() {
    var m = /slide-(\d+)/.exec(location.hash);
    return m ? clamp(parseInt(m[1], 10)) : 1;
  }
  function clamp(n) { return Math.min(Math.max(n || 1, 1), total); }

  function updateUi() {
    input.value = current;
    if (bar) bar.style.width = (total > 1 ? (current - 1) / (total - 1) * 100 : 100) + "%";
    prevBtns.forEach(function (b) { b.disabled = current <= 1; });
    nextBtns.forEach(function (b) { b.disabled = current >= total; });
    canvas.setAttribute("aria-label", "Slide " + current + " of " + total + " — " + title);
  }

  function go(n, opts) {
    n = clamp(n);
    current = n;
    updateUi();
    if (!(opts && opts.noHash)) {
      var url = location.pathname + location.search + (n > 1 ? "#slide-" + n : "");
      history.replaceState(null, "", url);
    }
    if (!pdf) return;
    if (task) { pending = n; return; }
    render(n);
  }

  function render(n) {
    pdf.getPage(n).then(function (page) {
      var dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      var base = page.getViewport({ scale: 1 });
      var w = stage.clientWidth || 800, h = stage.clientHeight || w / (base.width / base.height);
      var scale = Math.min(w / base.width, h / base.height) * dpr;
      var vp = page.getViewport({ scale: scale });
      var off = document.createElement("canvas");
      off.width = Math.floor(vp.width);
      off.height = Math.floor(vp.height);
      task = page.render({ canvasContext: off.getContext("2d", { alpha: false }), viewport: vp });
      return task.promise.then(function () {
        canvas.width = off.width;
        canvas.height = off.height;
        canvas.getContext("2d").drawImage(off, 0, 0);
        canvas.hidden = false;
        cover.hidden = true;
        status.textContent = "";
      });
    }).catch(function (err) {
      if (err && err.name === "RenderingCancelledException") return;
      status.textContent = "Couldn’t draw this slide.";
    }).then(function () {
      task = null;
      if (pending !== null) { var p = pending; pending = null; render(p); }
      else if (current < total) pdf.getPage(current + 1); // warm up the next slide
    });
  }

  function load() {
    if (!window.pdfjsLib) {
      status.innerHTML = "The slide viewer couldn’t load. <a href=\"" + viewer.dataset.pdf + "\" style=\"color:#fff\">Open the PDF</a> instead.";
      return;
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = viewer.dataset.worker;
    status.textContent = "Loading slides…";
    pdfjsLib.getDocument({ url: viewer.dataset.pdf, disableAutoFetch: false }).promise.then(function (doc) {
      pdf = doc;
      total = doc.numPages;
      input.max = total;
      go(current, { noHash: true });
    }).catch(function () {
      status.innerHTML = "Couldn’t load the slides. <a href=\"" + viewer.dataset.pdf + "\" style=\"color:#fff\">Open the PDF</a> instead.";
    });
  }

  // Controls
  prevBtns.forEach(function (b) { b.addEventListener("click", function () { go(current - 1); }); });
  nextBtns.forEach(function (b) { b.addEventListener("click", function () { go(current + 1); }); });
  input.addEventListener("change", function () { go(parseInt(input.value, 10)); });

  var fsBtn = viewer.querySelector("[data-fullscreen]");
  function toggleFullscreen() {
    var el = document.fullscreenElement || document.webkitFullscreenElement;
    if (el) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else if (viewer.requestFullscreen) viewer.requestFullscreen();
    else if (viewer.webkitRequestFullscreen) viewer.webkitRequestFullscreen();
  }
  if (fsBtn) fsBtn.addEventListener("click", toggleFullscreen);

  var copyBtn = viewer.querySelector("[data-copy-slide]");
  if (copyBtn) copyBtn.addEventListener("click", function () {
    var link = location.origin + location.pathname + (current > 1 ? "#slide-" + current : "");
    if (navigator.clipboard) navigator.clipboard.writeText(link);
    status.textContent = "Link to slide " + current + " copied";
    setTimeout(function () { if (status.textContent.indexOf("copied") > 0) status.textContent = ""; }, 1800);
  });

  document.addEventListener("keydown", function (e) {
    var t = e.target.tagName;
    if (t === "INPUT" || t === "TEXTAREA" || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "ArrowRight" || e.key === "PageDown") { go(current + 1); e.preventDefault(); }
    else if (e.key === "ArrowLeft" || e.key === "PageUp") { go(current - 1); e.preventDefault(); }
    else if (e.key === "Home") { go(1); e.preventDefault(); }
    else if (e.key === "End") { go(total); e.preventDefault(); }
    else if (e.key === "f" || e.key === "F") toggleFullscreen();
  });

  var sx = null, sy = null;
  stage.addEventListener("touchstart", function (e) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  stage.addEventListener("touchend", function (e) {
    if (sx === null) return;
    var dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) go(current + (dx < 0 ? 1 : -1));
    sx = sy = null;
  });

  document.querySelectorAll("[data-goto]").forEach(function (a) {
    a.addEventListener("click", function (e) {
      e.preventDefault();
      go(parseInt(a.dataset.goto, 10));
      viewer.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });

  var resizeTimer;
  function rerender() { clearTimeout(resizeTimer); resizeTimer = setTimeout(function () { if (pdf) go(current, { noHash: true }); }, 150); }
  window.addEventListener("resize", rerender);
  document.addEventListener("fullscreenchange", rerender);
  window.addEventListener("hashchange", function () { go(pageFromHash(), { noHash: true }); });

  current = pageFromHash();
  updateUi();
  load();
})();
