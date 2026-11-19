import { Readable } from "node:stream";
import type { PublicUpdateFetch } from "./update-transport";

export function createElectronUpdateRequest(
  getSession: () => Promise<Electron.Session>, open: typeof Electron.net.request,
): PublicUpdateFetch {
  return (url, { signal, ...options }) => new Promise((resolve, reject) => {
    signal.throwIfAborted();
    let request: Electron.ClientRequest | undefined;
    let incoming: Readable | undefined;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const stop = () => { cleanup(); const active = request; request = undefined; active?.abort(); };
    const fail = (error: unknown) => { reject(error); stop(); };
    const onAbort = () => {
      // Destroy the body with the same reason so a pending reader also settles.
      const reason: unknown = signal.reason;
      incoming?.destroy(reason instanceof Error ? reason : new DOMException("Update request aborted", "AbortError"));
      fail(reason);
    };
    const withoutBody = (status: number, headers: Headers) => { resolve({ status, headers, body: null }); stop(); };
    signal.addEventListener("abort", onAbort, { once: true });

    void getSession().then((session) => {
      signal.throwIfAborted();
      request = open({ ...options, url, session, bypassCustomProtocolHandlers: true });
      request.on("error", fail);
      request.on("abort", () => fail(signal.aborted ? signal.reason : new Error("Update request aborted")));
      request.on("redirect", (status, _method, _target, responseHeaders) => {
        try {
          // Abort this hop synchronously; only the shared transport may authorize the next URL.
          const location = Object.entries(responseHeaders).find(([name]) => name.toLowerCase() === "location")?.[1];
          const headers = new Headers();
          if (location?.length === 1) headers.set("location", location[0]);
          withoutBody(status, headers);
        } catch (error) { fail(error); }
      });
      request.on("response", (response) => {
        try {
          response.on("error", fail);
          const headers = new Headers();
          for (let i = 0; i + 1 < response.rawHeaders.length; i += 2) {
            const name = response.rawHeaders[i].toLowerCase();
            if (name === "content-length" || name === "location") headers.append(name, response.rawHeaders[i + 1]);
          }
          if (response.statusCode !== 200) { withoutBody(response.statusCode, headers); return; }
          // Electron 45 implements IncomingMessage as a Node Readable, while its declarations expose only events.
          if (!(response instanceof Readable)) throw new Error("Update metadata response is not readable");
          incoming = response;
          response.once("close", () => { if (response.readableEnded) cleanup(); else stop(); });
          const body = Readable.toWeb(response, { strategy: { highWaterMark: 1 } });
          resolve({ status: response.statusCode, headers, body });
        } catch (error) { fail(error); }
      });
      request.end();
    }).catch(fail);
  });
}
