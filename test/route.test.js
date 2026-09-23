import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_ROUTE_METHOD,
  buildRouteJudgment,
  createAutoRouteHandler,
  createRouteHandler,
  formatRouteEventText,
  logRouteFeedback,
  normalizeAutoRouteParams,
  normalizeRouteParams,
  readJudgment,
  ROUTE_METHOD,
} from "../lib/route.js";

function mockApi({ entry, enqueueResult, enqueueError, wakeError, withSystem = true } = {}) {
  const calls = { enqueue: [], wake: [] };
  const system = {
    enqueueSystemEvent: (text, options) => {
      calls.enqueue.push({ text, options });
      if (enqueueError) throw enqueueError;
      return enqueueResult ?? true;
    },
    requestHeartbeat: (options) => {
      calls.wake.push(options);
      if (wakeError) throw wakeError;
    },
  };
  return {
    calls,
    runtime: {
      agent: {
        session: {
          getSessionEntry: ({ sessionKey }) =>
            entry && sessionKey === entry.key ? { agentId: entry.agentId } : undefined,
        },
      },
      ...(withSystem ? { system } : {}),
    },
    logger: { info() {}, warn() {} },
  };
}

function call(handler, params) {
  return new Promise((resolve) => {
    handler({ params, respond: (ok, payload, error) => resolve({ ok, payload, error }) });
  });
}

const CANDIDATES = [
  { sessionKey: "agent:cdx:main", label: "Codex 작업 세션", agentId: "cdx", activity: "2026-09-17 19:00" },
  { sessionKey: "agent:gjc:main", label: "gjc 메인", agentId: "gjc", activity: "2026-09-17 18:00" },
];

function jevAnswer({ choice, pickP, determined, operation = "ROUTE" }) {
  // jev-ultrafast speculative-heads shape: the operation head decides
  // ROUTE vs ASK_USER; `determined` maps to the ROUTE probability.
  return {
    answers: {
      operation: {
        type: "choice",
        choice: operation,
        probabilities: { ROUTE: determined, ASK_USER: 1 - determined },
      },
      route_target: {
        type: "choice",
        choice,
        probabilities: { [choice]: pickP, other: 1 - pickP },
      },
    },
  };
}

// ── manual route ────────────────────────────────────────────────────────────

test("normalizeRouteParams requires a message and a target", () => {
  assert.match(normalizeRouteParams({}).error, /message is required/);
  assert.match(normalizeRouteParams({ message: "hi" }).error, /sessionKey or agentId/);
  assert.match(normalizeRouteParams({ sessionKey: "  ", message: "hi" }).error, /sessionKey or agentId/);
});

test("normalizeRouteParams keeps exactly one target and trims it", () => {
  const out = normalizeRouteParams({ sessionKey: " agent:x:y ", message: " hi " });
  assert.equal(out.sessionKey, "agent:x:y");
  assert.equal(out.message, "hi");
  assert.equal(out.agentId, undefined);
});

test("normalizeRouteParams rejects oversized messages", () => {
  const out = normalizeRouteParams({ agentId: "gjc", message: "x".repeat(8001) });
  assert.match(out.error, /8000 characters/);
});

test("formatRouteEventText marks provenance and keeps the body verbatim", () => {
  const text = formatRouteEventText("작업 부탁해");
  assert.ok(text.startsWith("[Session Router]"));
  assert.ok(text.includes("작업 부탁해"));
});

test("route rejects invalid params before touching the runtime", async () => {
  const api = mockApi();
  const out = await call(createRouteHandler({ api }), { message: "" });
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "invalid_params");
  assert.equal(api.calls.enqueue.length, 0);
});

test("route rejects unknown session keys", async () => {
  const api = mockApi({ entry: { key: "agent:gjc:main", agentId: "gjc" } });
  const out = await call(createRouteHandler({ api }), { sessionKey: "agent:nope:x", message: "hi" });
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "unknown_session");
  assert.equal(api.calls.enqueue.length, 0);
});

test("route rejects an agent whose main session does not exist", async () => {
  const api = mockApi({ entry: { key: "agent:gjc:main", agentId: "gjc" } });
  const out = await call(createRouteHandler({ api }), { agentId: "nobody", message: "hi" });
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "unknown_session");
  assert.match(out.error.message, /agent:nobody:main/);
});

