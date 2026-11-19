/* A searchable multi-select of Actors, styled like the Console's own
   "All Actors" picker. It owns no data: the page gives it the Actor list and
   the current selection, and hears back through onChange. Choices apply a
   moment after the last click (or when the list closes), so ticking five
   Actors starts one reload instead of five. */
(function () {
  const MODEL = self.AAP_ACTOR_FILTER;
  // Enough for any real account; past this, the search narrows the list.
  const MAX_RENDERED = 400;
  let pickerCount = 0;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function create({ onChange, applyDelay = 700, ariaLabel = "Filter by Actor" } = {}) {
    const uid = `aap-actor-picker-${++pickerCount}`;
    let actors = [];
    let selected = [];
    let draft = new Set();
    let ordered = [];
    let visible = [];
    let activeIndex = -1;
    let open = false;
    let loading = false;
    let failed = false;
    let applyTimer = null;

    const root = element("div", "aap-actor-picker");
    const button = element("button", "aap-actor-picker-button");
    button.type = "button";
    button.setAttribute("aria-haspopup", "listbox");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-controls", `${uid}-popover`);
    const buttonLabel = element("span", "aap-actor-picker-button-label", "All Actors");
    const buttonCount = element("span", "aap-actor-picker-count");
    buttonCount.hidden = true;
    button.append(buttonLabel, buttonCount);

    const popover = element("div", "aap-actor-picker-popover");
    popover.id = `${uid}-popover`;
    popover.hidden = true;

    const searchWrap = element("div", "aap-actor-picker-search");
    const search = element("input", "aap-actor-picker-input");
    search.type = "search";
    search.placeholder = "Search Actors by name";
    search.autocomplete = "off";
    search.spellcheck = false;
    search.setAttribute("role", "combobox");
    search.setAttribute("aria-label", "Search Actors by name");
    search.setAttribute("aria-controls", `${uid}-list`);
    search.setAttribute("aria-expanded", "true");
    search.setAttribute("aria-autocomplete", "list");
    searchWrap.appendChild(search);

    const list = element("ul", "aap-actor-picker-list");
    list.id = `${uid}-list`;
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-multiselectable", "true");
    list.setAttribute("aria-label", "Actors");

    const message = element("div", "aap-actor-picker-message");
    message.setAttribute("role", "status");

    const footer = element("div", "aap-actor-picker-footer");
    const footerText = element("span", "aap-actor-picker-footer-text");
    const clear = element("button", "aap-actor-picker-clear", "Clear");
    clear.type = "button";
    footer.append(footerText, clear);

    popover.append(searchWrap, list, message, footer);
    root.append(button, popover);
    syncButton();

    function selectionLabel(ids) {
      return MODEL.summary(ids, actors);
    }

    function syncButton() {
      const ids = open ? [...draft] : selected;
      const label = selectionLabel(ids);
      buttonLabel.textContent = label;
      buttonCount.hidden = ids.length < 2;
      buttonCount.textContent = ids.length < 2 ? "" : String(ids.length);
      if (ids.length >= 2) buttonLabel.textContent = "Actors";
      button.classList.toggle("aap-actor-picker-button-filtered", ids.length > 0);
      button.title = ids.length ? `Showing ${label}. Click to change.` : "Showing every Actor. Click to pick some.";
      button.setAttribute("aria-label", `${ariaLabel}: ${label}`);
    }

    function syncFooter() {
      const count = draft.size;
      footerText.textContent = count ? `${count} selected` : "All Actors";
      clear.disabled = count === 0;
    }

    function optionId(index) {
      return `${uid}-option-${index}`;
    }

    function setActive(index, scroll = true) {
      const options = list.children;
      if (activeIndex >= 0 && options[activeIndex]) options[activeIndex].classList.remove("aap-actor-picker-option-active");
      activeIndex = Math.max(0, Math.min(index, visible.length));
      // Index 0 is the "All Actors" row, then one row per visible Actor.
      const option = options[activeIndex];
      if (!option) {
        search.removeAttribute("aria-activedescendant");
        return;
      }
      option.classList.add("aap-actor-picker-option-active");
      search.setAttribute("aria-activedescendant", option.id);
      if (scroll) option.scrollIntoView?.({ block: "nearest" });
    }

    function optionRow(index, title, subtitle, checked, extraClass = "") {
      const row = element("li", `aap-actor-picker-option${extraClass ? ` ${extraClass}` : ""}`);
      row.id = optionId(index);
      row.dataset.index = String(index);
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(checked));
      const box = element("span", "aap-actor-picker-check");
      box.setAttribute("aria-hidden", "true");
      const text = element("span", "aap-actor-picker-text");
      const titleNode = element("span", "aap-actor-picker-title", title);
      titleNode.title = title;
      text.appendChild(titleNode);
      if (subtitle) {
        const subtitleNode = element("span", "aap-actor-picker-slug", subtitle);
        subtitleNode.title = subtitle;
        text.appendChild(subtitleNode);
      }
      row.append(box, text);
      return row;
    }

    function renderList() {
      const query = search.value;
      const matching = ordered.filter((actor) => MODEL.matches(actor, query));
      visible = matching.slice(0, MAX_RENDERED);
      const rows = [optionRow(0, "All Actors", query ? "" : "Every Actor, combined", draft.size === 0, "aap-actor-picker-option-all")];
      visible.forEach((actor, index) => {
        rows.push(optionRow(index + 1, actor.title, MODEL.slug(actor), draft.has(actor.id)));
      });
      list.replaceChildren(...rows);

      let text = "";
      if (loading && !actors.length) text = "Loading your Actors…";
      else if (failed && !actors.length) text = "Couldn't load your Actors. Close and reopen to retry.";
      else if (!actors.length) text = "No Actors found on this account.";
      else if (!matching.length) text = `No Actors match "${query.trim()}".`;
      else if (matching.length > visible.length) text = `Showing ${visible.length} of ${matching.length}. Type to narrow the list.`;
      message.textContent = text;
      message.hidden = !text;
      syncFooter();
      setActive(Math.min(activeIndex < 0 ? 0 : activeIndex, visible.length), false);
    }

    function scheduleApply() {
      clearTimeout(applyTimer);
      applyTimer = setTimeout(applyDraft, applyDelay);
    }

    function applyDraft() {
      clearTimeout(applyTimer);
      applyTimer = null;
      const next = MODEL.normalizeIds([...draft]);
      if (MODEL.sameIds(next, selected)) return;
      selected = next;
      syncButton();
      onChange?.(next);
    }

    function toggleIndex(index) {
      if (index === 0) {
        if (!draft.size) return;
        draft.clear();
      } else {
        const actor = visible[index - 1];
        if (!actor) return;
        if (draft.has(actor.id)) draft.delete(actor.id);
        else draft.add(actor.id);
      }
      // Update the rows in place so the list never jumps under the pointer.
      for (const row of list.children) {
        const rowIndex = Number(row.dataset.index);
        const checked = rowIndex === 0 ? draft.size === 0 : draft.has(visible[rowIndex - 1]?.id);
        row.setAttribute("aria-selected", String(checked));
      }
      syncFooter();
      syncButton();
      scheduleApply();
    }

    function openPopover() {
      if (open) return;
      open = true;
      draft = new Set(selected);
      ordered = MODEL.order(actors, selected);
      search.value = "";
      activeIndex = 0;
      popover.hidden = false;
      button.setAttribute("aria-expanded", "true");
      root.classList.add("aap-actor-picker-open");
      renderList();
      list.scrollTop = 0;
      document.addEventListener("pointerdown", onOutside, true);
      requestOpenData?.();
      search.focus({ preventScroll: true });
    }

    function closePopover(returnFocus = false) {
      if (!open) return;
      open = false;
      popover.hidden = true;
      button.setAttribute("aria-expanded", "false");
      root.classList.remove("aap-actor-picker-open");
      document.removeEventListener("pointerdown", onOutside, true);
      applyDraft();
      syncButton();
      if (returnFocus) button.focus({ preventScroll: true });
    }

    function onOutside(event) {
      if (!root.contains(event.target)) closePopover(false);
    }

    button.addEventListener("click", () => (open ? closePopover(true) : openPopover()));
    button.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" && !open) {
        event.preventDefault();
        openPopover();
      }
    });
    search.addEventListener("input", () => {
      activeIndex = 0;
      renderList();
      list.scrollTop = 0;
    });
    search.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive(activeIndex + 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive(activeIndex - 1);
      } else if (event.key === "Home" && event.ctrlKey) {
        event.preventDefault();
        setActive(0);
      } else if (event.key === "End" && event.ctrlKey) {
        event.preventDefault();
        setActive(visible.length);
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (activeIndex >= 0) toggleIndex(activeIndex);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closePopover(true);
      } else if (event.key === "Tab") {
        closePopover(false);
      }
    });
    // pointerdown keeps focus in the search box, so typing continues after a click.
    list.addEventListener("pointerdown", (event) => event.preventDefault());
    list.addEventListener("click", (event) => {
      const row = event.target.closest?.(".aap-actor-picker-option");
      if (!row || !list.contains(row)) return;
      const index = Number(row.dataset.index);
      setActive(index, false);
      toggleIndex(index);
    });
    list.addEventListener("pointermove", (event) => {
      const row = event.target.closest?.(".aap-actor-picker-option");
      if (row && Number(row.dataset.index) !== activeIndex) setActive(Number(row.dataset.index), false);
    });
    clear.addEventListener("click", () => {
      toggleIndex(0);
      search.focus({ preventScroll: true });
    });

    let requestOpenData = null;

    return {
      element: root,
      // Called whenever the list opens, so a failed load can retry.
      onOpen(callback) {
        requestOpenData = callback;
      },
      setActors(nextActors, status = {}) {
        actors = Array.isArray(nextActors) ? nextActors : [];
        loading = Boolean(status.loading);
        failed = Boolean(status.failed);
        if (open) {
          // Keep the order fixed while open; only add Actors that just arrived.
          const known = new Set(ordered.map((actor) => actor.id));
          const byId = new Map(actors.map((actor) => [actor.id, actor]));
          ordered = ordered.map((actor) => byId.get(actor.id) || actor);
          ordered.push(...MODEL.order(actors.filter((actor) => !known.has(actor.id))));
          renderList();
        }
        syncButton();
      },
      // Sync from the page (an account switch, say) without calling onChange.
      setSelected(ids) {
        clearTimeout(applyTimer);
        applyTimer = null;
        selected = MODEL.normalizeIds(ids);
        draft = new Set(selected);
        if (open) renderList();
        syncButton();
      },
      selected: () => [...selected],
      close: () => closePopover(false),
      destroy() {
        clearTimeout(applyTimer);
        document.removeEventListener("pointerdown", onOutside, true);
        root.remove();
      },
    };
  }

  self.AAP_ACTOR_PICKER = { create };
})();
