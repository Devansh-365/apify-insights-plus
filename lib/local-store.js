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

  const migrated = new Set();

  // Reads `key`, first folding into it any older copies saved under keys
  // that start with `legacyPrefix`, which are then removed. Saved decisions
  // used to be scoped by a hash of the login token, so each new token started
  // an empty copy. `merge` must be idempotent: two tabs may merge the same
  // copies at once. Runs once per key per page load; old copies a failed
  // attempt leaves behind are merged on the next load.
  async function getMigrated(key, legacyPrefix, merge) {
    const read = async () => (await chrome.storage.local.get(key))?.[key];
    if (migrated.has(key)) return read();
    migrated.add(key);
    try {
      const keys = chrome.storage.local.getKeys
        ? await chrome.storage.local.getKeys()
        : Object.keys(await chrome.storage.local.get(null));
      const legacy = keys.filter((name) => name.startsWith(legacyPrefix) && name !== key);
      if (!legacy.length) return read();
      const old = await chrome.storage.local.get(legacy);
      const copies = legacy.map((name) => old[name]).filter((value) => value != null);
      // Read after the old copies: if another tab merged them first, its
      // result is already here.
      const current = await read();
      if (!copies.length) return current;
      const merged = merge(current === undefined ? copies : [current, ...copies]);
      await set(key, merged);
      await chrome.storage.local.remove(legacy);
      return merged;
    } catch {
      return read();
    }
  }

  self.AAP_LOCAL_STORE = { set, isEcho, getMigrated };
})();