test("route enqueues a provenance-marked event and wakes the session", async () => {
  const api = mockApi({ entry: { key: "agent:cdx:main", agentId: "cdx" } });
  const out = await call(createRouteHandler({ api }), { sessionKey: "agent:cdx:main", message: "작업 부탁해" });
  assert.equal(out.ok, true);
  assert.deepEqual(out.payload, { status: "enqueued", sessionKey: "agent:cdx:main", agentId: "cdx" });
  assert.equal(api.calls.enqueue.length, 1);
  const { text, options } = api.calls.enqueue[0];
  assert.equal(options.sessionKey, "agent:cdx:main");
  assert.ok(text.startsWith("[Session Router]"));
  assert.ok(text.includes("작업 부탁해"));
  assert.equal(api.calls.wake.length, 1);
  assert.deepEqual(
    { ...api.calls.wake[0] },
    {
      source: "other",
      intent: "event",
      reason: "dashboard session router",
      agentId: "cdx",
      sessionKey: "agent:cdx:main",
    },
  );
});

test("route with agentId only resolves to the agent main session", async () => {
  const api = mockApi({ entry: { key: "agent:cdx:main", agentId: "cdx" } });
  const out = await call(createRouteHandler({ api }), { agentId: "cdx", message: "hi" });
  assert.equal(out.ok, true);
  assert.deepEqual(out.payload, { status: "enqueued", sessionKey: "agent:cdx:main", agentId: "cdx" });
  assert.equal(api.calls.enqueue[0].options.sessionKey, "agent:cdx:main");
});

test("route logs click-confirmation feedback when the send confirms a suggestion", async () => {
  const api = mockApi({ entry: { key: "agent:cdx:main", agentId: "cdx" } });
  const logged = [];
  const handler = createRouteHandler({
    api,
    logFeedback: (entryRecord) => {
      logged.push(entryRecord);
      return true;
    },
  });
  const out = await call(handler, {
    sessionKey: "agent:cdx:main",
    message: "codex 일 부탁해",
    feedback: { suggestion: "agent:cdx:main", probability: 0.6, determined: 0.7 },
  });
  assert.equal(out.ok, true);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].chosen, "agent:cdx:main");
  assert.equal(logged[0].suggestion, "agent:cdx:main");
  assert.equal(logged[0].suggestion, logged[0].chosen); // confirmed by construction; computation covered in logRouteFeedback test
  assert.equal(logged[0].probability, 0.6);
});

test("route without feedback params logs nothing", async () => {
  const api = mockApi({ entry: { key: "agent:gjc:main", agentId: "gjc" } });
  const logged = [];
  const handler = createRouteHandler({ api, logFeedback: (r) => logged.push(r) });
  await call(handler, { sessionKey: "agent:gjc:main", message: "hi" });
  assert.equal(logged.length, 0);
});

test("a false enqueue is reported as a failure, not queued silently", async () => {
  const api = mockApi({ entry: { key: "agent:gjc:main", agentId: "gjc" }, enqueueResult: false });
  const out = await call(createRouteHandler({ api }), { sessionKey: "agent:gjc:main", message: "hi" });
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "enqueue_failed");
  assert.equal(api.calls.wake.length, 0);
});

test("a throwing enqueue is reported as a failure", async () => {
  const api = mockApi({ entry: { key: "agent:gjc:main", agentId: "gjc" }, enqueueError: new Error("boom") });
  const out = await call(createRouteHandler({ api }), { sessionKey: "agent:gjc:main", message: "hi" });
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "enqueue_failed");
});

test("a failing wake request does not fail the route", async () => {
  const api = mockApi({ entry: { key: "agent:gjc:main", agentId: "gjc" }, wakeError: new Error("nope") });
  const out = await call(createRouteHandler({ api }), { agentId: "gjc", message: "hi" });
  assert.equal(out.ok, true);
  assert.equal(out.payload.status, "enqueued");
});

