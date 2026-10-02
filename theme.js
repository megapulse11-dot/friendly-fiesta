/**
 * Northwind Realty — theme bootstrap.
 *
 * Runs before the stylesheet is applied, so a reader who chose dark - or whose
 * system is dark - never sees a flash of the light theme. It has to be a
 * blocking script in the head for that reason: no defer, no async, no module.
 *
 * It lives in its own file rather than inline so that the pages can ship a
 * Content-Security-Policy with script-src 'self' and no 'unsafe-inline'. That
 * only stays true if nothing adds an inline <script> back.
 *
 * app.js picks up from here: it re-reads the same key, wires the toggle button,
 * and keeps following the system while no explicit choice has been made.
 */
(function () {
  var stored = null;
  try { stored = localStorage.getItem('northwind:theme'); } catch (e) { /* storage unavailable */ }
  if (stored !== 'light' && stored !== 'dark') stored = null;
  var dark = stored ? stored === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();