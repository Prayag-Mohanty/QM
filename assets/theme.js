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

  // Email links are stored scrambled in the page so spam bots can't harvest the address.
  document.querySelectorAll("[data-mail]").forEach(function (a) {
    try {
      var addr = atob(a.dataset.mail).split("").reverse().join("");
      a.href = "mailto:" + addr + (a.dataset.subject ? "?subject=" + encodeURIComponent(a.dataset.subject) : "");
    } catch (e) { /* leave the fallback link */ }
  });
  buttons.forEach(function (b) {
    b.addEventListener("click", function () {
      var dark = html.dataset.theme !== "dark";
      apply(dark);
      try { localStorage.setItem("qm-theme", dark ? "dark" : "light"); } catch (e) { /* storage blocked */ }
    });
  });
})();
