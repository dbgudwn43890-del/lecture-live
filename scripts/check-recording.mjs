import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/** Read only the public relay address; never evaluate or print environment text. */
export function readRelayUrl(text) {
  const line = text.split(/\r?\n/).findLast(line => /^\s*(?:export\s+)?STT_RELAY_URL\s*=/.test(line));
  if (!line) return undefined;
  const value = line.slice(line.indexOf("=") + 1).trim();
  if (value.startsWith('"') || value.startsWith("'")) {
    const end = value.indexOf(value[0], 1);
    return end < 0 ? undefined : value.slice(1, end);
  }
  return value.replace(/\s+#.*$/, "").trim();
}

function parsedUrl(value, protocols) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`Expected a valid ${protocols.join("/")} URL.`); }
  if (!protocols.includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`Use a ${protocols.join("/")} URL without credentials, query parameters, or fragments.`);
  }
  return url;
}

function policyDirectives(policy) {
  const directives = new Map();
  for (const value of policy.split(";")) {
    const [name, ...sources] = value.trim().split(/\s+/);
    if (name && !directives.has(name.toLowerCase())) directives.set(name.toLowerCase(), sources);
  }
  return directives;
}

function allows(sources, target, app) {
  if (!sources) return true; // No CSP directive applies to this resource.
  return sources.some(source => {
    if (source === "'self'") return target.protocol !== "blob:" && target.origin === app.origin;
    if (source === "*") return ["http:", "https:", "ws:", "wss:"].includes(target.protocol);
    if (/^[a-z][a-z\d+.-]*:$/i.test(source)) return source.toLowerCase() === target.protocol;
    try {
      const allowed = new URL(source, app);
      const hostname = allowed.hostname.startsWith("*.")
        ? target.hostname.endsWith(allowed.hostname.slice(1)) : allowed.hostname === target.hostname;
      const path = allowed.pathname === "/" || (allowed.pathname.endsWith("/")
        ? target.pathname.startsWith(allowed.pathname) : target.pathname === allowed.pathname);
      return allowed.protocol === target.protocol && hostname && allowed.port === target.port && path;
    } catch { return false; }
  });
}

export function inspectRecordingHeaders(headers, appUrl, relayUrl) {
  const app = new URL(appUrl);
  const relay = new URL(relayUrl);
  const csp = headers.get("content-security-policy");
  const policies = csp ? csp.split(",").map(policyDirectives) : [];
  const check = (name, ok, message) => ({ name, ok, message });
  const checks = [check("CSP", policies.length > 0, policies.length
    ? "Enforced Content-Security-Policy is present."
    : "No enforced CSP was returned; the recording policy could not be verified.")];
  if (policies.length) {
    const connects = policies.every(policy => allows(policy.get("connect-src") ?? policy.get("default-src"), relay, app));
    checks.push(check("Relay WebSocket CSP", connects, connects
      ? `CSP permits the configured relay at ${relay.origin}.`
      : `CSP blocks the configured relay at ${relay.origin}. If STT_RELAY_URL was just added, fully restart the dev server and reload the browser document; HMR alone retains stale CSP. Verify the exact relay origin in connect-src.`));
    const script = new URL("/pcm-capture-worklet.js", app);
    const scriptAllowed = policies.every(policy => allows(policy.get("script-src") ?? policy.get("default-src"), script, app));
    checks.push(check("AudioWorklet CSP", scriptAllowed, scriptAllowed
      ? "CSP permits the same-origin PCM AudioWorklet module."
      : "script-src blocks the same-origin PCM AudioWorklet module."));
    const worker = new URL("/recording-check-worker.js", app);
    const blob = new URL(`blob:${app.origin}/recording-check`);
    const workers = policies.every(policy => {
      const sources = policy.get("worker-src") ?? policy.get("child-src") ?? policy.get("script-src") ?? policy.get("default-src");
      return allows(sources, worker, app) && allows(sources, blob, app);
    });
    checks.push(check("Worker CSP", workers, workers
      ? "CSP permits same-origin and blob workers used by the workspace."
      : "The effective worker-src policy must permit the workspace's same-origin and blob workers. Check worker-src and its CSP fallbacks."));
  }
  const permissions = headers.get("permissions-policy") ?? "";
  for (const feature of ["microphone", "display-capture"]) {
    const entries = [...permissions.matchAll(new RegExp(`(?:^|,)\\s*${feature}\\s*=\\s*(\\([^)]*\\)|\\*)`, "gi"))];
    const permitted = entries.every(([, list]) => list === "*" || /(?:^|[\s(])self(?:[\s)]|$)/.test(list) || list.includes(`"${app.origin}"`) || /(?:^|[\s(])\*(?:[\s)]|$)/.test(list));
    checks.push(check(`${feature} Permissions-Policy`, permitted, permitted
      ? `Permissions-Policy does not block ${feature} for this origin.`
      : `Permissions-Policy explicitly blocks ${feature} for this origin.`));
  }
  return { checks };
}

