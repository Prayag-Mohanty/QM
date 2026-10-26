/* Askaban feed: "2h" / "3d" style times, and share buttons. */
(function () {
  "use strict";
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function ago(when) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(when);
    if (!m) return null;
    var d = new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5]);   // the time as written (local)
    var s = (Date.now() - d.getTime()) / 1000;
    if (s < 0) s = 0;
    if (s < 60) return "now";
    if (s < 3600) return Math.floor(s / 60) + "m";
    if (s < 86400) return Math.floor(s / 3600) + "h";
    if (s < 7 * 86400) return Math.floor(s / 86400) + "d";
    return d.getDate() + " " + MONTHS[d.getMonth()] + (d.getFullYear() !== new Date().getFullYear() ? " " + d.getFullYear() : "");
  }
  document.querySelectorAll("time[data-when]").forEach(function (t) {
    var label = ago(t.dataset.when);
    if (label) t.textContent = label;
    var m = /T(\d{2}):(\d{2})/.exec(t.dataset.when);
    if (m) {
      var h = +m[1], ap = h < 12 ? "AM" : "PM";
      t.title = (h % 12 || 12) + ":" + m[2] + " " + ap + " · " + t.dateTime.slice(0, 10);
    }
  });
  document.querySelectorAll("[data-share]").forEach(function (b) {
    b.addEventListener("click", function () {
      var url = b.dataset.share, label = b.querySelector("span");
      if (navigator.share) return navigator.share({ title: b.dataset.shareTitle, url: url }).catch(function () {});
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () {
        label.textContent = "Link copied";
        setTimeout(function () { label.textContent = "Share"; }, 1600);
      });
    });
  });
})();

/* Phones: Feed / Blog tabs (desktop shows both columns side by side). */
(function () {
  "use strict";
  var tabs = document.querySelector(".ask-tabs"), layout = document.querySelector(".ask-layout");
  if (!tabs || !layout) return;
  tabs.hidden = false;
  function pick(which, push) {
    layout.dataset.active = which;
    tabs.querySelectorAll("[data-ask-tab]").forEach(function (t) {
      var on = t.dataset.askTab === which;
      t.classList.toggle("is-active", on);
      t.setAttribute("aria-selected", String(on));
    });
    if (push) history.replaceState(null, "", which === "blog" ? "#blog" : location.pathname + location.search);
  }
  tabs.addEventListener("click", function (e) {
    var t = e.target.closest("[data-ask-tab]");
    if (t) { pick(t.dataset.askTab, true); window.scrollTo({ top: tabs.offsetTop - 70, behavior: "smooth" }); }
  });
  pick(location.hash === "#blog" ? "blog" : "feed", false);
})();
