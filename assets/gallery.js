/* About page: open a photo big, flip with arrows / swipe, close with Esc. */
(function () {
  "use strict";
  var box = document.getElementById("lightbox");
  if (!box || typeof box.showModal !== "function") return;
  var buttons = Array.prototype.slice.call(document.querySelectorAll(".photo-open[data-full]"));
  var photos = buttons.map(function (b) {
    var cap = b.parentNode.querySelector("figcaption");
    return { src: b.dataset.full, caption: cap ? cap.textContent : "" };
  });
  var img = document.getElementById("lb-img"), cap = document.getElementById("lb-cap"), at = 0;

  function show(i) {
    at = (i + photos.length) % photos.length;
    img.src = photos[at].src;
    img.alt = photos[at].caption;
    cap.textContent = photos[at].caption;
    cap.hidden = !photos[at].caption;
    var next = photos[(at + 1) % photos.length];
    if (next) new Image().src = next.src;
  }
  buttons.forEach(function (b, i) {
    b.addEventListener("click", function () { show(i); box.showModal(); });
  });
  box.addEventListener("click", function (e) {
    var act = e.target.closest("[data-lb]");
    if (act) {
      if (act.dataset.lb === "close") box.close();
      else show(at + (act.dataset.lb === "next" ? 1 : -1));
    } else if (e.target === box || e.target.tagName === "FIGURE") box.close();
  });
  box.addEventListener("keydown", function (e) {
    if (e.key === "ArrowRight") show(at + 1);
    else if (e.key === "ArrowLeft") show(at - 1);
  });
  var x0 = null;
  box.addEventListener("touchstart", function (e) { x0 = e.touches[0].clientX; }, { passive: true });
  box.addEventListener("touchend", function (e) {
    if (x0 === null) return;
    var dx = e.changedTouches[0].clientX - x0;
    x0 = null;
    if (Math.abs(dx) > 50 && photos.length > 1) show(at + (dx < 0 ? 1 : -1));
  });
  box.addEventListener("close", function () { img.removeAttribute("src"); });
})();
