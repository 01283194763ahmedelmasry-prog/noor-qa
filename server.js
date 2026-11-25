// نور — zero-dependency Node server: static site + /api/search (hybrid Quran/hadith retrieval),
// /api/explain (plain-language hadith meaning, cached), /api/admin/import (one-time data loader).
// Rule #1: answers come from verified texts with citations. The LLM never writes rulings.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
if (fs.existsSync('.env')) for (const l of fs.readFileSync('.env', 'utf8').split('\n')) { const m = /^([A-Z_]+)=(.*)$/.exec(l.trim()); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]; }
const KEY = process.env.GEMINI_API_KEY;
const ADMIN = process.env.ADMIN_TOKEN || '';
const PORT = Number(process.env.PORT || 3000);
const SB = process.env.SUPABASE_URL, SBK = process.env.SUPABASE_SERVICE_KEY;
const EMB_MODEL = process.env.EMB_MODEL || 'text-embedding-004';
const EMB_DIMS = Number(process.env.EMB_DIMS || 768);
const GEN_MODELS = [...new Set([process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3-flash'])];
const sb = (p, o = {}) => fetch(SB + p, { ...o, headers: { apikey: SBK, ...(SBK && !SBK.startsWith('sb_') ? { Authorization: 'Bearer ' + SBK } : {}), 'Content-Type': 'application/json', ...(o.headers || {}) } });
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Personal-fatwa topics: the app shows verified texts, it never issues rulings on personal cases.
const FATWA_TOPICS = ['طلاق', 'طلقت', 'مطلقة', 'ميراث', 'ورث', 'إرث', 'إجهاض', 'اجهاض', 'انتحار', 'نذر شخصي'];
const FATWA_MSG = 'هذا السؤال يتعلق بحالة شخصية تحتاج فتوى من عالم مؤهل يسمع تفاصيلها. التطبيق يعرض النصوص الموثقة من القرآن والسنة فقط ولا يُفتي في الحالات الشخصية.';

const body = (req) => new Promise((resolve, reject) => { let b = '', n = 0, dead = false;
  req.on('data', (c) => { n += c.length; if (n > 1e6) { dead = true; reject(Object.assign(new Error('too_large'), { code: 413 })); req.destroy(); } else b += c; });
  req.on('end', () => { if (dead) return; try { const v = JSON.parse(b || '{}'); resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {}); } catch { reject(Object.assign(new Error('bad_json'), { code: 400 })); } });
  req.on('error', () => { if (!dead) reject(Object.assign(new Error('bad_request'), { code: 400 })); }); });
process.on('uncaughtException', (e) => console.error('uncaughtException', e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

async function embedBatch(texts) {
  for (let a = 0; a < 4; a++) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${EMB_MODEL}:batchEmbedContents`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
      body: JSON.stringify({ requests: texts.map((t) => ({ model: 'models/' + EMB_MODEL, content: { parts: [{ text: t }] }, outputDimensionality: EMB_DIMS })) }),
    });
    if (r.ok) return (await r.json()).embeddings.map((e) => e.values);
    const st = r.status;
    console.log('embed', st, (await r.text()).slice(0, 300));
    if (st !== 503 && st !== 429) throw new Error('embed ' + st);
    await sleep(2000 * (a + 1));
  }
  throw new Error('embed retries exhausted');
}
const embedOne = async (t) => (await embedBatch([t]))[0];

async function search(q) {
  const emb = await embedOne(q);
  const r = await sb('/rest/v1/rpc/qa_search', { method: 'POST', body: JSON.stringify({ q, emb: JSON.stringify(emb), ka: 5, kh: 5 }) });
  if (!r.ok) { console.log('qa_search', r.status, (await r.text()).slice(0, 300)); throw new Error('search_failed'); }
  const rows = await r.json();
  return {
    ayahs: rows.filter((x) => x.kind === 'ayah').map(({ id, ref, body, extra, url, score }) => ({ id, ref, text: body, tafsir: extra, url, score })),
    hadiths: rows.filter((x) => x.kind === 'hadith').map(({ id, ref, body, extra, grade, url, score }) => ({ id, ref, matn: body, chapter: extra, grade, url, score })),
  };
}

async function explainHadith(id) {
  const got = await sb('/rest/v1/qa_hadiths?id=eq.' + encodeURIComponent(id) + '&select=id,matn,simple_explanation');
  const h = (await got.json())[0];
  if (!h) return null;
  if (h.simple_explanation) return h.simple_explanation;
  const prompt = `اشرح معنى الحديث التالي بلغة عربية بسيطة جدًا يفهمها الناس العاديون، في 3 إلى 5 جمل قصيرة. التزم بمعنى نص الحديث فقط: لا تضف أحكامًا ولا معلومات من خارجه ولا تُفتي. اكتب الشرح مباشرة بدون مقدمات.\n\nالحديث: ${h.matn}`;
  let out = null;
  outer: for (const m of GEN_MODELS) {
    for (let a = 0; a < 3; a++) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      });
      if (r.ok) { const j = await r.json(); out = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim(); break outer; }
      const st = r.status;
      console.log('explain', m, st, (await r.text()).slice(0, 300));
      if (st !== 503 && st !== 429) break;
      await sleep(1500 * (a + 1));
    }
  }
  if (out) await sb('/rest/v1/qa_hadiths?id=eq.' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ simple_explanation: out }) });
  return out;
}

// --- one-time data import (chunked, resumable) ---
let cache = {};
function loadData(kind) {
  if (cache[kind]) return cache[kind];
  const file = path.join('data', kind === 'ayahs' ? 'ayahs.jsonl' : 'hadiths.jsonl');
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  cache[kind] = rows;
  return rows;
}
const ayahDoc = (r) => `سورة ${r.surah_name} الآية ${r.ayah}: ${r.text}\nالتفسير: ${String(r.tafsir).slice(0, 600)}`;
const hadithDoc = (r) => `${r.collection} - ${r.book_ar} - ${r.chapter_ar}: ${r.matn}`;

async function importChunk(kind, offset, limit) {
  const rows = loadData(kind);
  const slice = rows.slice(offset, offset + limit);
  if (!slice.length) return { done: true, total: rows.length, offset };
  const docs = slice.map(kind === 'ayahs' ? ayahDoc : hadithDoc);
  const embs = await embedBatch(docs);
  const payload = slice.map((r, i) => kind === 'ayahs'
    ? { id: r.id, surah: r.surah, surah_name: r.surah_name, ayah: r.ayah, text: r.text, tafsir: r.tafsir, embedding: JSON.stringify(embs[i]) }
    : { id: r.id, collection: r.collection, book_ar: r.book_ar, chapter_ar: r.chapter_ar, matn: r.matn, grade: r.grade, url: r.url, embedding: JSON.stringify(embs[i]) });
  const r = await sb('/rest/v1/' + (kind === 'ayahs' ? 'qa_ayahs' : 'qa_hadiths'), { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify(payload) });
  if (!r.ok) { console.log('import', r.status, (await r.text()).slice(0, 400)); throw new Error('import_failed'); }
  return { done: offset + limit >= rows.length, total: rows.length, offset: offset + limit };
}

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/search' && req.method === 'POST') {
      const inp = await body(req);
      const q = String(inp.q || '').trim().slice(0, 500);
      if (q.length < 2) return send(res, 400, { error: 'query_required' });
      if (FATWA_TOPICS.some((w) => q.includes(w))) return send(res, 200, { fatwa: FATWA_MSG, ayahs: [], hadiths: [] });
      const out = await search(q);
      if (!out.ayahs.length && !out.hadiths.length) return send(res, 200, { none: true, ayahs: [], hadiths: [] });
      return send(res, 200, out);
    }
    if (u.pathname === '/api/explain' && req.method === 'POST') {
      const inp = await body(req);
      const id = String(inp.id || '').trim().slice(0, 60);
      if (!/^(bukhari|muslim):[\w.]+$/.test(id)) return send(res, 400, { error: 'bad_id' });
      const out = await explainHadith(id);
      return out ? send(res, 200, { explanation: out }) : send(res, 404, { error: 'not_found' });
    }
    if (u.pathname === '/api/admin/import' && req.method === 'POST') {
      const b = await body(req);
      if (!ADMIN || b.token !== ADMIN) return send(res, 403, { error: 'forbidden' });
      const kind = b.kind === 'hadiths' ? 'hadiths' : 'ayahs';
      const out = await importChunk(kind, Math.max(0, Number(b.offset) || 0), Math.min(100, Number(b.limit) || 100));
      return send(res, 200, out);
    }
    if (u.pathname === '/api/admin/status' && req.method === 'POST') {
      const b = await body(req);
      if (!ADMIN || b.token !== ADMIN) return send(res, 403, { error: 'forbidden' });
      const ca = (await sb('/rest/v1/qa_ayahs?select=id&embedding=not.is.null', { headers: { Prefer: 'count=exact', Range: '0-0' } })).headers.get('content-range');
      const ch = (await sb('/rest/v1/qa_hadiths?select=id&embedding=not.is.null', { headers: { Prefer: 'count=exact', Range: '0-0' } })).headers.get('content-range');
      return send(res, 200, { ayahs_embedded: ca, hadiths_embedded: ch });
    }
    if (u.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
    const f = path.join('public', u.pathname === '/' ? 'index.html' : path.normalize(u.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); return fs.createReadStream(f).pipe(res); }
    res.writeHead(404); res.end('not found');
  } catch (e) { if (!res.headersSent) send(res, e.code === 400 || e.code === 413 ? e.code : 500, { error: String(e.message) }); }
}).listen(PORT, () => console.log('http://localhost:' + PORT));
