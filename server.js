// Yoroxy LowBand — 統合版 (右上メニュー / 広告ブロック / Skyrox 完全統合)
//   軽量モード: サーバー側で文字だけに軽量化 / 通常モード: Ultraviolet + Bare / Skyrox モード: ./skyrox/ (naoki747/skyrox_plus をそのまま同梱)
// 必須: npm install  (@tomphttp/bare-server-node express compression unblocker)
// 画面ファイルは ./public/ に置いてあり、起動時に Brotli で圧縮してメモリに載せます
const http = require('http');
const zlib = require('zlib');
const dns = require('dns').promises;
const net = require('net');
const crypto = require('crypto');
const { createBareServer } = require('@tomphttp/bare-server-node');

const PORT = process.env.PORT || 8080;
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE === '1';   // テスト用。本番では設定しない
const MAX_BYTES = 10 * 1024 * 1024, TTL = 30 * 60 * 1000, CACHE_MAX = 60 * 1024 * 1024;
const MIME = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json' };
const fs = require('fs');
const path = require('path');

// ---------- 画面ファイル (./public/) を起動時に Brotli 圧縮してメモリへ ----------
const PUBLIC = path.join(__dirname, 'public');
const store = new Map();
const addAsset = (r, raw) => { raw = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8'); store.set(r, zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: raw.length > 200000 ? 6 : 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } })); };
// 画面ファイルはこのファイルの末尾に埋め込み済み。./public/ には /uv/ (Ultraviolet本体) だけを置く。
// 埋め込み分を ./public/ のファイルで上書きして試したいときは USE_PUBLIC=1 を付けて起動する
const EMBED = embeddedAssets();
for (const k of Object.keys(EMBED)) addAsset(k, EMBED[k]);
(function load(dir, rel) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name), r = rel + '/' + e.name;
    if (e.isDirectory()) { load(f, r); continue; }
    if (EMBED[r] !== undefined && process.env.USE_PUBLIC !== '1') continue;
    addAsset(r, fs.readFileSync(f));
  }
})(PUBLIC, '');
const bare = createBareServer('/bare/');


// ---------- 広告・計測ブロック (Cookie lb_ads=0 のときだけ無効。設定画面/右上メニューで切替) ----------
const AD_HOSTS = new Set(('doubleclick.net googlesyndication.com googleadservices.com googletagservices.com googletagmanager.com google-analytics.com adservice.google.com 2mdn.net ' +
  'amazon-adsystem.com adnxs.com taboola.com outbrain.com criteo.com criteo.net rubiconproject.com pubmatic.com openx.net adsrvr.org scorecardresearch.com moatads.com ' +
  'adform.net smartadserver.com advertising.com adsafeprotected.com doubleverify.com quantserve.com 33across.com sharethrough.com lijit.com teads.tv adcolony.com media.net ' +
  'casalemedia.com bidswitch.net mgid.com revcontent.com zedo.com hotjar.com yieldmo.com ads.yahoo.com analytics.yahoo.com yads.c.yimg.jp ' +
  'i-mobile.co.jp microad.jp fout.jp logly.co.jp impact-ad.jp adingo.jp popin.cc geniee.jp ad-stir.com nend.net adlantis.jp fluct.jp socdm.com ladsp.com zucks.net amoad.com gssprt.jp').split(' '));
function isAdHost(h) {
  h = String(h || '').toLowerCase();
  for (;;) { if (AD_HOSTS.has(h)) return true; const i = h.indexOf('.'); if (i < 0) return false; h = h.slice(i + 1); }
}
const adsOn = req => !/(^|;\s*)lb_ads=0/.test(req.headers.cookie || '');

// ---------- 軽量化 ----------
const esc = s => String(s).replace(/&(?!#?\w+;)/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const getAttr = (attrs, name) => {
  const m = new RegExp('\\s' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(' ' + attrs);
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
};
const DROP = /\s(?:on\w+|style|class|data-[\w:.-]+|aria-[\w-]+|role|tabindex|srcset|sizes|loading|decoding|fetchpriority|integrity|nonce|crossorigin|referrerpolicy|target|rel|hreflang|autocomplete|autofocus|width|height|bgcolor|background|align|valign)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

function liteHtml(html, baseUrl, origBytes, ads) {
  const bm = /<base\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(html);
  let base = baseUrl; if (bm) { try { base = new URL(bm[1] ?? bm[2], baseUrl).href; } catch {} }
  const abs = u => { try { return new URL(u.trim().replace(/&amp;/g, '&'), base).href; } catch { return null; } };
  const L = u => '/lite?url=' + encodeURIComponent(u);
  const tm = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = (tm ? tm[1] : '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const bd = /<body\b[^>]*>([\s\S]*)/i.exec(html);
  let b = bd ? bd[1] : html.replace(/<head\b[\s\S]*?<\/head>/i, '');
  b = b.replace(/<\/body>[\s\S]*$/i, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|svg|canvas|video|audio|iframe|object|embed|template|head|map)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(noscript|picture|source|track|use|path|link|meta|base|wbr)\b[^>]*>/gi, '');
  if (ads) b = b.replace(/<ins\b[^>]*adsbygoogle[\s\S]*?<\/ins\s*>/gi, '');
  b = b.replace(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi, (m, tag, attrs) => {
    tag = tag.toLowerCase();
    if (tag === 'a') {
      const id = getAttr(attrs, 'id') || getAttr(attrs, 'name'), idp = id ? ' id="' + esc(id) + '"' : '';
      let h = getAttr(attrs, 'href'); if (h == null) return '<a' + idp + '>';
      h = h.trim();
      if (h.startsWith('#') || /^(mailto:|tel:)/i.test(h)) return '<a' + idp + ' href="' + esc(h) + '">';
      const u = /^javascript:/i.test(h) ? null : abs(h);
      return u ? '<a' + idp + ' href="' + esc(L(u)) + '">' : '<a' + idp + '>';
    }
    if (tag === 'img') {
      const alt = (getAttr(attrs, 'alt') || '').trim();
      let s = getAttr(attrs, 'src') || getAttr(attrs, 'data-src') || getAttr(attrs, 'data-original') || getAttr(attrs, 'data-lazy-src');
      if (!s) { const ss = getAttr(attrs, 'srcset'); if (ss) s = ss.trim().split(/\s+/)[0]; }
      const u = s && !/^data:/i.test(s) ? abs(s) : null;
      if (ads && u && (isAdHost(new URL(u).hostname) || (/^[01]$/.test(getAttr(attrs, 'width') || '') && /^[01]$/.test(getAttr(attrs, 'height') || '')))) return '';
      if (!u) return alt ? '<span>' + esc(alt) + '</span>' : '';
      return '<span class="lb-img" data-s="' + esc(L(u)) + '" data-a="' + esc(alt) + '">🖼 ' + (alt ? esc(alt.slice(0, 60)) : '画像') + '(タップで表示)</span>';
    }
    if (tag === 'form') {
      const method = (getAttr(attrs, 'method') || 'get').toLowerCase();
      if (method === 'post') return '<form action="#" data-p="1">';
      const act = getAttr(attrs, 'action'), u = (act ? abs(act) : null) || baseUrl;
      return '<form action="/lite" method="get"><input type="hidden" name="__u" value="' + esc(u) + '">';
    }
    return '<' + tag + attrs.replace(DROP, '') + '>';
  });
  return '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + title + '</title><meta name="lite-info" content="orig=' + origBytes + '"><link rel="stylesheet" href="/lite.css"></head><body>' +
    b + '<script src="/lite.js" defer></script></body></html>';
}

function decode(buf, type) {
  let cs = (/charset=["']?([\w-]+)/i.exec(type) || [])[1];
  if (!cs) cs = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 3000).toString('latin1')) || [])[1];
  try { return new TextDecoder(cs || 'utf-8').decode(buf); } catch { return buf.toString('utf8'); }
}
const brAsync = (s, q = 5) => new Promise((ok, ng) => zlib.brotliCompress(Buffer.isBuffer(s) ? s : Buffer.from(s), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: q } }, (e, r) => (e ? ng(e) : ok(r))));   // 非同期: 他の利用者を待たせない

async function buildEntry(p, ads) {
  const t = p.type.toLowerCase();
  if (/text\/html|application\/xhtml/.test(t)) {
    const out = liteHtml(decode(p.buf, p.type), p.url.href, p.buf.length, ads);
    return { status: p.status, type: 'text/html; charset=utf-8', body: await brAsync(out, 5), enc: 'br', time: Date.now(),
      csp: "default-src 'none'; img-src 'self' data:; style-src 'self'; script-src 'self'; form-action 'self'; base-uri 'none'" };
  }
  return { status: p.status, type: p.type, body: p.buf, enc: null, csp: 'sandbox', time: Date.now() };   // 画像など: そのまま
}

// ---------- 安全な取得 (内部ネットワーク遮断・リダイレクトごとに検査) ----------
function isPrivateIp(ip) {
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const l = ip.toLowerCase();
  return l === '::1' || l === '::' || /^f[cd]/.test(l) || /^fe[89ab]/.test(l);
}
async function fetchPage(start, req) {
  let url = new URL(start);
  for (let hop = 0; hop < 6; hop++) {
    if (!/^https?:$/.test(url.protocol)) throw new Error('http/https のURLのみ開けます');
    if (adsOn(req) && isAdHost(url.hostname)) throw new Error('広告・計測用のアドレスのためブロックしました');
    if (!ALLOW_PRIVATE && (await dns.lookup(url.hostname, { all: true })).some(a => isPrivateIp(a.address))) throw new Error('このアドレスは開けません');
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 25000);
    try {
      const r = await fetch(url, { redirect: 'manual', signal: ctl.signal, headers: {
        'user-agent': req.headers['user-agent'] || 'Mozilla/5.0', 'accept': req.headers.accept || '*/*',
        'accept-language': req.headers['accept-language'] || 'ja,en;q=0.8' } });
      const loc = r.headers.get('location');
      if (r.status >= 300 && r.status < 400 && loc) { url = new URL(loc, url); continue; }
      if ((+r.headers.get('content-length') || 0) > MAX_BYTES) throw new Error('サイズが大きすぎます');
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_BYTES) throw new Error('サイズが大きすぎます');
      return { status: r.status, type: r.headers.get('content-type') || 'application/octet-stream', buf, url };
    } finally { clearTimeout(timer); }
  }
  throw new Error('リダイレクトが多すぎます');
}

// ---------- キャッシュ・制限 ----------
const cache = new Map(); let cacheBytes = 0;
function cacheSet(k, e) {
  const old = cache.get(k); if (old) { cacheBytes -= old.body.length; cache.delete(k); }
  cache.set(k, e); cacheBytes += e.body.length;
  while (cacheBytes > CACHE_MAX || cache.size > 300) { const [kk, ee] = cache.entries().next().value; cache.delete(kk); cacheBytes -= ee.body.length; }
}
const hits = new Map(); setInterval(() => hits.clear(), 60000).unref();
function limited(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const n = (hits.get(ip) || 0) + 1; hits.set(ip, n); return n > 240;
}

function sendLite(req, res, e, tag) {
  const h = { 'content-type': e.type, 'content-security-policy': e.csp, 'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer', 'cache-control': 'no-cache', 'x-cache': tag, 'vary': 'accept-encoding' };
  if (e.enc === 'br') {
    if (/\bbr\b/.test(req.headers['accept-encoding'] || '')) { h['content-encoding'] = 'br'; res.writeHead(e.status, h); return res.end(e.body); }
    res.writeHead(e.status, h); return res.end(zlib.brotliDecompressSync(e.body));
  }
  res.writeHead(e.status, h); res.end(e.body);
}
const errPage = m => '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font:16px/1.7 system-ui;padding:16px"><p>取得できませんでした。</p><p style="opacity:.7">' + esc(m) + '</p><p>上の「通常で開く」で開ける場合があります。</p></body>';

async function handleLite(req, res, u) {
  const q = u.searchParams;
  if (limited(req)) { res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('リクエストが多すぎます。少し待ってください。'); }
  if (q.has('__u')) {   // 軽量ページ内のGETフォーム (検索など)
    try {
      const t = new URL(q.get('__u')), keys = new Set();
      for (const k of q.keys()) if (k !== '__u' && k !== 'fresh') keys.add(k);
      for (const k of keys) { t.searchParams.delete(k); for (const v of q.getAll(k)) t.searchParams.append(k, v); }
      res.writeHead(302, { location: '/lite?url=' + encodeURIComponent(t.href) }); return res.end();
    } catch { res.writeHead(400); return res.end('bad form'); }
  }
  const target = q.get('url');
  if (!target) { res.writeHead(400); return res.end('url required'); }
  const ads = adsOn(req), ck = ads ? target : '\0' + target;   // 広告ブロックON/OFFで保存を分ける
  const c = cache.get(ck);
  if (c && q.get('fresh') !== '1' && Date.now() - c.time < TTL) return sendLite(req, res, c, 'HIT');
  try {
    const e = await buildEntry(await fetchPage(target, req), ads);
    if (e.status < 500) cacheSet(ck, e);
    sendLite(req, res, e, 'MISS');
  } catch (err) {
    if (c) return sendLite(req, res, c, 'STALE');
    res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
    res.end(errPage(err.message));
  }
}


// ---------- Skyrox モード: ./skyrox/ (あなたの skyrox_plus そのもの) を組み込み ----------
// skyrox/server.js は require されると単独で待ち受けず app を返します。ここでは前段に
//  低速回線の画像省略 / 広告ブロック / 内部ネットワーク遮断 / 回数制限 を付けてから渡します。
// ---------- 同梱モジュール (Skyrox 本体と sites/*.js を、このファイルの末尾に埋め込んだもの) ----------
const _vmods = Object.create(null); let _vdefs = null;
function vrequire(name) {
  if (_vmods[name]) return _vmods[name].exports;
  const fn = (_vdefs || (_vdefs = virtualModules()))[name];
  if (!fn) return require(name);   // express / unblocker など外部パッケージ
  const m = { exports: {} }; _vmods[name] = m;
  fn(m, m.exports, vrequire, path.join(__dirname, 'skyrox'));
  return m.exports;
}
const SKY = (() => { try { return vrequire('./skyrox/server.js'); } catch (e) { console.log('Skyrox モードは無効です(' + e.message.split('\n')[0] + ')'); return null; } })();
const SKY_PREFIX = '/proxy/', SKY_CTX = '__proxy_origin', POKI_PREFIX = '/jp';
const isPoki = p => p === POKI_PREFIX || p.startsWith(POKI_PREFIX + '/');
const parseCookies = hd => { const r = Object.create(null); for (const p of String(hd || '').split(';')) { const i = p.indexOf('='); if (i > 0) r[p.slice(0, i).trim()] = p.slice(i + 1).trim(); } return r; };
const GIF1 = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const skyDns = new Map();
async function allowTarget(raw) {
  try {
    const u = new URL(String(raw).replace(/^(\w+):\/(?!\/)/i, '$1://'));
    if (!/^(https?|wss?):$/.test(u.protocol)) return false;
    if (ALLOW_PRIVATE) return true;
    const c = skyDns.get(u.hostname); if (c && Date.now() - c.t < 60000) return c.ok;
    const ok = !(await dns.lookup(u.hostname, { all: true })).some(a => isPrivateIp(a.address));
    skyDns.set(u.hostname, { ok, t: Date.now() }); if (skyDns.size > 500) skyDns.clear();
    return ok;
  } catch { return false; }
}
// このリクエストが最終的に取りに行く先 (Skyrox が URL / Referer / Cookie から決めるもの全部)
function skyTargets(req) {
  const t = [], p = req.url.split('?')[0];
  if (req.url.startsWith(SKY_PREFIX)) { if (!req.url.startsWith(SKY_PREFIX + 'client/')) t.push(req.url.slice(SKY_PREFIX.length)); return t; }
  if (isPoki(p)) return t;                                   // poki.com 固定
  const ref = req.headers.referer;
  if (ref) { try { const r = new URL(ref); const i = r.pathname.indexOf(SKY_PREFIX); if (r.host === req.headers.host && i === 0) t.push(r.pathname.slice(SKY_PREFIX.length) + r.search); } catch {} return t; }
  const c = parseCookies(req.headers.cookie)[SKY_CTX];
  if (c && c.length < 2048) { try { t.push(Buffer.from(c, 'base64url').toString('utf8')); } catch {} }
  return t;
}
const skyHits = new Map(); setInterval(() => skyHits.clear(), 60000).unref();
async function skyAllowed(req, res) {   // false を返したら応答済み
  const lb = req.headers.cookie || '';
  if (res && /(^|;\s*)lb_skip=1/.test(lb)) {   // 低速回線: 画像・動画は取得しない
    const d = req.headers['sec-fetch-dest'];
    if (d === 'image') { res.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'private, max-age=600' }); res.end(GIF1); return false; }
    if (d === 'video' || d === 'audio') { res.statusCode = 204; res.end(); return false; }
  }
  const targets = skyTargets(req);
  if (req.url.startsWith(SKY_PREFIX) && res) {
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const n = (skyHits.get(ip) || 0) + 1; skyHits.set(ip, n);
    if (n > 3000) { res.statusCode = 429; res.end('Too many requests'); return false; }
    if (adsOn(req) && targets[0]) { try { if (isAdHost(new URL(targets[0].replace(/^(\w+):\/(?!\/)/i, '$1://')).hostname)) { res.statusCode = 204; res.end(); return false; } } catch {} }
  }
  for (const t of targets) if (!(await allowTarget(t))) {
    if (res) { res.statusCode = 403; res.setHeader('content-type', 'text/plain; charset=utf-8'); res.end('このアドレスは開けません'); }
    return false;
  }
  return true;
}
function wantsSkyrox(req) {
  if (!SKY) return false;
  const p = req.url.split('?')[0];
  if (p.startsWith(SKY_PREFIX) || isPoki(p)) return true;
  const ref = req.headers.referer;
  if (ref) { try { const r = new URL(ref); if (r.host === req.headers.host && (r.pathname.startsWith(SKY_PREFIX) || isPoki(r.pathname)) && p !== '/') return true; } catch {} return false; }
  // Referer が無い遷移: 直前に開いたサイトの記憶(Cookie)があり、このサーバー自身のファイルでなければ元サイトへ
  if (new RegExp('(^|;\\s*)' + SKY_CTX + '=').test(req.headers.cookie || '') && p !== '/' && !store.has(p) && !['/lite', '/__ping', '/__modes', '/healthz'].includes(p)) return true;
  return false;
}

// ---------- 静的配信 + ルーティング ----------
function serve(req, res) {
  const u = new URL(req.url, 'http://x');
  let p; try { p = decodeURIComponent(u.pathname); } catch { res.writeHead(400); return res.end(); }
  if (p === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (p === '/__ping') {   // 回線速度の測定用
    const n = Math.min(+u.searchParams.get('n') || 8000, 32000);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' }); return res.end(crypto.randomBytes(n));
  }
  if (p === '/__modes') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify({ skyrox: !!SKY })); }
  if (p === '/lite') return handleLite(req, res, u);
  if (p === '/') p = '/index.html';
  const packed = store.get(p);
  if (!packed) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
  const h = { 'content-type': MIME[p.split('.').pop()] || 'application/octet-stream', vary: 'accept-encoding',
    'cache-control': /^\/(sw|uv-sw)\.js$/.test(p) ? 'no-cache' : (/^\/uv\/uv\.(bundle|client)\.js$/.test(p) ? 'public, max-age=604800' : 'public, max-age=3600') };
  if (/\bbr\b/.test(req.headers['accept-encoding'] || '')) { h['content-encoding'] = 'br'; h['content-length'] = packed.length; res.writeHead(200, h); res.end(packed); }
  else { const raw = zlib.brotliDecompressSync(packed); h['content-length'] = raw.length; res.writeHead(200, h); res.end(raw); }
}
const server = http.createServer((req, res) => {
  if (bare.shouldRoute(req)) {   // 通常(UV)モード: 広告・計測ドメインへの中継を断る
    if (adsOn(req)) {
      let h = req.headers['x-bare-host']; if (!h) { try { h = new URL(req.headers['x-bare-url']).hostname; } catch {} }
      if (h && isAdHost(h)) { res.writeHead(403, { 'content-type': 'application/json' }); return res.end('{"code":"ADBLOCK","id":"error.AdBlock","message":"blocked"}'); }
    }
    return bare.routeRequest(req, res);
  }
  if (wantsSkyrox(req)) return skyAllowed(req, res).then(ok => { if (ok) SKY.server.emit('request', req, res); }).catch(() => { try { res.statusCode = 502; res.end(); } catch {} });
  serve(req, res);
});
server.keepAliveTimeout = 65000; server.headersTimeout = 66000;   // 低速回線で接続を張り直さない
server.on('upgrade', (req, socket, head) => {
  if (bare.shouldRoute(req)) return bare.routeUpgrade(req, socket, head);
  if (wantsSkyrox(req)) return skyAllowed(req, null).then(ok => { if (ok) SKY.server.emit('upgrade', req, socket, head); else socket.end(); }).catch(() => socket.end());
  socket.end();
});
server.listen(PORT, '0.0.0.0', () => console.log('Yoroxy LowBand: http://localhost:' + PORT));

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { console.log(sig + ' — 終了します'); server.close(); try { SKY && (SKY.httpAgent.destroy(), SKY.httpsAgent.destroy()); } catch {} setTimeout(() => process.exit(0), 3000).unref(); });

