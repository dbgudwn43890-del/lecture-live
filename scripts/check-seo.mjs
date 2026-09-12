// Anonymous HTTP acceptance check: node scripts/check-seo.mjs https://www.lecue.app
import assert from 'node:assert/strict';
const base = process.argv[2] || 'http://localhost:3000';
const origin = 'https://www.lecue.app';
async function page(path, headers = {}) {
  const response = await fetch(new URL(path, base), { headers, redirect: 'manual' });
  assert.equal(response.status, 200, `${path}: ${response.status} ${response.headers.get('location') || ''}`);
  return { response, html: await response.text() };
}
for (const [path, lang, cookie] of [
  ['/ko', 'ko', 'en'], ['/en', 'en', 'ko'],
  ['/privacy', 'ko', 'en'], ['/en/privacy', 'en', 'ko'],
  ['/billing?plan=term', 'ko', 'en'],
]) {
  const { html } = await page(path, { cookie: `site-locale-choice=${cookie}`, 'accept-language': cookie });
  assert.ok(html.includes(`<html lang="${lang}"`), `${path}: wrong document language`);
  assert.ok(html.includes(`rel="canonical" href="${origin}${path.split('?')[0]}"`), `${path}: missing canonical`);
  assert.match(html, /hrefLang="ko"/);
  assert.match(html, /hrefLang="en"/);
  console.log(`PASS public ${path}`);
}
for (const lang of ['ko', 'en']) {
  const { html } = await page('/', { cookie: `site-locale-choice=${lang}` });
  assert.ok(html.includes(`rel="canonical" href="${origin}/${lang}"`));
}
for (const path of ['/월', '/4개월', '/month']) {
  const response = await fetch(new URL(path, base), { redirect: 'manual' });
  assert.equal(response.status, 308, `${path}: expected a permanent redirect`);
  assert.equal(new URL(response.headers.get('location'), base).pathname, '/billing');
  console.log(`PASS retired pricing link ${path}`);
}
const login = await page('/en/login?next=/en/classroom', { cookie: 'site-locale-choice=en' });
assert.match(login.html, /name="robots" content="noindex, follow"/);
const robots = await page('/robots.txt');
assert.match(robots.response.headers.get('content-type'), /text\/plain/);
assert.ok(robots.html.includes(`Sitemap: ${origin}/sitemap.xml`));
const sitemap = await page('/sitemap.xml');
assert.match(sitemap.response.headers.get('content-type'), /xml/);
assert.ok(sitemap.html.includes(`${origin}/ko`));
assert.ok(!sitemap.html.includes('/login'));
const font = login.html.match(/(?:href|src)="([^\"]*\/_next\/static\/[^\"]+)"/);
assert.ok(font, 'Expected a static asset');
const fontResponse = await fetch(new URL(font[1], base), { method: 'HEAD' });
assert.equal(fontResponse.status, 200);
assert.equal(fontResponse.headers.get('x-robots-tag'), 'noindex');
console.log('PASS adaptive home, login noindex, robots.txt, sitemap.xml, static asset noindex');
