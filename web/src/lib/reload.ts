// After a deploy, Workers Assets only serves the new build's hashed chunks, so a tab still
// running the previous build fails to lazy-load pages. Reloading picks up the new build.

const KEY = "blift:reloaded-at";

/** True once a reload is under way; the error page renders nothing meanwhile. */
export let reloading = false;

/** Browser messages for a failed dynamic import (Chromium / Firefox / Safari). */
export const isChunkLoadError = (e: unknown) =>
  e instanceof Error &&
  /dynamically imported module|Importing a module script failed|module script/i.test(e.message);

/** Reloads the page unless it was already reloaded for this reason in the last 10 s (no loops). */
export function reloadForNewVersion(): boolean {
  try {
    if (Date.now() - Number(sessionStorage.getItem(KEY) ?? 0) < 10_000) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    return false; // no storage, no loop guard: let the error page offer a manual refresh
  }
  reloading = true;
  location.reload();
  return true;
}
