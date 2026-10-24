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

  // Whole numbers with thousands separators: 1234.6 -> "1,235".
  function count(n) {
    return Math.round(Number(n) || 0).toLocaleString("en-US");
  }

  function plural(n, one, many) {
    return `${count(n)} ${Math.round(Number(n) || 0) === 1 ? one : many}`;
  }

  // Whole dollars for estimates, where cents would be false precision.
  function wholeMoney(n) {
    if (n == null || Number.isNaN(n)) return "–";
    return n > 0 && n < 1 ? "<$1" : `$${count(n)}`;
  }

  // After the extension is reloaded or updated, scripts already running in
  // an open tab lose the extension APIs; only reloading the tab recovers.
  function extensionReloaded(error) {
    return /extension context invalidated/i.test(typeof error === "string" ? error : error?.message || "");
  }

  const RELOAD_TEXT = "Apify Insights Plus was reloaded or updated. Reload this page";

  function messageOf(error) {
    return typeof error === "string" ? error : error?.message;
  }

  // "Couldn't load <subject>: <reason>", or how to recover when the reason
  // is a reloaded extension.
  function loadError(subject, error) {
    if (extensionReloaded(error)) return `${RELOAD_TEXT} to load ${subject}.`;
    const message = messageOf(error);
    return `Couldn't load ${subject}${message ? `: ${message}` : "."}`;
  }

  // The error's own message, the fallback, or how to recover from a
  // reloaded extension.
  function errorText(error, fallback) {
    return extensionReloaded(error) ? `${RELOAD_TEXT} to continue.` : messageOf(error) || fallback;
  }

  self.AAPF = { money, wholeMoney, count, plural, pct, compact, dayOfMonth, shortDate, extensionReloaded, loadError, errorText };
})();
