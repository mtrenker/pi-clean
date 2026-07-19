import http from "node:http";
import { Readable } from "node:stream";

const PORT = 3020;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const TARGET = "https://chatgpt.com/backend-api/codex/responses";
const ACCESS_PLACEHOLDER = "openshell:resolve:env:CODEX_AUTH_ACCESS_TOKEN";
const ACCOUNT_PLACEHOLDER = "openshell:resolve:env:CODEX_AUTH_ACCOUNT_ID";
const REQUEST_HEADERS = ["accept", "content-type", "content-encoding", "openai-beta", "session-id", "x-client-request-id"];
const RESPONSE_HEADERS = ["content-type", "cache-control", "retry-after", "retry-after-ms"];

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") return send(response, 200, "ok");
    if (request.method !== "POST" || request.url !== "/backend-api/codex/responses") return send(response, 404, "not_found");
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) throw new RelayError("request_too_large", 413);
      chunks.push(chunk);
    }
    const headers = new Headers();
    for (const name of REQUEST_HEADERS) {
      const value = request.headers[name];
      if (typeof value === "string") headers.set(name, value);
    }
    headers.set("authorization", `Bearer ${ACCESS_PLACEHOLDER}`);
    headers.set("chatgpt-account-id", ACCOUNT_PLACEHOLDER);
    headers.set("originator", "pi");
    const upstream = await fetch(TARGET, {
      method: "POST",
      headers,
      body: Buffer.concat(chunks),
      redirect: "error",
    });
    const outgoing = {};
    for (const name of RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) outgoing[name] = value;
    }
    response.writeHead(upstream.status, outgoing);
    if (upstream.body) Readable.fromWeb(upstream.body).pipe(response);
    else response.end();
  } catch (error) {
    const status = error instanceof RelayError ? error.status : 502;
    send(response, status, error instanceof RelayError ? error.code : "relay_failed");
  }
});

server.listen(PORT, "127.0.0.1");

class RelayError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}

function send(response, status, code) {
  if (!response.headersSent) response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ code }));
}
