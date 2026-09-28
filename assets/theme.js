/* Light / dark mode switch. Light is the default; the choice is remembered per device. */
(function () {
  "use strict";
  var html = document.documentElement;
  var buttons = document.querySelectorAll("[data-theme-toggle]");
  function apply(dark) {
    if (dark) html.dataset.theme = "dark"; else delete html.dataset.theme;
    buttons.forEach(function (b) {
      b.setAttribute("aria-checked", String(dark));
      b.title = dark ? "Switch to light mode" : "Switch to dark mode";
    });
  }
  apply(html.dataset.theme === "dark");
  buttons.forEach(function (b) {
    b.addEventListener("click", function () {
      var dark = html.dataset.theme !== "dark";
      apply(dark);
      try { localStorage.setItem("qm-theme", dark ? "dark" : "light"); } catch (e) { /* storage blocked */ }
    });
  });
})();
