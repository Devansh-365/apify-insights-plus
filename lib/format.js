/* Shared money/percent/date helpers, classic script (no modules). */
(function () {
  function money(n) {
    if (n == null || Number.isNaN(n)) return "–";
    const sign = n < 0 ? "-" : "";
    return sign + "$" + Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function pct(n) {
    if (n == null || Number.isNaN(n)) return "–";
    return (n * 100).toFixed(1) + "%";
  }

  function compact(n) {
    if (n == null || Number.isNaN(n)) return "–";
    const abs = Math.abs(n);
    if (abs >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (abs >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return String(n);
  }

  // "2026-07-08" -> "8"
  function dayOfMonth(dateStr) {
    return String(Number(dateStr.slice(8, 10)));
  }

  // "2026-07-08" -> "Jul 8" (matches Apify's own chart; hardcoded to en-US
  // so the month-then-day order doesn't flip under a day-first browser locale)
  function shortDate(dateStr) {
    const d = new Date(dateStr + "T00:00:00Z");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  }

  self.AAPF = { money, pct, compact, dayOfMonth, shortDate };
})();
