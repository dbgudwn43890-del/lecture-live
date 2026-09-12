// Run with the authenticated Vercel CLI and a temporary Workers deployment token.
// No provider keys or database credentials are uploaded to this Worker.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const parse = file => Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter(l => /^[A-Z_]+=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0,i), l.slice(i+1).trim().replace(/^['"]|['"]$/g,'')]; }));
const env = parse(resolve(root, '.env.local'));
const setup = parse(resolve(root, '.env.security-setup.local'));
const account = setup.CLOUDFLARE_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID;
const token = setup.CLOUDFLARE_API_TOKEN;
if (!/^[a-f0-9]{32}$/.test(account ?? '') || !token) throw new Error('Workers deployment credential is not configured.');
async function cloudflare(path, method = 'GET', body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body instanceof FormData || body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }), signal: AbortSignal.timeout(60000), redirect: 'error',
  });
  const result = await response.json();
  if (!response.ok || !result.success) {
    const detail = (result.errors ?? []).map(e => `${e.code}: ${String(e.message).replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]')}`).join('; ');
    throw new Error(`Cloudflare ${method} failed (${response.status}); ${detail}`);
  }
  return result.result;
}
const subdomain = (await cloudflare(`accounts/${account}/workers/subdomain`)).subdomain;
if (!/^[a-z0-9-]+$/.test(subdomain ?? '')) throw new Error('Configure a workers.dev subdomain in the Cloudflare dashboard first.');
const secretsFile = resolve(root, '.env.stt-relay.local');
if (!existsSync(secretsFile)) writeFileSync(secretsFile, `STT_RELAY_SECRET=${randomBytes(32).toString('hex')}\nCRON_SECRET=${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
const stored = parse(secretsFile);
const secrets = { STT_RELAY_SECRET: stored.STT_RELAY_SECRET, CRON_SECRET: stored.CRON_SECRET };
if (secrets.STT_RELAY_SECRET?.length !== 64 || secrets.CRON_SECRET?.length !== 64) throw new Error('Invalid relay secret configuration');
const name = 'lecue-stt-relay';
const form = new FormData();
form.append('metadata', new Blob([JSON.stringify({ main_module: 'index.mjs', compatibility_date: '2026-08-06',
  bindings: [{ name: 'LECUE_ORIGIN', type: 'plain_text', text: 'https://www.lecue.app' }, ...Object.entries(secrets).map(([name,text]) => ({ name, type: 'secret_text', text }))],
  observability: { enabled: false },
  // A three-hour lecture needs ~1,260 control requests; Free's 50/request cap is insufficient.
  limits: { cpu_ms: 30000, subrequests: 3000 },
})], { type: 'application/json' }));
form.append('index.mjs', new Blob([readFileSync(resolve(import.meta.dirname, 'index.mjs'))], { type: 'application/javascript+module' }), 'index.mjs');
await cloudflare(`accounts/${account}/workers/scripts/${name}`, 'PUT', form);
await cloudflare(`accounts/${account}/workers/scripts/${name}/subdomain`, 'POST', { enabled: true, previews_enabled: false });
const relayUrl = `wss://${name}.${subdomain}.workers.dev/v1/listen`;
// CLI uses its existing keychain login. Sensitive request/response bodies stay in memory.
const values = { ...secrets, STT_RELAY_URL: relayUrl };
const project = JSON.parse(readFileSync(resolve(root, '.vercel/project.json'), 'utf8')).projectId;
for (const [key, value] of Object.entries(values)) {
  try {
    execFileSync('vercel', ['api', `/v10/projects/${project}/env?upsert=true`, '--method', 'POST', '--input', '-', '--silent'], {
      input: JSON.stringify({ key, value, type: key === 'STT_RELAY_URL' ? 'plain' : 'encrypted', target: ['production'] }), stdio: ['pipe','pipe','pipe'], timeout: 60000,
    });
  } catch { throw new Error(`Could not configure Vercel variable ${key}`); }
}
// Enable the hourly cleanup only after the matching app/DB release is promoted.
if (process.argv.includes('--enable-cleanup')) await cloudflare(`accounts/${account}/workers/scripts/${name}/schedules`, 'PUT', [{ cron: '17 * * * *' }]);
writeFileSync(resolve(root, '.env.stt-relay.local'), Object.entries(values).map(([k,v])=>`${k}=${v}`).join('\n')+'\n', { mode: 0o600 });
console.log(`Relay deployed: ${relayUrl}. Production environment configured. Cleanup ${process.argv.includes('--enable-cleanup') ? 'enabled' : 'awaits app promotion'}.`);
