import assert from "node:assert/strict";
import { test } from "node:test";
import { isJsonContentType, rejectReason } from "../src/guard.ts";

test("the app's own pages, Electron and server-side callers are allowed", () => {
  assert.equal(rejectReason({ method: "POST", host: "localhost:4321", origin: "http://localhost:4321" }), undefined);
  assert.equal(rejectReason({ method: "POST", host: "127.0.0.1:51234", origin: "http://127.0.0.1:51234" }), undefined);
  assert.equal(rejectReason({ method: "DELETE", host: "127.0.0.1:4321" }), undefined, "no Origin: curl or the website's server");
  assert.equal(rejectReason({ method: "GET", host: "[::1]:4321" }), undefined);
});

test("other websites cannot change anything", () => {
  assert.ok(rejectReason({ method: "POST", host: "localhost:4321", origin: "https://evil.example" }));
  assert.ok(rejectReason({ method: "DELETE", host: "localhost:4321", origin: "null" }));
  assert.ok(rejectReason({ method: "POST", host: "localhost:4321", origin: "http://localhost.evil.example" }));
});

test("DNS rebinding (a foreign Host header) is refused even for reads", () => {
  assert.ok(rejectReason({ method: "GET", host: "evil.example:4321" }));
  assert.ok(rejectReason({ method: "GET" }), "missing Host");
});

test("only real JSON content types are accepted for bodies", () => {
  assert.ok(isJsonContentType("application/json"));
  assert.ok(isJsonContentType("application/json; charset=utf-8"));
  assert.ok(!isJsonContentType("text/plain"));
  assert.ok(!isJsonContentType("application/jsonp"));
  assert.ok(!isJsonContentType(undefined));
});
