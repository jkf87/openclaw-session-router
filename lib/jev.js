// Minimal TypeSafe System One client for auto-routing judgments.
//
// Mirrors the jev-judgment skill's wire format (POST /v1/systemone) without a
// python dependency: the gateway process already has network access and Node
// 18+ ships fetch. The API key resolves from the gateway environment first,
// then from the agent workspace `.env` the skill itself documents, so the
// router and the skill share one credential.

import { readFileSync } from "node:fs";
import path from "node:path";

const ENV_KEY = "TYPESAFE_API_KEY";
const ENV_BASE_URL = "TYPESAFE_BASE_URL";
const ENV_MODEL = "TYPESAFE_DEFAULT_MODEL";
const DEFAULT_MODEL = "jev-latest";
const DEFAULT_BASE_URL = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_ENV_PATH = path.join(
  process.env.HOME ?? "",
  ".openclaw",
  "workspace",
  ".env",
);
const REQUEST_TIMEOUT_MS = 8000;

/** Parses NAME=value lines from a .env file body. */
export function parseDotenv(body) {
  const out = {};
  for (const rawLine of String(body ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[name] = value;
  }
  return out;
}

/** Resolves the API key: env first, then the workspace .env fallback. */
export function resolveApiKey({ envPath } = {}) {
  const fromEnv = (process.env[ENV_KEY] ?? "").trim();
  if (fromEnv) return fromEnv;
  const candidates = [envPath, process.env.TYPESAFE_ENV_PATH, DEFAULT_ENV_PATH].filter(Boolean);
  for (const filePath of candidates) {
    try {
      const parsed = parseDotenv(readFileSync(filePath, "utf8"));
      const value = (parsed[ENV_KEY] ?? "").trim();
      if (value) return value;
    } catch {
      // Missing or unreadable file falls through to the next candidate.
    }
  }
  return null;
}

// The skill's script redacts credentials it recognises before sending state;
// the router applies the same spirit to the two free-text fields it sends.
const SECRET_PATTERN =
  /(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|Bearer\s+[A-Za-z0-9._-]{8,}|AKIA[0-9A-Z]{12,})/g;

/** Redacts recognisable credentials and caps runaway strings. */
export function sanitizeText(value, maxChars = 2000) {
  const text = String(value ?? "").replace(SECRET_PATTERN, "[REDACTED]");
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/**
 * Calls System One with {state, questions} and returns the parsed answer.
 * Throws on network or HTTP failure; callers decide how to fail open.
 */
export async function callSystemOne({ state, questions, model, apiKey, baseUrl, fetchImpl, timeoutMs }) {
  const key = apiKey ?? resolveApiKey();
  if (!key) {
    const err = new Error("TYPESAFE_API_KEY not set in environment or .env");
    err.code = "no_api_key";
    throw err;
  }
  const url = baseUrl || (process.env[ENV_BASE_URL] ?? "").trim() || DEFAULT_BASE_URL;
  // Mirror the skill's resolution order: explicit arg, then env, then default.
  const resolvedModel =
    (model ?? "").trim() || (process.env[ENV_MODEL] ?? "").trim() || DEFAULT_MODEL;
  const doFetch = fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    const response = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: resolvedModel, state, questions }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const err = new Error(`systemone HTTP ${response.status}: ${body.slice(0, 200)}`);
      err.code = `http_${response.status}`;
      throw err;
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}
