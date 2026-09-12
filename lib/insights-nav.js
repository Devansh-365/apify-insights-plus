/* Shared Original/Custom toggle mounted beside the native Insights tabs. */
(function () {
  const TOGGLE_CLASS = "aap-insights-nav-view-toggle";
  const BUTTON_CLASS = "aap-insights-nav-view-button";

  function findTabList() {
    return document.querySelector('nav[data-test="tabs-items"] [role="tablist"]');
  }

  function syncToggle(toggle, mode) {
    const activeMode = mode === "original" ? "original" : "custom";
    for (const button of toggle.querySelectorAll("button")) {
      const selected = button.dataset.aapInsightsViewMode === activeMode;
      button.classList.toggle("aap-insights-nav-view-button-active", selected);
      button.setAttribute("aria-pressed", String(selected));
    }
  }

  function createToggle(owner, onChange) {
    const toggle = document.createElement("div");
    toggle.className = TOGGLE_CLASS;
    toggle.dataset.aapInsightsViewOwner = owner;
    toggle.setAttribute("role", "group");
    toggle.setAttribute("aria-label", "Insights view");
    toggle.__aapOnChange = onChange;

    for (const [mode, label] of [["original", "Original"], ["custom", "Plus"]]) {
      const button = document.createElement("button");
      button.className = BUTTON_CLASS;
      button.type = "button";
      button.textContent = label;
      button.dataset.aapInsightsViewMode = mode;
      button.addEventListener("click", () => toggle.__aapOnChange?.(mode));
      toggle.appendChild(button);
    }
    return toggle;
  }

  function ensureViewToggle(owner, mode, onChange) {
    const tabList = findTabList();
    if (!tabList) return null;
    const tabWrapper = tabList.parentElement;
    if (!tabWrapper) return null;

    let toggle = [...document.querySelectorAll(`.${TOGGLE_CLASS}`)].find((item) => item.parentElement === tabWrapper) || null;
    if (toggle?.dataset.aapInsightsViewOwner !== owner) {
      toggle?.remove();
      toggle = null;
    }
    if (!toggle) toggle = createToggle(owner, onChange);
    toggle.__aapOnChange = onChange;

    // Keep the toggle outside the horizontally scrolling tab list while it
    // remains in the same native navigation row.
    const trailingCell = [...tabWrapper.children].find((child) => child.getAttribute("role") === "cell" && child !== tabList.previousElementSibling);
    if (toggle.parentElement !== tabWrapper || toggle.previousElementSibling !== tabList) {
      tabWrapper.insertBefore(toggle, trailingCell || null);
    }
    syncToggle(toggle, mode);
    return toggle;
  }

  function removeViewToggle(owner) {
    for (const toggle of document.querySelectorAll(`.${TOGGLE_CLASS}`)) {
      if (toggle.dataset.aapInsightsViewOwner === owner) toggle.remove();
    }
  }

  window.AAP_INSIGHTS_NAV = { ensureViewToggle, removeViewToggle };
})();
