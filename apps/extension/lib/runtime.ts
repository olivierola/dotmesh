/**
 * Runtime guards for content scripts.
 *
 * When the user reloads the Mesh extension from chrome://extensions, every
 * content script that's already running in an open tab becomes an orphan:
 *   - chrome.runtime.id throws when read,
 *   - chrome.runtime.sendMessage throws synchronously,
 *   - alarms / storage callbacks fire chrome.runtime.lastError.
 *
 * Stale content scripts then spew "Extension context invalidated" all over
 * the host page's console. Worse, our injector intercepts Enter, fails to
 * reach the background, and leaves the user staring at a frozen composer.
 *
 * Two helpers centralise the defence:
 *
 *   - runtimeIsAlive()  — sync probe used to bypass listeners entirely when
 *                         the runtime is gone. Cheap; safe to call hot.
 *   - safeSendMessage() — Promise wrapper around chrome.runtime.sendMessage
 *                         that resolves with null on any failure (including
 *                         the synchronous throw on dead contexts).
 *
 * Callers MUST handle the null return; never assume a response.
 */

export function runtimeIsAlive(): boolean {
  try {
    return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
  } catch {
    return false;
  }
}

/**
 * Resolve(null) on any messaging error instead of throwing. Use this from
 * every fire-and-forget signal site so a dead background never crashes the
 * host page.
 */
export function safeSendMessage<T = unknown>(message: unknown): Promise<T | null> {
  return new Promise((resolve) => {
    if (!runtimeIsAlive()) {
      resolve(null);
      return;
    }
    try {
      chrome.runtime.sendMessage(message, (response) => {
        // Reading chrome.runtime.lastError suppresses Chrome's auto-thrown
        // "Unchecked runtime.lastError" warning that would otherwise flood
        // the console of every site Mesh runs on.
        const err = chrome.runtime.lastError;
        if (err) {
          resolve(null);
          return;
        }
        resolve((response as T) ?? null);
      });
    } catch {
      resolve(null);
    }
  });
}
