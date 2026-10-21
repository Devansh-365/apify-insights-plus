/*
 * chrome.storage.local writes that know their own echoes. storage.onChanged
 * also fires in the tab that wrote, and late: applying an echo of an older
 * write would undo a newer change made in between. set() remembers what this
 * tab wrote, and isEcho() lets a listener skip exactly those changes, so only
 * changes from other tabs (or other pages) are applied.
 */
(function () {
  const pending = new Map();

  function serialize(value) {
    return JSON.stringify(value ?? null);
  }

  function set(key, value) {
    const id = `${key}\n${serialize(value)}`;
    pending.set(id, (pending.get(id) || 0) + 1);
    return chrome.storage.local.set({ [key]: value }).catch?.(() => {});
  }

  function isEcho(key, newValue) {
    const id = `${key}\n${serialize(newValue)}`;
    const count = pending.get(id);
    if (!count) return false;
    if (count === 1) pending.delete(id);
    else pending.set(id, count - 1);
    return true;
  }

  self.AAP_LOCAL_STORE = { set, isEcho };
})();
