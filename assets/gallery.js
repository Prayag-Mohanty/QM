/* Photo viewer for the About page and Askaban: open a photo big, flip with
   arrows / swipe, close with Esc. Photos sharing a data-group flip together. */
(function () {
  "use strict";
  var box = document.getElementById("lightbox");
  if (!box || typeof box.showModal !== "function") return;
  var all = Array.prototype.slice.call(document.querySelectorAll(".photo-open[data-full]"));
  var img = document.getElementById("lb-img"), cap = document.getElementById("lb-cap");
  var photos = [], at = 0;

  function captionOf(b) {
    var fc = b.parentNode.querySelector("figcaption");
    return fc ? fc.textContent : "";
  }
  function show(i) {
    at = (i + photos.length) % photos.length;
    img.src = photos[at].src;
    img.alt = photos[at].caption;
    cap.textContent = photos[at].caption;
    cap.hidden = !photos[at].caption;
    if (photos.length > 1) new Image().src = photos[(at + 1) % photos.length].src;
  }
  all.forEach(function (b) {
    b.addEventListener("click", function () {
      var group = b.dataset.group;
      var set = group ? all.filter(function (x) { return x.dataset.group === group; }) : all.filter(function (x) { return !x.dataset.group; });
      photos = set.map(function (x) { return { src: x.dataset.full, caption: captionOf(x) }; });
      box.classList.toggle("is-single", photos.length < 2);
      show(set.indexOf(b));
      box.showModal();
    });
  });
  box.addEventListener("click", function (e) {
    var act = e.target.closest("[data-lb]");
    if (act) {
      if (act.dataset.lb === "close") box.close();
      else show(at + (act.dataset.lb === "next" ? 1 : -1));
    } else if (e.target === box || e.target.tagName === "FIGURE") box.close();
  });
  box.addEventListener("keydown", function (e) {
    if (photos.length < 2) return;
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
