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

  // ---- audio / video on slides -------------------------------------------
  var layer = viewer.querySelector(".stage-layer");
  var media = [];
  try { media = JSON.parse((viewer.querySelector(".media-data") || {}).textContent || "[]"); } catch (e) { media = []; }
  var mediaSlide = null;
  var ICON = {
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/></svg>',
    audio: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" stroke="none"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/></svg>'
  };

  function isAudio(item) { return item.k === "audio" || item.audio; }
  function pct(v) { return (v * 100).toFixed(3) + "%"; }
  function place(el, r) {
    el.style.left = pct(r[0]); el.style.top = pct(r[1]);
    el.style.width = pct(r[2]); el.style.height = pct(r[3]);
  }

  // Keep the layer exactly over the drawn slide (the canvas is letterboxed).
  function layoutLayer() {
    if (!layer) return;
    var el = canvas.hidden ? cover : canvas;
    var iw = canvas.hidden ? (cover.naturalWidth || 16) : canvas.width;
    var ih = canvas.hidden ? (cover.naturalHeight || 9) : canvas.height;
    var W = el.clientWidth, H = el.clientHeight, a = iw / ih;
    var w = W / H > a ? H * a : W, h = W / H > a ? H : W / a;
    layer.style.left = el.offsetLeft + (W - w) / 2 + "px";
    layer.style.top = el.offsetTop + (H - h) / 2 + "px";
    layer.style.width = w + "px";
    layer.style.height = h + "px";
  }

  function stopMedia() {
    if (!layer) return;
    layer.querySelectorAll("video, audio").forEach(function (m) { try { m.pause(); } catch (e) { /* ignore */ } });
    layer.innerHTML = "";
    mediaSlide = null;
  }

  function renderMedia(n) {
    if (!layer || mediaSlide === n) return;
    stopMedia();
    mediaSlide = n;
    var items = media.filter(function (m) { return m.s === n; });
    if (!items.length) return;
    var pills = null;
    items.forEach(function (item) {
      if (item.k === "link") {
        if (!item.r) return;
        var a = document.createElement("a");
        a.className = "hot-link";
        a.href = item.src; a.target = "_blank"; a.rel = "noopener";
        a.title = item.src; a.setAttribute("aria-label", "Open link: " + item.src);
        place(a, item.r);
        layer.appendChild(a);
        return;
      }
      var audio = isAudio(item);
      var label = (audio ? "Play audio" : "Play video") + (item.k === "embed" ? " (" + item.label + ")" : "");
      if (item.r) {
        var hot = document.createElement("button");
        hot.type = "button";
        hot.className = "hot-media" + (audio ? " is-audio" : "");
        hot.setAttribute("aria-label", label);
        hot.title = label;
        hot.innerHTML = '<span class="hot-badge">' + (audio ? ICON.audio : ICON.play) + "</span>";
        place(hot, item.r);
        hot.addEventListener("click", function (e) { e.stopPropagation(); play(item); });
        layer.appendChild(hot);
      } else {
        if (!pills) { pills = document.createElement("div"); pills.className = "media-pills"; layer.appendChild(pills); }
        var pill = document.createElement("button");
        pill.type = "button";
        pill.className = "media-pill";
        pill.innerHTML = (audio ? ICON.audio : ICON.play) + "<span>" + label + "</span>";
        pill.addEventListener("click", function (e) { e.stopPropagation(); play(item); });
        pills.appendChild(pill);
      }
    });
  }

  function play(item) {
    layer.querySelectorAll(".media-player").forEach(function (p) { p.remove(); });
    layer.querySelectorAll("video, audio").forEach(function (m) { m.pause(); });
    var audio = isAudio(item);
    var box = document.createElement("div");
    box.className = "media-player" + (audio ? " is-audio" : "");
    var r = item.r;
    if (!audio && r && r[2] >= 0.3 && r[3] >= 0.25) place(box, r);   // play where it sits on the slide
    else box.classList.add(audio ? "at-bottom" : "centered");
    var el;
    if (item.k === "video") {
      el = document.createElement("video");
      el.controls = true; el.autoplay = true; el.playsInline = true; el.preload = "auto";
      el.src = item.src;
    } else if (item.k === "audio") {
      el = document.createElement("audio");
      el.controls = true; el.autoplay = true; el.preload = "auto";
      el.src = item.src;
    } else {
      el = document.createElement("iframe");
      el.src = item.src;
      el.title = item.label + " player";
      el.allow = "autoplay; encrypted-media; fullscreen; picture-in-picture; clipboard-write";
      el.setAttribute("allowfullscreen", "");
      el.referrerPolicy = "strict-origin-when-cross-origin";
      if (item.audio) box.classList.add(/soundcloud/.test(item.src) ? "is-soundcloud" : "is-spotify");
    }
    var close = document.createElement("button");
    close.type = "button";
    close.className = "media-close";
    close.setAttribute("aria-label", "Close player");
    close.innerHTML = "×";
    close.addEventListener("click", function (e) {
      e.stopPropagation();
      if (el.pause) el.pause();
      box.remove();
    });
    box.appendChild(el);
    box.appendChild(close);
    box.addEventListener("click", function (e) { e.stopPropagation(); });
    layer.appendChild(box);
  }

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
    if (n !== current) stopMedia();
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
        layoutLayer();
        if (n === current) renderMedia(n);
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
    if (t === "INPUT" || t === "TEXTAREA" || t === "VIDEO" || t === "AUDIO" || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "ArrowRight" || e.key === "PageDown") { go(current + 1); e.preventDefault(); }
    else if (e.key === "ArrowLeft" || e.key === "PageUp") { go(current - 1); e.preventDefault(); }
    else if (e.key === "Home") { go(1); e.preventDefault(); }
    else if (e.key === "End") { go(total); e.preventDefault(); }
    else if (e.key === "f" || e.key === "F") toggleFullscreen();
  });

  var sx = null, sy = null;
  stage.addEventListener("touchstart", function (e) {
    if (e.target.closest && e.target.closest(".media-player, .hot-media, .media-pill")) { sx = null; return; }
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
  }, { passive: true });
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
  function rerender() {
    layoutLayer();  // players keep playing; they're positioned in % of the layer
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { if (pdf) go(current, { noHash: true }); }, 150);
  }
  window.addEventListener("resize", rerender);
  document.addEventListener("fullscreenchange", rerender);
  window.addEventListener("hashchange", function () { go(pageFromHash(), { noHash: true }); });

  current = pageFromHash();
  updateUi();
  load();
})();