test("a runtime without the system queue fails closed with an internal error", async () => {
  const api = mockApi({ entry: { key: "agent:gjc:main", agentId: "gjc" }, withSystem: false });
  const out = await call(createRouteHandler({ api }), { agentId: "gjc", message: "hi" });
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "internal");
  assert.match(out.error.message, /system event queue unavailable/);
});

test("route method names match the manifest verb methods", () => {
  assert.equal(ROUTE_METHOD, "session-router.route");
  assert.equal(AUTO_ROUTE_METHOD, "session-router.auto-route");
});

// ── judgment building ───────────────────────────────────────────────────────

test("buildRouteJudgment uses speculative heads: operation + compatible target", () => {
  const body = buildRouteJudgment({ message: "codex야 이것 좀 해줘", candidates: CANDIDATES });
  const opCriteria = body.questions.operation.criteria;
  const targetCriteria = body.questions.route_target.criteria;
  assert.equal(opCriteria.ROUTE.startsWith("One listed session"), true);
  assert.equal(opCriteria.ASK_USER.startsWith("No listed session"), true);
  assert.equal(targetCriteria["agent:cdx:main"], null);
  assert.equal(targetCriteria["agent:gjc:main"], null);
  assert.equal("ask_user" in targetCriteria, false);
  assert.ok(body.state.facts.some((f) => f.includes("Codex 작업 세션")));
  assert.equal(body.questions.operation.type, "choice");
  assert.equal(body.questions.route_target.type, "choice");
});

test("readJudgment reads operation + target heads; determined maps to ROUTE mass", () => {
  const valid = new Set(["agent:cdx:main"]);
  const out = readJudgment(
    {
      operation: { choice: "ROUTE", probabilities: { ROUTE: 0.95, ASK_USER: 0.05 } },
      route_target: { choice: "agent:cdx:main", probabilities: { "agent:cdx:main": 0.93 } },
    },
    valid,
  );
  assert.equal(out.operation, "ROUTE");
  assert.equal(out.chosen, "agent:cdx:main");
  assert.equal(out.pickP, 0.93);
  assert.equal(out.determined, 0.95);
  assert.equal(readJudgment({ route_target: { choice: "garbage" } }, valid).chosen, null);
  const ask = readJudgment(
    { operation: { choice: "ASK_USER", probabilities: { ROUTE: 0.2, ASK_USER: 0.8 } }, route_target: {} },
    valid,
  );
  assert.equal(ask.operation, "ASK_USER");
  assert.equal(ask.determined, 0.2);
});

// ── auto route ──────────────────────────────────────────────────────────────

test("auto-route rejects params without candidates", async () => {
  const api = mockApi();
  const out = await call(createAutoRouteHandler({ api }), { message: "hi" });
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "invalid_params");
  assert.match(out.error.message, /candidates/);
});

test("auto-route rejects oversized candidate lists", async () => {
  const api = mockApi();
  const candidates = Array.from({ length: 26 }, (_, i) => ({ sessionKey: `s${i}`, label: `s${i}` }));
  const out = await call(createAutoRouteHandler({ api }), { message: "hi", candidates });
  assert.equal(out.error.code, "invalid_params");
  assert.match(out.error.message, /25/);
});

test("normalizeAutoRouteParams drops duplicates and unusable entries", () => {
  const out = normalizeAutoRouteParams({
    message: "hi",
    candidates: [
      { sessionKey: " a ", label: "A" },
      { sessionKey: "a", label: "A2" },
      { nope: true },
      { sessionKey: "b" },
    ],
  });
  assert.deepEqual(out.candidates.map((c) => c.sessionKey), ["a", "b"]);
  assert.equal(out.candidates[0].label, "A"); // first occurrence wins
});

test("auto-route fails open to manual picking when Jev is unavailable", async () => {
  const api = mockApi({ entry: { key: "agent:cdx:main", agentId: "cdx" } });
  const handler = createAutoRouteHandler({
    api,
    callJev: async () => {
      throw new Error("network down");
    },
  });
  const out = await call(handler, { message: "hi", candidates: CANDIDATES });
  assert.equal(out.ok, true);
  assert.equal(out.payload.status, "jev_unavailable");
  assert.match(out.payload.reason, /network down/);
  assert.equal(api.calls.enqueue.length, 0);
});