// ================= 埋め込み画面ファイル =================
function embeddedAssets() {
  return {
    "/index.html": "<!doctype html> <html lang=\"ja\"><head><meta charset=\"utf-8\"> <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"> <title>Skyrox２</title> <style>:root{color-scheme:light dark;--bg:#e6f6ff;--surface:#ffffff;--line:#bfe4f6;--text:#0b2a3d;--text-dim:#5b7f95;--accent:#2fb4ea;--accent-strong:#0f95cf;--accent-dim:rgba(47,180,234,.18);--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,\"Liberation Mono\",monospace;\n--color-bg-base:var(--bg);--color-bg-elevated:var(--surface);--color-text-primary:var(--text);--color-text-secondary:var(--text-dim);--color-accent:var(--accent);--color-accent-strong:var(--accent-strong)}\n@media (prefers-color-scheme:dark){:root{--bg:#06202e;--surface:#0b2e41;--line:#12445d;--text:#e8f8ff;--text-dim:#82aabf;--accent:#4cc9f5;--accent-strong:#7adbfa;--accent-dim:rgba(76,201,245,.18)}}\n:root[data-theme=\"light\"]{color-scheme:light;--bg:#e6f6ff;--surface:#fff;--line:#bfe4f6;--text:#0b2a3d;--text-dim:#5b7f95;--accent:#2fb4ea;--accent-strong:#0f95cf;--accent-dim:rgba(47,180,234,.18)}\n:root[data-theme=\"dark\"]{color-scheme:dark;--bg:#06202e;--surface:#0b2e41;--line:#12445d;--text:#e8f8ff;--text-dim:#82aabf;--accent:#4cc9f5;--accent-strong:#7adbfa;--accent-dim:rgba(76,201,245,.18)}\n*{box-sizing:border-box}html,body{margin:0;min-height:100%}\nbody{background:var(--bg);background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);background-size:42px 42px;background-position:center;color:var(--text);font-family:system-ui,\"Hiragino Sans\",\"Noto Sans JP\",sans-serif;display:flex;align-items:center;justify-content:center;min-height:100dvh;padding:24px}\n#background{display:none}\n.wrap{width:100%;max-width:520px}\n.eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.22em;color:var(--text-dim);text-transform:uppercase;margin-bottom:18px;display:flex;align-items:center;gap:10px}\n.eyebrow::before{content:\"\";width:6px;height:6px;background:var(--accent);border-radius:1px}\n.eyebrow .link-btn{margin-left:auto;font-family:var(--mono);letter-spacing:.08em}\nh1{font-size:1.9rem;line-height:1.4;font-weight:700;margin:0 0 8px;letter-spacing:-.01em}\np.desc{color:var(--text-dim);font-size:.92rem;line-height:1.7;margin:0 0 30px}\n.route{display:flex;align-items:center;margin-bottom:30px}\n.node{display:flex;flex-direction:column;align-items:center;gap:8px;flex-shrink:0}\n.node-dot{width:9px;height:9px;border:1.5px solid var(--text-dim);border-radius:50%;background:var(--bg)}\n.node.mid .node-dot{border-color:var(--accent);background:var(--accent);box-shadow:0 0 0 4px var(--accent-dim)}\n.node-label{font-family:var(--mono);font-size:9.5px;letter-spacing:.14em;color:var(--text-dim)}\n.node.mid .node-label{color:var(--accent-strong)}\n.track{flex:1;height:1px;position:relative;background-image:repeating-linear-gradient(90deg,var(--text-dim) 0 4px,transparent 4px 8px);opacity:.9;margin:0 6px;top:-8px}\n.track .pulse{position:absolute;top:50%;left:0;width:4px;height:4px;background:var(--accent);border-radius:50%;transform:translate(-50%,-50%);animation:travel 2.6s ease-in-out infinite;box-shadow:0 0 6px var(--accent)}\n.track.b .pulse{animation-delay:1.3s}\n@keyframes travel{0%{left:0;opacity:0}12%{opacity:1}88%{opacity:1}100%{left:100%;opacity:0}}\n@media (prefers-reduced-motion:reduce){.pulse{animation:none!important}}\nform.searchbar{display:flex;align-items:stretch;border:1px solid var(--line);background:var(--surface);border-radius:3px;overflow:hidden;padding:0;gap:0;transition:border-color .15s,box-shadow .15s}\nform.searchbar:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-dim)}\n.prompt{display:flex;align-items:center;padding:0 4px 0 16px;font-family:var(--mono);font-size:.95rem;color:var(--accent-strong);user-select:none}\n.search-input{flex:1;padding:15px 6px;border:none;background:transparent;outline:none;color:var(--text);font-family:var(--mono);font-size:.9rem;min-width:0}\n.search-input::placeholder{color:var(--text-dim);opacity:.7}\n.go{padding:0 22px;border:none;border-left:1px solid var(--line);background:var(--surface);color:var(--text-dim);font-family:var(--mono);font-size:.95rem;cursor:pointer;transition:color .15s,background .15s}\n.go:hover{color:#fff;background:var(--accent)}\n.panel{margin-top:14px;display:flex;flex-direction:column;gap:10px}\n.item,.chip{background:var(--accent-dim)}\n.list{border:0}\n.note{margin-top:14px;font-size:11.5px;line-height:1.7;color:var(--text-dim)}\n</style><style>.col{display:flex;flex-direction:column;gap:8px;width:100%}.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:12px;color:var(--color-text-secondary)}.chip{padding:3px 10px;border-radius:999px;background:color-mix(in srgb,var(--color-accent) 12%,transparent);font-size:12px}.link-btn{border:none;background:none;color:var(--color-accent-strong);cursor:pointer;font-size:12px;padding:0}select{padding:5px 8px;border-radius:8px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;font-size:13px}.tabs{display:flex;gap:6px}.tab{border:none;background:transparent;color:inherit;opacity:.6;padding:6px 10px;border-radius:8px;cursor:pointer;font-size:13px}.tab.on{opacity:1;background:color-mix(in srgb,var(--color-accent) 14%,transparent);font-weight:600}.list{display:flex;flex-direction:column;gap:6px;max-height:42vh;overflow:auto}.item{display:flex;align-items:center;gap:6px;padding:8px 10px;border-radius:10px;background:color-mix(in srgb,var(--color-accent) 7%,transparent)}.item a{flex:1;min-width:0;color:inherit;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.item a small{display:block;opacity:.6;font-size:11px;overflow:hidden;text-overflow:ellipsis}.badge{font-size:10px;padding:1px 6px;border-radius:99px;background:rgba(128,128,128,.25)}.badge.ok{background:rgba(34,160,90,.3)}.item .x{border:none;background:none;color:inherit;opacity:.5;cursor:pointer;font-size:16px}.empty{font-size:12px;opacity:.6;padding:8px}body.fr{display:flex;flex-direction:column;height:100vh;height:100dvh;margin:0}body.fr .topbar{flex-wrap:wrap;gap:6px;align-items:center}body.fr .frame-wrap{flex:1;min-height:0;height:auto!important;position:relative!important;inset:auto!important}body.fr iframe{width:100%;height:100%;border:0;background:#fff}.addr{flex:1;min-width:140px;padding:6px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:inherit;font-size:13px}.topbar .chip{background:rgba(255,255,255,.1)}#toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#222;color:#fff;padding:8px 14px;border-radius:99px;font-size:13px;opacity:0;pointer-events:none;transition:opacity .2s;z-index:9}#toast.on{opacity:.95}.keychip{border:none;cursor:pointer;color:inherit}.set-sec{display:flex;flex-direction:column;gap:8px;padding:12px 0;border-top:1px solid rgba(128,128,128,.25)}.set-sec h2{margin:0;font-size:14px}.set-sec p{margin:0;font-size:12px;opacity:.7;line-height:1.6}.set-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:13px}.txt{padding:7px 10px;border-radius:8px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;font-size:13px;min-width:0}.hk-row{display:grid;grid-template-columns:130px 1fr 96px auto;gap:6px;align-items:center}.hk-row.bad .txt,.txt.bad{border-color:#e5484d}.keybtn{padding:7px 8px;border-radius:8px;border:1px dashed rgba(128,128,128,.6);background:transparent;color:inherit;cursor:pointer;font-size:13px}.keybtn.rec{border-color:var(--color-accent);background:color-mix(in srgb,var(--color-accent) 15%,transparent)}.sbtn{padding:7px 12px;border-radius:8px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;cursor:pointer;font-size:13px}.sbtn.danger{color:#e5484d}.warn{font-size:12px;color:#e5484d}@media(max-width:560px){.hk-row{grid-template-columns:1fr 1fr}.hk-row .txt{grid-column:1/3}}</style> <style id=\"lbm-css\">.lbm{position:relative;display:inline-block;margin-left:auto}.lbm.fix{position:fixed;top:8px;right:10px;z-index:9999}.lbm .ml{display:none;position:absolute;right:0;top:100%;margin-top:4px;min-width:170px;background:#fff;color:#111;border:1px solid #8886;border-radius:10px;box-shadow:0 6px 18px #0004;padding:4px;z-index:10000}.lbm.open .ml{display:block}.lbm .ml button{display:block;width:100%;text-align:left;background:none;border:0;color:inherit;font:inherit;padding:9px 10px;border-radius:7px;cursor:pointer}.lbm .ml button:hover{background:#8882}.lbm .ml hr{border:0;border-top:1px solid #8883;margin:4px 0}@media(prefers-color-scheme:dark){.lbm .ml{background:#23272b;color:#eee}}</style></head><body> <div id=\"background\"></div>\n<div class=\"wrap\">\n<div class=\"eyebrow\">low-band relay<a class=\"link-btn\" href=\"/settings.html\">⚙ 設定</a></div>\n<h1>Yoroxy LowBand</h1>\n<p class=\"desc\">URLまたは検索したいキーワードを入力してください。</p>\n<div class=\"route\"><div class=\"node\"><span class=\"node-dot\"></span><span class=\"node-label\">YOU</span></div><div class=\"track a\"><span class=\"pulse\"></span></div><div class=\"node mid\"><span class=\"node-dot\"></span><span class=\"node-label\">RELAY</span></div><div class=\"track b\"><span class=\"pulse\"></span></div><div class=\"node\"><span class=\"node-dot\"></span><span class=\"node-label\">SITE</span></div></div>\n<form id=\"form\" class=\"searchbar\" autocomplete=\"off\"><span class=\"prompt\">›</span><input id=\"q\" class=\"search-input\" type=\"text\" inputmode=\"url\" placeholder=\"URL または検索キーワード\" autofocus><button class=\"go\" type=\"submit\">開く</button></form>\n<div class=\"panel\">\n<div class=\"row\"> <label>表示モード\n<select id=\"mode\"> <option value=\"lite\">軽量</option> <option value=\"normal\">通常(UV)</option> <option value=\"skyrox\">Skyrox</option> <option value=\"auto\">自動(回線速度で切替)</option> </select> </label> <span class=\"chip\" id=\"net\">回線: 測定中…</span> <span class=\"chip\" id=\"saved\">保存済み: 0</span> </div> <div class=\"row\" id=\"keys\" hidden></div> <div class=\"tabs\"> <button class=\"tab on\" id=\"tab-h\" type=\"button\">履歴</button> <button class=\"tab\" id=\"tab-b\" type=\"button\">★ ブックマーク</button> </div> <div class=\"list\" id=\"list\"></div> <div class=\"row\"> <button class=\"link-btn\" id=\"clear\" type=\"button\">保存したページを削除</button> <button class=\"link-btn\" id=\"resetpref\" type=\"button\">サイト別モードをリセット</button> </div>\n</div>\n<p class=\"note\">URL以外は設定した検索エンジンで検索します。右上の ☰ からモード(低速 / 高速 / Skyrox)を切り替えられます。</p>\n</div> <script>// 全ページ共通: 設定の読み書き・モード判定・ショートカットキー\nconst LS = {\nget(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v === null ? d : v; } catch { return d; } },\nset(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },\n};\nconst MODE_LABEL = { lite: '軽量', normal: '通常', skyrox: 'Skyrox' };\nconst MODE_OPTIONS = [['lite', '軽量'], ['normal', '通常(UV)'], ['skyrox', 'Skyrox']];\nconst hostOf = u => { try { return new URL(u).hostname; } catch { return ''; } };\nconst ENGINES = {\nddg:    { name: 'DuckDuckGo(おすすめ)', lite: 'https://html.duckduckgo.com/html/?q=', normal: 'https://duckduckgo.com/?q=' },\nbing:   { name: 'Bing', lite: 'https://www.bing.com/search?q=', normal: 'https://www.bing.com/search?q=' },\ngoogle: { name: 'Google', lite: 'https://www.google.com/search?q=', normal: 'https://www.google.com/search?q=' },\nyahoo:  { name: 'Yahoo! JAPAN', lite: 'https://search.yahoo.co.jp/search?p=', normal: 'https://search.yahoo.co.jp/search?p=' },\n};\n// 表示モードの決定: サイト別の設定 > 既定(自動なら回線速度で判定)\nfunction resolveMode(url) {\nconst p = LS.get('yl_pref', {})[hostOf(url)]; if (p) return p;\nconst d = LS.get('yl_default', 'lite');\nif (d === 'auto') { const k = LS.get('yl_kbps', null); return k !== null && k >= LS.get('yl_thresh', 1000) ? 'normal' : 'lite'; }\nreturn d;\n}\n// 入力 → { url, m? }  (URLならそのまま、それ以外は検索)\nfunction normalizeInput(s) {\ns = s.trim(); if (!s) return null;\nif (/^https?:\\/\\//i.test(s)) return { url: s };\nif (/^[\\w-]+(\\.[\\w-]+)+(:\\d+)?(\\/.*)?$/.test(s)) return { url: 'https://' + s };\nconst m = resolveMode(''), e = ENGINES[LS.get('yl_engine', 'ddg')] || ENGINES.ddg;\nreturn { url: (m === 'lite' ? e.lite : e.normal) + encodeURIComponent(s), m };\n}\n// ---- ショートカットキー ----\nfunction keyName(e) {\nlet k = e.key || '';\nif (k === ' ') k = 'Space';\nelse if (e.altKey && /^(Key|Digit)/.test(e.code || '')) k = e.code.slice(-1);   // Mac の Alt+文字 対策\nelse if (k.length === 1) k = k.toUpperCase();\nconst m = [];\nif (e.ctrlKey) m.push('Ctrl'); if (e.altKey) m.push('Alt'); if (e.metaKey) m.push('Meta');\nif (e.shiftKey && !(k.length === 1 && /[^A-Z0-9]/.test(k))) m.push('Shift');\nm.push(k); return m.join('+');\n}\nconst isModifierKey = e => ['Control', 'Shift', 'Alt', 'Meta', 'Process', 'Dead'].includes(e.key);\nconst isTyping = t => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));\nfunction hotkeyFor(e) {\nif (e.repeat || e.isComposing || !e.key || isModifierKey(e)) return null;\nconst name = keyName(e);\nconst hk = LS.get('yl_keys', []).find(h => h.key === name && h.url);\nif (!hk) return null;\nif (isTyping(e.target) && !/(Ctrl|Alt|Meta)\\+/.test(hk.key)) return null;   // 入力中は修飾キー付きだけ有効\nreturn hk;\n}\nfunction installHotkeys(doc, onHit) {\ndoc.addEventListener('keydown', e => {\nconst hk = hotkeyFor(e); if (!hk) return;\ne.preventDefault(); e.stopPropagation(); onHit(hk);\n}, true);\n}\n// ---- 回線速度(追加の通信なしで推定) ----\n// 読み込み済みページの転送時間から推定し、Service Worker とサーバーにも共有する\nfunction isLow() {\nconst k = LS.get('yl_kbps', null), c = navigator.connection;\nreturn !!((c && (c.saveData || c.downlink <= 0.5)) || (k !== null && k < LS.get('yl_thresh', 1000)));\n}\nasync function syncMeta() {\nconst skip = LS.get('yl_skipimg', true);\ntry { document.cookie = 'lb_skip=' + (isLow() && skip ? 1 : 0) + '; Path=/; Max-Age=86400; SameSite=Lax'; } catch {} try { document.cookie = 'lb_ads=' + (LS.get('yl_adblock', true) ? 1 : 0) + '; Path=/; Max-Age=31536000; SameSite=Lax'; } catch {}\ntry {\nconst c = await caches.open('meta-v1');\nawait c.put('/__meta', new Response(JSON.stringify({ k: LS.get('yl_kbps', null), low: LS.get('yl_thresh', 1000), skip, reval: LS.get('yl_reval', 'auto') })));\n} catch {}\n}\nfunction noteSpeed(win) {\ntry {\n// ページ全体(本体+読み込んだ部品)の転送量 ÷ 転送にかかった時間。並列読み込みでも実効速度が出る\nconst p = win.performance, nav = p.getEntriesByType('navigation')[0];\nlet bytes = 0, t0 = Infinity, t1 = 0;\nfor (const e of [nav].concat(p.getEntriesByType('resource'))) {\nif (!e || !e.transferSize || e.responseEnd <= e.responseStart) continue;      // 保存済み(0)・計測不能は除外\nbytes += e.transferSize; t0 = Math.min(t0, e.responseStart); t1 = Math.max(t1, e.responseEnd);\n}\nconst ms = t1 - t0;\nif (bytes < 8000 || ms < 80) return false;\npushSpeed(bytes * 8 / ms); return true;\n} catch { return false; }\n}\n// 直近6回の中央値を採用(1回だけ極端な値が出ても判定が揺れない)\nfunction pushSpeed(k) {\nconst h = LS.get('yl_ks', []).concat(Math.round(k)).slice(-6), s = h.slice().sort((a, b) => a - b);\nLS.set('yl_ks', h); LS.set('yl_kt', Date.now());\nLS.set('yl_kbps', s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2));\nsyncMeta();\n}\n// 実測が無い/古いときだけ、小さなデータ(約6KB)で測る。往復遅延を差し引く\nasync function probeSpeed() {\nif (!navigator.onLine || Date.now() - LS.get('yl_kt', 0) < 600000) return;\ntry {\nconst t = async n => { const a = performance.now(); const r = await fetch('/__ping?n=' + n + '&r=' + Math.random(), { cache: 'no-store' }); await r.arrayBuffer(); return performance.now() - a; };\nconst rtt = await t(1), ms = await t(6000);\nif (ms - rtt > 20) pushSpeed(6000 * 8 / (ms - rtt)); else pushSpeed(20000);\n} catch {}\n}\nfunction speedLabel() {\nconst k = LS.get('yl_kbps', null), c = navigator.connection;\nif (!navigator.onLine) return 'オフライン';\nif (k === null) return c && c.downlink ? '約 ' + c.downlink + ' Mbps' : '測定中…';\nreturn '約 ' + (k >= 1000 ? (k / 1000).toFixed(1) + ' Mbps' : Math.round(k) + ' kbps');\n}\n</script><script>const $ = id => document.getElementById(id);\nlet tab = 'h';\nfunction openUrl(url, m) { location.href = '/frame.html?u=' + encodeURIComponent(url) + '&m=' + (m || resolveMode(url)); }\nconst hkOpen = hk => openUrl(hk.url, hk.mode && hk.mode !== 'default' ? hk.mode : undefined);\nfunction renderKeys() {\nconst box = $('keys'); box.textContent = '';\nconst ks = LS.get('yl_keys', []).filter(h => h.key && h.url);\nbox.hidden = !ks.length; if (!ks.length) return;\nconst lb = document.createElement('span'); lb.textContent = 'ショートカット:'; box.append(lb);\nks.forEach(h => { const b = document.createElement('button'); b.type = 'button'; b.className = 'chip keychip'; b.textContent = h.key + ' → ' + (h.label || hostOf(h.url)); b.onclick = () => hkOpen(h); box.append(b); });\n}\nasync function render() {\ntry { $('saved').textContent = '保存済み: ' + (await (await caches.open('lite-v1')).keys()).length; } catch {}\nconst list = $('list'); list.textContent = '';\nconst items = tab === 'h' ? LS.get('yl_hist', []) : LS.get('yl_bm', []);\nif (!items.length) { const d = document.createElement('div'); d.className = 'empty'; d.textContent = tab === 'h' ? 'まだ履歴はありません' : '★ ボタンで追加できます'; list.append(d); return; }\nlet lc = null; try { lc = await caches.open('lite-v1'); } catch {}\nfor (const it of items) {\nconst row = document.createElement('div'); row.className = 'item';\nconst a = document.createElement('a'); a.href = '#'; a.textContent = it.title || hostOf(it.url);\nconst sm = document.createElement('small'); sm.textContent = it.url; a.append(sm);\na.onclick = e => { e.preventDefault(); openUrl(it.url); };\nrow.append(a);\nconst m = LS.get('yl_pref', {})[hostOf(it.url)] || it.mode;\nif (m) { const b = document.createElement('span'); b.className = 'badge'; b.textContent = MODE_LABEL[m] || '軽量'; row.append(b); }\nif (lc && await lc.match('/lite?url=' + encodeURIComponent(it.url))) { const b = document.createElement('span'); b.className = 'badge ok'; b.textContent = '保存済'; row.append(b); }\nconst x = document.createElement('button'); x.className = 'x'; x.type = 'button'; x.textContent = '×';\nx.onclick = () => { const key = tab === 'h' ? 'yl_hist' : 'yl_bm'; LS.set(key, LS.get(key, []).filter(h => h.url !== it.url)); render(); };\nrow.append(x);\nlist.append(row);\n}\n}\nfunction showNet() { $('net').textContent = '回線: ' + speedLabel() + (isLow() ? '(低速)' : ''); }\n// 画面の操作は、通信の準備(Service Worker)を待たずにすぐ使えるようにする\n$('mode').value = LS.get('yl_default', 'lite');\n$('mode').onchange = () => LS.set('yl_default', $('mode').value);\n$('form').addEventListener('submit', e => { e.preventDefault(); const t = normalizeInput($('q').value); if (t) openUrl(t.url, t.m); });\n$('tab-h').onclick = () => { tab = 'h'; $('tab-h').classList.add('on'); $('tab-b').classList.remove('on'); render(); };\n$('tab-b').onclick = () => { tab = 'b'; $('tab-b').classList.add('on'); $('tab-h').classList.remove('on'); render(); };\n$('clear').onclick = async () => { for (const k of ['lite-v1', 'pages-v1', 'skx-v1']) { try { await caches.delete(k); } catch {} } render(); };\n$('resetpref').onclick = () => { LS.set('yl_pref', {}); render(); };\ninstallHotkeys(document, hkOpen); renderKeys(); showNet(); render();\nnoteSpeed(window); showNet(); syncMeta(); probeSpeed().then(showNet);\naddEventListener('online', showNet); addEventListener('offline', showNet);\nif (navigator.onLine) fetch('/healthz', { cache: 'no-store' }).catch(() => {});   // 停止中のサーバーを先に起こしておく\nif (navigator.serviceWorker) navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});\n</script> <span class=\"lbm fix\" id=\"lbm\"><button class=\"btn\" id=\"lbmb\" title=\"メニュー\" aria-haspopup=\"true\">☰</button><div class=\"ml\" id=\"lbml\"><button data-m=\"lite\">🐢 低速(軽量)</button><button data-m=\"normal\">🚀 高速(通常 UV)</button><button data-m=\"skyrox\">🦅 Skyrox</button><hr><button data-ad=\"1\">🛡 広告ブロック</button><button data-go=\"/settings.html\">⚙ 設定</button></div></span><script>(function(){var g=function(i){return document.getElementById(i)},w=g('lbm'),l=g('lbml');if(!w)return;\nvar NM={lite:'低速(軽量)',normal:'高速(通常 UV)',skyrox:'Skyrox'};\nfunction cur(){var s=g('mode');return s?s.value:''}\nfunction ads(){try{return LS.get('yl_adblock',true)}catch(e){return true}}\nfunction paint(){[].forEach.call(l.querySelectorAll('[data-m]'),function(b){b.textContent=(cur()===b.dataset.m?'✓ ':'')+b.textContent.replace(/^✓ /,'')});var a=l.querySelector('[data-ad]');a.textContent='🛡 広告ブロック: '+(ads()?'ON':'OFF')}\ng('lbmb').onclick=function(e){e.stopPropagation();w.classList.toggle('open');paint()};\ndocument.addEventListener('click',function(){w.classList.remove('open')});\ndocument.addEventListener('keydown',function(e){if(e.key==='Escape')w.classList.remove('open')});\nl.onclick=function(e){var b=e.target.closest('button');if(!b)return;w.classList.remove('open');\nif(b.dataset.go){location.href=b.dataset.go;return}\nif(b.dataset.ad){var v=!ads();try{LS.set('yl_adblock',v)}catch(x){}try{document.cookie='lb_ads='+(v?1:0)+'; Path=/; Max-Age=31536000; SameSite=Lax'}catch(x){}\ntry{if(typeof toast==='function')toast('広告ブロック '+(v?'ON':'OFF')+(g('fresh')?'(「最新」で再読み込み)':''))}catch(x){}return}\nvar m=b.dataset.m,s=g('mode');try{LS.set('yl_default',m)}catch(x){}\nif(s){s.value=m;s.dispatchEvent(new Event('change'))}}})();</script></body></html>\n",
    "/frame.html": "<!doctype html><html lang=\"ja\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>新しいタブ</title>\n<style>\n:root{--frame:#d3e3fd;--tool:#fff;--omni:#edf2fa;--fg:#1f1f1f;--fg2:#444746;--hv:rgba(31,31,31,.08);--acc:#0b57d0;--bd:rgba(0,0,0,.12);--pop:#f0f4f9;--nb:rgba(255,255,255,.55);--sh:0 2px 6px 2px rgba(60,64,67,.15),0 1px 2px rgba(60,64,67,.3)}\n@media(prefers-color-scheme:dark){:root{--nb:rgba(255,255,255,.1);--frame:#202124;--tool:#35363a;--omni:#202124;--fg:#e8eaed;--fg2:#9aa0a6;--hv:rgba(232,234,237,.1);--acc:#8ab4f8;--bd:rgba(255,255,255,.14);--pop:#292a2d}}\n*{box-sizing:border-box}html,body{height:100%;margin:0;overflow:hidden;background:var(--frame);color:var(--fg);font:13px/1.4 \"Google Sans\",Roboto,\"Segoe UI\",\"Hiragino Sans\",\"Yu Gothic UI\",system-ui,sans-serif}\nbutton{font:inherit;color:inherit}svg{display:block;pointer-events:none}\n#app{display:flex;height:100vh;height:100dvh}\n#side{width:240px;flex:none;display:flex;flex-direction:column;gap:6px;padding:8px 4px 8px 8px;user-select:none}\n#sh{display:flex;align-items:center;gap:4px}\n.ib{width:32px;height:32px;flex:none;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:50%;background:none;color:var(--fg2);cursor:pointer;padding:0}\n.ib:hover{background:var(--hv)}.ib:disabled{opacity:.35;cursor:default;background:none}.ib.on{background:var(--hv);color:var(--acc)}\n#nt{flex:1;min-width:0;display:flex;align-items:center;gap:8px;height:34px;padding:0 12px;border:0;border-radius:17px;background:var(--hv);cursor:pointer}\n#nt:hover{background:var(--bd)}\n#tabs{flex:1;overflow:auto;display:flex;flex-direction:column;gap:2px;scrollbar-width:thin}\n.tab{display:flex;align-items:center;gap:8px;height:36px;flex:none;padding:0 6px 0 10px;border-radius:8px;cursor:default;position:relative}\n.tab:hover{background:var(--hv)}.tab.on{background:var(--tool)}.tab.dg{opacity:.4}\n.fav{width:16px;height:16px;flex:none;border-radius:50%;color:#fff;font-size:10px;line-height:16px;text-align:center;font-weight:600;background:#80868b;overflow:hidden}\n.fav.sp{background:none;border:2px solid var(--bd);border-top-color:var(--acc);animation:r .8s linear infinite}\n@keyframes r{to{transform:rotate(360deg)}}\n.ttl{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.x{width:22px;height:22px;border:0;border-radius:50%;background:none;display:inline-flex;align-items:center;justify-content:center;opacity:0;cursor:pointer;padding:0;color:var(--fg2)}\n.tab:hover .x,.tab.on .x{opacity:1}.x:hover{background:var(--bd)}\nbody.vt.sc #side{width:56px;padding-right:4px}body.vt.sc #sh{flex-direction:column}body.vt.sc #nt{width:34px;flex:none;padding:0;justify-content:center}\nbody.vt.sc #nt b,body.vt.sc .ttl,body.vt.sc .x{display:none}body.vt.sc .tab{justify-content:center;padding:0}\n#main{flex:1;min-width:0;display:flex;flex-direction:column;margin-top:8px;background:var(--tool);border-radius:10px 0 0 0}\nbody.fs #main{margin-top:0}\n#tb{display:flex;align-items:center;gap:4px;height:44px;padding:0 8px;flex:none}\n#om{flex:1;min-width:0;height:36px;display:flex;align-items:center;gap:2px;padding:0 4px;border-radius:18px;background:var(--omni);border:2px solid transparent;margin:0 4px}#om:hover{background:color-mix(in srgb,var(--omni) 80%,var(--fg) 8%)}#om .lf{background:var(--tool);color:var(--fg2);width:28px;height:28px}\n#om:focus-within{border-color:var(--acc);background:var(--tool)}#av{width:28px;height:28px;margin:0 2px 0 4px;border:0;border-radius:50%;background:var(--acc);color:var(--tool);font-weight:600;font-size:13px;cursor:pointer;padding:0}\n#om .ib{width:28px;height:28px}\n#addr{flex:1;min-width:0;border:0;outline:0;background:none;color:var(--fg);font:inherit;font-size:14px;padding:0 6px}\n#bm{display:flex;gap:2px;height:30px;padding:0 8px 2px;flex:none;overflow:hidden;border-bottom:1px solid var(--bd)}\n#bm:empty{display:none}\n.bk{display:flex;align-items:center;gap:6px;max-width:170px;height:26px;padding:0 8px;border:0;border-radius:13px;background:none;cursor:pointer;white-space:nowrap;flex:none}\n.bk:hover{background:var(--hv)}.bk span{overflow:hidden;text-overflow:ellipsis}\n#content{flex:1;position:relative;min-height:0;background:#fff;border-top:1px solid var(--bd)}\n#bm:not(:empty)+#content{border-top:0}\n.pane{display:none;position:absolute;inset:0}.pane.on{display:block}\n.pane iframe{width:100%;height:100%;border:0;background:#fff;display:block}\n.pane.blank iframe{display:none}.pane:not(.blank) .ntp{display:none}\n.ntp{position:absolute;inset:0;overflow:auto;background:var(--tool);display:flex;flex-direction:column;align-items:center;padding-top:18vh}\n.ntp input{width:min(584px,86%);height:46px;border:1px solid transparent;border-radius:23px;background:var(--omni);color:var(--fg);font:inherit;font-size:16px;padding:0 22px 0 52px;outline:0;background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23888'%3E%3Cpath d='M15.5 14h-.79l-.28-.27A6.47 6.47 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z'/%3E%3C/svg%3E\");background-repeat:no-repeat;background-position:16px center;background-size:22px}.ntp input:hover{background-color:color-mix(in srgb,var(--omni) 80%,var(--fg) 8%)}.cz{position:absolute;right:16px;bottom:16px;height:36px;padding:0 16px;border:1px solid var(--bd);border-radius:18px;background:var(--tool);cursor:pointer}.cz:hover{background:var(--hv)}\n.ntp input:focus{border-color:var(--acc);background:var(--tool)}\n.tiles{display:grid;grid-template-columns:repeat(5,112px);gap:12px 4px;margin-top:34px}\n.tile{display:flex;flex-direction:column;align-items:center;gap:8px;padding:10px 4px;border:0;border-radius:10px;background:none;cursor:pointer}\n.tile:hover{background:var(--hv)}.tile .fav{width:48px;height:48px;line-height:48px;font-size:20px;background:var(--omni)!important;color:var(--fg2)}\n.tile span{max-width:104px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}\n#st{position:absolute;left:0;bottom:0;max-width:60%;padding:3px 10px;background:var(--tool);color:var(--fg);border:1px solid var(--bd);border-left:0;border-bottom:0;border-radius:0 6px 0 0;font-size:12px;display:none;z-index:5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n#pop{position:fixed;display:none;min-width:260px;max-width:min(360px,94vw);max-height:80vh;overflow:auto;padding:8px 0;background:var(--pop);border-radius:12px;box-shadow:var(--sh);z-index:50;user-select:none}\n#pop.on{display:block}\n.mi{display:flex;align-items:center;gap:14px;width:100%;height:34px;padding:0 16px 0 14px;border:0;background:none;text-align:left;cursor:pointer;white-space:nowrap}\n.mi:hover{background:var(--hv)}.mi i{width:16px;color:var(--fg2);font-style:normal;text-align:center}.mi em{margin-left:auto;font-style:normal;color:var(--fg2);font-size:12px;padding-left:20px}\n.sep{height:1px;background:var(--bd);margin:6px 0}.ph{padding:6px 16px;color:var(--fg2);font-size:12px}\n.li{display:flex;align-items:center;gap:8px;padding:0 6px 0 14px}.li .mi{padding:0;flex:1;min-width:0;height:36px}.li .mi div{overflow:hidden;text-overflow:ellipsis}.li small{display:block;color:var(--fg2);font-size:11px;overflow:hidden;text-overflow:ellipsis}\n.dp{padding:10px 18px 12px;width:290px}.dp label{display:flex;justify-content:space-between;margin:6px 0 2px}.dp input{width:100%;accent-color:var(--acc)}.dp p{margin:8px 0 0;color:var(--fg2);font-size:11px}\n#toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#323232;color:#fff;padding:8px 16px;border-radius:4px;font-size:13px;opacity:0;pointer-events:none;transition:opacity .2s;z-index:60}#toast.on{opacity:.95}\n#dim,#warm{position:fixed;inset:0;pointer-events:none;z-index:2147483647}\n#dim{background:#000;opacity:0}#warm{background:rgb(255,150,60);mix-blend-mode:multiply;opacity:0;z-index:2147483646}\n@media(max-width:640px){body.vt #side{width:56px;padding-right:4px}body.vt #sh{flex-direction:column}body.vt #nt{width:34px;flex:none;padding:0;justify-content:center}body.vt #nt b,body.vt .ttl,body.vt .x{display:none}body.vt .tab{justify-content:center;padding:0}.tiles{grid-template-columns:repeat(2,112px)}}\nbody:not(.vt) #app{flex-direction:column}\nbody:not(.vt) #side{width:auto;height:42px;flex-direction:row;align-items:flex-end;gap:0;padding:8px 8px 0}\nbody:not(.vt) #sh{display:contents}body:not(.vt) #col,body:not(.vt) #nt b{display:none}\nbody:not(.vt) #tabs{order:1;flex:0 1 auto;max-width:calc(100% - 44px);flex-direction:row;align-items:flex-end;gap:0;overflow:hidden;height:34px}\nbody:not(.vt) #nt{order:2;flex:none;width:28px;height:28px;margin:0 0 3px 6px;padding:0;justify-content:center;border-radius:50%;background:none}body:not(.vt) #nt:hover{background:var(--hv)}\nbody:not(.vt) .tab{flex:1 1 0;min-width:36px;max-width:240px;width:240px;height:34px;border-radius:8px 8px 0 0;padding:0 4px 0 12px;background:none}\nbody:not(.vt) .tab:hover:not(.on){background:var(--hv)}body:not(.vt) .tab.on{background:var(--tool)}\nbody:not(.vt) .tab:not(.on)::after{content:\"\";position:absolute;right:0;top:9px;bottom:9px;width:1px;background:var(--bd)}\nbody:not(.vt) .tab.on::before,body:not(.vt) .tab.on::after{content:\"\";position:absolute;bottom:0;width:8px;height:8px;background:radial-gradient(circle at 0 0,transparent 8px,var(--tool) 8.5px)}\nbody:not(.vt) .tab.on::before{left:-8px;transform:scaleX(-1)}body:not(.vt) .tab.on::after{right:-8px}\nbody:not(.vt) #main{margin-top:0;border-radius:0}body:not(.vt) #content{border-top:1px solid var(--bd)}\nbody:not(.vt).fs #side{display:none}\n/* --- スクリーンショット準拠 (縦タブ) --- */\nbody.vt #side{width:240px;padding:12px 12px 8px}\nbody.vt #sh{display:contents}\nbody.vt #col{order:0;align-self:flex-start;margin:0 0 6px -4px}\nbody.vt #tabs{order:1;flex:0 1 auto;max-height:calc(100% - 100px)}\nbody.vt #nt{order:2;flex:none;height:34px;border-radius:8px;background:var(--nb);justify-content:center;margin-top:2px}body.vt #nt:hover{background:var(--hv)}body.vt #nt b{display:none}\nbody.vt .tab{height:32px;border-radius:8px}body.vt .tab.on{background:#fff;box-shadow:none}\n@media(prefers-color-scheme:dark){body.vt .tab.on{background:var(--tool)}}\nbody.vt #main{margin-top:0;border-radius:0}\nbody.vt.sc #side{width:56px;padding:12px 8px 8px}body.vt.sc #nt{width:auto}\n#bm{height:36px;padding:0 10px;align-items:center;border-bottom:1px solid var(--bd)}#bm:empty{display:flex}\n#bm .gap{flex:1}.bk{height:28px}\n.ntp{padding-top:24vh}\n.sb{display:flex;align-items:center;width:min(584px,88%);height:52px;border-radius:26px;background:#fff;box-shadow:0 1px 6px rgba(32,33,36,.28);padding:0 18px;gap:6px;color:var(--fg2)}\n.sb:hover{box-shadow:0 1px 8px rgba(32,33,36,.35)}\n.ntp .sb input{flex:1;width:auto;height:50px;border:0!important;box-shadow:none;background:none!important;padding:0 8px;font-size:16px;color:#1f1f1f}\n.sb b{font-size:22px;font-weight:300;color:#1f1f1f;width:20px;text-align:center}\n.tile .fav{border-radius:50%}\n@media(prefers-color-scheme:dark){.sb{background:var(--omni)}.ntp .sb input,.sb b{color:var(--fg)}}\n\n/* ===== Chrome 寄せ追加 ===== */\n#tb{height:40px;padding:0 8px 0 6px}\n#om{height:34px;position:relative}\n.ib svg{margin:auto}\n.ttl{font-size:12px}\n.tab{transition:background .1s}\n#av{margin:0 4px}\n#om .ib.lf:hover{background:var(--hv)}\n#om.open{border-radius:18px 18px 0 0;background:var(--tool);border-bottom-color:var(--tool)}\n#sg{display:none;position:absolute;left:-2px;right:-2px;top:calc(100% + 2px);padding:4px 0 8px;background:var(--tool);border:2px solid var(--acc);border-top:0;border-radius:0 0 18px 18px;box-shadow:var(--sh);z-index:40}\n#om.open #sg{display:block}\n.sr{display:flex;align-items:center;gap:14px;height:36px;padding:0 16px 0 12px;cursor:pointer;font-size:14px;min-width:0}\n.sr:hover,.sr.on{background:var(--hv)}\n.sr svg{color:var(--fg2);flex:none}\n.sr b{font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto}\n.sr small{font-size:13px;color:var(--acc);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}\n.sr small.g{color:var(--fg2)}\n.ntp{padding-top:15vh;background:var(--tool)}\n.glogo{font:500 clamp(48px,11vw,92px)/1 \"Product Sans\",\"Google Sans\",Arial,sans-serif;letter-spacing:-.04em;margin:0 0 28px;user-select:none;white-space:nowrap}\n.glogo span:nth-child(1),.glogo span:nth-child(4){color:#4285f4}.glogo span:nth-child(2),.glogo span:nth-child(6){color:#ea4335}.glogo span:nth-child(3){color:#fbbc05}.glogo span:nth-child(5){color:#34a853}\n@media(max-height:520px){.glogo{display:none}.ntp{padding-top:8vh}}\n.sb{height:46px;border-radius:23px;background:var(--omni);box-shadow:none;border:1px solid transparent;transition:box-shadow .15s,background .15s}\n.sb:hover{background:var(--tool);box-shadow:0 1px 6px rgba(32,33,36,.28)}\n.sb:focus-within{background:var(--tool);box-shadow:0 1px 6px rgba(32,33,36,.28)}\n.sb svg{flex:none;cursor:pointer}\n.ntp .sb input{height:44px}\n.tiles{margin-top:30px;gap:8px 4px}\n.tile:hover{background:var(--hv)}\n.cz{background:var(--omni);border:0;height:34px;color:var(--fg)}\n.cz:hover{background:color-mix(in srgb,var(--omni) 85%,var(--fg) 10%)}\n.mi{height:36px;font-size:13px}\n#pop{border-radius:8px;padding:6px 0}\n#st{border-radius:0 8px 0 0}\n@media(prefers-color-scheme:dark){.ntp{background:#202124}.glogo span{color:#e8eaed!important}.sb{background:#303134}.sb:hover,.sb:focus-within{background:#303134;box-shadow:0 1px 6px rgba(0,0,0,.6)}.cz{background:#303134}}\n#av{background-size:cover;background-position:center;overflow:hidden}.sw{width:26px;height:26px;border-radius:50%;border:2px solid transparent;cursor:pointer;padding:0}.sw.on{border-color:var(--fg)}</style></head><body>\n<div id=\"app\">\n<aside id=\"side\"><div id=\"sh\"><button class=\"ib\" id=\"col\" title=\"タブバーを折りたたむ(縦タブ時)\" data-ic=\"side\"></button><button id=\"nt\" title=\"新しいタブ (Alt+T)\"><span data-ic=\"add\"></span><b>新しいタブ</b></button></div><div id=\"tabs\"></div></aside>\n<main id=\"main\">\n<div id=\"tb\">\n<button class=\"ib\" id=\"back\" title=\"戻る\" data-ic=\"back\"></button><button class=\"ib\" id=\"fwd\" title=\"進む\" data-ic=\"fwd\"></button><button class=\"ib\" id=\"reload\" title=\"再読み込み\" data-ic=\"reload\"></button><button class=\"ib\" id=\"home\" title=\"ホーム\" data-ic=\"home\"></button>\n<div id=\"om\"><span class=\"ib lf\" id=\"oi\" data-ic=\"tune\"></span><input id=\"addr\" type=\"text\" inputmode=\"url\" autocomplete=\"off\" spellcheck=\"false\" placeholder=\"検索または URL を入力\"><button class=\"ib\" id=\"star\" title=\"このタブをブックマークに追加\" data-ic=\"star\"></button></div>\n<button class=\"ib\" id=\"ext\" title=\"拡張機能\" data-ic=\"ext\"></button><button id=\"av\" title=\"プロフィール\">ゲ</button><button class=\"ib\" id=\"dimb\" title=\"画面の明るさ (Alt+↑/↓)\" data-ic=\"bri\"></button><button class=\"ib\" id=\"menu\" title=\"設定\" data-ic=\"more\"></button>\n</div><div id=\"bm\"></div>\n<div id=\"content\"><div id=\"st\"></div></div>\n</main></div>\n<div id=\"pop\"></div><div id=\"toast\"></div><div id=\"warm\"></div><div id=\"dim\"></div>\n<script>\nconst LS={get(k,d){try{const v=JSON.parse(localStorage.getItem(k));return v===null?d:v}catch{return d}},set(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch{}}};\nconst MODE_LABEL={lite:'軽量',normal:'通常',skyrox:'Skyrox'};\nconst hostOf=u=>{try{return new URL(u).hostname}catch{return''}};\nconst ENGINES={ddg:{lite:'https://html.duckduckgo.com/html/?q=',normal:'https://duckduckgo.com/?q='},bing:{lite:'https://www.bing.com/search?q=',normal:'https://www.bing.com/search?q='},google:{lite:'https://www.google.com/search?q=',normal:'https://www.google.com/search?q='},yahoo:{lite:'https://search.yahoo.co.jp/search?p=',normal:'https://search.yahoo.co.jp/search?p='}};\nfunction resolveMode(url){const p=LS.get('yl_pref',{})[hostOf(url)];if(p)return p;const d=LS.get('yl_default','lite');if(d==='auto'){const k=LS.get('yl_kbps',null);return k!==null&&k>=LS.get('yl_thresh',1000)?'normal':'lite'}return d}\nfunction normalizeInput(s){s=s.trim();if(!s)return null;if(/^https?:\\/\\//i.test(s))return{url:s};if(/^[\\w-]+(\\.[\\w-]+)+(:\\d+)?(\\/.*)?$/.test(s))return{url:'https://'+s};const m=resolveMode(''),e=ENGINES[LS.get('yl_engine','ddg')]||ENGINES.ddg;return{url:(m==='lite'?e.lite:e.normal)+encodeURIComponent(s),m}}\nfunction keyName(e){let k=e.key||'';if(k===' ')k='Space';else if(e.altKey&&/^(Key|Digit)/.test(e.code||''))k=e.code.slice(-1);else if(k.length===1)k=k.toUpperCase();const m=[];if(e.ctrlKey)m.push('Ctrl');if(e.altKey)m.push('Alt');if(e.metaKey)m.push('Meta');if(e.shiftKey&&!(k.length===1&&/[^A-Z0-9]/.test(k)))m.push('Shift');m.push(k);return m.join('+')}\nconst isMod=e=>['Control','Shift','Alt','Meta','Process','Dead'].includes(e.key);\nconst isTyping=t=>!!t&&(t.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));\nfunction hotkeyFor(e){if(e.repeat||e.isComposing||!e.key||isMod(e))return null;const n=keyName(e),hk=LS.get('yl_keys',[]).find(h=>h.key===n&&h.url);if(!hk)return null;if(isTyping(e.target)&&!/(Ctrl|Alt|Meta)\\+/.test(hk.key))return null;return hk}\nfunction isLow(){const k=LS.get('yl_kbps',null),c=navigator.connection;return!!((c&&(c.saveData||c.downlink<=.5))||(k!==null&&k<LS.get('yl_thresh',1000)))}\nasync function syncMeta(){const skip=LS.get('yl_skipimg',true);try{document.cookie='lb_skip='+(isLow()&&skip?1:0)+'; Path=/; Max-Age=86400; SameSite=Lax'}catch{}try{document.cookie='lb_ads='+(LS.get('yl_adblock',true)?1:0)+'; Path=/; Max-Age=31536000; SameSite=Lax'}catch{}try{const c=await caches.open('meta-v1');await c.put('/__meta',new Response(JSON.stringify({k:LS.get('yl_kbps',null),low:LS.get('yl_thresh',1000),skip,reval:LS.get('yl_reval','auto')})))}catch{}}\nfunction noteSpeed(win){try{const p=win.performance,nav=p.getEntriesByType('navigation')[0];let b=0,t0=Infinity,t1=0;for(const e of[nav].concat(p.getEntriesByType('resource'))){if(!e||!e.transferSize||e.responseEnd<=e.responseStart)continue;b+=e.transferSize;t0=Math.min(t0,e.responseStart);t1=Math.max(t1,e.responseEnd)}const ms=t1-t0;if(b<8000||ms<80)return;pushSpeed(b*8/ms)}catch{}}\nfunction pushSpeed(k){const h=LS.get('yl_ks',[]).concat(Math.round(k)).slice(-6),s=h.slice().sort((a,b)=>a-b);LS.set('yl_ks',h);LS.set('yl_kt',Date.now());LS.set('yl_kbps',s.length%2?s[(s.length-1)/2]:Math.round((s[s.length/2-1]+s[s.length/2])/2));syncMeta()}\nfunction speedLabel(){const k=LS.get('yl_kbps',null);if(!navigator.onLine)return'オフライン';if(k===null)return'測定中';return k>=1000?(k/1000).toFixed(1)+' Mbps':Math.round(k)+' kbps'}\n</script>\n<script>\nconst $=id=>document.getElementById(id);\nconst P={side:'M3 3h18v18H3V3zm2 2v14h4V5H5zm6 0v14h8V5h-8z',add:'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',back:'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',fwd:'M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z',reload:'M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',home:'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',tune:'M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z',star:'M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z',starf:'M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z',more:'M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',x:'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',srch:'M15.5 14h-.79l-.28-.27A6.47 6.47 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',mic:'M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z',apps:'M4 8h4V4H4v4zm6 12h4v-4h-4v4zm-6 0h4v-4H4v4zm0-6h4v-4H4v4zm6 0h4v-4h-4v4zm6-10v4h4V4h-4zm-6 4h4V4h-4v4zm6 6h4v-4h-4v4zm0 6h4v-4h-4v4z',fold:'M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z',bri:'M20 15.31L23.31 12 20 8.69V4h-4.69L12 .69 8.69 4H4v4.69L.69 12 4 15.31V20h4.69L12 23.31 15.31 20H20v-4.69zM12 18V6c3.31 0 6 2.69 6 6s-2.69 6-6 6z'};\nObject.assign(P,{ext:'M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7 1.49 0 2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z',lens:'M12 8.5A3.5 3.5 0 1015.5 12 3.5 3.5 0 0012 8.5zM5 15H3v4a2 2 0 002 2h4v-2H5zM5 5h4V3H5a2 2 0 00-2 2v4h2zm14-2h-4v2h4v4h2V5a2 2 0 00-2-2zm0 16h-4v2h4a2 2 0 002-2v-4h-2z',hist:'M13 3a9 9 0 00-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0013 21a9 9 0 000-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z'});\nconst ic=(k,s=20)=>`<svg viewBox=\"0 0 24 24\" width=\"${s}\" height=\"${s}\" fill=\"currentColor\"><path d=\"${P[k]}\"/></svg>`;\ndocument.querySelectorAll('[data-ic]').forEach(e=>e.innerHTML=ic(e.dataset.ic));\nconst mk=(t,c)=>{const e=document.createElement(t);if(c)e.className=c;return e};\nconst esc=s=>String(s).replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));\nlet tabs=[],act=null,seq=0,modes={skyrox:true},tt;\nconst cur=()=>tabs.find(t=>t.id===act);const dispUrl=u=>(u||'').replace(/^https?:\\/\\//i,'').replace(/^www\\./i,'').replace(/\\/$/,'');\nconst liteHref=(u,f)=>'/lite?url='+encodeURIComponent(u)+(f?'&fresh=1':'');\nfunction toast(m){const t=$('toast');t.textContent=m;t.classList.add('on');clearTimeout(tt);tt=setTimeout(()=>t.classList.remove('on'),2600)}\nconst letter=(u,t)=>{const h=hostOf(u)||t||'';return(h.replace(/^www\\./,'')[0]||'').toUpperCase()};\nconst hue=s=>{let h=0;for(const c of s)h=(h*31+c.charCodeAt(0))%360;return`hsl(${h} 45% 45%)`};\n/* ---- 画面を暗くする(ソフトウェア調光: OSの最低輝度より下げられる) ---- */\nfunction applyDim(){const d=Math.min(95,Math.max(0,LS.get('yl_dim',0))),w=Math.min(70,Math.max(0,LS.get('yl_warm',0)));$('dim').style.opacity=d/100;$('warm').style.opacity=w/100;$('dimb').classList.toggle('on',d>0||w>0)}\nfunction bump(n){LS.set('yl_dim',Math.min(95,Math.max(0,LS.get('yl_dim',0)+n)));applyDim();toast('画面の暗さ '+LS.get('yl_dim',0)+'%')}\n/* ---- タブ ---- */\nfunction newTab(url,m,force,bg){\n const t={id:++seq,url:'',mode:'lite',title:'',loading:false,info:'',switching:false,skipPref:false,timer:null};\n t.pane=mk('div','pane blank');t.ntp=mk('div','ntp');t.fr=mk('iframe');t.fr.title='page';t.pane.append(t.ntp,t.fr);$('content').append(t.pane);\n t.fr.addEventListener('load',()=>onLoad(t));tabs.push(t);\n if(bg)renderTabs();else activate(t);\n if(url)go(t,url,m||resolveMode(url),false,force);else renderNtp(t);\n saveTabs();return t}\nfunction activate(t){act=t.id;tabs.forEach(x=>x.pane.classList.toggle('on',x===t));renderTabs();sync();if(!t.url){renderNtp(t);setTimeout(()=>t.ntp.querySelector('input')&&t.ntp.querySelector('input').focus(),30)}saveTabs()}\nfunction closeTab(t){const i=tabs.indexOf(t);clearInterval(t.timer);t.pane.remove();tabs.splice(i,1);if(!tabs.length){newTab();return}if(act===t.id)activate(tabs[Math.min(i,tabs.length-1)]);else renderTabs();saveTabs()}\nfunction renderTabs(){\n const box=$('tabs');box.innerHTML='';\n tabs.forEach(t=>{const e=mk('div','tab'+(t.id===act?' on':'')),f=mk('div','fav'+(t.loading?' sp':''));\n  if(!t.loading){f.textContent=t.url?letter(t.url,t.title):'+';f.style.background=t.url?hue(hostOf(t.url)):''}\n  const n=mk('span','ttl');n.textContent=t.title||(t.url?hostOf(t.url):'新しいタブ');e.title=n.textContent;\n  const x=mk('button','x');x.innerHTML=ic('x',14);x.title='タブを閉じる';\n  x.onclick=ev=>{ev.stopPropagation();closeTab(t)};e.onclick=()=>activate(t);e.onauxclick=ev=>{if(ev.button===1){ev.preventDefault();closeTab(t)}};\n  e.draggable=true;e.ondragstart=ev=>{ev.dataTransfer.setData('text/plain',t.id);e.classList.add('dg')};e.ondragend=()=>e.classList.remove('dg');\n  e.ondragover=ev=>ev.preventDefault();e.ondrop=ev=>{ev.preventDefault();const s=tabs.find(z=>z.id==ev.dataTransfer.getData('text/plain'));if(s&&s!==t){tabs.splice(tabs.indexOf(s),1);tabs.splice(tabs.indexOf(t),0,s);renderTabs();saveTabs()}};\n  e.append(f,n,x);box.append(e)});\n}\nfunction saveTabs(){try{sessionStorage.setItem('yl_tabs',JSON.stringify({a:tabs.findIndex(t=>t.id===act),t:tabs.map(t=>({u:t.url,m:t.mode}))}))}catch{}}\nconst ENAME={ddg:'DuckDuckGo',bing:'Bing',google:'Google',yahoo:'Yahoo! JAPAN'};\nfunction sync(){$('addr').placeholder=(ENAME[LS.get('yl_engine','ddg')]||'')+' で検索または URL を入力';\n const t=cur();if(!t)return;\n if(document.activeElement!==$('addr'))$('addr').value=dispUrl(t.url);\n const bm=LS.get('yl_bm',[]).some(b=>b.url===t.url);$('star').innerHTML=ic(bm?'starf':'star');$('star').classList.toggle('on',bm);\n document.title=t.title||'新しいタブ';$('reload').innerHTML=ic(t.loading?'x':'reload');$('reload').title=t.loading?'読み込み中止':'再読み込み';\n const s=$('st');if(t.loading&&t.info){s.textContent=t.info;s.style.display='block'}else s.style.display='none';\n renderBm()}\nfunction renderBm(){const b=$('bm');b.innerHTML='';const ap=mk('button','ib');ap.innerHTML=ic('apps',18);ap.style.cssText='width:28px;height:28px;margin-right:6px';ap.title='アプリ';ap.onclick=()=>toast('アプリはありません');b.append(ap);LS.get('yl_bm',[]).slice(0,30).forEach(x=>{const e=mk('button','bk');e.title=x.url;e.innerHTML=`<div class=\"fav\" style=\"width:16px;height:16px;line-height:16px;background:${hue(hostOf(x.url))}\">${esc(letter(x.url,x.title))}</div><span>${esc(x.title||hostOf(x.url))}</span>`;e.onclick=()=>openIn(cur(),x.url);e.onauxclick=ev=>{if(ev.button===1){ev.preventDefault();newTab(x.url,resolveMode(x.url),false,true)}};b.append(e)});b.append(mk('span','gap'));const all=mk('button','bk');all.innerHTML=ic('fold',18)+'<span>すべてのブックマーク</span>';all.onclick=ev=>{ev.stopPropagation();pop.dataset.k='b';showPop(all,'<div class=\"ph\">ブックマーク</div>'+listHtml(LS.get('yl_bm',[]),'bm'))};b.append(all)}\nfunction renderNtp(t){\n const seen=new Set(),items=[];for(const x of LS.get('yl_bm',[]).concat(LS.get('yl_hist',[]))){const h=hostOf(x.url);if(h&&!seen.has(h)){seen.add(h);items.push(x)}if(items.length>=9)break}\n t.ntp.innerHTML='<div class=\"glogo\"><span>G</span><span>o</span><span>o</span><span>g</span><span>l</span><span>e</span></div><div class=\"sb\"><b>＋</b><input type=\"text\" placeholder=\"検索または URL を入力\" autocomplete=\"off\" spellcheck=\"false\">'+ic('mic',22)+ic('lens',22)+'</div><div class=\"tiles\"></div>';\n const inp=t.ntp.querySelector('input');inp.onkeydown=e=>{if(e.key==='Enter'){const r=normalizeInput(inp.value);if(r)go(t,r.url,r.m||resolveMode(r.url))}};\n const g=t.ntp.querySelector('.tiles');items.forEach(x=>{const b=mk('button','tile');b.innerHTML=`<div class=\"fav\">${esc(letter(x.url,x.title))}</div><span>${esc(x.title||hostOf(x.url))}</span>`;b.onclick=()=>openIn(t,x.url);g.append(b)});const ad=mk('button','tile');ad.innerHTML='<div class=\"fav\">+</div><span>追加</span>';ad.onclick=()=>{$('addr').focus()};g.append(ad);const cz=mk('button','cz');cz.textContent='✎ Chrome をカスタマイズ';cz.onclick=ev=>{ev.stopPropagation();openDim()};t.ntp.append(cz)}\nfunction openIn(t,u){if(t)go(t,u,resolveMode(u))}\n/* ---- 読み込み ---- */\nconst loadScript=s=>new Promise((res,rej)=>{const e=document.createElement('script');e.src=s;e.onload=res;e.onerror=rej;document.head.append(e)});\nlet uvReady=null;\nfunction ensureUV(){if(uvReady)return uvReady;uvReady=(async()=>{await loadScript('/uv/uv.bundle.js');await loadScript('/uv/uv.config.js');const reg=await navigator.serviceWorker.register('/uv-sw.js',{scope:__uv$config.prefix});if(!reg.active){const sw=reg.installing||reg.waiting;await new Promise(r=>{if(!sw||sw.state==='activated')return r();sw.addEventListener('statechange',()=>{if(sw.state==='activated')r()})})}})();uvReady.catch(()=>{uvReady=null});return uvReady}\nfunction startTimer(t,label){const t0=Date.now();clearInterval(t.timer);t.info=label+'…';t.timer=setInterval(()=>{const s=Math.round((Date.now()-t0)/1000);t.info=label+' '+s+'秒…'+(s>20?'(サーバー起動中かもしれません)':'');if(t===cur())sync()},1000)}\nasync function go(t,url,m,fresh,force){\n if(force)t.skipPref=true;\n t.url=url;t.mode=m;t.loading=true;t.pane.classList.remove('blank');t.title=t.title&&t.title!=='新しいタブ'?t.title:hostOf(url);\n startTimer(t,m==='lite'?'軽量で読み込み中':'読み込み中');renderTabs();if(t===cur())sync();\n try{\n  if(m==='lite')t.fr.src=liteHref(url,fresh);\n  else if(m==='skyrox'){if(fresh){try{const c=await caches.open('skx-v1');await c.delete(new URL('/proxy/'+url,location.href).href)}catch{}}t.fr.src='/proxy/'+url}\n  else{await ensureUV();if(fresh){try{const c=await caches.open('pages-v1');await c.delete(new URL(__uv$config.prefix+__uv$config.encodeUrl(url),location.href).href)}catch{}}t.fr.src=__uv$config.prefix+__uv$config.encodeUrl(url)}\n }catch(e){clearInterval(t.timer);t.loading=false;t.info='失敗: '+(e.message||e);toast(t.info);renderTabs();sync()}\n}\nfunction onLoad(t){\n clearInterval(t.timer);let loc;try{loc=t.fr.contentWindow.location}catch{return}\n if(loc.href==='about:blank')return;\n let real='',m='lite';\n if(loc.pathname==='/lite')real=new URLSearchParams(loc.search).get('url')||'';\n else if(loc.pathname==='/jp'||loc.pathname.startsWith('/jp/')){m='skyrox';real='https://poki.com'+loc.pathname+loc.search+loc.hash}\n else if(loc.pathname.startsWith('/proxy/')){m='skyrox';real=(loc.pathname.slice(7)+loc.search+loc.hash).replace(/^(https?):\\/(?!\\/)/i,'$1://')}\n else if(window.__uv$config&&loc.pathname.startsWith(__uv$config.prefix)){m='normal';try{real=__uv$config.decodeUrl(loc.href.split(__uv$config.prefix)[1]||'')}catch{}}\n t.loading=false;\n if(!real){t.info='表示中';renderTabs();if(t===cur())sync();return}\n const p=LS.get('yl_pref',{})[hostOf(real)];\n if(p&&p!==m&&!t.switching&&!t.skipPref){t.switching=true;go(t,real,p);return}\n t.switching=false;t.skipPref=false;\n try{const d=t.fr.contentDocument;if(d&&!d.__hk){d.__hk=1;addKeys(d)}}catch{}\n t.mode=m;t.url=real;let title='';try{title=t.fr.contentDocument.title}catch{}\n t.title=(title||hostOf(real)).slice(0,80);\n const hist=LS.get('yl_hist',[]).filter(h=>h.url!==real);hist.unshift({url:real,title:t.title,mode:m,t:Date.now()});LS.set('yl_hist',hist.slice(0,60));\n let info=MODE_LABEL[m]||'通常';\n try{const nav=t.fr.contentWindow.performance.getEntriesByType('navigation')[0],fc=nav&&nav.transferSize===0;if(!fc)noteSpeed(t.fr.contentWindow);\n  if(m==='lite'){const meta=t.fr.contentDocument.querySelector('meta[name=lite-info]'),o=meta&&/orig=(\\d+)/.exec(meta.content);if(fc)info+='・保存済みから表示'+(o?'(元HTML '+Math.ceil(o[1]/1024)+'KB)':'');else if(nav&&o)info+=' '+Math.max(1,Math.ceil(nav.encodedBodySize/1024))+'KB(元HTML '+Math.ceil(o[1]/1024)+'KB)'}else if(fc)info+='・保存済みから表示'}catch{}\n t.info=info;renderTabs();if(t===cur())sync();saveTabs();\n}\nsetInterval(()=>{let ch=false;tabs.forEach(t=>{if(t.loading||!t.url)return;try{const s=t.fr.contentDocument.title;if(s&&s.slice(0,80)!==t.title){t.title=s.slice(0,80);ch=true}}catch{}});if(ch){renderTabs();sync()}},2000);\n/* ---- ボタン ---- */\nconst win=()=>{const t=cur();return t&&t.fr.contentWindow};\n$('back').onclick=()=>{try{win().history.back()}catch{}};\n$('fwd').onclick=()=>{try{win().history.forward()}catch{}};\n$('reload').onclick=()=>{const t=cur();if(t&&t.loading){clearInterval(t.timer);t.loading=false;try{win().stop()}catch{}renderTabs();sync();return}if(t&&t.url){try{win().location.reload()}catch{}}};\n$('home').onclick=()=>{const t=cur();if(!t)return;clearInterval(t.timer);t.url='';t.title='';t.loading=false;t.fr.src='about:blank';t.pane.classList.add('blank');renderNtp(t);renderTabs();sync();$('addr').value='';setTimeout(()=>t.ntp.querySelector('input').focus(),30);saveTabs()};\n$('nt').onclick=()=>newTab();\n$('col').onclick=()=>{document.body.classList.toggle('sc');LS.set('yl_sc',document.body.classList.contains('sc'))};\n$('addr').addEventListener('focus',e=>{e.target.select();$('oi').innerHTML=ic('srch')});$('addr').addEventListener('blur',()=>{$('oi').innerHTML=ic('tune')});$('av').onclick=e=>{e.stopPropagation();$('menu').click()};\n$('addr').addEventListener('keydown',e=>{if(e.key==='Enter'){const r=normalizeInput($('addr').value),t=cur();if(r&&t){go(t,r.url,r.m||resolveMode(r.url));e.target.blur()}}else if(e.key==='Escape'){const t=cur();$('addr').value=t&&t.url||'';e.target.blur()}});\n$('star').onclick=()=>{const t=cur();if(!t||!t.url)return;let bm=LS.get('yl_bm',[]);if(bm.some(b=>b.url===t.url))bm=bm.filter(b=>b.url!==t.url);else bm.unshift({url:t.url,title:(t.title||hostOf(t.url)).slice(0,80)});LS.set('yl_bm',bm);sync()};\n/* ---- ポップアップ ---- */\nconst pop=$('pop');\nfunction showPop(anchor,html){pop.innerHTML=html;pop.classList.add('on');const r=anchor.getBoundingClientRect(),w=pop.offsetWidth;pop.style.top=(r.bottom+4)+'px';pop.style.left=Math.max(8,Math.min(innerWidth-w-8,r.right-w))+'px'}\nconst hidePop=()=>pop.classList.remove('on');\ndocument.addEventListener('click',e=>{if(!pop.contains(e.target)&&!e.target.closest('#menu,#dimb'))hidePop()});\nconst mi=(a,i,l,r)=>`<button class=\"mi\" data-a=\"${a}\"><i>${i}</i>${l}${r?`<em>${r}</em>`:''}</button>`;\nfunction listHtml(arr,kind){return arr.length?arr.slice(0,40).map((x,i)=>`<div class=\"li\"><button class=\"mi\" data-a=\"open\" data-u=\"${esc(x.url)}\"><div>${esc(x.title||hostOf(x.url))}<small>${esc(x.url)}</small></div></button>${kind==='bm'?`<button class=\"x\" style=\"opacity:1\" data-a=\"delbm\" data-u=\"${esc(x.url)}\">${ic('x',14)}</button>`:''}</div>`).join(''):'<div class=\"ph\">項目がありません</div>'}\n$('menu').onclick=e=>{e.stopPropagation();if(pop.classList.contains('on')&&pop.dataset.k==='m'){hidePop();return}const t=cur()||{},m=t.mode;pop.dataset.k='m';\n showPop($('menu'),mi('nt','＋','新しいタブ','Alt+T')+mi('close','✕','タブを閉じる','Alt+W')+mi('vt','▥',document.body.classList.contains('vt')?'横のタブに戻す':'縦のタブを使用')+'<div class=\"sep\"></div>'+mi('bms','★','ブックマーク','▸')+mi('hist','⟲','履歴','▸')+'<div class=\"sep\"></div><div class=\"ph\">表示モード(このサイト)</div>'\n +['lite','normal','skyrox'].map(k=>mi('mode-'+k,m===k?'✓':'',{lite:'低速(軽量)',normal:'高速(通常 UV)',skyrox:'Skyrox'}[k])).join('')\n +mi('fresh','⟳','保存を無視して最新を取得')+(m==='lite'&&t.url?mi('imgs','▣','画像をすべて読み込む'):'')+mi('ads','⛨','広告ブロック',LS.get('yl_adblock',true)?'ON':'OFF')+'<div class=\"sep\"></div>'\n +mi('fs','⛶','全画面表示',document.fullscreenElement?'解除':'F11')+mi('dim','☀','画面を暗くする…')+mi('set','⚙','設定')+mi('start','⌂','スタート画面へ')+`<div class=\"sep\"></div><div class=\"ph\">${esc(t.info||'')} ・ 回線 ${speedLabel()}</div>`)};\n$('dimb').onclick=e=>{e.stopPropagation();openDim()};\nfunction openDim(){pop.dataset.k='d';const d=LS.get('yl_dim',0),w=LS.get('yl_warm',0);\n showPop($('dimb'),`<div class=\"dp\"><label>画面の暗さ<b id=\"dv\">${d}%</b></label><input type=\"range\" id=\"dr\" min=\"0\" max=\"95\" value=\"${d}\"><label>暖色フィルター<b id=\"wv\">${w}%</b></label><input type=\"range\" id=\"wr\" min=\"0\" max=\"70\" value=\"${w}\"><div style=\"margin-top:10px\"><button class=\"mi\" style=\"height:30px;padding:0 10px;width:auto;border-radius:15px\" id=\"dz\">リセット</button></div><p>OSの最低輝度より暗くできます。Alt+↑/↓ でも調整できます。</p></div>`);\n $('dr').oninput=e=>{LS.set('yl_dim',+e.target.value);$('dv').textContent=e.target.value+'%';applyDim()};\n $('wr').oninput=e=>{LS.set('yl_warm',+e.target.value);$('wv').textContent=e.target.value+'%';applyDim()};\n $('dz').onclick=()=>{LS.set('yl_dim',0);LS.set('yl_warm',0);applyDim();openDim()}}\npop.onclick=e=>{const b=e.target.closest('[data-a]');if(!b)return;const a=b.dataset.a,t=cur();\n if(a==='open'){hidePop();openIn(t,b.dataset.u);return}\n if(a==='delbm'){LS.set('yl_bm',LS.get('yl_bm',[]).filter(x=>x.url!==b.dataset.u));sync();pop.querySelector('.li')&&b.closest('.li').remove();return}\n if(a==='bms'){pop.innerHTML=`<div class=\"ph\">ブックマーク</div>`+listHtml(LS.get('yl_bm',[]),'bm');return}\n if(a==='hist'){pop.innerHTML=`<div class=\"ph\">履歴</div>`+listHtml(LS.get('yl_hist',[]),'h');return}\n if(a==='dim'){openDim();return}\n hidePop();\n if(a==='nt')newTab();else if(a==='close'&&t)closeTab(t);\n else if(a.startsWith('mode-')){const nm=a.slice(5);if(!t||!t.url)return;if(nm==='skyrox'&&!modes.skyrox){toast('このサーバーではSkyroxモードが有効になっていません');return}const pr=LS.get('yl_pref',{});pr[hostOf(t.url)]=nm;LS.set('yl_pref',pr);toast(hostOf(t.url)+' は次回から'+MODE_LABEL[nm]+'モードで開きます');go(t,t.url,nm,false,true)}\n else if(a==='fresh'){if(t&&t.url)go(t,t.url,t.mode,true)}\n else if(a==='imgs'){try{win().lbLoadAll()}catch{}}\n else if(a==='ads'){const v=!LS.get('yl_adblock',true);LS.set('yl_adblock',v);syncMeta();toast('広告ブロック '+(v?'ON':'OFF')+'(「最新を取得」で再読み込み)')}\n else if(a==='vt'){document.body.classList.toggle('vt');LS.set('yl_vt',document.body.classList.contains('vt'))}else if(a==='fs')toggleFs();else if(a==='set')location.href='/settings.html';else if(a==='start')location.href='/'};\nfunction toggleFs(){if(document.fullscreenElement)document.exitFullscreen();else document.documentElement.requestFullscreen&&document.documentElement.requestFullscreen().catch(()=>{})}\ndocument.addEventListener('fullscreenchange',()=>document.body.classList.toggle('fs',!!document.fullscreenElement));\n/* ---- ショートカット(登録済みホットキー優先) ---- */\nfunction onKey(e){\n const hk=hotkeyFor(e);if(hk){e.preventDefault();e.stopPropagation();const x=hk.mode&&hk.mode!=='default',t=cur();if(t)go(t,hk.url,x?hk.mode:resolveMode(hk.url),false,x);return}\n if(!e.altKey||e.ctrlKey||e.metaKey||e.isComposing)return;\n const k=e.code;let h=true;\n if(k==='KeyT')newTab();else if(k==='KeyW'){const t=cur();t&&closeTab(t)}else if(k==='KeyL'){$('addr').focus()}\n else if(k==='ArrowUp')bump(-5);else if(k==='ArrowDown')bump(5);\n else if(k==='BracketRight'||k==='BracketLeft'){const i=tabs.findIndex(t=>t.id===act),n=(i+(k==='BracketRight'?1:-1)+tabs.length)%tabs.length;activate(tabs[n])}\n else h=false;\n if(h){e.preventDefault();e.stopPropagation()}}\nfunction addKeys(d){d.addEventListener('keydown',onKey,true)}\naddKeys(document);\ndocument.addEventListener('keydown',e=>{if(e.key==='Escape')hidePop()});\n/* ---- 起動 ---- */\nfetch('/__modes',{cache:'no-store'}).then(r=>r.json()).then(j=>{modes=j}).catch(()=>{});\nif(navigator.serviceWorker)navigator.serviceWorker.register('/sw.js',{scope:'/'}).catch(()=>{});\nif(LS.get('yl_vt',true))document.body.classList.add('vt');\nif(LS.get('yl_sc',false))document.body.classList.add('sc');\napplyDim();syncMeta();\n(()=>{\n const u=new URLSearchParams(location.search).get('u'),m=new URLSearchParams(location.search).get('m');\n if(u){history.replaceState(null,'','frame.html');newTab(u,m||resolveMode(u));return}\n let s=null;try{s=JSON.parse(sessionStorage.getItem('yl_tabs'))}catch{}\n if(s&&s.t&&s.t.length){const made=s.t.map(x=>newTab(x.u||'',x.m,false,true));activate(made[Math.max(0,Math.min(s.a,made.length-1))])}\n else newTab();\n})();\n</script><script>\n(()=>{\nconst addr=$('addr'),om=$('om'),sg=mk('div');sg.id='sg';om.append(sg);\nlet items=[],sel=-1;\n$('ext').onclick=()=>toast('拡張機能はインストールされていません');\nconst close=()=>{om.classList.remove('open');sg.innerHTML='';items=[];sel=-1};\nfunction mark(){[...sg.children].forEach((e,i)=>e.classList.toggle('on',i===sel))}\nfunction build(){\n const q=addr.value.trim();if(!q||document.activeElement!==addr){close();return}\n const ql=q.toLowerCase(),seen=new Set(),list=[];\n const all=LS.get('yl_bm',[]).map(v=>({...v,k:'bm'})).concat(LS.get('yl_hist',[]).map(v=>({...v,k:'h'})));\n for(const x of all){if(seen.has(x.url))continue;if((x.title||'').toLowerCase().includes(ql)||x.url.toLowerCase().includes(ql)){seen.add(x.url);list.push(x)}if(list.length>=5)break}\n items=[{k:'s',text:q}].concat(list);sel=0;\n sg.innerHTML=items.map((x,i)=>x.k==='s'\n  ?`<div class=\"sr\" data-i=\"${i}\">${ic('srch',20)}<b>${esc(x.text)}</b><small class=\"g\">- ${esc(ENAME[LS.get('yl_engine','ddg')]||'')} で検索</small></div>`\n  :`<div class=\"sr\" data-i=\"${i}\">${ic(x.k==='bm'?'starf':'hist',20)}<b>${esc(x.title||hostOf(x.url))}</b><small>- ${esc(dispUrl(x.url))}</small></div>`).join('');\n om.classList.add('open');mark()}\nfunction pick(i){const it=items[i],t=cur();if(!it||!t)return;\n if(it.k==='s'){const r=normalizeInput(it.text);if(r)go(t,r.url,r.m||resolveMode(r.url))}else go(t,it.url,resolveMode(it.url));\n close();addr.blur()}\nsg.addEventListener('mousedown',e=>e.preventDefault());\nsg.addEventListener('click',e=>{const r=e.target.closest('.sr');if(r)pick(+r.dataset.i)});\naddr.addEventListener('input',build);\naddr.addEventListener('focus',()=>{const t=cur();addr.value=t&&t.url||'';addr.select()});\naddr.addEventListener('blur',()=>{const t=cur();addr.value=dispUrl(t&&t.url);close()});\naddr.addEventListener('keydown',e=>{\n if(e.isComposing)return;\n if((e.key==='ArrowDown'||e.key==='ArrowUp')&&items.length){e.preventDefault();sel=(sel+(e.key==='ArrowDown'?1:-1)+items.length)%items.length;mark()}\n else if(e.key==='Enter'&&sel>0&&items[sel]){e.preventDefault();e.stopImmediatePropagation();pick(sel)}\n else if(e.key==='Escape')close()\n},true);\n})();\n</script><script>\n(()=>{\nconst av=$('av'),COL=['#0b57d0','#d93025','#188038','#e37400','#9334e6','#5f6368'];\nfunction paint(el){const img=LS.get('yl_avimg',''),tx=LS.get('yl_avtx','ゲ'),c=LS.get('yl_avcol',COL[0]);\n el.style.background=img?`center/cover url(${img})`:c;el.textContent=img?'':tx}\nfunction apply(){paint(av);const pv=$('pv');if(pv)paint(pv)}\nfunction open(){pop.dataset.k='p';\n showPop(av,`<div class=\"dp\" style=\"width:280px\"><div style=\"display:flex;justify-content:center;margin:4px 0 12px\"><div id=\"pv\" style=\"width:64px;height:64px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:28px;color:#fff;font-weight:600\"></div></div>\n <button class=\"mi\" id=\"pimg\" style=\"height:34px;border-radius:17px;padding:0 14px;background:var(--hv);justify-content:center\">画像を選ぶ…</button><input type=\"file\" id=\"pf\" accept=\"image/*\" hidden>\n <label style=\"margin-top:12px\">文字・絵文字</label><input type=\"text\" id=\"ptx\" maxlength=\"2\" value=\"${esc(LS.get('yl_avtx','ゲ'))}\" style=\"height:32px;border:1px solid var(--bd);border-radius:8px;background:var(--tool);color:var(--fg);padding:0 10px;font:inherit\">\n <label style=\"margin-top:12px\">色</label><div style=\"display:flex;gap:8px;margin-top:4px\">${COL.map(c=>`<button class=\"sw${LS.get('yl_avcol',COL[0])===c?' on':''}\" data-c=\"${c}\" style=\"background:${c}\"></button>`).join('')}</div>\n <div style=\"margin-top:12px\"><button class=\"mi\" id=\"prs\" style=\"height:30px;padding:0 10px;width:auto;border-radius:15px\">リセット</button></div></div>`);\n apply();\n $('pimg').onclick=()=>$('pf').click();\n $('pf').onchange=e=>{const f=e.target.files[0];if(!f)return;const r=new FileReader();r.onload=()=>{const im=new Image();im.onload=()=>{const c=document.createElement('canvas');c.width=c.height=96;const m=Math.min(im.width,im.height);c.getContext('2d').drawImage(im,(im.width-m)/2,(im.height-m)/2,m,m,0,0,96,96);LS.set('yl_avimg',c.toDataURL('image/jpeg',.85));apply()};im.onerror=()=>toast('画像を読み込めませんでした');im.src=r.result};r.readAsDataURL(f)};\n $('ptx').oninput=e=>{LS.set('yl_avtx',e.target.value||'ゲ');LS.set('yl_avimg','');apply()};\n pop.querySelectorAll('.sw').forEach(b=>b.onclick=()=>{LS.set('yl_avcol',b.dataset.c);pop.querySelectorAll('.sw').forEach(x=>x.classList.toggle('on',x===b));apply()});\n $('prs').onclick=()=>{['yl_avimg','yl_avtx','yl_avcol'].forEach(k=>{try{localStorage.removeItem(k)}catch{}});apply();open()}}\nav.onclick=e=>{e.stopPropagation();if(pop.classList.contains('on')&&pop.dataset.k==='p'){hidePop();return}open()};\nav.title='プロフィールのアイコンを変更';apply();\n})();\n</script></body></html>\n",
    "/settings.html": "<!doctype html> <html lang=\"ja\"><head><meta charset=\"utf-8\"> <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"> <title>設定 - Yoroxy LowBand</title> <style>:root{color-scheme:light dark;--radius:14px;--ease:cubic-bezier(.2,.9,.3,1);--dur-base:320ms;--color-bg-base:#f6f9fc;--color-bg-subtle:#eef4fb;--color-bg-elevated:#ffffff;--color-text-primary:#0b1220;--color-text-secondary:#6b7280;--color-accent:#4f9cff;--color-accent-strong:#2d7be6;--color-glass-bg:rgba(255,255,255,0.72);--color-glass-border:rgba(255,255,255,0.4);--shadow-soft:0 8px 28px rgba(16,24,40,0.06);--shadow-strong:0 20px 60px rgba(16,24,40,0.08)}@media (prefers-color-scheme:dark){:root{--color-bg-base:#071026;--color-bg-subtle:#07152a;--color-bg-elevated:#0b162f;--color-text-primary:#e6eef8;--color-text-secondary:#9aa3b2;--color-accent:#6aa8ff;--color-accent-strong:#3f8cff;--color-glass-bg:rgba(12,16,24,0.6);--color-glass-border:rgba(255,255,255,0.06);--shadow-soft:0 10px 40px rgba(0,0,0,0.6);--shadow-strong:0 30px 80px rgba(0,0,0,0.7)}}:root[data-theme=\"light\"]{color-scheme:light}:root[data-theme=\"dark\"]{color-scheme:dark;--color-bg-base:#071026;--color-bg-subtle:#07152a;--color-bg-elevated:#0b162f;--color-text-primary:#e6eef8;--color-text-secondary:#9aa3b2;--color-accent:#6aa8ff;--color-accent-strong:#3f8cff;--color-glass-bg:rgba(12,16,24,0.6);--color-glass-border:rgba(255,255,255,0.06);--shadow-soft:0 10px 40px rgba(0,0,0,0.6);--shadow-strong:0 30px 80px rgba(0,0,0,0.7)}*{box-sizing:border-box}html,body{height:100%}body{margin:0;height:100dvh;color:var(--color-text-primary);background:linear-gradient( 180deg,var(--color-bg-base),var(--color-bg-subtle) );display:flex;justify-content:center;align-items:center}#background{position:fixed;inset:0;z-index:-2;pointer-events:none}.app-root{width:100%;max-width:1200px;height:100%;padding:clamp(16px,4vw,32px);display:flex}.layout{width:100%;height:100%;display:flex;align-items:center;justify-content:center}.center-panel{width:100%;display:flex;justify-content:center}.card{width:100%;max-width:880px;padding:clamp(16px,3vw,24px);border-radius:calc(var(--radius) + 2px);background:var(--color-glass-bg);border:1px solid var(--color-glass-border);backdrop-filter:blur(16px) saturate(140%);box-shadow:var(--shadow-soft);display:flex;flex-direction:column;gap:16px;transition:transform var(--dur-base) var(--ease),box-shadow var(--dur-base) var(--ease)}.card:focus-within{transform:translateY(-4px);box-shadow:var(--shadow-strong)}.card-header{display:flex;align-items:center}.brand{font-weight:600;font-size:1rem;color:var(--color-accent-strong)}.search-area{width:100%}.searchbar{display:flex;align-items:center;gap:12px;width:100%;padding:clamp(10px,2vw,14px);border-radius:999px;background:linear-gradient( 180deg,color-mix(in srgb,var(--color-bg-elevated) 95%,transparent),color-mix(in srgb,var(--color-bg-elevated) 85%,transparent) );border:1px solid color-mix(in srgb,var(--color-accent) 20%,transparent)}.searchbar:focus-within{border-color:var(--color-accent)}.icon{flex:0 0 20px;display:flex;align-items:center;justify-content:center}.search-input{flex:1;border:none;background:transparent;outline:none;font-size:clamp(15px,2.5vw,20px);color:var(--color-text-primary);min-width:0}.search-input::placeholder{color:var(--color-text-secondary)}@media (min-width:768px){.card{flex-direction:row;align-items:center}.card-header{margin-right:16px}.search-area{flex:1}}</style><style>.col{display:flex;flex-direction:column;gap:8px;width:100%}.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:12px;color:var(--color-text-secondary)}.chip{padding:3px 10px;border-radius:999px;background:color-mix(in srgb,var(--color-accent) 12%,transparent);font-size:12px}.link-btn{border:none;background:none;color:var(--color-accent-strong);cursor:pointer;font-size:12px;padding:0}select{padding:5px 8px;border-radius:8px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;font-size:13px}.tabs{display:flex;gap:6px}.tab{border:none;background:transparent;color:inherit;opacity:.6;padding:6px 10px;border-radius:8px;cursor:pointer;font-size:13px}.tab.on{opacity:1;background:color-mix(in srgb,var(--color-accent) 14%,transparent);font-weight:600}.list{display:flex;flex-direction:column;gap:6px;max-height:42vh;overflow:auto}.item{display:flex;align-items:center;gap:6px;padding:8px 10px;border-radius:10px;background:color-mix(in srgb,var(--color-accent) 7%,transparent)}.item a{flex:1;min-width:0;color:inherit;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.item a small{display:block;opacity:.6;font-size:11px;overflow:hidden;text-overflow:ellipsis}.badge{font-size:10px;padding:1px 6px;border-radius:99px;background:rgba(128,128,128,.25)}.badge.ok{background:rgba(34,160,90,.3)}.item .x{border:none;background:none;color:inherit;opacity:.5;cursor:pointer;font-size:16px}.empty{font-size:12px;opacity:.6;padding:8px}body.fr{display:flex;flex-direction:column;height:100vh;height:100dvh;margin:0}body.fr .topbar{flex-wrap:wrap;gap:6px;align-items:center}body.fr .frame-wrap{flex:1;min-height:0;height:auto!important;position:relative!important;inset:auto!important}body.fr iframe{width:100%;height:100%;border:0;background:#fff}.addr{flex:1;min-width:140px;padding:6px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:inherit;font-size:13px}.topbar .chip{background:rgba(255,255,255,.1)}#toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#222;color:#fff;padding:8px 14px;border-radius:99px;font-size:13px;opacity:0;pointer-events:none;transition:opacity .2s;z-index:9}#toast.on{opacity:.95}.keychip{border:none;cursor:pointer;color:inherit}.set-sec{display:flex;flex-direction:column;gap:8px;padding:12px 0;border-top:1px solid rgba(128,128,128,.25)}.set-sec h2{margin:0;font-size:14px}.set-sec p{margin:0;font-size:12px;opacity:.7;line-height:1.6}.set-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:13px}.txt{padding:7px 10px;border-radius:8px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;font-size:13px;min-width:0}.hk-row{display:grid;grid-template-columns:130px 1fr 96px auto;gap:6px;align-items:center}.hk-row.bad .txt,.txt.bad{border-color:#e5484d}.keybtn{padding:7px 8px;border-radius:8px;border:1px dashed rgba(128,128,128,.6);background:transparent;color:inherit;cursor:pointer;font-size:13px}.keybtn.rec{border-color:var(--color-accent);background:color-mix(in srgb,var(--color-accent) 15%,transparent)}.sbtn{padding:7px 12px;border-radius:8px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;cursor:pointer;font-size:13px}.sbtn.danger{color:#e5484d}.warn{font-size:12px;color:#e5484d}@media(max-width:560px){.hk-row{grid-template-columns:1fr 1fr}.hk-row .txt{grid-column:1/3}}</style> </head><body> <div id=\"background\"></div> <div class=\"app-root\"><div class=\"layout\"><div class=\"center-panel\"> <main class=\"card\" style=\"max-height:92vh;overflow:auto\"> <header class=\"card-header\"><span class=\"brand\">設定</span><a class=\"link-btn\" href=\"/\" style=\"margin-left:auto\">← ホームへ</a></header> <div class=\"search-area col\"> <section class=\"set-sec\" style=\"border-top:none\"> <h2>表示モード</h2> <div class=\"set-row\"><label>既定のモード\n<select id=\"mode\"><option value=\"lite\">軽量(おすすめ)</option><option value=\"normal\">通常(UV)</option><option value=\"skyrox\">Skyrox</option><option value=\"auto\">自動(回線速度で切替)</option></select></label></div> <div class=\"set-row\"><span>「自動」は、回線が上の「低速」より速いときに通常、遅いときに軽量で開きます。</span></div> <p><b>軽量</b>=文字中心で速い / <b>通常(UV)</b>=ブラウザ側で書き換え・動画やゲーム向け / <b>Skyrox</b>=サーバー側で書き換え(unblocker方式)。<br>サイト別に覚えたモードは、既定より優先されます(下の一覧で変更できます)。</p> </section> <section class=\"set-sec\"> <h2>低速回線</h2> <div class=\"set-row\"><label>この速度より遅いときを「低速」とみなす <input class=\"txt\" id=\"low\" type=\"number\" min=\"50\" max=\"50000\" step=\"50\" style=\"width:90px\"> kbps</label></div> <div class=\"set-row\"><label><input type=\"checkbox\" id=\"skipimg\"> 低速時は画像・動画を読み込まない(通常・Skyroxモード)</label></div> <div class=\"set-row\"><label><input type=\"checkbox\" id=\"adblock\"> 広告・計測ブロックを有効にする(全モード共通。画像の1px計測タグや広告配信ドメインを遮断)</label></div> <div class=\"set-row\"><label>保存済みページの裏更新\n<select id=\"reval\"><option value=\"auto\">速い回線のときだけ(おすすめ)</option><option value=\"never\">しない(通信を節約)</option></select></label></div> <p>回線速度は、ページを開くたびに転送時間から自動で推定します(追加の通信はしません)。低速と判定されると、保存済みページをそのまま表示し、通信を使う更新や画像の読み込みを控えます。「最新」ボタンで取り直せます。</p> </section> <section class=\"set-sec\"> <h2>検索エンジン</h2> <div class=\"set-row\"><select id=\"engine\"></select></div> <p>URLではない文字を入力したときに使います。軽量モードではJavaScript不要の画面が出るDuckDuckGoがおすすめです。</p> </section> <section class=\"set-sec\"> <h2>ショートカットキー</h2> <p>キーを押すと、指定したサイトへ移動します(ホーム画面・閲覧画面・表示中のページ内で有効)。「キー」の欄を押してから、割り当てたいキーを押してください。Escで取り消せます。<br>\n文字入力中は誤作動を防ぐため、<b>Alt+1</b> のように Ctrl / Alt / Meta を含むキーだけが動きます。ブラウザが使うキー(Ctrl+T など)は使えないことがあります。</p> <div id=\"hk\" class=\"col\"></div> <div class=\"set-row\"><button class=\"sbtn\" id=\"hk-add\" type=\"button\">＋ ショートカットを追加</button></div> </section> <section class=\"set-sec\"> <h2>サイト別のモード</h2> <div id=\"prefs\" class=\"col\"></div> </section> <section class=\"set-sec\"> <h2>データ</h2> <div class=\"set-row\"> <button class=\"sbtn\" id=\"d-hist\" type=\"button\">履歴を削除</button> <button class=\"sbtn\" id=\"d-bm\" type=\"button\">ブックマークを削除</button> <button class=\"sbtn\" id=\"d-cache\" type=\"button\">保存したページを削除</button> <button class=\"sbtn danger\" id=\"d-all\" type=\"button\">すべて初期化</button> </div> </section> </div> </main> </div></div></div> <div id=\"toast\" style=\"position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#222;color:#fff;padding:8px 14px;border-radius:99px;font-size:13px;opacity:0;pointer-events:none;transition:opacity .2s;z-index:9\"></div> <script>// 全ページ共通: 設定の読み書き・モード判定・ショートカットキー\nconst LS = {\nget(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v === null ? d : v; } catch { return d; } },\nset(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },\n};\nconst MODE_LABEL = { lite: '軽量', normal: '通常', skyrox: 'Skyrox' };\nconst MODE_OPTIONS = [['lite', '軽量'], ['normal', '通常(UV)'], ['skyrox', 'Skyrox']];\nconst hostOf = u => { try { return new URL(u).hostname; } catch { return ''; } };\nconst ENGINES = {\nddg:    { name: 'DuckDuckGo(おすすめ)', lite: 'https://html.duckduckgo.com/html/?q=', normal: 'https://duckduckgo.com/?q=' },\nbing:   { name: 'Bing', lite: 'https://www.bing.com/search?q=', normal: 'https://www.bing.com/search?q=' },\ngoogle: { name: 'Google', lite: 'https://www.google.com/search?q=', normal: 'https://www.google.com/search?q=' },\nyahoo:  { name: 'Yahoo! JAPAN', lite: 'https://search.yahoo.co.jp/search?p=', normal: 'https://search.yahoo.co.jp/search?p=' },\n};\n// 表示モードの決定: サイト別の設定 > 既定(自動なら回線速度で判定)\nfunction resolveMode(url) {\nconst p = LS.get('yl_pref', {})[hostOf(url)]; if (p) return p;\nconst d = LS.get('yl_default', 'lite');\nif (d === 'auto') { const k = LS.get('yl_kbps', null); return k !== null && k >= LS.get('yl_thresh', 1000) ? 'normal' : 'lite'; }\nreturn d;\n}\n// 入力 → { url, m? }  (URLならそのまま、それ以外は検索)\nfunction normalizeInput(s) {\ns = s.trim(); if (!s) return null;\nif (/^https?:\\/\\//i.test(s)) return { url: s };\nif (/^[\\w-]+(\\.[\\w-]+)+(:\\d+)?(\\/.*)?$/.test(s)) return { url: 'https://' + s };\nconst m = resolveMode(''), e = ENGINES[LS.get('yl_engine', 'ddg')] || ENGINES.ddg;\nreturn { url: (m === 'lite' ? e.lite : e.normal) + encodeURIComponent(s), m };\n}\n// ---- ショートカットキー ----\nfunction keyName(e) {\nlet k = e.key || '';\nif (k === ' ') k = 'Space';\nelse if (e.altKey && /^(Key|Digit)/.test(e.code || '')) k = e.code.slice(-1);   // Mac の Alt+文字 対策\nelse if (k.length === 1) k = k.toUpperCase();\nconst m = [];\nif (e.ctrlKey) m.push('Ctrl'); if (e.altKey) m.push('Alt'); if (e.metaKey) m.push('Meta');\nif (e.shiftKey && !(k.length === 1 && /[^A-Z0-9]/.test(k))) m.push('Shift');\nm.push(k); return m.join('+');\n}\nconst isModifierKey = e => ['Control', 'Shift', 'Alt', 'Meta', 'Process', 'Dead'].includes(e.key);\nconst isTyping = t => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));\nfunction hotkeyFor(e) {\nif (e.repeat || e.isComposing || !e.key || isModifierKey(e)) return null;\nconst name = keyName(e);\nconst hk = LS.get('yl_keys', []).find(h => h.key === name && h.url);\nif (!hk) return null;\nif (isTyping(e.target) && !/(Ctrl|Alt|Meta)\\+/.test(hk.key)) return null;   // 入力中は修飾キー付きだけ有効\nreturn hk;\n}\nfunction installHotkeys(doc, onHit) {\ndoc.addEventListener('keydown', e => {\nconst hk = hotkeyFor(e); if (!hk) return;\ne.preventDefault(); e.stopPropagation(); onHit(hk);\n}, true);\n}\n// ---- 回線速度(追加の通信なしで推定) ----\n// 読み込み済みページの転送時間から推定し、Service Worker とサーバーにも共有する\nfunction isLow() {\nconst k = LS.get('yl_kbps', null), c = navigator.connection;\nreturn !!((c && (c.saveData || c.downlink <= 0.5)) || (k !== null && k < LS.get('yl_thresh', 1000)));\n}\nasync function syncMeta() {\nconst skip = LS.get('yl_skipimg', true);\ntry { document.cookie = 'lb_skip=' + (isLow() && skip ? 1 : 0) + '; Path=/; Max-Age=86400; SameSite=Lax'; } catch {} try { document.cookie = 'lb_ads=' + (LS.get('yl_adblock', true) ? 1 : 0) + '; Path=/; Max-Age=31536000; SameSite=Lax'; } catch {}\ntry {\nconst c = await caches.open('meta-v1');\nawait c.put('/__meta', new Response(JSON.stringify({ k: LS.get('yl_kbps', null), low: LS.get('yl_thresh', 1000), skip, reval: LS.get('yl_reval', 'auto') })));\n} catch {}\n}\nfunction noteSpeed(win) {\ntry {\n// ページ全体(本体+読み込んだ部品)の転送量 ÷ 転送にかかった時間。並列読み込みでも実効速度が出る\nconst p = win.performance, nav = p.getEntriesByType('navigation')[0];\nlet bytes = 0, t0 = Infinity, t1 = 0;\nfor (const e of [nav].concat(p.getEntriesByType('resource'))) {\nif (!e || !e.transferSize || e.responseEnd <= e.responseStart) continue;      // 保存済み(0)・計測不能は除外\nbytes += e.transferSize; t0 = Math.min(t0, e.responseStart); t1 = Math.max(t1, e.responseEnd);\n}\nconst ms = t1 - t0;\nif (bytes < 8000 || ms < 80) return false;\npushSpeed(bytes * 8 / ms); return true;\n} catch { return false; }\n}\n// 直近6回の中央値を採用(1回だけ極端な値が出ても判定が揺れない)\nfunction pushSpeed(k) {\nconst h = LS.get('yl_ks', []).concat(Math.round(k)).slice(-6), s = h.slice().sort((a, b) => a - b);\nLS.set('yl_ks', h); LS.set('yl_kt', Date.now());\nLS.set('yl_kbps', s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2));\nsyncMeta();\n}\n// 実測が無い/古いときだけ、小さなデータ(約6KB)で測る。往復遅延を差し引く\nasync function probeSpeed() {\nif (!navigator.onLine || Date.now() - LS.get('yl_kt', 0) < 600000) return;\ntry {\nconst t = async n => { const a = performance.now(); const r = await fetch('/__ping?n=' + n + '&r=' + Math.random(), { cache: 'no-store' }); await r.arrayBuffer(); return performance.now() - a; };\nconst rtt = await t(1), ms = await t(6000);\nif (ms - rtt > 20) pushSpeed(6000 * 8 / (ms - rtt)); else pushSpeed(20000);\n} catch {}\n}\nfunction speedLabel() {\nconst k = LS.get('yl_kbps', null), c = navigator.connection;\nif (!navigator.onLine) return 'オフライン';\nif (k === null) return c && c.downlink ? '約 ' + c.downlink + ' Mbps' : '測定中…';\nreturn '約 ' + (k >= 1000 ? (k / 1000).toFixed(1) + ' Mbps' : Math.round(k) + ' kbps');\n}\n</script><script>const $ = id => document.getElementById(id);\nlet tt; const toast = m => { const t = $('toast'); t.textContent = m; t.style.opacity = .95; clearTimeout(tt); tt = setTimeout(() => (t.style.opacity = 0), 1800); };\nconst fixUrl = s => { s = s.trim(); if (!s) return ''; return /^https?:\\/\\//i.test(s) ? s : 'https://' + s; };\nconst validUrl = s => { try { return /^https?:$/.test(new URL(s).protocol); } catch { return false; } };\n// ---- 表示モード / 検索エンジン ----\n$('mode').value = LS.get('yl_default', 'lite');\n$('mode').onchange = () => { LS.set('yl_default', $('mode').value); toast('保存しました'); };\n$('low').value = LS.get('yl_thresh', 1000);\n$('low').onchange = () => { const v = Math.min(50000, Math.max(50, +$('low').value || 1000)); $('low').value = v; LS.set('yl_thresh', v); syncMeta(); toast('保存しました'); };\n$('skipimg').checked = LS.get('yl_skipimg', true);\n$('skipimg').onchange = () => { LS.set('yl_skipimg', $('skipimg').checked); syncMeta(); toast('保存しました'); };\n$('adblock').checked = LS.get('yl_adblock', true);\n$('adblock').onchange = () => { LS.set('yl_adblock', $('adblock').checked); syncMeta(); toast('保存しました'); };\n$('reval').value = LS.get('yl_reval', 'auto');\n$('reval').onchange = () => { LS.set('yl_reval', $('reval').value); syncMeta(); toast('保存しました'); };\nfor (const [k, e] of Object.entries(ENGINES)) { const o = document.createElement('option'); o.value = k; o.textContent = e.name; $('engine').append(o); }\n$('engine').value = LS.get('yl_engine', 'ddg');\n$('engine').onchange = () => { LS.set('yl_engine', $('engine').value); toast('保存しました'); };\n// ---- ショートカットキー ----\nlet keys = LS.get('yl_keys', []);\nconst saveKeys = () => LS.set('yl_keys', keys.filter(k => k.key || k.url));\nfunction renderKeys() {\nconst box = $('hk'); box.textContent = '';\nconst count = {}; keys.forEach(k => { if (k.key) count[k.key] = (count[k.key] || 0) + 1; });\nif (!keys.length) { const p = document.createElement('p'); p.textContent = 'まだ設定がありません。'; box.append(p); }\nkeys.forEach((k, i) => {\nconst row = document.createElement('div'); row.className = 'hk-row';\nconst kb = document.createElement('button'); kb.type = 'button'; kb.className = 'keybtn'; kb.textContent = k.key || 'キーを設定';\nkb.onclick = () => record(kb, i);\nconst url = document.createElement('input'); url.className = 'txt'; url.placeholder = 'https://example.com'; url.value = k.url || '';\nurl.onchange = () => { k.url = fixUrl(url.value); url.value = k.url; url.classList.toggle('bad', !!k.url && !validUrl(k.url)); saveKeys(); toast('保存しました'); };\nif (k.url && !validUrl(k.url)) url.classList.add('bad');\nconst md = document.createElement('select');\n[['default', '既定のモード'], ...MODE_OPTIONS].forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; md.append(o); });\nmd.value = k.mode || 'default'; md.onchange = () => { k.mode = md.value; saveKeys(); toast('保存しました'); };\nconst del = document.createElement('button'); del.type = 'button'; del.className = 'sbtn'; del.textContent = '削除';\ndel.onclick = () => { keys.splice(i, 1); saveKeys(); renderKeys(); };\nrow.append(kb, url, md, del);\nif (k.key && count[k.key] > 1) { row.classList.add('bad'); const w = document.createElement('div'); w.className = 'warn'; w.textContent = 'このキーは重複しています(上にあるものが優先されます)'; box.append(row, w); }\nelse box.append(row);\n});\n}\nfunction record(btn, i) {\nwindow.__recording = true; btn.classList.add('rec'); btn.textContent = 'キーを押してください…';\nconst done = () => { window.__recording = false; removeEventListener('keydown', on, true); renderKeys(); };\nconst on = e => {\nif (isModifierKey(e)) return;\ne.preventDefault(); e.stopPropagation();\nif (e.key !== 'Escape') { keys[i].key = keyName(e); saveKeys(); toast('キーを設定: ' + keys[i].key); }\ndone();\n};\naddEventListener('keydown', on, true);\n}\n$('hk-add').onclick = () => { keys.push({ key: '', url: '', mode: 'default' }); renderKeys(); };\nrenderKeys();\n// ---- サイト別モード ----\nfunction renderPrefs() {\nconst box = $('prefs'); box.textContent = '';\nconst prefs = LS.get('yl_pref', {}), hosts = Object.keys(prefs);\nif (!hosts.length) { const p = document.createElement('p'); p.textContent = 'ありません。閲覧画面の「通常で開く / 軽量で開く」を押すと、そのサイトの設定が追加されます。'; box.append(p); return; }\nhosts.forEach(h => {\nconst row = document.createElement('div'); row.className = 'set-row';\nconst n = document.createElement('span'); n.textContent = h; n.style.flex = '1';\nconst s = document.createElement('select');\nMODE_OPTIONS.forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; s.append(o); });\ns.value = prefs[h]; s.onchange = () => { const p = LS.get('yl_pref', {}); p[h] = s.value; LS.set('yl_pref', p); toast('保存しました'); };\nconst d = document.createElement('button'); d.type = 'button'; d.className = 'sbtn'; d.textContent = '削除';\nd.onclick = () => { const p = LS.get('yl_pref', {}); delete p[h]; LS.set('yl_pref', p); renderPrefs(); };\nrow.append(n, s, d); box.append(row);\n});\n}\nrenderPrefs();\n// ---- データ ----\nconst dropCaches = async () => { for (const k of ['lite-v1', 'pages-v1', 'skx-v1']) { try { await caches.delete(k); } catch {} } };\n$('d-hist').onclick = () => { if (confirm('履歴を削除しますか?')) { LS.set('yl_hist', []); toast('削除しました'); } };\n$('d-bm').onclick = () => { if (confirm('ブックマークを削除しますか?')) { LS.set('yl_bm', []); toast('削除しました'); } };\n$('d-cache').onclick = async () => { if (confirm('保存したページを削除します。オフラインで開けなくなります。')) { await dropCaches(); toast('削除しました'); } };\n$('d-all').onclick = async () => {\nif (!confirm('履歴・ブックマーク・ショートカット・設定・保存ページをすべて削除します。')) return;\nObject.keys(localStorage).filter(k => k.startsWith('yl_')).forEach(k => localStorage.removeItem(k));\nawait dropCaches(); location.reload();\n};\n</script> </body></html>\n",
    "/lite.js": "function lbLoad(e){var s=e.getAttribute('data-s');if(!s||e.getAttribute('data-d'))return;e.setAttribute('data-d','1');var i=new Image();i.alt=e.getAttribute('data-a')||'';i.onload=function(){e.replaceWith(i)};i.onerror=function(){e.textContent='⚠ 読込失敗'};i.src=s;e.textContent='読込中…'}document.addEventListener('click',function(v){var t=v.target.closest&&v.target.closest('.lb-img');if(t){v.preventDefault();lbLoad(t)}});document.addEventListener('submit',function(v){if(v.target.getAttribute('data-p')){v.preventDefault();alert('軽量モードでは送信(POST)できません。上の「通常で開く」を押してください。')}});window.lbLoadAll=function(){document.querySelectorAll('.lb-img').forEach(lbLoad)};",
    "/lite.css": ":root{color-scheme:light dark;--bg:#fff;--fg:#1b1b1b;--l:#1a56db;--b:#ddd}@media(prefers-color-scheme:dark){:root{--bg:#15171a;--fg:#e6e6e6;--l:#7aa7ff;--b:#333}}body{margin:0 auto;max-width:46rem;padding:12px;font:16px/1.7 system-ui,sans-serif;background:var(--bg);color:var(--fg);word-break:break-word}a{color:var(--l)}img{max-width:100%}table{border-collapse:collapse;display:block;overflow-x:auto}td,th{border:1px solid var(--b);padding:4px 8px}input,button,select,textarea{font:inherit;max-width:100%;margin:2px 0}pre{overflow:auto}.lb-img{display:inline-block;border:1px dashed var(--b);padding:2px 8px;border-radius:6px;font-size:13px;cursor:pointer;margin:2px 0}",
    "/sw.js": "// 軽量モード + アプリ本体のキャッシュ用 Service Worker (scope: /)\nconst SHELL = 'shell-v5', LITE = 'lite-v1', LIB = 'uvlib-v1', SKX = 'skx-v1', MAX_LITE = 500;\nconst CACHEABLE = ['document', 'iframe', 'style', 'script', 'image', 'font'];   // fetch/XHR(API)は保存しない\nconst SHELL_FILES = ['/', '/frame.html', '/settings.html', '/lite.css', '/lite.js'];\n// 回線速度などの共有情報(ページ側が Cache Storage に書き込む)。SWが再起動しても失われない\nasync function net_() {\n  let m = {}; try { const r = await (await caches.open('meta-v1')).match('/__meta'); if (r) m = await r.json(); } catch {}\n  const cn = self.navigator && navigator.connection, k = m.k == null ? null : m.k, low = m.low || 1000;\n  const slow = !!((cn && (cn.saveData || cn.downlink <= 0.5)) || (k !== null && k < low));\n  return { slow, fast: !slow && k !== null && k >= low, skip: m.skip !== false, reval: m.reval || 'auto' };\n}\nself.addEventListener('install', e => {\n  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));\n});\nself.addEventListener('activate', e => {\n  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => /^shell-v[1-4]$/.test(k)).map(k => caches.delete(k)))).then(() => self.clients.claim()));\n});\nasync function trim(cache) {\n  const keys = await cache.keys();\n  if (keys.length > MAX_LITE) await Promise.all(keys.slice(0, keys.length - MAX_LITE).map(k => cache.delete(k)));\n}\nasync function lite(e) {\n  const u = new URL(e.request.url);\n  const fresh = u.searchParams.get('fresh') === '1';\n  u.searchParams.delete('fresh');\n  const key = u.href, cache = await caches.open(LITE);\n  const hit = fresh ? null : await cache.match(key);\n  const net = async () => {\n    const r = await fetch(key, { cache: 'no-store' });\n    if (r.status === 200 && !r.redirected) { await cache.put(key, r.clone()); trim(cache); }\n    return r;\n  };\n  const sp = await net_();\n  if (hit) { if (sp.fast && sp.reval === 'auto' && navigator.onLine) e.waitUntil(net().catch(() => {})); return hit; }\n  try {\n    const limit = sp.slow ? 120000 : 40000;\n    return await Promise.race([net(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), limit))]);\n  } catch {\n    return new Response('<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><body style=\"font:16px system-ui;padding:16px\">オフライン、または取得に失敗しました。<br>このページはまだ保存されていません。</body>',\n      { status: 504, headers: { 'content-type': 'text/html; charset=utf-8' } });\n  }\n}\nasync function skyrox(e) {\n  const req = e.request, cache = await caches.open(SKX);\n  const hit = await cache.match(req.url), sp = await net_();\n  const net = async () => {\n    const r = await fetch(req);\n    if (r.status === 200 && !r.redirected && r.type === 'basic') { await cache.put(req.url, r.clone()); trim(cache); }\n    return r;\n  };\n  if (hit) { if (sp.fast && sp.reval === 'auto' && navigator.onLine) e.waitUntil(net().catch(() => {})); return hit; }\n  if (sp.slow && sp.skip && ['image', 'video', 'audio'].includes(req.destination)) return new Response('', { status: 204 });\n  try {\n    return await Promise.race([net(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), sp.slow ? 90000 : 40000))]);\n  } catch { return new Response('オフライン、または取得に失敗しました。', { status: 504, headers: { 'content-type': 'text/plain; charset=utf-8' } }); }\n}\nself.addEventListener('fetch', e => {\n  const r = e.request, u = new URL(r.url);\n  if (r.method !== 'GET' || u.origin !== location.origin) return;\n  const p = u.pathname;\n  if (p === '/lite') { if (u.searchParams.has('__u')) return; e.respondWith(lite(e)); return; }\n  if (p.startsWith('/uv/service/')) return;\n  if (p.startsWith('/proxy/')) {   // Skyrox互換モード: 訪問済みページ・画像などを端末に保存\n    if (p.startsWith('/proxy/client/') || r.headers.has('range') || !(r.mode === 'navigate' || CACHEABLE.includes(r.destination))) return;\n    e.respondWith(skyrox(e)); return;\n  }\n  if (p.startsWith('/uv/')) {   // UV本体は一度取れば端末に保存\n    e.respondWith(caches.open(LIB).then(async c => {\n      const h = await c.match(r); if (h) return h;\n      const n = await fetch(r); if (n.ok) c.put(r, n.clone()); return n;\n    }));\n    return;\n  }\n  if (SHELL_FILES.includes(p)) {   // アプリ本体: 保存済みを即表示し、裏で更新\n    e.respondWith(caches.open(SHELL).then(async c => {\n      const h = await c.match(p);\n      const upd = fetch(r).then(n => { if (n.ok) c.put(p, n.clone()); return n; });\n      if (h) { e.waitUntil(upd.catch(() => {})); return h; }\n      return upd;\n    }));\n  }\n});\n",
    "/uv-sw.js": "/* global UVServiceWorker, __uv$config */\n// 通常モード用: Ultraviolet + 訪問済みページの端末キャッシュ (scope: /uv/service/)\nimportScripts('/uv/uv.bundle.js');\nimportScripts('/uv/uv.config.js');\nimportScripts(__uv$config.sw);\nconst uv = new UVServiceWorker();\nconst PAGES = 'pages-v1', MAX_ENTRIES = 400, DOC_TTL = 30 * 60 * 1000;\n// ログイン・会員・決済など「状態を持つ」ページ: 保存分を先に出さず、常に最新を取る\nconst AUTH_RE = /log-?in|sign-?in|sign-?up|log-?out|sign-?out|auth|sso|session|account|member|mypage|my-page|user|token|csrf|captcha|password|regist|verify|callback|cart|checkout|admin|dashboard/i;\nasync function net_() {\n  let m = {}; try { const r = await (await caches.open('meta-v1')).match('/__meta'); if (r) m = await r.json(); } catch {}\n  const cn = self.navigator && navigator.connection, k = m.k == null ? null : m.k, low = m.low || 1000;\n  const slow = !!((cn && (cn.saveData || cn.downlink <= 0.5)) || (k !== null && k < low));\n  return { slow, fast: !slow && k !== null && k >= low, skip: m.skip !== false, reval: m.reval || 'auto' };\n}\nself.addEventListener('install', () => self.skipWaiting());\n// 更新時に旧版が保存した画面(ログイン前の画面・古いトークン入り)を一掃する\nself.addEventListener('activate', e => e.waitUntil(caches.delete(PAGES).then(() => self.clients.claim())));\nasync function trim(cache) {\n  const keys = await cache.keys();\n  if (keys.length > MAX_ENTRIES) await Promise.all(keys.slice(0, keys.length - MAX_ENTRIES).map(k => cache.delete(k)));\n}\nconst timeout = ms => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));\nconst FAIL = () => new Response('オフライン、または取得に失敗しました。', { status: 504, headers: { 'content-type': 'text/plain; charset=utf-8' } });\n// UV のURLから元のURLを取り出す\nfunction realUrl(u) {\n  try { return __uv$config.decodeUrl(u.slice(u.indexOf(__uv$config.prefix) + __uv$config.prefix.length)); } catch { return u; }\n}\n// そのサイトの保存済み「画面(HTML)」だけを捨てる (画像・JS・CSSは残すので、低速でもやり直しが軽い)\nasync function purgeDocs(origin) {\n  try {\n    const c = await caches.open(PAGES);\n    for (const k of await c.keys()) {\n      const r = await c.match(k);\n      if (r && r.headers.get('x-lb-o') === origin) await c.delete(k);\n    }\n  } catch {}\n}\nasync function handleProxy(event) {\n  const req = event.request, d = req.destination;\n  let real = '', origin = ''; try { real = realUrl(req.url); origin = new URL(real).origin; } catch {}\n  // ログイン送信などの POST/PUT/DELETE: そのサイトの保存済み画面を捨てる (送信後に「ログイン前の画面」が出るのを防ぐ)\n  if (req.method !== 'GET') { if (origin) event.waitUntil(purgeDocs(origin)); return uv.fetch(event); }\n  if (req.headers.has('range')) return uv.fetch(event);\n  const isDoc = req.mode === 'navigate' || d === 'document' || d === 'iframe';\n  const cacheable = isDoc || ['style', 'script', 'image', 'font'].includes(d);\n  if (!(cacheable || ['video', 'audio'].includes(d))) return uv.fetch(event);   // fetch/XHR(API・ゲーム通信)は保存しない\n  const cache = await caches.open(PAGES);\n  const hit = await cache.match(req.url);\n  const sp = await net_();\n  const auth = isDoc && AUTH_RE.test(real);\n  const network = async () => {\n    const r = await uv.fetch(event);\n    if (cacheable && r && r.status === 200 && r.type !== 'opaque') {\n      if (!isDoc) await cache.put(req.url, r.clone());\n      else if (!auth && !/no-store|private/i.test(r.headers.get('cache-control') || '')) {\n        // 画面は保存時刻とサイトを印として付けて保存する\n        const h = new Headers(r.headers); h.set('x-lb-t', String(Date.now())); h.set('x-lb-o', origin);\n        await cache.put(req.url, new Response(r.clone().body, { status: r.status, statusText: r.statusText, headers: h }));\n      }\n      trim(cache);\n    }\n    return r;\n  };\n\n  if (isDoc) {\n    // 画面(HTML)は「ネットワーク優先」。保存分は、①ログイン系以外で低速かつ30分以内 ②オフライン ③取得失敗・時間切れ のときだけ使う\n    const age = hit ? Date.now() - (+hit.headers.get('x-lb-t') || 0) : Infinity;\n    if (hit && !auth && sp.slow && age < DOC_TTL) return hit;\n    if (hit && !navigator.onLine) return hit;\n    try { return await Promise.race([network(), timeout(sp.slow ? 90000 : 30000)]); }\n    catch { return hit || FAIL(); }\n  }\n\n  // 画像・CSS・JS・フォント・メディア: 保存済みを即表示 (速い回線なら裏で更新)\n  if (hit) { if (sp.fast && sp.reval === 'auto' && navigator.onLine) event.waitUntil(network().catch(() => {})); return hit; }\n  if (sp.slow && sp.skip && ['image', 'video', 'audio'].includes(d)) return new Response(null, { status: 204 });\n  try { return await Promise.race([network(), timeout(sp.slow ? 90000 : 30000)]); }\n  catch { return FAIL(); }\n}\nself.addEventListener('fetch', event => {\n  const url = new URL(event.request.url);\n  if (url.origin === location.origin && url.pathname.startsWith(__uv$config.prefix)) event.respondWith(handleProxy(event));\n});\n",
  };
}

// ================= 同梱モジュール: Skyrox 本体 + sites/* =================
function virtualModules() {
  return {
  './sites/bloxd': (module, exports, require, __dirname) => {
'use strict';

const BLOXD_RELATIVE_RESOURCE_PATCH = String.raw`;(function () {
  'use strict';
  var PREFIX = '/proxy/';
  function upstream() {
    var path = String(window.location.pathname || '');
    if (path.indexOf(PREFIX) !== 0) return null;
    var raw = path.slice(PREFIX.length) + String(window.location.search || '');
    raw = raw.replace(/^(https?):\/(?!\/)/i, '$1://');
    try { return new URL(raw); } catch (error) { return null; }
  }
  function fix(value) {
    if (typeof value !== 'string' || value.charAt(0) !== '/' || value.indexOf('//') === 0 || value.indexOf(PREFIX) === 0) return value;
    var base = upstream();
    if (!base) return value;
    try { return PREFIX + new URL(value, base.origin).href; } catch (error) { return value; }
  }
  function rewrite(root) {
    if (!root || root.nodeType !== 1) return;
    var nodes = [root];
    if (root.querySelectorAll) nodes = nodes.concat(Array.prototype.slice.call(root.querySelectorAll('[src],[href],[poster]')));
    for (var i = 0; i < nodes.length; i += 1) {
      for (var j = 0; j < 3; j += 1) {
        var attr = ['src', 'href', 'poster'][j];
        if (!nodes[i].hasAttribute || !nodes[i].hasAttribute(attr)) continue;
        var before = nodes[i].getAttribute(attr);
        var after = fix(before);
        if (after !== before) nodes[i].setAttribute(attr, after);
      }
    }
  }
  function start() {
    rewrite(document.documentElement);
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i += 1) {
        if (records[i].type === 'attributes') rewrite(records[i].target);
        for (var j = 0; j < records[i].addedNodes.length; j += 1) rewrite(records[i].addedNodes[j]);
      }
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'href', 'poster'] });
  }
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();`;

module.exports = { BLOXD_RELATIVE_RESOURCE_PATCH };
  },

  './sites/bloxd-relay': (module, exports, require, __dirname) => {
'use strict';

module.exports = function register(app, dependencies) {
  const { https, httpsAgent, PROXY_PREFIX, setRelayCors, applyRelayCors, stripHopByHopHeaders } = dependencies;

  // Relay selected Bloxd backend APIs directly. On Cloud Shell, allowing
  // Unblocker to answer an OPTIONS request with a redirect makes the browser reject
  // the preflight. A direct relay keeps the request on this origin and returns CORS
  // headers without attempting to bypass any upstream authentication or challenge.
  app.use(PROXY_PREFIX, relayBloxdBackendApi);
  function relayBloxdBackendApi(req, res, next) {
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method)) return next();
    let rawTarget = req.originalUrl.slice(PROXY_PREFIX.length);
    rawTarget = rawTarget.replace(/^(https?):\/(?!\/)/i, '$1://');

    let target;
    try { target = new URL(rawTarget); } catch { return next(); }

    const hostname = target.hostname.toLowerCase();
    const allowedHosts = new Set([
      'firebaseinstallations.googleapis.com',
      'identitytoolkit.googleapis.com',
      'securetoken.googleapis.com',
      'firebaseremoteconfig.googleapis.com'
    ]);
    if (target.protocol !== 'https:' || !allowedHosts.has(hostname)) return next();

    if (req.method === 'OPTIONS') {
      setRelayCors(req, res);
      return res.status(204).end();
    }

    const headers = Object.create(null);
    const blockedRequestHeaders = new Set([
      'host', 'connection', 'proxy-connection', 'keep-alive',
      'transfer-encoding', 'upgrade', 'origin', 'referer'
    ]);
    for (const [name, value] of Object.entries(req.headers)) {
      if (!blockedRequestHeaders.has(name.toLowerCase()) && value != null) headers[name] = value;
    }
    headers.host = target.host;
    headers.origin = 'https://bloxd.io';
    headers.referer = 'https://bloxd.io/';

    const upstream = https.request(target, {
      method: req.method,
      headers,
      agent: httpsAgent,
      timeout: 30_000
    }, (remote) => {
      const responseHeaders = { ...remote.headers };
      stripHopByHopHeaders(responseHeaders);
      applyRelayCors(req, responseHeaders);
      if (responseHeaders.location) {
        try {
          const redirected = new URL(responseHeaders.location, target);
          if (redirected.protocol === 'https:' && allowedHosts.has(redirected.hostname.toLowerCase())) {
            responseHeaders.location = `${PROXY_PREFIX}${redirected.href}`;
          }
        } catch {}
      }
      res.writeHead(Number(remote.statusCode || 502), responseHeaders);
      if (req.method === 'HEAD') {
        remote.resume();
        res.end();
      } else {
        remote.pipe(res);
      }
    });

    upstream.once('timeout', () => upstream.destroy(Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT' })));
    upstream.once('error', (error) => {
      console.error(JSON.stringify({
        type: 'bloxd-backend-api-error',
        host: hostname,
        code: error.code || 'ERROR',
        path: target.pathname
      }));
      if (!res.headersSent) res.status(502).send('Bad Gateway');
      else res.destroy(error);
    });
    req.once('aborted', () => upstream.destroy());
    req.pipe(upstream);
  }
};
  },

  './sites/mcpedl': (module, exports, require, __dirname) => {
'use strict';

const MCPEDL_CLIENT_RECOVERY = String.raw`;(function () {
  'use strict';

  if (window.location.pathname.toLowerCase().indexOf('mcpedl.com') === -1) return;

  var tries = 0;
  var maxTries = 80;
  var running = false;
  var completed = false;

  function hasFrontpage(store) {
    var submission = store && store.state && store.state.submission;
    var value = submission && submission.frontpageV2;
    return !!(value && value.shelves);
  }

  function recover() {
    if (completed || running) return;
    tries += 1;

    var nuxt = window.$nuxt;
    var store = nuxt && nuxt.$store;
    if (!store || typeof store.dispatch !== 'function') {
      if (tries < maxTries) window.setTimeout(recover, 250);
      return;
    }

    if (hasFrontpage(store)) {
      completed = true;
      return;
    }

    running = true;
    Promise.resolve(store.dispatch('submission/fetchFrontpageV2'))
      .then(function () {
        running = false;
        if (hasFrontpage(store)) {
          completed = true;
          console.info('[proxy] MCPEDL front page recovered');
          return;
        }
        if (tries < maxTries) window.setTimeout(recover, 750);
      })
      .catch(function (error) {
        running = false;
        console.warn('[proxy] MCPEDL front page retry failed', error);
        if (tries < maxTries) window.setTimeout(recover, 1000);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', recover, { once: true });
  } else {
    recover();
  }
})();`;

module.exports = { MCPEDL_CLIENT_RECOVERY };
  },

  './sites/mcpedl-relay': (module, exports, require, __dirname) => {
'use strict';

module.exports = function register(app, dependencies) {
  const { https, httpsAgent, PROXY_PREFIX, sanitizeLocationValue } = dependencies;

  // MCPEDL loads many Nuxt chunks simultaneously. Relay only its static assets
  // directly and retry one safe GET/HEAD once on transient upstream failures.
  app.use(PROXY_PREFIX, relayMcpedlStaticAsset);

  function relayMcpedlStaticAsset(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let target;
    try {
      target = new URL(req.originalUrl.slice(PROXY_PREFIX.length));
    } catch {
      return next();
    }
    const host = target.hostname.toLowerCase();
    if (target.protocol !== 'https:' || (host !== 'mcpedl.com' && host !== 'www.mcpedl.com')) return next();
    if (!target.pathname.startsWith('/_nuxt/') && !target.pathname.startsWith('/js/') && !target.pathname.startsWith('/web/')) return next();
    if (!/\.(?:js|mjs|css|map|woff2?|ttf|otf|eot|png|jpe?g|gif|webp|svg|ico)$/i.test(target.pathname)) return next();
    requestMcpedlStatic(target, req, res, Date.now(), 0);
  }

  function requestMcpedlStatic(target, req, res, startedAt, attempt) {
    if (res.headersSent || res.destroyed) return;
    const headers = Object.create(null);
    for (const name of ['accept','accept-encoding','accept-language','cache-control','if-modified-since','if-none-match','range','user-agent']) {
      if (req.headers[name] != null) headers[name] = req.headers[name];
    }
    headers.host = target.host;
    headers.referer = `${target.origin}/`;

    const upstream = https.request(target, { method: req.method, headers, agent: httpsAgent, timeout: 20_000 }, (remote) => {
      const status = Number(remote.statusCode || 502);
      if (attempt === 0 && [502, 503, 504].includes(status)) {
        remote.resume();
        remote.once('end', () => setTimeout(() => requestMcpedlStatic(target, req, res, startedAt, 1), 150));
        return;
      }
      const responseHeaders = { ...remote.headers };
      for (const name of ['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']) delete responseHeaders[name];
      if (responseHeaders.location != null) responseHeaders.location = sanitizeLocationValue(responseHeaders.location);
      res.writeHead(status, responseHeaders);
      if (req.method === 'HEAD') { remote.resume(); res.end(); } else remote.pipe(res);
      remote.once('end', () => console.log(JSON.stringify({ type:'mcpedl-static', status, attempt, elapsedMs:Date.now()-startedAt, path:target.pathname })));
    });
    upstream.once('timeout', () => upstream.destroy(Object.assign(new Error('upstream timeout'), { code:'ETIMEDOUT' })));
    upstream.once('error', (error) => {
      if (attempt === 0 && !res.headersSent) {
        console.warn(JSON.stringify({ type:'mcpedl-static-retry', code:error.code || 'ERROR', path:target.pathname }));
        setTimeout(() => requestMcpedlStatic(target, req, res, startedAt, 1), 150);
      } else if (!res.headersSent) {
        console.error(JSON.stringify({ type:'mcpedl-static-error', code:error.code || 'ERROR', message:error.message, path:target.pathname }));
        res.status(502).send('Bad Gateway');
      } else res.destroy(error);
    });
    req.once('aborted', () => upstream.destroy());
    upstream.end();
  }
};
  },

  './sites/minecraft': (module, exports, require, __dirname) => {
'use strict';

const MINECRAFT_DOWNLOAD_NAVIGATION_PATCH = String.raw`;(function () {
  'use strict';
  var PREFIX = '/proxy/';

  function upstreamPageUrl() {
    var path = String(window.location.pathname || '');
    if (path.indexOf(PREFIX) !== 0) return null;
    var raw = path.slice(PREFIX.length) + String(window.location.search || '');
    raw = raw.replace(/^(https?):\/(?!\/)/i, '$1://');
    try {
      var url = new URL(raw);
      return /^https?:$/.test(url.protocol) ? url : null;
    } catch (error) {
      return null;
    }
  }

  function isMinecraftPage() {
    var upstream = upstreamPageUrl();
    if (!upstream) return false;
    var host = String(upstream.hostname || '').toLowerCase();
    return host === 'minecraft-mcworld.com' || host === 'www.minecraft-mcworld.com';
  }

  function downloadUrl(postid, type) {
    var target = new URL('https://minecraft-mcworld.com/dl/');
    target.searchParams.set('postid', String(postid));
    target.searchParams.set('type', String(type == null ? 0 : type));
    return PREFIX + target.href;
  }

  function parseInvocation(node) {
    var clickable = node && node.closest
      ? node.closest('[onclick*="download_bt_func"]')
      : null;
    if (!clickable) return null;
    var source = String(clickable.getAttribute('onclick') || '');
    var match = source.match(/download_bt_func\s*\(\s*['"]?(\d+)['"]?\s*,\s*['"]?(\d+)['"]?\s*\)/);
    return match ? { postid: match[1], type: match[2] } : null;
  }

  // Capture phase runs before the page's inline onclick handler.
  document.addEventListener('click', function (event) {
    if (!isMinecraftPage()) return;
    var invocation = parseInvocation(event.target);
    if (!invocation) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    var destination = downloadUrl(invocation.postid, invocation.type);
    console.info('[proxy] Minecraft download navigation:', destination);
    window.location.assign(destination);
  }, true);

  // Also replace the global function for keyboard/programmatic invocations.
  var attempts = 0;
  function installFunctionPatch() {
    attempts += 1;
    if (!isMinecraftPage()) return;
    var original = window.download_bt_func;
    if (typeof original === 'function' && !original.__proxyDownloadPatched) {
      function patched(postid, type) {
        window.location.assign(downloadUrl(postid, type));
      }
      patched.__proxyDownloadPatched = true;
      patched.__proxyOriginal = original;
      window.download_bt_func = patched;
      return;
    }
    if (attempts < 300) window.setTimeout(installFunctionPatch, 100);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installFunctionPatch, { once: true });
  } else {
    installFunctionPatch();
  }
})();`;

module.exports = { MINECRAFT_DOWNLOAD_NAVIGATION_PATCH };
  },

  './sites/navigation': (module, exports, require, __dirname) => {
'use strict';

const GLOBAL_PROXIED_NAVIGATION_PATCH = String.raw`;(function () {
  'use strict';
  var PREFIX = '/proxy/';

  function upstreamPageUrl() {
    var path = String(window.location.pathname || '');
    if (path.indexOf(PREFIX) !== 0) return null;
    var raw = path.slice(PREFIX.length) + String(window.location.search || '') + String(window.location.hash || '');
    raw = raw.replace(/^(https?):\/(?!\/)/i, '$1://');
    try {
      var url = new URL(raw);
      return /^https?:$/.test(url.protocol) ? url : null;
    } catch (error) {
      return null;
    }
  }

  function unwrapDuckDuckGoRedirect(url) {
    var host = String(url.hostname || '').toLowerCase();
    if (host !== 'duckduckgo.com' && host !== 'www.duckduckgo.com' && host !== 'links.duckduckgo.com') return url;
    var encoded = url.searchParams.get('uddg');
    if (!encoded) return url;
    try {
      var destination = new URL(encoded);
      if (/^https?:$/.test(destination.protocol)) return destination;
    } catch (error) {}
    return url;
  }

  function proxiedHref(anchor) {
    if (!anchor || !anchor.getAttribute) return null;
    var raw = anchor.getAttribute('href');
    if (!raw || raw.charAt(0) === '#' || /^(?:javascript|mailto|tel|data|blob):/i.test(raw)) return null;
    if (raw.indexOf(PREFIX) === 0) return null;

    var upstream = upstreamPageUrl();
    if (!upstream) return null;

    var target;
    try {
      target = new URL(raw, upstream);
    } catch (error) {
      return null;
    }
    if (!/^https?:$/.test(target.protocol)) return null;
    if (target.origin === window.location.origin && target.pathname.indexOf(PREFIX) === 0) return null;
    target = unwrapDuckDuckGoRedirect(target);
    return PREFIX + target.href;
  }

  function rewriteAnchor(event) {
    var node = event.target;
    var anchor = node && node.closest ? node.closest('a[href]') : null;
    if (!anchor) return;
    var fixed = proxiedHref(anchor);
    if (fixed) anchor.setAttribute('href', fixed);
  }

  // pointerdown/mousedown makes middle-click, Ctrl/Cmd-click and context-menu
  // "open in new tab" see the rewritten href before the browser navigates.
  document.addEventListener('pointerdown', rewriteAnchor, true);
  document.addEventListener('mousedown', rewriteAnchor, true);
  document.addEventListener('contextmenu', rewriteAnchor, true);
  document.addEventListener('click', rewriteAnchor, true);
  document.addEventListener('auxclick', rewriteAnchor, true);

  function rewriteForm(form) {
    if (!form || !form.getAttribute) return;
    var raw = form.getAttribute('action') || window.location.href;
    var fixed = proxiedHref({ getAttribute: function () { return raw; } });
    if (fixed) form.setAttribute('action', fixed);
  }

  document.addEventListener('submit', function (event) {
    var form = event.target;
    rewriteForm(form);
  }, true);

  if (window.HTMLFormElement && window.HTMLFormElement.prototype.submit) {
    var originalSubmit = window.HTMLFormElement.prototype.submit;
    window.HTMLFormElement.prototype.submit = function () {
      rewriteForm(this);
      return originalSubmit.call(this);
    };
  }

  if (typeof window.open === 'function') {
    var originalOpen = window.open;
    window.open = function (url, target, features) {
      var fixed = proxiedHref({ getAttribute: function () { return url; } });
      return originalOpen.call(window, fixed || url, target, features);
    };
  }

  if (window.navigation && window.navigation.addEventListener) {
    window.navigation.addEventListener('navigate', function (event) {
      if (!event.canIntercept || !event.destination) return;
      var fixed = proxiedHref({
        getAttribute: function () { return event.destination.url; }
      });
      if (!fixed) return;
      event.intercept({
        handler: function () {
          window.location.assign(fixed);
        }
      });
    });
  }

  if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
    navigator.serviceWorker.getRegistrations()
      .then(function (registrations) {
        return Promise.all(registrations.map(function (registration) {
          var workers = [registration.active, registration.waiting, registration.installing];
          var isProxyWorker = workers.some(function (worker) {
            if (!worker) return false;
            var workerUrl = new URL(worker.scriptURL);
            return workerUrl.origin === window.location.origin &&
              workerUrl.pathname === '/proxy-service-worker.js';
          });
          return isProxyWorker ? registration.unregister() : Promise.resolve();
        }));
      })
      .then(function () {
        if (!navigator.serviceWorker.controller) return;
        var reloadKey = '__skyrox_proxy_sw_cleanup_reload';
        try {
          if (sessionStorage.getItem(reloadKey)) return;
          sessionStorage.setItem(reloadKey, '1');
          window.location.reload();
        } catch (error) {
          console.warn('[proxy] Could not reload after service worker cleanup:', error);
        }
      })
      .catch(function (error) {
        console.warn('[proxy] Service worker cleanup failed:', error);
      });
  }
})();`;

module.exports = { GLOBAL_PROXIED_NAVIGATION_PATCH };
  },

  './sites/poki': (module, exports, require, __dirname) => {
'use strict';

const POKI_CLEAN_NAVIGATION_PATCH = String.raw`;(function () {
  'use strict';
  var PREFIX = '/proxy/';
  function cleanPokiUrl(value) {
    if (!value) return null;
    var raw = String(value);
    if (raw.indexOf(PREFIX) === 0) raw = raw.slice(PREFIX.length);
    try {
      var url = new URL(raw, 'https://poki.com');
      var host = String(url.hostname || '').toLowerCase();
      if ((host === 'poki.com' || host === 'www.poki.com') &&
          (url.pathname === '/jp' || url.pathname.indexOf('/jp/') === 0)) {
        return url.pathname + url.search + url.hash;
      }
    } catch (error) {}
    return null;
  }
  function rewrite(root) {
    if (!root) return;
    var nodes = [];
    if (root.nodeType === 1 && root.matches && root.matches('a[href]')) nodes.push(root);
    if (root.querySelectorAll) nodes = nodes.concat(Array.prototype.slice.call(root.querySelectorAll('a[href]')));
    for (var i = 0; i < nodes.length; i += 1) {
      var clean = cleanPokiUrl(nodes[i].getAttribute('href'));
      if (clean) nodes[i].setAttribute('href', clean);
    }
  }
  function start() {
    rewrite(document.documentElement);
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i += 1) {
        if (records[i].type === 'attributes') rewrite(records[i].target);
        for (var j = 0; j < records[i].addedNodes.length; j += 1) rewrite(records[i].addedNodes[j]);
      }
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['href'] });
  }
  document.addEventListener('click', function (event) {
    var anchor = event.target && event.target.closest ? event.target.closest('a[href], [data-tile-url]') : null;
    if (!anchor) return;
    var clean = cleanPokiUrl(anchor.getAttribute('href') || anchor.getAttribute('data-tile-url'));
    if (!clean) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    window.location.assign(clean);
  }, true);
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();`;

module.exports = { POKI_CLEAN_NAVIGATION_PATCH };
  },

  './sites/poki-auth-relay': (module, exports, require, __dirname) => {
'use strict';

module.exports = function register(app, dependencies) {
  const { https, httpsAgent, PROXY_PREFIX, POKI_AUTH_HOSTS, POKI_WEB_ORIGIN, setRelayCors, applyRelayCors, stripHopByHopHeaders, parseCookies } = dependencies;

  // Relay Poki authentication directly. Keeping this endpoint out of the generic
  // HTML proxy avoids losing Set-Cookie headers and preserves the upstream request
  // method/body. Authentication is not bypassed: an anonymous whoami still returns 401.
  app.use(PROXY_PREFIX, relayPokiAuthApi);
  function relayPokiAuthApi(req, res, next) {
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method)) return next();
    let rawTarget = req.originalUrl.slice(PROXY_PREFIX.length);
    rawTarget = rawTarget.replace(/^(https?):\/(?!\/)/i, '$1://');
    let target;
    try { target = new URL(rawTarget); } catch { return next(); }
    if (target.protocol !== 'https:' || !POKI_AUTH_HOSTS.has(target.hostname.toLowerCase())) return next();

    if (req.method === 'OPTIONS') {
      setRelayCors(req, res);
      return res.status(204).end();
    }

    const headers = Object.create(null);
    for (const name of [
      'accept', 'accept-encoding', 'accept-language', 'authorization',
      'content-type', 'content-length', 'user-agent', 'x-csrf-token', 'x-xsrf-token'
    ]) {
      if (req.headers[name] != null) headers[name] = req.headers[name];
    }
    const upstreamCookie = decodePokiAuthCookies(req.headers.cookie);
    if (upstreamCookie) headers.cookie = upstreamCookie;
    headers.host = target.host;
    headers.origin = POKI_WEB_ORIGIN;
    headers.referer = `${POKI_WEB_ORIGIN}/`;

    const upstream = https.request(target, {
      method: req.method,
      headers,
      agent: httpsAgent,
      timeout: 30_000
    }, (remote) => {
      const responseHeaders = { ...remote.headers };
      stripHopByHopHeaders(responseHeaders);
      responseHeaders['cache-control'] = 'private, no-store, max-age=0';
      responseHeaders.pragma = 'no-cache';
      delete responseHeaders.expires;
      applyRelayCors(req, responseHeaders);

      const setCookies = remote.headers['set-cookie'];
      if (setCookies) {
        responseHeaders['set-cookie'] = (Array.isArray(setCookies) ? setCookies : [setCookies])
          .map(encodePokiAuthSetCookie);
      }
      if (responseHeaders.location) {
        try {
          responseHeaders.location = `${PROXY_PREFIX}${new URL(responseHeaders.location, target).href}`;
        } catch {}
      }
      res.writeHead(Number(remote.statusCode || 502), responseHeaders);
      if (req.method === 'HEAD') { remote.resume(); res.end(); }
      else remote.pipe(res);
    });
    upstream.once('timeout', () => upstream.destroy(Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT' })));
    upstream.once('error', (error) => {
      console.error(JSON.stringify({ type: 'poki-auth-api-error', code: error.code || 'ERROR', path: target.pathname }));
      if (!res.headersSent) res.status(502).send('Bad Gateway');
      else res.destroy(error);
    });
    req.once('aborted', () => upstream.destroy());
    req.pipe(upstream);
  }

  const POKI_AUTH_COOKIE_PREFIX = '__poki_auth__';
  function encodePokiAuthSetCookie(cookie) {
    const parts = String(cookie).split(';');
    const first = parts.shift();
    const separator = first.indexOf('=');
    if (separator < 1) return cookie;
    const name = first.slice(0, separator).trim();
    const value = first.slice(separator + 1);
    const attributes = parts
      .map((part) => part.trim())
      .filter((part) => !/^domain=/i.test(part) && !/^path=/i.test(part) && !/^samesite=/i.test(part));
    attributes.push('Path=/');
    attributes.push('SameSite=Lax');
    if (!attributes.some((part) => /^secure$/i.test(part))) attributes.push('Secure');
    return `${POKI_AUTH_COOKIE_PREFIX}${encodeURIComponent(name)}=${value}; ${attributes.join('; ')}`;
  }

  function decodePokiAuthCookies(header) {
    const cookies = parseCookies(header);
    const result = [];
    for (const [name, value] of Object.entries(cookies)) {
      if (!name.startsWith(POKI_AUTH_COOKIE_PREFIX)) continue;
      let upstreamName;
      try { upstreamName = decodeURIComponent(name.slice(POKI_AUTH_COOKIE_PREFIX.length)); }
      catch { continue; }
      if (upstreamName) result.push(`${upstreamName}=${value}`);
    }
    return result.join('; ');
  }
};
  },

  './sites/typingerz': (module, exports, require, __dirname) => {
'use strict';

const TYPINGERZ_FORCE_PROXY_PATCH = String.raw`;(function () {
  'use strict';
  var PREFIX = '/proxy/';
  var HOST_RE = /^(?:www\.)?typingerz\.com$/i;
  var ABSOLUTE_RE = /https?:\\?\/\\?\/(?:www\.)?typingerz\.com(?=[\\/"'\\s),]|$)/ig;

  function isTypingerPage() {
    var path = String(window.location.pathname || '');
    return path.indexOf(PREFIX + 'https://typingerz.com/') === 0 ||
      path.indexOf(PREFIX + 'https://www.typingerz.com/') === 0 ||
      path.indexOf(PREFIX + 'http://typingerz.com/') === 0 ||
      path.indexOf(PREFIX + 'http://www.typingerz.com/') === 0;
  }

  function proxyUrl(value) {
    if (value == null) return value;
    var raw = String(value);
    if (!raw || raw.indexOf(PREFIX) === 0 || /^(?:data|blob|javascript|mailto|tel):/i.test(raw)) return value;
    try {
      var url = new URL(raw, 'https://typingerz.com/');
      if (HOST_RE.test(url.hostname) && /^https?:$/.test(url.protocol)) return PREFIX + url.href;
    } catch (error) {}
    return value;
  }

  function proxyText(value) {
    if (value == null) return value;
    return String(value).replace(ABSOLUTE_RE, function (match, offset, whole) {
      if (offset >= PREFIX.length && whole.slice(offset - PREFIX.length, offset) === PREFIX) return match;
      return PREFIX + match.replace(/\\\\\//g, '/');
    });
  }

  if (!isTypingerPage()) return;

  var originalSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    var key = String(name).toLowerCase();
    if (key === 'src' || key === 'href' || key === 'poster' || key === 'action' || key === 'formaction') {
      value = proxyUrl(value);
    } else if (key === 'srcset' || key === 'style') {
      value = proxyText(value);
    }
    return originalSetAttribute.call(this, name, value);
  };

  function patchUrlProperty(prototype, property) {
    if (!prototype) return;
    var descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(prototype, property); } catch (error) { return; }
    if (!descriptor || typeof descriptor.set !== 'function' || typeof descriptor.get !== 'function') return;
    try {
      Object.defineProperty(prototype, property, {
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        get: descriptor.get,
        set: function (value) { return descriptor.set.call(this, proxyUrl(value)); }
      });
    } catch (error) {}
  }

  patchUrlProperty(window.HTMLImageElement && HTMLImageElement.prototype, 'src');
  patchUrlProperty(window.HTMLScriptElement && HTMLScriptElement.prototype, 'src');
  patchUrlProperty(window.HTMLIFrameElement && HTMLIFrameElement.prototype, 'src');
  patchUrlProperty(window.HTMLSourceElement && HTMLSourceElement.prototype, 'src');
  patchUrlProperty(window.HTMLLinkElement && HTMLLinkElement.prototype, 'href');
  patchUrlProperty(window.HTMLAnchorElement && HTMLAnchorElement.prototype, 'href');
  patchUrlProperty(window.HTMLFormElement && HTMLFormElement.prototype, 'action');

  if (window.CSSStyleDeclaration && CSSStyleDeclaration.prototype.setProperty) {
    var originalSetProperty = CSSStyleDeclaration.prototype.setProperty;
    CSSStyleDeclaration.prototype.setProperty = function (name, value, priority) {
      return originalSetProperty.call(this, name, proxyText(value), priority);
    };
  }

  function rewrite(root) {
    if (!root) return;
    var nodes = [];
    if (root.nodeType === 1) nodes.push(root);
    if (root.querySelectorAll) nodes = nodes.concat(Array.prototype.slice.call(root.querySelectorAll('[src],[href],[poster],[srcset],[style],form[action]')));
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      var attrs = ['src', 'href', 'poster', 'action', 'formaction'];
      for (var j = 0; j < attrs.length; j += 1) {
        var attr = attrs[j];
        if (!node.hasAttribute || !node.hasAttribute(attr)) continue;
        var before = node.getAttribute(attr);
        var after = proxyUrl(before);
        if (after !== before) originalSetAttribute.call(node, attr, after);
      }
      for (var k = 0; k < 2; k += 1) {
        var textAttr = k ? 'style' : 'srcset';
        if (!node.hasAttribute || !node.hasAttribute(textAttr)) continue;
        var textBefore = node.getAttribute(textAttr);
        var textAfter = proxyText(textBefore);
        if (textAfter !== textBefore) originalSetAttribute.call(node, textAttr, textAfter);
      }
    }
  }

  function start() {
    rewrite(document.documentElement);
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i += 1) {
        if (records[i].type === 'attributes') rewrite(records[i].target);
        for (var j = 0; j < records[i].addedNodes.length; j += 1) rewrite(records[i].addedNodes[j]);
      }
    }).observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['src', 'href', 'poster', 'srcset', 'style', 'action', 'formaction']
    });
  }

  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();`;

const TYPINGERZ_NETWORK_PATCH = String.raw`;(function () {
  'use strict';

  var PREFIX = '/proxy/';
  var TYPINGER_HOST_RE = /^(?:www\.)?typingerz\.com$/i;

  function getUpstreamPageUrl() {
    var pathname = String(window.location.pathname || '');
    if (pathname.indexOf(PREFIX) !== 0) return null;

    var raw = pathname.slice(PREFIX.length) + String(window.location.search || '');
    raw = raw.replace(/^(https?):\/(?!\/)/i, '$1://');

    try {
      var url = new URL(raw);
      if (/^https?:$/.test(url.protocol) && TYPINGER_HOST_RE.test(url.hostname)) return url;
    } catch (error) {}
    return null;
  }

  function isAlreadyProxied(value) {
    var raw = String(value || '');
    return raw.indexOf(PREFIX) === 0 || raw.indexOf(window.location.origin + PREFIX) === 0;
  }

  function resolveUpstreamUrl(value) {
    if (value == null) return value;
    var raw = String(value);
    if (!raw || isAlreadyProxied(raw) || /^(?:data|blob|javascript|mailto|tel):/i.test(raw)) return value;

    var upstreamPage = getUpstreamPageUrl();
    if (!upstreamPage) return value;

    try {
      var parsed = new URL(raw, window.location.href);
      var resolved;

      if (parsed.origin === window.location.origin) {
        resolved = new URL(parsed.pathname + parsed.search + parsed.hash, upstreamPage.origin);
      } else {
        resolved = new URL(raw, upstreamPage);
      }

      if (!/^https?:$/.test(resolved.protocol)) return value;
      return PREFIX + resolved.href;
    } catch (error) {
      return value;
    }
  }

  function resolveWebSocketUrl(value) {
    if (value == null) return value;
    var raw = String(value);
    if (!raw) return value;

    if (raw.indexOf('ws://' + window.location.host + PREFIX) === 0 ||
        raw.indexOf('wss://' + window.location.host + PREFIX) === 0) {
      return value;
    }

    var upstreamPage = getUpstreamPageUrl();
    if (!upstreamPage) return value;

    try {
      var parsed;
      if (/^wss?:/i.test(raw)) {
        parsed = new URL(raw);
      } else {
        var websocketBase = upstreamPage.protocol === 'https:'
          ? 'wss://' + upstreamPage.host
          : 'ws://' + upstreamPage.host;
        parsed = new URL(raw, websocketBase);
      }

      if (parsed.host === window.location.host) {
        parsed.host = upstreamPage.host;
        parsed.protocol = upstreamPage.protocol === 'https:' ? 'wss:' : 'ws:';
      }

      var innerProtocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
      var innerUrl = innerProtocol + '//' + parsed.host + parsed.pathname + parsed.search + parsed.hash;
      var proxyProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return proxyProtocol + '//' + window.location.host + PREFIX + innerUrl;
    } catch (error) {
      return value;
    }
  }

  if (typeof window.fetch === 'function') {
    var originalFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        if (typeof input === 'string' || input instanceof URL) {
          input = resolveUpstreamUrl(input);
        } else if (typeof Request !== 'undefined' && input instanceof Request) {
          var fixedRequestUrl = resolveUpstreamUrl(input.url);
          if (fixedRequestUrl !== input.url) input = new Request(fixedRequestUrl, input);
        }
      } catch (error) {
        console.warn('[proxy] fetch URL rewrite failed:', error);
      }
      return originalFetch.call(this, input, init);
    };
  }

  if (window.XMLHttpRequest && XMLHttpRequest.prototype.open) {
    var originalXhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, async, user, password) {
      return originalXhrOpen.call(this, method, resolveUpstreamUrl(url), async !== false, user, password);
    };
  }

  if (typeof window.EventSource === 'function') {
    var OriginalEventSource = window.EventSource;
    function ProxyEventSource(url, options) {
      return new OriginalEventSource(resolveUpstreamUrl(url), options);
    }
    ProxyEventSource.prototype = OriginalEventSource.prototype;
    try { Object.setPrototypeOf(ProxyEventSource, OriginalEventSource); } catch (error) {}
    window.EventSource = ProxyEventSource;
  }

  if (window.navigator && typeof navigator.sendBeacon === 'function') {
    var originalSendBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      return originalSendBeacon(resolveUpstreamUrl(url), data);
    };
  }

  if (typeof window.WebSocket === 'function') {
    var OriginalWebSocket = window.WebSocket;
    function ProxyWebSocket(url, protocols) {
      var fixedUrl = resolveWebSocketUrl(url);
      console.info('[proxy] WebSocket URL:', String(url), '->', String(fixedUrl));
      if (arguments.length >= 2 && protocols !== undefined) return new OriginalWebSocket(fixedUrl, protocols);
      return new OriginalWebSocket(fixedUrl);
    }
    ProxyWebSocket.prototype = OriginalWebSocket.prototype;
    try {
      Object.defineProperties(ProxyWebSocket, {
        CONNECTING: { value: OriginalWebSocket.CONNECTING },
        OPEN: { value: OriginalWebSocket.OPEN },
        CLOSING: { value: OriginalWebSocket.CLOSING },
        CLOSED: { value: OriginalWebSocket.CLOSED }
      });
      Object.setPrototypeOf(ProxyWebSocket, OriginalWebSocket);
    } catch (error) {}
    window.WebSocket = ProxyWebSocket;
  }

  console.info('[proxy] Typinger Z network patch installed');
})();`;

module.exports = { TYPINGERZ_FORCE_PROXY_PATCH, TYPINGERZ_NETWORK_PATCH };
  },

  './sites/youtube-tv': (module, exports, require, __dirname) => {
'use strict';

const YOUTUBE_TV_WATERMARK_PATCH = String.raw`;(function () {
  'use strict';
  // Keep the post-login /tv return URL on the proxy origin. YouTube may use an
  // absolute top-level navigation which cannot be fixed by response headers.
  function proxyYouTubeTvUrl(value) {
    try {
      var url = new URL(String(value), 'https://www.youtube.com');
      if ((url.hostname === 'youtube.com' || url.hostname === 'www.youtube.com') &&
          (url.pathname === '/tv' || url.pathname.indexOf('/tv/') === 0)) {
        return '/proxy/' + url.href;
      }
    } catch (error) {}
    return value;
  }
  document.addEventListener('click', function (event) {
    var element = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!element) return;
    var fixed = proxyYouTubeTvUrl(element.getAttribute('href'));
    if (fixed !== element.getAttribute('href')) element.setAttribute('href', fixed);
  }, true);
  function isYouTubeTvPage() {
    var path = String(window.location.pathname || '').toLowerCase();
    return path.indexOf('/proxy/https://www.youtube.com/tv') === 0 ||
      path.indexOf('/proxy/https://youtube.com/tv') === 0;
  }
  if (!isYouTubeTvPage()) return;
  function removeDebugWatermarks(root) {
    if (!root) return;
    if (root.nodeType === 1 && root.matches && root.matches('yt-debug-watermark')) {
      root.remove();
      return;
    }
    if (!root.querySelectorAll) return;
    var nodes = root.querySelectorAll('yt-debug-watermark');
    for (var i = 0; i < nodes.length; i += 1) nodes[i].remove();
  }
  function start() {
    removeDebugWatermarks(document);
    var observer = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i += 1) {
        var added = records[i].addedNodes;
        for (var j = 0; j < added.length; j += 1) removeDebugWatermarks(added[j]);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();`;

module.exports = { YOUTUBE_TV_WATERMARK_PATCH };
  },

  './sites/youtube-tv-relay': (module, exports, require, __dirname) => {
'use strict';

module.exports = function register(app, dependencies) {
  const { https, httpsAgent, PROXY_PREFIX, YOUTUBE_TV_USER_AGENT, appendVary } = dependencies;

  // Relay YouTube TV account APIs directly. Unblocker normalizes a target like
  // https://www.youtube.com/... into a 307 Location containing https:/..., which
  // breaks POST-based device OAuth and account discovery in a redirect loop.
  app.use(PROXY_PREFIX, relayYouTubeTvAccountApi);
  function relayYouTubeTvAccountApi(req, res, next) {
    if (!['GET', 'POST', 'OPTIONS'].includes(req.method)) return next();
    let rawTarget = req.originalUrl.slice(PROXY_PREFIX.length);
    rawTarget = rawTarget.replace(/^(https?):\/(?!\/)/i, '$1://');
    let target;
    try { target = new URL(rawTarget); } catch { return next(); }
    const host = target.hostname.toLowerCase();
    if (target.protocol !== 'https:' || (host !== 'youtube.com' && host !== 'www.youtube.com')) return next();
    const allowed = target.pathname === '/o/oauth2/token' ||
      target.pathname.startsWith('/youtubei/v1/account/') ||
      target.pathname.startsWith('/api/lounge/');
    if (!allowed) return next();
    if (req.method === 'OPTIONS') {
      setYouTubeTvCors(req, res);
      return res.status(204).end();
    }
    const headers = Object.create(null);
    const forwarded = [
      'accept', 'accept-encoding', 'accept-language', 'authorization',
      'content-type', 'cookie', 'x-goog-request-time', 'x-goog-visitor-id',
      'x-youtube-client-name', 'x-youtube-client-version',
      'x-youtube-lava-device-context', 'x-youtube-page-cl', 'x-youtube-page-label'
    ];
    for (const name of forwarded) if (req.headers[name] != null) headers[name] = req.headers[name];
    headers.host = target.host;
    headers['user-agent'] = YOUTUBE_TV_USER_AGENT;
    headers.origin = 'https://www.youtube.com';
    headers.referer = 'https://www.youtube.com/tv';
    if (req.headers['content-length'] != null) headers['content-length'] = req.headers['content-length'];
    const upstream = https.request(target, {
      method: req.method,
      headers,
      agent: httpsAgent,
      timeout: 30_000
    }, (remote) => {
      const responseHeaders = { ...remote.headers };
      for (const name of ['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']) {
        delete responseHeaders[name];
      }
      // The browser talks to this proxy origin, so expose the API response there.
      const origin = req.get('origin');
      if (origin) {
        responseHeaders['access-control-allow-origin'] = origin;
        responseHeaders['access-control-allow-credentials'] = 'true';
        responseHeaders.vary = appendVary(responseHeaders.vary, 'Origin');
      }
      if (responseHeaders.location) {
        try {
          const redirected = new URL(responseHeaders.location, target);
          if (redirected.protocol === 'https:' &&
              (redirected.hostname === 'youtube.com' || redirected.hostname === 'www.youtube.com')) {
            responseHeaders.location = `${PROXY_PREFIX}${redirected.href}`;
          }
        } catch {}
      }
      res.writeHead(Number(remote.statusCode || 502), responseHeaders);
      remote.pipe(res);
    });
    upstream.once('timeout', () => upstream.destroy(Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT' })));
    upstream.once('error', (error) => {
      console.error(JSON.stringify({ type: 'youtube-tv-account-api-error', code: error.code || 'ERROR', path: target.pathname }));
      if (!res.headersSent) res.status(502).send('Bad Gateway');
      else res.destroy(error);
    });
    req.once('aborted', () => upstream.destroy());
    req.pipe(upstream);
  }
  function setYouTubeTvCors(req, res) {
    const origin = req.get('origin');
    if (origin) res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.set('Access-Control-Allow-Headers', req.get('access-control-request-headers') || 'content-type,authorization');
    res.set('Vary', 'Origin, Access-Control-Request-Headers');
  }
};
  },

  './skyrox/server.js': (module, exports, require, __dirname) => {
'use strict';

const path = require('path');
const fs = require('fs');
const legacyUrl = require('url');
const express = require('express');
const compression = require('compression');
const Unblocker = require('unblocker');
const http = require('http');
const https = require('https');
const { Transform } = require('stream');
const registerBloxdRelay = require('./sites/bloxd-relay');
const registerPokiRelay = require('./sites/poki-auth-relay');
const registerYoutubeRelay = require('./sites/youtube-tv-relay');
const registerMcpedlRelay = require('./sites/mcpedl-relay');
const { POKI_CLEAN_NAVIGATION_PATCH } = require('./sites/poki');
const { TYPINGERZ_FORCE_PROXY_PATCH, TYPINGERZ_NETWORK_PATCH } = require('./sites/typingerz');
const { BLOXD_RELATIVE_RESOURCE_PATCH } = require('./sites/bloxd');
const { GLOBAL_PROXIED_NAVIGATION_PATCH } = require('./sites/navigation');
const { MINECRAFT_DOWNLOAD_NAVIGATION_PATCH } = require('./sites/minecraft');
const { YOUTUBE_TV_WATERMARK_PATCH } = require('./sites/youtube-tv');
const { MCPEDL_CLIENT_RECOVERY } = require('./sites/mcpedl');

const app = express();
const PORT = Number.parseInt(process.env.PORT, 10) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const PROXY_PREFIX = '/proxy/';
const CONTEXT_COOKIE = '__proxy_origin';
const ABEMA_WORKER_URL = 'https://myproxy-api.xenonsan123.workers.dev/';
const GARTIC_PHONE_HOST = 'garticphone.com';
const GARTIC_BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const POKI_WEB_ORIGIN = 'https://poki.com';
const POKI_ROUTE_PREFIX = '/jp';
const POKI_AUTH_HOSTS = new Set(['poki-auth.poki.com']);
const YOUTUBE_TV_USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; UHD Google TV STB Build/UTT1.250214.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/151.0.7922.199 Mobile Safari/537.36';
const MAX_SOCKETS = positiveInteger(process.env.MAX_SOCKETS, 64);
const MAX_FREE_SOCKETS = positiveInteger(process.env.MAX_FREE_SOCKETS, 32);
const MAX_TOTAL_SOCKETS = positiveInteger(process.env.MAX_TOTAL_SOCKETS, 128);
const ASSET_CACHE_SECONDS = positiveInteger(process.env.ASSET_CACHE_SECONDS, 1800);
const MINECRAFT_DOWNLOAD_HOSTS = new Set([
  'minecraft-mcworld.com',
  'www.minecraft-mcworld.com'
]);
const MINECRAFT_DOWNLOAD_EXTENSIONS = new Set(['.mcworld', '.mcpack', '.zip']);

const agentOptions = {
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: MAX_SOCKETS,
  maxFreeSockets: MAX_FREE_SOCKETS,
  maxTotalSockets: MAX_TOTAL_SOCKETS,
  scheduling: 'lifo'
};
const httpAgent = new http.Agent(agentOptions);
const httpsAgent = new https.Agent(agentOptions);

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  const originalSetHeader = res.setHeader;
  res.setHeader = function setSafeHeader(name, value) {
    const lowerName = String(name).toLowerCase();
    if (lowerName === 'location') {
      value = sanitizeLocationValue(value);
    }
    if (lowerName === 'permissions-policy') {
      value = sanitizePermissionsPolicyValue(value);
      if (value == null || value === '') return this;
    }
    return originalSetHeader.call(this, name, value);
  };
  next();
});

function sanitizePermissionsPolicyValue(value) {
  const values = Array.isArray(value) ? value : [value];
  const cleaned = values
    .flatMap((item) => String(item || '').split(','))
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => !/^(?:attribution-reporting|private-aggregation|join-ad-interest-group|run-ad-auction)\s*=/i.test(item));
  return cleaned.length ? cleaned.join(', ') : null;
}

function sanitizeLocationValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeLocationValue);
  if (typeof value !== 'string') return value;
  return value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/ /g, '%20')
    .replace(/[^\x21-\x7e]/gu, (character) => encodeURIComponent(character));
}

function keepYouTubeTvRedirectInsideProxy(data) {
  if (!data?.headers || data.headers.location == null || !data.url) return;
  let source;
  try { source = new URL(data.url); } catch { return; }
  const sourceHost = source.hostname.toLowerCase();
  if (sourceHost !== 'youtube.com' && sourceHost !== 'www.youtube.com') return;
  const rewrite = (value) => {
    if (typeof value !== 'string') return value;
    try {
      const target = new URL(value, source);
      const host = target.hostname.toLowerCase();
      if ((host === 'youtube.com' || host === 'www.youtube.com') &&
          (target.pathname === '/tv' || target.pathname.startsWith('/tv/'))) {
        return `${PROXY_PREFIX}${target.href}`;
      }
    } catch {}
    return value;
  };
  data.headers.location = Array.isArray(data.headers.location)
    ? data.headers.location.map(rewrite)
    : rewrite(data.headers.location);
}

function keepPokiRedirectOnCleanRoute(data) {
  if (!data?.headers || data.headers.location == null || !data.url) return;
  let source;
  try { source = new URL(data.url); } catch { return; }
  const host = source.hostname.toLowerCase();
  if (host !== 'poki.com' && host !== 'www.poki.com') return;
  const rewrite = (value) => {
    if (typeof value !== 'string') return value;
    try {
      const target = new URL(value, source);
      const targetHost = target.hostname.toLowerCase();
      if ((targetHost === 'poki.com' || targetHost === 'www.poki.com') &&
          (target.pathname === POKI_ROUTE_PREFIX || target.pathname.startsWith(`${POKI_ROUTE_PREFIX}/`))) {
        return `${target.pathname}${target.search}${target.hash}`;
      }
    } catch {}
    return value;
  };
  data.headers.location = Array.isArray(data.headers.location)
    ? data.headers.location.map(rewrite)
    : rewrite(data.headers.location);
}

function sanitizeProxyResponseHeaders(data) {
  if (!data?.headers || data.headers.location == null) return;
  data.headers.location = sanitizeLocationValue(data.headers.location);
}

// Normalize malformed proxied Location values such as /proxy/https:/host/path.
function repairMalformedProxyLocation(data) {
  if (!data?.headers || data.headers.location == null) return;
  const repair = (location) => {
    if (typeof location !== 'string') return location;
    return location.replace(
      /\/proxy\/(https?):\/(?!\/)/gi,
      '/proxy/$1://'
    );
  };
  data.headers.location = Array.isArray(data.headers.location)
    ? data.headers.location.map(repair)
    : repair(data.headers.location);
}

// Fix minecraft-mcworld.com download redirects whose Japanese filename was
// decoded as Latin-1 and then encoded again, for example ç·´ç¿ã... -> 練習ワールド.
function repairMinecraftDownloadRedirect(data) {
  if (!data?.headers || data.headers.location == null || !data.url) return;
  const repair = (location) => {
    const repaired = repairMinecraftDownloadLocation(location, data.url);
    if (repaired !== location) {
      console.log(JSON.stringify({
        type: 'minecraft-download-redirect-repaired',
        sourceUrl: data.url,
        before: location,
        after: repaired
      }));
    }
    return repaired;
  };
  data.headers.location = Array.isArray(data.headers.location)
    ? data.headers.location.map(repair)
    : repair(data.headers.location);
}
function repairMinecraftDownloadLocation(location, baseUrl) {
  if (typeof location !== 'string') return location;
  let absolute;
  try {
    absolute = new URL(location, baseUrl);
  } catch {
    return location;
  }

  // Unblocker may already have wrapped the upstream Location in this proxy's
  // URL. Repair the inner minecraft-mcworld.com URL without confusing the
  // proxy host with the upstream host.
  const proxyIndex = absolute.pathname.indexOf(PROXY_PREFIX);
  if (proxyIndex !== -1) {
    let innerTarget =
      absolute.pathname.slice(proxyIndex + PROXY_PREFIX.length) +
      absolute.search +
      absolute.hash;
    innerTarget = innerTarget.replace(/^(https?):\/(?!\/)/i, '$1://');
    innerTarget = innerTarget.replace(/%25([0-9a-f]{2})/gi, '%$1');
    const repairedInnerTarget = repairMinecraftDownloadUrl(innerTarget);
    if (repairedInnerTarget !== innerTarget) {
      const proxyPath = absolute.pathname.slice(0, proxyIndex + PROXY_PREFIX.length);
      return `${absolute.origin}${proxyPath}${repairedInnerTarget}`;
    }
  }

  return repairMinecraftDownloadUrl(absolute.href);
}

function repairMinecraftDownloadUrl(value) {
  if (typeof value !== 'string') return value;

  let target;
  try {
    target = new URL(value);
  } catch {
    return value;
  }

  if (!MINECRAFT_DOWNLOAD_HOSTS.has(target.hostname.toLowerCase())) return value;
  if (!target.pathname.startsWith('/wp-content/uploads/')) return value;

  const lowerPath = target.pathname.toLowerCase();
  const matchingExtension = [...MINECRAFT_DOWNLOAD_EXTENSIONS]
    .some((extension) => lowerPath.endsWith(extension));
  if (!matchingExtension) return value;

  const repairedPath = target.pathname
    .split('/')
    .map(repairEncodedMojibakeSegment)
    .join('/');

  if (repairedPath === target.pathname) return value;
  return `${target.protocol}//${target.host}${repairedPath}${target.search}${target.hash}`;
}

function repairEncodedMojibakeSegment(segment) {
  if (!segment) return segment;

  let decoded;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return segment;
  }

  const repaired = repairUtf8Mojibake(decoded);
  return repaired === decoded ? segment : encodeURIComponent(repaired);
}

