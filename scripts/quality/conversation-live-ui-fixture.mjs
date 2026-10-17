import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

// Synthetic live-transcript fixture: no personal history, models or microphone.
const seedMessages = () =>
  Array.from({ length: 95 }, (_, position) => {
    const deliveryId = randomUUID();
    const assistant = position % 2 === 1;
    const interrupted = assistant && position % 5 === 1;
    return {
      deliveryId,
      recordId: position,
      position,
      role: assistant ? "assistant" : "user",
      languageSpans: [],
      text: interrupted
        ? ""
        : `Fixture row ${position}. ` + "A sentence with variable height. ".repeat((position % 19) + 1),
      ...(assistant
        ? { responseId: deliveryId, inputDeliveryId: randomUUID(), outcome: interrupted ? "interrupted" : "completed" }
        : {}),
    };
  });
let messages = seedMessages();
let reply = null;
const observers = new Set();
const publish = () => {
  for (const response of observers) response.write(`data: ${JSON.stringify(reply)}\n\n`);
};
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1:8792");
  let body;
  if (url.pathname === "/test/reset") {
    messages = seedMessages();
    reply = null;
    body = { reset: true };
  } else if (url.pathname === "/test/start") {
    const input = {
      deliveryId: randomUUID(),
      recordId: messages.length,
      position: messages.length,
      role: "user",
      languageSpans: [],
      text: "A new spoken input.",
    };
    messages.push(input);
    reply = {
      responseId: randomUUID(),
      inputDeliveryId: input.deliveryId,
      sequence: 1,
      state: "Streaming",
      text: "Answer. ",
      languageSpans: [],
      error: null,
      receipt: null,
    };
    body = { started: true };
  } else if (url.pathname === "/test/step" && reply) {
    reply = {
      ...reply,
      sequence: reply.sequence + 1,
      text: reply.text + "Another part of the spoken answer. ".repeat(3),
    };
    publish();
    body = { stepped: true };
  } else if (url.pathname === "/test/finish" && reply) {
    const receipt = {
      deliveryId: reply.responseId,
      recordId: messages.length,
      position: messages.length,
      role: "assistant",
      text: reply.text,
      languageSpans: [],
      responseId: reply.responseId,
      inputDeliveryId: reply.inputDeliveryId,
      outcome: "completed",
    };
    messages.push(receipt);
    reply = { ...reply, sequence: reply.sequence + 1, state: "Completed", receipt };
    publish();
    body = { finished: true };
  } else if (url.pathname.endsWith("/events") && reply) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify(reply)}\n\n`);
    observers.add(response);
    response.on("close", () => observers.delete(response));
    return;
  } else if (url.pathname === "/conversation/current") {
    body = reply ? { input: messages.find((m) => m.deliveryId === reply.inputDeliveryId), reply } : null;
  } else if (url.pathname === "/conversation/messages") {
    const older = url.searchParams.get("direction") === "older";
    const after = Number(url.searchParams.get("after") ?? -1);
    body = older
      ? { messages: messages.slice(-100), nextBefore: null }
      : { messages: messages.filter((m) => m.position > after).slice(0, 100), nextAfter: null };
  } else {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
});
server.listen(8792, "127.0.0.1", () => console.log("Synthetic live transcript fixture ready on 8792"));