async function appHeaders(app, fetcher) {
  let current = app;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const options = { method: "HEAD", redirect: "manual", credentials: "omit", signal: AbortSignal.timeout(10_000) };
    let response = await fetcher(current.href, options);
    if (response.status === 405 || response.status === 501) {
      await response.body?.cancel();
      response = await fetcher(current.href, { ...options, method: "GET", signal: AbortSignal.timeout(10_000) });
    }
    await response.body?.cancel();
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("App redirect has no Location header.");
      const next = new URL(location, current);
      if (next.origin !== app.origin || next.username || next.password) throw new Error("App redirects to another origin. Rerun with the final app --base-url; no cross-origin redirect was followed.");
      current = next;
      continue;
    }
    if (response.status !== 200) throw new Error(`App header request returned HTTP ${response.status}; expected 200.`);
    return { headers: response.headers, url: current.href };
  }
  throw new Error("App exceeded five redirects; check the locale/auth redirect configuration.");
}

async function relayHealth(relay, fetcher) {
  const url = new URL("/health", relay);
  url.protocol = "https:";
  const response = await fetcher(url.href, { method: "GET", redirect: "manual", credentials: "omit", signal: AbortSignal.timeout(10_000) });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`Relay health returned HTTP ${response.status}; expected 200 without a redirect.`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Relay health returned no JSON body.");
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4_096) throw new Error("Relay health body exceeds 4096 bytes.");
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("Relay health did not return valid JSON."); }
  if (body?.service !== "lecue-stt-relay" || body?.status !== "ok") throw new Error("Relay health JSON does not identify a healthy lecue-stt-relay service.");
  return { name: "Relay health", ok: true, message: "Relay /health returned HTTP 200 and the expected healthy service JSON." };
}

export async function runRecordingCheck({ baseUrl = "http://localhost:3000", relayUrl, fetcher = fetch }) {
  const app = parsedUrl(baseUrl, ["http:", "https:"]);
  const relay = parsedUrl(relayUrl, ["wss:"]);
  const checks = [];
  let finalUrl = app.href;
  const [page, health] = await Promise.allSettled([appHeaders(app, fetcher), relayHealth(relay, fetcher)]);
  if (page.status === "fulfilled") {
    finalUrl = page.value.url;
    checks.push(...inspectRecordingHeaders(page.value.headers, finalUrl, relay.href).checks);
  } else checks.push({ name: "App response", ok: false, message: page.reason instanceof Error ? page.reason.message : "App request failed." });
  if (health.status === "fulfilled") checks.push(health.value);
  else checks.push({ name: "Relay health", ok: false, message: health.reason instanceof Error ? health.reason.message : "Relay health request failed." });
  return { ok: checks.every(check => check.ok), checks, appUrl: finalUrl };
}

async function main() {
  const options = { baseUrl: "http://localhost:3000" };
  const args = process.argv.slice(2);
  const flags = new Map([["--base-url", "baseUrl"], ["--relay-url", "relayUrl"]]);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help") {
      console.log("Usage: npm run check:recording -- [--base-url http://localhost:3000] [--relay-url wss://relay.example/v1/listen]\nRead-only CSP/permissions/relay-health preflight. No microphone, auth cookies, DB writes, or paid STT calls.");
      return;
    }
    const key = flags.get(args[i]);
    if (!key || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error("Use --base-url URL and/or --relay-url URL; see --help.");
    options[key] = args[++i];
  }
  if (!options.relayUrl) {
    let envText = "";
    try { envText = await readFile(new URL("../.env.local", import.meta.url), "utf8"); } catch (error) { if (error.code !== "ENOENT") throw new Error("Could not read the local relay URL configuration."); }
    options.relayUrl = process.env.STT_RELAY_URL || readRelayUrl(envText);
  }
  if (!options.relayUrl) throw new Error("STT_RELAY_URL is missing. Configure it in .env.local or pass --relay-url, then restart the dev server and reload the browser document.");
  const result = await runRecordingCheck(options);
  for (const check of result.checks) console.log(`${check.ok ? "PASS" : "FAILED"} ${check.name}: ${check.message}`);
  console.log(`${result.ok ? "PASS" : "FAILED"}: read-only recording preflight only; real voice, microphone permission, authentication, tickets, credits, and transcription were not tested.`);
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`FAILED: ${error.message}`); process.exitCode = 1; });
}