test("auto-route delivers directly above the 0.5 bar", async () => {
  const api = mockApi({ entry: { key: "agent:cdx:main", agentId: "cdx" } });
  const handler = createAutoRouteHandler({
    api,
    callJev: async () => jevAnswer({ choice: "agent:cdx:main", pickP: 0.55, determined: 0.52 }),
  });
  const out = await call(handler, { message: "codex로 보내줘", candidates: CANDIDATES });
  assert.equal(out.ok, true);
  assert.equal(out.payload.status, "routed");
  assert.equal(out.payload.sessionKey, "agent:cdx:main");
  assert.equal(out.payload.probability, 0.55);
  assert.equal(out.payload.determined, 0.52);
  assert.ok(out.payload.probabilities);
  assert.ok(Math.abs((out.payload.probabilities["agent:cdx:main"] ?? 0) - 0.55) < 1e-9);
  assert.equal(api.calls.enqueue.length, 1);
  assert.ok(api.calls.enqueue[0].text.includes("codex로 보내줘"));
});

test("auto-route stays below the bar when determined is weak even at high pickP", async () => {
  const api = mockApi({ entry: { key: "agent:cdx:main", agentId: "cdx" } });
  const handler = createAutoRouteHandler({
    api,
    callJev: async () => jevAnswer({ choice: "agent:cdx:main", pickP: 0.95, determined: 0.45 }),
  });
  const out = await call(handler, { message: "hi", candidates: CANDIDATES });
  assert.equal(out.payload.status, "needs_pick");
  assert.equal(out.payload.suggestion, "agent:cdx:main");
  assert.equal(api.calls.enqueue.length, 0);
});

test("auto-route asks the user when the operation head picks ASK_USER", async () => {
  const api = mockApi({ entry: { key: "agent:cdx:main", agentId: "cdx" } });
  const handler = createAutoRouteHandler({
    api,
    callJev: async () => jevAnswer({ choice: "", pickP: 0, determined: 0.2, operation: "ASK_USER" }),
  });
  const out = await call(handler, { message: "애매한 요청", candidates: CANDIDATES });
  assert.equal(out.payload.status, "needs_pick");
  assert.equal(out.payload.suggestion, null);
  assert.equal(out.payload.operation, "ASK_USER");
  assert.equal(api.calls.enqueue.length, 0);
});

test("auto-route below the 0.5 bar returns the suggestion for one-click confirm", async () => {
  const api = mockApi({ entry: { key: "agent:cdx:main", agentId: "cdx" } });
  const handler = createAutoRouteHandler({
    api,
    callJev: async () => jevAnswer({ choice: "agent:cdx:main", pickP: 0.45, determined: 0.8 }),
  });
  const out = await call(handler, { message: "이것 좀", candidates: CANDIDATES });
  assert.equal(out.payload.status, "needs_pick");
  assert.equal(out.payload.suggestion, "agent:cdx:main");
  assert.equal(out.payload.probability, 0.45);
});

// ── feedback store ──────────────────────────────────────────────────────────

test("logRouteFeedback writes bounded JSONL through injected io", () => {
  const written = [];
  const io = {
    mkdirSync() {},
    readFileSync: () => Array.from({ length: 260 }, () => JSON.stringify({ old: true })).join("\n"),
    writeFileSync: (p, body) => written.push({ p, body }),
  };
  const ok = logRouteFeedback({
    message: "msg",
    chosen: "agent:cdx:main",
    suggestion: "agent:cdx:main",
    probability: 0.6,
    io,
  });
  assert.equal(ok, true);
  assert.equal(written.length, 1);
  const lines = written[0].body.trim().split("\n");
  assert.equal(lines.length, 200); // capped at FEEDBACK_KEEP, new entry included
  const entry = JSON.parse(lines[lines.length - 1]);
  assert.equal(entry.chosen, "agent:cdx:main");
  assert.equal(entry.confirmed, true);
  assert.equal(entry.probability, 0.6);
  assert.ok(entry.ts);
});

test("logRouteFeedback swallows io failures", () => {
  const io = {
    mkdirSync() {
      throw new Error("no disk");
    },
  };
  assert.equal(logRouteFeedback({ message: "m", chosen: "c", io }), false);
});
