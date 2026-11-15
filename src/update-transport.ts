import { allowedUpdateURL, invalidRelease, MAX_METADATA_BYTES, RELEASE_API } from "./update-release";

export type PublicUpdateFetch = (url: string, init: RequestInit) => Promise<Response>;
export async function readPublicUpdateMetadata(
  initial: string, signal: AbortSignal, request: PublicUpdateFetch = fetch,
): Promise<string> {
  let url = initial;
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  for (let redirect = 0; redirect <= 3; redirect++) {
    if (url !== RELEASE_API && !allowedUpdateURL(url)) throw invalidRelease();
    const response = await request(url, {
      method: "GET", redirect: "manual", credentials: "omit", cache: "no-store", signal: bounded,
      headers: { Accept: url === RELEASE_API ? "application/vnd.github+json" : "application/octet-stream", "User-Agent": "Chat-Desktop-Updates" },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location"); await response.body?.cancel();
      if (!location || redirect === 3) throw invalidRelease();
      url = new URL(location, url).href; continue;
    }
    if (response.status !== 200 || !response.body) { await response.body?.cancel(); throw new Error("Update metadata unavailable"); }
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_METADATA_BYTES)) {
      await response.body.cancel(); throw invalidRelease();
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let total = 0; let text = "";
    try {
      while (true) {
        bounded.throwIfAborted();
        const chunk = await reader.read(); if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > MAX_METADATA_BYTES) throw invalidRelease();
        text += decoder.decode(chunk.value, { stream: true });
      }
      return text + decoder.decode();
    } finally { await reader.cancel(); }
  }
  throw invalidRelease();
}
