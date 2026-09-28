import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";

/** Create an authenticated same-origin provider for one immutable draft id. */
export function createDraftWebsocketProvider(document: Y.Doc, draftId: string): WebsocketProvider {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(draftId)) {
    throw new Error("Invalid collaborative draft id");
  }
  const endpoint = new URL("/api/collaboration", window.location.origin);
  endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  return new WebsocketProvider(endpoint.toString().replace(/\/$/, ""), draftId, document, {
    disableBc: true,
    params: {},
  });
}

export function closeDraftCollaboration(provider: WebsocketProvider, document: Y.Doc): void {
  provider.disconnect();
  provider.awareness.destroy();
  document.destroy();
}
