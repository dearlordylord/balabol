import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

// Isolated wire fixture for TextDeliveryUITests' full-page prepend/viewport check.
// Run with Node 24 before that test; no model, persistence or personal history is used.
const messages = Array.from({ length: 205 }, (_, position) => ({
  deliveryId: randomUUID(),
  recordId: position,
  position,
  role: "user",
  languageSpans: [],
  text: `History fixture message ${position}${position % 3 === 0 ? " with a second line for varied height." : ""}`,
}));
createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1:8791");
  let body;
  if (url.pathname === "/conversation/messages") {
    const limit = Number(url.searchParams.get("limit") ?? 100);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      response.writeHead(400).end();
      return;
    }
    const older = url.searchParams.get("direction") === "older";
    const before = Number(url.searchParams.get("before") ?? messages.length);
    const after = Number(url.searchParams.get("after") ?? -1);
    const eligible = messages.filter((message) => (older ? message.position < before : message.position > after));
    const selected = older ? eligible.slice(-limit) : eligible.slice(0, limit);
    body = older
      ? { messages: selected, nextBefore: eligible.length > selected.length ? selected[0].position : null }
      : { messages: selected, nextAfter: eligible.length > selected.length ? selected.at(-1).position : null };
  } else if (url.pathname === "/conversation/current") body = null;
  else {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
}).listen(8791, "127.0.0.1", () => console.log("Synthetic history UI fixture ready on 127.0.0.1:8791"));