function repairUtf8Mojibake(value) {
  // These characters commonly appear when UTF-8 Japanese text is interpreted
  // as Latin-1/Windows-1252. Restricting conversion avoids changing valid names.
  if (!/[ÃÂãçåæä]/u.test(value)) return value;
  if ([...value].some((character) => character.codePointAt(0) > 0xff)) return value;

  const repaired = Buffer.from(value, 'latin1').toString('utf8');
  if (!repaired || repaired.includes('\uFFFD')) return value;
  return mojibakeScore(repaired) < mojibakeScore(value) ? repaired : value;
}

function mojibakeScore(value) {
  return (value.match(/[ÃÂãçåæä]/gu) || []).length;
}

app.use(compression({
  level: 1,
  threshold: 4 * 1024,
  filter(req, res) {
    if (req.headers.range || req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

// Expose Poki on a clean local pathname. Poki's React router reads
// window.location.pathname, so /proxy/https://poki.com/jp/... is interpreted
// as an unknown Poki route after hydration. Internally rewriting /jp/... keeps
// the browser-visible pathname compatible with Poki while still using Unblocker.
app.use((req, res, next) => {
  if (!isCleanPokiRequest(req)) return next();
  const target = new URL(req.originalUrl, `${POKI_WEB_ORIGIN}/`);
  req.url = `${PROXY_PREFIX}${target.href}`;
  next();
});

function isCleanPokiRequest(req) {
  if (req.path === POKI_ROUTE_PREFIX || req.path.startsWith(`${POKI_ROUTE_PREFIX}/`)) {
    return true;
  }
  const referer = req.get('referer');
  const requestHost = req.get('host');
  if (!referer || !requestHost || isLocalRoute(req.path)) return false;
  try {
    const ref = new URL(referer);
    return ref.host === requestHost &&
      (ref.pathname === POKI_ROUTE_PREFIX || ref.pathname.startsWith(`${POKI_ROUTE_PREFIX}/`));
  } catch {
    return false;
  }
}

app.use(express.static(PUBLIC_DIR, {
  index: false,
  etag: true,
  lastModified: true,
  maxAge: '1d',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    } else if (/\.[a-f0-9]{8,}\./i.test(path.basename(filePath))) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));

app.use((req, res, next) => {
  const repairedUrl = repairProxyPath(req.url);
  if (typeof req.headers.referer === 'string') {
    req.headers.referer = repairProxyReference(req.headers.referer);
  }
  if (repairedUrl !== req.url) req.url = repairedUrl;
  next();
});

function repairProxyReference(value) {
  try {
    const reference = new URL(value);
    const repaired = repairProxyPath(
      `${reference.pathname}${reference.search}${reference.hash}`
    );
    return `${reference.origin}${repaired}`;
  } catch {
    return repairProxyPath(value);
  }
}

function repairProxyPath(value) {
  if (typeof value !== 'string' || !value.includes(PROXY_PREFIX)) return value;
  const prefixIndex = value.indexOf(PROXY_PREFIX);
  const before = value.slice(0, prefixIndex + PROXY_PREFIX.length);
  let target = value.slice(prefixIndex + PROXY_PREFIX.length);
  if (!/^https?:/i.test(target)) return value;
  target = target.replace(/^(https?):\/(?!\/)/i, '$1://');
  target = target.replace(/%25([0-9a-f]{2})/gi, '%$1');
  target = repairMinecraftDownloadUrl(target);
  return before + target;
}

function rememberDocumentOrigin(data) {
  if (!data?.headers || !data.url || !data.clientRequest) return;
  const method = String(data.clientRequest.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return;
  const contentType = String(
    data.headers['content-type'] || data.contentType || ''
  ).toLowerCase();
  if (!contentType.includes('text/html')) return;
  const destination = String(
    data.clientRequest.headers['sec-fetch-dest'] || ''
  ).toLowerCase();
  if (destination && destination !== 'document' && destination !== 'iframe') return;
  let target;
  try {
    target = new URL(data.url);
  } catch {
    return;
  }
  if (!isHttpOrigin(target)) return;
  const encodedOrigin = Buffer.from(target.origin, 'utf8').toString('base64url');
  const secure = isSecureClientRequest(data.clientRequest) ? '; Secure' : '';
  const cookie = `${CONTEXT_COOKIE}=${encodedOrigin}; Path=/; Max-Age=1800; HttpOnly; SameSite=Lax${secure}`;
  appendSetCookie(data.headers, cookie);
}

function cleanProxyRequest(data) {
  if (!data?.headers) return;
  delete data.headers['proxy-connection'];
}

function routeAbemaRequestThroughWorker(data) {
  if (!data?.url || !data?.headers) return;

  const pageOrigin = data.headers['x-skyrox-page-origin'];
  delete data.headers['x-skyrox-page-origin'];

  let target;
  try {
    target = new URL(data.url);
  } catch {
    return;
  }
  if (target.protocol !== 'https:' || !isAbemaRequest(data, target, pageOrigin)) return;
  normalizeAbemaHostname(target);

  const workerUrl = new URL(ABEMA_WORKER_URL);
  workerUrl.searchParams.set('url', target.href);
  data.abemaOriginalUrl = target.href;
  data.url = workerUrl.href;
  data.headers.host = workerUrl.host;
  const abemaPageOrigin = getAbemaPageOrigin(data, target, pageOrigin);
  if (data.headers.origin && abemaPageOrigin) data.headers.origin = abemaPageOrigin;
  if (typeof data.headers.referer === 'string') {
    try {
      const referer = new URL(data.headers.referer);
      normalizeAbemaHostname(referer);
      data.headers.referer = referer.href;
    } catch {}
  }

  if (data.uri) {
    Object.assign(data.uri, legacyUrl.parse(workerUrl.href));
  }
}

function normalizeAbemaHostname(url) {
  if (url.hostname.toLowerCase() === 'www.abema.tv') {
    url.hostname = 'abema.tv';
  }
}

function getAbemaPageOrigin(data, target, pageOrigin) {
  if (isAbemaHost(target.hostname)) {
    normalizeAbemaHostname(target);
    return target.origin;
  }

  if (typeof pageOrigin === 'string' && pageOrigin) {
    try {
      const parsed = new URL(pageOrigin);
      if (parsed.protocol !== 'https:' || !isAbemaHost(parsed.hostname)) return null;
      normalizeAbemaHostname(parsed);
      return parsed.origin;
    } catch {
      return null;
    }
  }

  for (const value of [data.headers.referer, data.headers.origin]) {
    if (typeof value !== 'string' || !value) continue;
    try {
      const parsed = new URL(value);
      if (parsed.protocol === 'https:' && isAbemaHost(parsed.hostname)) {
        normalizeAbemaHostname(parsed);
        return parsed.origin;
      }
    } catch {}
  }
  return null;
}

function isAbemaRequest(data, target, pageOrigin) {
  return Boolean(getAbemaPageOrigin(data, target, pageOrigin));
}

function isAbemaHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return host === 'abema.tv' || host.endsWith('.abema.tv');
}

function restoreAbemaWorkerResponseUrl(data) {
  if (!data?.abemaOriginalUrl) return;

  let responseUrl = data.abemaOriginalUrl;
  const finalUrl = data.headers?.['x-proxy-final-url'];
  if (typeof finalUrl === 'string') {
    try {
      const parsed = new URL(finalUrl);
      if (parsed.protocol === 'https:') responseUrl = parsed.href;
    } catch {}
  }

  data.url = responseUrl;
  if (data.uri) Object.assign(data.uri, legacyUrl.parse(responseUrl));
}

function findHtmlHeadEnd(source) {
  let position = 0;
  while (position < source.length) {
    const tagStart = source.indexOf('<', position);
    if (tagStart === -1) return -1;

    if (source.startsWith('<!--', tagStart)) {
      const commentEnd = source.indexOf('-->', tagStart + 4);
      if (commentEnd === -1) return -1;
      position = commentEnd + 3;
      continue;
    }

    const openingTag = source.slice(tagStart).match(/^<(head|script|style|textarea|title)\b/i);
    if (!openingTag) {
      position = tagStart + 1;
      continue;
    }

    const tagEnd = findHtmlTagEnd(source, tagStart + openingTag[0].length);
    if (tagEnd === -1) return -1;
    if (openingTag[1].toLowerCase() === 'head') return tagEnd + 1;

    const closingTag = new RegExp(`<\\/\\s*${openingTag[1]}\\s*>`, 'ig');
    closingTag.lastIndex = tagEnd + 1;
    const closingMatch = closingTag.exec(source);
    if (!closingMatch) return -1;
    position = closingTag.lastIndex;
  }

  return -1;
}

function findHtmlTagEnd(source, position) {
  let quote = '';
  for (let index = position; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

function injectUnblockerClientSafely(data) {
  const contentType = String(data?.contentType || data?.headers?.['content-type'] || '').toLowerCase();
  if (!contentType.includes('text/html') || !data.stream) return;

  const injection = `\n<script src="${PROXY_PREFIX}client/unblocker-client.js"></script>\n` +
    `<script>unblockerInit(${JSON.stringify({ prefix: PROXY_PREFIX, url: data.url })}, window);</script>\n`;
  let pending = '';
  let injected = false;

  data.stream = data.stream.pipe(new Transform({
    decodeStrings: false,
    transform(chunk, encoding, callback) {
      if (injected) {
        this.push(chunk.toString());
        callback();
        return;
      }

      pending += chunk.toString();
      const headEnd = findHtmlHeadEnd(pending);
      if (headEnd !== -1) {
        this.push(pending.slice(0, headEnd) + injection + pending.slice(headEnd));
        pending = '';
        injected = true;
      } else if (pending.length > 1024 * 1024) {
        this.push(pending);
        pending = '';
        injected = true;
      }
      callback();
    },
    flush(callback) {
      if (pending) this.push(pending);
      callback();
    }
  }));
}

function applyGarticPhoneBrowserHeaders(data) {
  if (!data?.headers || !data.url) return;

  let target;
  try {
    target = new URL(data.url);
  } catch {
    return;
  }

  if (!isGarticPhoneHost(target.hostname)) return;

  const headers = data.headers;
  headers['user-agent'] ||= GARTIC_BROWSER_USER_AGENT;
  headers.accept ||= data.isWebsocket
    ? '*/*'
    : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
  headers['accept-language'] ||= 'ja,en-US;q=0.9,en;q=0.8';
  headers['sec-ch-ua'] ||= '"Chromium";v="140", "Google Chrome";v="140", "Not=A?Brand";v="24"';
  headers['sec-ch-ua-mobile'] ||= '?0';
  headers['sec-ch-ua-platform'] ||= '"Windows"';

  let pageUrl;
  try {
    pageUrl = new URL(headers.referer);
  } catch {}

  if (pageUrl && isGarticPhoneHost(pageUrl.hostname)) {
    const isSameOrigin = pageUrl.origin === target.origin;
    headers['sec-fetch-site'] = isSameOrigin ? 'same-origin' : 'same-site';
    if (headers.origin) headers.origin = pageUrl.origin;
  } else if (!headers['sec-fetch-site']) {
    headers['sec-fetch-site'] = data.isWebsocket ? 'same-origin' : 'none';
  }

  if (data.isWebsocket) {
    headers['sec-fetch-mode'] = 'websocket';
    headers['sec-fetch-dest'] = 'empty';
  }
}

function isGarticPhoneHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === GARTIC_PHONE_HOST || host.endsWith(`.${GARTIC_PHONE_HOST}`);
}

function logTypingerRequest(data) {
  if (!data?.url || !data?.clientRequest) return;

  let target;
  try {
    target = new URL(data.url);
  } catch {
    return;
  }

  const hostname = target.hostname.toLowerCase();
  if (hostname !== 'typingerz.com' && hostname !== 'www.typingerz.com') return;

  const method = String(data.clientRequest.method || 'GET').toUpperCase();
  const interesting =
    method !== 'GET' ||
    /\/(?:api|ajax|battle|matching|room|socket|ws)/i.test(target.pathname);

  if (!interesting) return;

  console.info(JSON.stringify({
    type: 'typinger-request',
    method,
    url: target.href,
    origin: data.headers?.origin || null,
    referer: data.headers?.referer || null,
    hasCookie: Boolean(data.headers?.cookie)
  }));
}
// Keep Poki authentication requests consistent with the upstream web origin.
// This does not bypass authentication. A 401 from /sessions/whoami remains the
// correct response when the browser has no valid Poki session cookie.
function applyPokiRequestContext(data) {
  if (!data?.headers || !data.url) return;
  let target;
  try {
    target = new URL(data.url);
  } catch {
    return;
  }
  if (!POKI_AUTH_HOSTS.has(target.hostname.toLowerCase())) return;

  data.headers.origin = POKI_WEB_ORIGIN;
  data.headers.referer = `${POKI_WEB_ORIGIN}/`;
  data.headers.host = target.host;

  // These browser-facing values describe the proxy origin and can cause an
  // upstream origin check to fail. Let Node generate the actual connection
  // headers while retaining Cookie and Authorization when present.
  delete data.headers['proxy-connection'];
  delete data.headers['sec-fetch-site'];
  delete data.headers['sec-fetch-mode'];
  delete data.headers['sec-fetch-dest'];
}

// Poki auth responses must never be cached. cookieRewrite:true below remains
// responsible for mapping upstream Set-Cookie headers onto the proxy origin.
function normalizePokiAuthResponse(data) {
  if (!data?.headers || !data.url) return;
  let target;
  try {
    target = new URL(data.url);
  } catch {
    return;
  }
  if (!POKI_AUTH_HOSTS.has(target.hostname.toLowerCase())) return;

  data.headers['cache-control'] = 'private, no-store, max-age=0';
  data.headers.pragma = 'no-cache';
  delete data.headers.expires;

  // Keep redirects from the authentication service inside the proxy.
  if (data.headers.location != null) {
    const rewrite = (value) => {
      if (typeof value !== 'string') return value;
      try {
        const redirected = new URL(value, target);
        return `${PROXY_PREFIX}${redirected.href}`;
      } catch {
        return value;
      }
    };
    data.headers.location = Array.isArray(data.headers.location)
      ? data.headers.location.map(rewrite)
      : rewrite(data.headers.location);
  }

  const status = Number(data.remoteResponse?.statusCode || 0);
  if (status === 401 && target.pathname === '/sessions/whoami') {
    console.info(JSON.stringify({
      type: 'poki-auth-session-missing',
      status,
      path: target.pathname,
      note: 'Expected when no valid Poki session cookie is available'
    }));
  }
}

// Remove unsupported ad-related directives that cause browser warnings and
// can block APIs used by embedded game pages.
function sanitizePermissionsPolicy(data) {
  if (!data?.headers || data.headers['permissions-policy'] == null) return;
  const values = Array.isArray(data.headers['permissions-policy'])
    ? data.headers['permissions-policy']
    : [data.headers['permissions-policy']];
  const cleaned = values
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value) => !/^(?:attribution-reporting|private-aggregation|join-ad-interest-group|run-ad-auction)\s*=/i.test(value));
  if (cleaned.length) data.headers['permissions-policy'] = cleaned.join(', ');
  else delete data.headers['permissions-policy'];
}

function applyYouTubeTvUserAgent(data) {
  if (!data?.headers || !data.url) return;
  let target;
  try {
    target = new URL(data.url);
  } catch {
    return;
  }
  const hostname = target.hostname.toLowerCase();
  const isYouTubeHost = hostname === 'youtube.com' || hostname === 'www.youtube.com';
  if (!isYouTubeHost) return;
  const referer = String(data.headers.referer || '');
  const isTvRequest = target.pathname === '/tv' || target.pathname.startsWith('/tv/');
  const isTvSubrequest = /^https?:\/\/(?:www\.)?youtube\.com\/tv(?:[/?#]|$)/i.test(referer);
  if (!isTvRequest && !isTvSubrequest) return;
  data.headers['user-agent'] = YOUTUBE_TV_USER_AGENT;
  data.headers.origin = 'https://www.youtube.com';
  if (data.headers.referer) data.headers.referer = 'https://www.youtube.com/tv';
}

function addConservativeAssetCache(data) {
  if (!data?.headers || !data.clientRequest || !data.remoteResponse) return;
  const method = String(data.clientRequest.method || 'GET').toUpperCase();
  if ((method !== 'GET' && method !== 'HEAD') || data.remoteResponse.statusCode !== 200) return;
  if (
    data.headers['cache-control'] ||
    data.headers['set-cookie'] ||
    data.clientRequest.headers.authorization
  ) return;
  const contentType = String(data.headers['content-type'] || '').toLowerCase();
  const staticAsset =
    contentType.startsWith('image/') ||
    contentType.startsWith('font/') ||
    contentType.startsWith('audio/') ||
    contentType.includes('text/css') ||
    contentType.includes('javascript') ||
    contentType.includes('application/wasm');
  if (staticAsset) {
    data.headers['cache-control'] =
      `private, max-age=${ASSET_CACHE_SECONDS}, stale-while-revalidate=60`;
  }
}

function preserveDownloadResponse(data) {
  if (!data?.headers || !data.url || !data.remoteResponse) return;
  const status = Number(data.remoteResponse.statusCode || 0);
  if (status < 200 || status >= 300) return;
  let target;
  try {
    target = new URL(data.url);
  } catch {
    return;
  }
  const pathname = target.pathname;
  const extension = pathname.includes('.')
    ? pathname.slice(pathname.lastIndexOf('.')).toLowerCase()
    : '';
  const contentType = String(data.headers['content-type'] || '').toLowerCase();
  const contentDisposition = String(data.headers['content-disposition'] || '').toLowerCase();
  const downloadExtensions = new Set([
    '.mcworld', '.mcpack', '.zip', '.rar', '.7z', '.tar', '.gz',
    '.pdf', '.apk', '.exe', '.msi', '.dmg', '.iso'
  ]);
  const isDownload =
    contentDisposition.includes('attachment') ||
    downloadExtensions.has(extension) ||
    contentType.includes('application/zip') ||
    contentType.includes('application/octet-stream') ||
    contentType.includes('application/x-rar-compressed') ||
    contentType.includes('application/vnd.rar');
  if (!isDownload) return;
  if (!data.headers['content-disposition']) {
    const rawName = decodePathFilename(pathname) || `download${extension}`;
    const asciiName = rawName
      .replace(/[^\x20-\x7e]/g, '_')
      .replace(/["\\]/g, '_')
      .slice(0, 180) || `download${extension}`;
    const encodedName = encodeURIComponent(rawName).replace(/['()]/g, escapeChar);
    data.headers['content-disposition'] =
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;
  }
  data.headers['cache-control'] ||= 'private, no-transform';
}

function escapeChar(character) {
  return `%${character.charCodeAt(0).toString(16).toUpperCase()}`;
}

function decodePathFilename(pathname) {
  const last = pathname.split('/').filter(Boolean).pop();
  if (!last) return '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

// Fallback for hosting environments where /dl/ reaches Express. Cloud Shell may
// reserve /dl/, so the browser-side patch below remains the primary fix there.
app.use((req, res, next) => {
  if (req.path !== '/dl' && req.path !== '/dl/') return next();
  const refererOrigin = getOriginFromProxyReferer(req);
  if (refererOrigin !== 'https://minecraft-mcworld.com' &&
      refererOrigin !== 'https://www.minecraft-mcworld.com') return next();
  let target;
  try {
    target = new URL(req.originalUrl, `${refererOrigin}/`);
  } catch {
    return next();
  }
  req.url = `${PROXY_PREFIX}${target.href}`;
  console.log(JSON.stringify({
    type: 'minecraft-download-navigation',
    originalUrl: req.originalUrl,
    target: target.href
  }));
  next();
});

app.use((req, res, next) => {
  if (req.originalUrl.startsWith(PROXY_PREFIX)) return next();
  if (req.path === '/') return next();
  if (isLocalRoute(req.path)) return next();
  const proxyRefererOrigin = getOriginFromProxyReferer(req);
  const contextCookieOrigin = getOriginFromContextCookie(req);
  // If a Referer exists but cannot be parsed as a proxied page, do not reuse a
  // stale origin cookie from another site.
  const upstreamOrigin = req.get('referer')
    ? proxyRefererOrigin
    : contextCookieOrigin;
  // Relative URLs emitted by the upstream page arrive at this Express app as
  // /textures/..., /cdn-cgi/..., etc. Proxy both navigations and subresources;
  // limiting this to navigations was the reason thumbnails returned local 404s.
  if (!upstreamOrigin) return next();
  let target;
  try {
    target = new URL(req.originalUrl, `${upstreamOrigin}/`);
  } catch {
    return next();
  }
  if (!isHttpOrigin(target)) return next();
  req.url = `${PROXY_PREFIX}${target.href}`;
  next();
});

const relayDependencies = {
  https,
  httpsAgent,
  PROXY_PREFIX,
  POKI_AUTH_HOSTS,
  POKI_WEB_ORIGIN,
  YOUTUBE_TV_USER_AGENT,
  sanitizeLocationValue,
  setRelayCors,
  applyRelayCors,
  stripHopByHopHeaders,
  parseCookies,
  appendVary
};

registerBloxdRelay(app, relayDependencies);

function setRelayCors(req, res) {
  const origin = req.get('origin');
  if (origin) res.set('Access-Control-Allow-Origin', origin);
  res.set('Access-Control-Allow-Credentials', 'true');
  res.set('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
  res.set('Access-Control-Allow-Headers', req.get('access-control-request-headers') || 'content-type,authorization');
  res.set('Access-Control-Max-Age', '600');
  res.set('Vary', 'Origin, Access-Control-Request-Headers');
}

function applyRelayCors(req, headers) {
  const origin = req.get('origin');
  if (!origin) return;
  headers['access-control-allow-origin'] = origin;
  headers['access-control-allow-credentials'] = 'true';
  headers.vary = appendVary(headers.vary, 'Origin');
}

function stripHopByHopHeaders(headers) {
  for (const name of [
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade'
  ]) delete headers[name];
}

function appendVary(current, value) {
  const values = String(current || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!values.some((item) => item.toLowerCase() === value.toLowerCase())) values.push(value);
  return values.join(', ');
}

registerPokiRelay(app, relayDependencies);

registerYoutubeRelay(app, relayDependencies);

registerMcpedlRelay(app, relayDependencies);

const unblockerConfig = {
  prefix: PROXY_PREFIX,
  cookieRewrite: true,
  redirectFollow: true,
  clientScripts: false,
  httpAgent,
  httpsAgent,
  requestMiddleware: [
    cleanProxyRequest,
    logTypingerRequest,
    applyPokiRequestContext,
    applyYouTubeTvUserAgent,
    applyGarticPhoneBrowserHeaders,
    routeAbemaRequestThroughWorker
  ],
  responseMiddleware: [
    repairMalformedProxyLocation,
    keepPokiRedirectOnCleanRoute,
    normalizePokiAuthResponse,
    sanitizePermissionsPolicy,
    repairMinecraftDownloadRedirect,
    keepYouTubeTvRedirectInsideProxy,
    sanitizeProxyResponseHeaders,
    rememberDocumentOrigin,
    preserveDownloadResponse,
    addConservativeAssetCache,
    injectUnblockerClientSafely
  ]
};
const unblocker = new Unblocker(unblockerConfig);
unblockerConfig.responseMiddleware.unshift(restoreAbemaWorkerResponseUrl);

// Prefer the package's local browser helper. If its layout differs, fall back
// to Unblocker's own route instead of returning a false 404.
const unblockerClientPath = findUnblockerClientScript();
let unblockerClientSource = null;
if (unblockerClientPath) {
  try {
    unblockerClientSource = patchUnblockerClientForUrlObjects(
      fs.readFileSync(unblockerClientPath, 'utf8')
    );
  } catch (error) {
    console.error('Unable to load unblocker client script:', error.message);
  }
}

// YouTube TV uses Trusted Types and may assign TrustedScriptURL objects to
// script.src. Older unblocker clients assume src is always a string and crash
// in fixUrl() when they call urlStr.substr(...). Coerce the value at the start
// of fixUrl so both strings and URL-like Trusted Types values are supported.
function patchUnblockerClientForUrlObjects(source) {
  let patched = String(source || '');

  // Unblocker compares location.protocol with "https" instead of "https:".
  // On HTTPS deployments this incorrectly creates insecure ws:// proxy URLs.
  patched = patched.replace(
    /location\.protocol\s*===\s*["']https["']/g,
    'location.protocol === "https:"'
  );

  // note uses Next.js/webpack and can pass URL, TrustedScriptURL, TrustedURL,
  // or other string-like values to script/link setters. Older unblocker builds
  // call string-only methods directly, which aborts hydration on note.
  const declarations = [
    /(function\s+fixUrl\s*\(\s*urlStr\b[^)]*\)\s*\{)/,
    /(fixUrl\s*=\s*function\s*\(\s*urlStr\b[^)]*\)\s*\{)/,
    /((?:const|let|var)\s+fixUrl\s*=\s*\(\s*urlStr\b[^)]*\)\s*=>\s*\{)/
  ];

  for (const declaration of declarations) {
    if (declaration.test(patched)) {
      patched = patched.replace(declaration, '$1\n    urlStr = String(urlStr);');
      break;
    }
  }

  // Cover minified/transformed variants and other string-only operations.
  patched = patched
    .replace(/urlStr\.substr\(/g, 'String(urlStr).substr(')
    .replace(/urlStr\.substring\(/g, 'String(urlStr).substring(')
    .replace(/urlStr\.startsWith\(/g, 'String(urlStr).startsWith(')
    .replace(/urlStr\.indexOf\(/g, 'String(urlStr).indexOf(');

  return patched;
}

function sendPatchedUnblockerClient(req, res, next) {
  if (!unblockerClientSource) return next();
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  res.set('Cache-Control', 'no-cache');
  res.set('X-Content-Type-Options', 'nosniff');
  res.send(`${unblockerClientSource}\n${TYPINGERZ_FORCE_PROXY_PATCH}\n${TYPINGERZ_NETWORK_PATCH}\n${BLOXD_RELATIVE_RESOURCE_PATCH}\n${GLOBAL_PROXIED_NAVIGATION_PATCH}\n${MINECRAFT_DOWNLOAD_NAVIGATION_PATCH}\n${YOUTUBE_TV_WATERMARK_PATCH}\n${MCPEDL_CLIENT_RECOVERY}\n${POKI_CLEAN_NAVIGATION_PATCH}`);
}

// Different unblocker releases emit either path. Register both before
// app.use(unblocker), so note always receives the patched browser helper.
app.get(`${PROXY_PREFIX}client/unblocker-client.js`, sendPatchedUnblockerClient);
app.get(`${PROXY_PREFIX}unblocker-client.js`, sendPatchedUnblockerClient);

// Keep top-level link navigation inside the proxy. Unblocker's URL wrappers
// cover many DOM assignments, but sites such as DuckDuckGo can install a
// direct absolute result URL after rendering. Capture navigation gestures and
// normalize those links before the browser leaves this origin.

// Typinger Z emits some image URLs through inline styles and late JavaScript.
// Those assignments can bypass ordinary anchor/src rewriting, so synchronously
// normalize every typingerz.com URL before the browser starts the request.

// Cloud Shell reserves the top-level /dl/ path. Crafters Colony's original
// download_bt_func navigates there, so intercept the gesture before the site's
// inline onclick handler and navigate directly to the proxied upstream /dl/.

// YouTube TV inserts <yt-debug-watermark> when the current host is not an
// approved debug-access domain. This UI-only patch removes that warning node
// and watches for later re-insertion by client-side rendering.

// MCPEDL marks the home-page Nuxt fetch as client-only. When its cached SSR
// response contains frontpageV2=null, hydration can leave all shelves empty.
// Retry the site's own Vuex action after Nuxt is ready. The existing XHR/fetch
// wrappers proxy the api.mcpedl.com request through this server.

function findUnblockerClientScript() {
  let entry;
  try { entry = require.resolve('unblocker'); } catch { return null; }
  let root = path.dirname(entry);
  for (let i = 0; i < 8 && path.dirname(root) !== root; i += 1) {
    if (fs.existsSync(path.join(root, 'package.json'))) break;
    root = path.dirname(root);
  }
  return findNamedFile(root, 'unblocker-client.js', 5);
}

function findNamedFile(directory, filename, depth) {
  if (depth < 0) return null;
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) if (entry.isFile() && entry.name === filename) return path.join(directory, filename);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const found = findNamedFile(path.join(directory, entry.name), filename, depth - 1);
    if (found) return found;
  }
  return null;
}

app.get(['/healthz', '/__proxy-local/healthz'], (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(200).send('ok');
});

app.use(unblocker);

app.get('/', (req, res) => res.status(404).send('Not found'));   // 統合時のホームは LowBand 側

app.use((req, res) => {
  res.status(404).send('Not found');
});

// [Yoroxy 統合] require() されたときは単独で待ち受けず、親サーバーへ app / server を渡す
const EMBEDDED = require.main !== module;
const server = EMBEDDED
  ? http.createServer(app)
  : app.listen(PORT, () => {
      console.log(`Proxy listening on ${PORT}`);
    });

server.keepAliveTimeout = 30_000;
server.headersTimeout = 20_000;
server.requestTimeout = 120_000;
server.setTimeout(120_000);
server.maxRequestsPerSocket = 1_000;

const handleUpgrade = unblocker.onUpgrade.bind(unblocker);
server.on('upgrade', (req, socket, head) => {
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 30_000);
  socket.setTimeout(0);

  try {
    req.url = repairProxyPath(req.url);

    if (!req.url.startsWith(PROXY_PREFIX)) {
      const refererOrigin = getOriginFromProxyReferer(req);
      const cookieOrigin = getOriginFromContextCookie(req);
      const upstreamOrigin = req.headers.referer ? refererOrigin : cookieOrigin;

      if (upstreamOrigin) {
        const target = new URL(req.url, `${upstreamOrigin}/`);
        if (isHttpOrigin(target)) {
          const originalUrl = req.url;
          req.url = `${PROXY_PREFIX}${target.href}`;
          console.info(JSON.stringify({
            type: 'websocket-relative-url-rewritten',
            originalUrl,
            target: target.href,
            proxyUrl: req.url
          }));
        }
      }
    }

    handleUpgrade(req, socket, head);
  } catch (error) {
    console.error(JSON.stringify({
      type: 'websocket-upgrade-error',
      message: error.message,
      url: req.url
    }));

    if (!socket.destroyed) {
      socket.write(
        'HTTP/1.1 502 Bad Gateway\r\n' +
        'Connection: close\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n' +
        '\r\n' +
        'WebSocket proxy error'
      );
      socket.destroy();
    }
  }
});

function getOriginFromProxyReferer(req) {
  const referer = req.get('referer');
  const requestHost = req.get('host');
  if (!referer || !requestHost) return null;
  let refererUrl;
  try {
    refererUrl = new URL(referer);
  } catch {
    return null;
  }
  if (refererUrl.host !== requestHost || !refererUrl.pathname.startsWith(PROXY_PREFIX)) {
    return null;
  }
  const proxiedTargetText =
    refererUrl.pathname.slice(PROXY_PREFIX.length) + refererUrl.search;
  try {
    const proxiedTarget = new URL(proxiedTargetText);
    return isHttpOrigin(proxiedTarget) ? proxiedTarget.origin : null;
  } catch {
    return null;
  }
}

function getOriginFromContextCookie(req) {
  const encoded = parseCookies(req.headers.cookie)[CONTEXT_COOKIE];
  if (!encoded || encoded.length > 2048) return null;
  let decoded;
  try {
    decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  try {
    const origin = new URL(decoded);
    return isHttpOrigin(origin) && origin.href === `${origin.origin}/`
      ? origin.origin
      : null;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const result = Object.create(null);
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) result[name] = value;
  }
  return result;
}

function appendSetCookie(headers, cookie) {
  const current = headers['set-cookie'];
  if (!current) headers['set-cookie'] = [cookie];
  else if (Array.isArray(current)) headers['set-cookie'] = current.concat(cookie);
  else headers['set-cookie'] = [current, cookie];
}

function isSecureClientRequest(request) {
  const forwarded = String(request.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return forwarded === 'https' || Boolean(request.socket?.encrypted);
}

function isHttpOrigin(url) {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

function isLocalRoute(pathname) {
  return pathname === '/' ||
    pathname === '/healthz' ||
    pathname === '/__proxy-local/healthz';
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received; shutting down`);
  server.close(() => {
    httpAgent.destroy();
    httpsAgent.destroy();
    process.exit(0);
  });
  setTimeout(() => {
    httpAgent.destroy();
    httpsAgent.destroy();
    process.exit(1);
  }, 10_000).unref();
}

if (!EMBEDDED) {
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
module.exports = { app, server, httpAgent, httpsAgent };
  },
  };
}
