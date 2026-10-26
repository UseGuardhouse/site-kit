// Shared helpers for site-kit scripts (upload.mjs, job.mjs). Node 24+, ESM, zero dependencies.
// API origins are hard-coded on purpose: workflows choose only an environment, never a URL.

export const ORIGINS = Object.freeze({
  production: "https://useguardhouse.com",
  staging: "https://staging.useguardhouse.com",
});

/** Environment for a calling repository ("owner/name"): staging iff the repo name ends in -stg (same rule as build.yml). */
export function envForRepository(repository) {
  const name = String(repository ?? "").replace(/^[^/]*\//, "");
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("invalid repository name");
  return name.endsWith("-stg") ? "staging" : "production";
}

export class ApiError extends Error {
  constructor(status, code, message) {
    super(`${code}: ${message}`);
    this.status = status;
    this.code = code;
  }
}

/** Token provider backed by the Actions OIDC endpoint. Never logs the token. */
export function githubTokenProvider(env = process.env, fetchImpl = fetch) {
  return async (audience) => {
    const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (!url || !bearer) {
      throw new Error("OIDC token request is unavailable (the calling job needs `permissions: id-token: write`).");
    }
    const res = await fetchImpl(`${url}&audience=${encodeURIComponent(audience)}`, {
      headers: { authorization: `Bearer ${bearer}`, accept: "application/json" },
    });
    if (!res.ok) throw new Error(`OIDC token request failed with HTTP ${res.status}`);
    const body = await res.json();
    if (!body?.value) throw new Error("OIDC token response had no value");
    return body.value;
  };
}

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Authenticated JSON/bytes client with token refresh and retry (5xx, 429, network errors).
 * api: { origin, getToken(audience) }.
 */
export function createClient(api, opts = {}) {
  const { fetch: fetchImpl = fetch, sleep = sleepReal, now = Date.now, tokenMaxAgeMs = 4 * 60 * 1000, retries = 3 } = opts;
  const origin = api.origin.replace(/\/$/, "");
  let token = null;
  let tokenAt = 0;
  async function bearer() {
    if (!token || now() - tokenAt > tokenMaxAgeMs) {
      token = await api.getToken(origin);
      tokenAt = now();
    }
    return token;
  }

  async function request(method, path, { json, body, headers = {} } = {}) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        const h = { ...headers, authorization: `Bearer ${await bearer()}` };
        if (json !== undefined) h["content-type"] = "application/json";
        res = await fetchImpl(origin + path, {
          method,
          headers: h,
          body: json !== undefined ? JSON.stringify(json) : body,
        });
      } catch (err) {
        if (err instanceof ApiError || attempt >= retries || /OIDC/.test(String(err?.message))) throw err;
        await sleep(500 * 2 ** attempt);
        continue;
      }
      if (res.ok) return res;
      if ((res.status >= 500 || res.status === 429) && attempt < retries) {
        await res.arrayBuffer().catch(() => {});
        await sleep(500 * 2 ** attempt);
        continue;
      }
      let code = `http_${res.status}`;
      let message = res.statusText || "request failed";
      try {
        const b = await res.json();
        if (b?.error?.code) code = String(b.error.code);
        if (b?.error?.message) message = String(b.error.message);
      } catch {}
      throw new ApiError(res.status, code, message);
    }
  }
  return { request, origin };
}
