/* Progressive enhancement, and nothing else.
 *
 * There is no form on this site, so there is no submit handler here. The calls
 * to action are prefilled mailto links: they work with JavaScript blocked, with
 * this file 404ing, and on a browser that has never heard of fetch. All this
 * does is replace the placeholder seat counts with the live ones.
 *
 * Reads the server's own capacity shape — cohorts.foundersDevelopers.{limit,
 * joined,remaining,full} — rather than inventing a second one.
 */
(function () {
  "use strict";

  var CAPACITY_URL = "/api/founding-network/capacity";
  var BASE_MS = 30000;
  var MAX_MS = 240000;
  var NUMBER = new Intl.NumberFormat("en-US");
  var delay = BASE_MS;
  var timer = null;

  function setText(sel, value) {
    var el = document.querySelector(sel);
    if (el && el.textContent !== value) el.textContent = value;
  }

  function paint(snap) {
    if (!snap || !snap.cohorts) return;

    Object.keys(snap.cohorts).forEach(function (key) {
      var c = snap.cohorts[key];
      if (!c) return;
      setText('[data-capacity-remaining="' + key + '"]', NUMBER.format(c.remaining));

      var fill = document.querySelector('[data-capacity-fill="' + key + '"]');
      if (fill && c.limit) {
        fill.style.width = Math.min(100, (c.joined / c.limit) * 100).toFixed(3) + "%";
      }
      var card = document.querySelector('[data-cohort="' + key + '"]');
      if (card) card.classList.toggle("cohort-full", Boolean(c.full));
    });

    if (snap.total) {
      setText("[data-capacity-total-remaining]", NUMBER.format(snap.total.remaining));
    }

    // The dot goes amber when the number on screen is not one the server stood
    // behind. Honest uncertainty beats confident scarcity — it is the same
    // promise the rest of the page makes.
    document.querySelectorAll(".badge-dot").forEach(function (dot) {
      dot.classList.remove("is-provisional");
    });
  }

  function stale() {
    document.querySelectorAll(".badge-dot").forEach(function (dot) {
      dot.classList.add("is-provisional");
    });
  }

  function schedule(ms) {
    window.clearTimeout(timer);
    timer = window.setTimeout(poll, ms);
  }

  function poll() {
    if (document.hidden) return schedule(BASE_MS);
    var ctl = new AbortController();
    var t = window.setTimeout(function () { ctl.abort(); }, 5000);

    fetch(CAPACITY_URL, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: ctl.signal,
    })
      .then(function (r) {
        if (!r.ok) throw new Error("capacity " + r.status);
        return r.json();
      })
      .then(function (snap) { paint(snap); delay = BASE_MS; })
      .catch(function () { stale(); delay = Math.min(MAX_MS, delay * 2); })
      .then(function () { window.clearTimeout(t); schedule(delay); });
  }

  if ("fetch" in window && "AbortController" in window) {
    poll();
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) { delay = BASE_MS; poll(); }
    });
  } else {
    stale();
  }

  document.addEventListener("click", function (ev) {
    var a = ev.target.closest && ev.target.closest('a[href^="#"]');
    if (!a) return;
    var id = a.getAttribute("href").slice(1);
    var target = id && document.getElementById(id);
    if (!target) return;
    ev.preventDefault();
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    history.replaceState(null, "", "#" + id);
  });
})();
