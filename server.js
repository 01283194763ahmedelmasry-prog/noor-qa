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
const GEN_MODELS = [...new Set([process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3-flash'])];
const sb = (p, o = {}) => fetch(SB + p, { ...o, headers: { apikey: SBK, ...(SBK && !SBK.startsWith('sb_') ? { Authorization: 'Bearer ' + SBK } : {}), 'Content-Type': 'application/json', ...(o.headers || {}) } });
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Personal-fatwa topics: the app shows verified texts, it never issues rulings on personal cases.
const FATWA_TOPICS = ['طلاق', 'طلقت', 'مطلقة', 'ميراث', 'ورث', 'إرث', 'إجهاض', 'اجهاض', 'انتحار', 'نذر شخصي'];
const FATWA_MSG = 'هذا السؤال يتعلق بحالة شخصية تحتاج فتوى من عالم مؤهل يسمع تفاصيلها. التطبيق يعرض النصوص الموثقة من القرآن والسنة فقط ولا يُفتي في الحالات الشخصية.';

const body = (req) => new Promise((resolve, reject) => { let b = '', n = 0, dead = false;
  req.on('data', (c) => { n += c.length; if (n > 8e6) { dead = true; reject(Object.assign(new Error('too_large'), { code: 413 })); req.destroy(); } else b += c; });
  req.on('end', () => { if (dead) return; try { const v = JSON.parse(b || '{}'); resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {}); } catch { reject(Object.assign(new Error('bad_json'), { code: 400 })); } });
  req.on('error', () => { if (!dead) reject(Object.assign(new Error('bad_request'), { code: 400 })); }); });
process.on('uncaughtException', (e) => console.error('uncaughtException', e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

// Embeddings: Gemini gemini-embedding-001 (768 dims). Task type differs for documents vs queries.
const EMB_MODEL = process.env.EMB_MODEL || 'gemini-embedding-001';
async function embedBatch(texts, taskType = 'RETRIEVAL_DOCUMENT') {
  for (let a = 0; a < 5; a++) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${EMB_MODEL}:batchEmbedContents`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
      body: JSON.stringify({ requests: texts.map((t) => ({ model: 'models/' + EMB_MODEL, content: { parts: [{ text: t }] }, taskType, outputDimensionality: 768 })) }),
    });
    if (r.ok) return (await r.json()).embeddings.map((e) => e.values);
    const st = r.status;
    console.log('embed', st, (await r.text()).slice(0, 200));
    if (st !== 503 && st !== 429 && st !== 500) throw new Error('embed ' + st);
    await sleep(2500 * (a + 1));
  }
  throw new Error('embed retries exhausted');
}
const embedOne = async (t) => (await embedBatch([t], 'RETRIEVAL_QUERY'))[0];

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

// --- one-time data import (chunked, resumable; fetches verified public sources itself) ---
const SURAH_NAMES = 'الفاتحة|البقرة|آل عمران|النساء|المائدة|الأنعام|الأعراف|الأنفال|التوبة|يونس|هود|يوسف|الرعد|إبراهيم|الحجر|النحل|الإسراء|الكهف|مريم|طه|الأنبياء|الحج|المؤمنون|النور|الفرقان|الشعراء|النمل|القصص|العنكبوت|الروم|لقمان|السجدة|الأحزاب|سبأ|فاطر|يس|الصافات|ص|الزمر|غافر|فصلت|الشورى|الزخرف|الدخان|الجاثية|الأحقاف|محمد|الفتح|الحجرات|ق|الذاريات|الطور|النجم|القمر|الرحمن|الواقعة|الحديد|المجادلة|الحشر|الممتحنة|الصف|الجمعة|المنافقون|التغابن|الطلاق|التحريم|الملك|القلم|الحاقة|المعارج|نوح|الجن|المزمل|المدثر|القيامة|الإنسان|المرسلات|النبأ|النازعات|عبس|التكوير|الانفطار|المطففين|الانشقاق|البروج|الطارق|الأعلى|الغاشية|الفجر|البلد|الشمس|الليل|الضحى|الشرح|التين|العلق|القدر|البينة|الزلزلة|العاديات|القارعة|التكاثر|العصر|الهمزة|الفيل|قريش|الماعون|الكوثر|الكافرون|النصر|المسد|الإخلاص|الفلق|الناس'.split('|');
const BASMALA_RE = /^بِسْمِ\s+\S+\s+\S+\s+\S+\s+/;
const TANZIL = 'https://tanzil.net/pub/download/index.php?quranType=uthmani&outType=txt-2&agree=true';
const MUYASSAR = (s) => `https://cdn.jsdelivr.net/gh/spa5k/tafsir_api@main/tafsir/ar-tafsir-muyassar/${s}.json`;
const HF_ROWS = (off, len) => `https://datasets-server.huggingface.co/rows?dataset=freococo%2Fsunnah_dataset&config=default&split=train&offset=${off}&length=${len}`;
const HF_TOTAL = 39318, TARGET = { 'Sahih al-Bukhari': 'صحيح البخاري', 'Sahih Muslim': 'صحيح مسلم' };
const fetchJ = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error('fetch ' + r.status + ' ' + u.slice(0, 80)); return r.json(); };

let quranCache = null;
async function loadQuran() {
  if (quranCache) return quranCache;
  const txt = await (await fetch(TANZIL)).text();
  const tafsirs = {};
  for (let s = 1; s <= 114; s++) tafsirs[s] = await fetchJ(MUYASSAR(s));
  const rows = [];
  for (const line of txt.split('\n')) {
    const m = /^(\d+)\|(\d+)\|(.*)$/.exec(line.trim());
    if (!m) continue;
    const s = +m[1], a = +m[2]; let t = m[3].trim();
    if (a === 1 && s !== 1 && s !== 9 && t.split(' ')[0].startsWith('بِسْمِ')) t = t.split(' ').slice(4).join(' ');
    let tf = (tafsirs[s] && tafsirs[s][a - 1] && tafsirs[s][a - 1].text) || '';
    tf = tf.replace(/(^|\n\n)\[التفسير\]\s*/g, '$1');
    if (a === 1) { // strip surah intro paragraphs
      const paras = tf.split('\n\n'); const kept = []; let started = false;
      for (const p of paras) {
        if (!started && (p.startsWith('تسمية السورة') || p.startsWith('من مقاصد السورة') || p.trimStart().startsWith('•'))) continue;
        started = true; kept.push(p);
      }
      tf = kept.join('\n\n').trim();
    }
    rows.push({ id: `${s}:${a}`, surah: s, surah_name: SURAH_NAMES[s - 1], ayah: a, text: t, tafsir: tf });
  }
  if (rows.length !== 6236) throw new Error('quran rows ' + rows.length);
  quranCache = rows;
  return rows;
}

// Fetch one page of the Sunnah.com dataset export and keep Bukhari/Muslim rows.
async function hadithPage(off, len) {
  const j = await fetchJ(HF_ROWS(off, len));
  const out = [];
  for (const w of j.rows || []) {
    const r = w.row;
    if (!TARGET[r.collection]) continue;
    const url = (r.url || '').trim();
    const id = url.split('sunnah.com/').pop().replace(/\/+$/, '') || (r.collection + ':' + r.hadith_id);
    let grade = 'صحيح';
    try { const g = typeof r.gradings === 'string' ? JSON.parse(r.gradings) : (r.gradings || []); if (g[0] && g[0].grade) grade = g[0].grade; } catch {}
    out.push({ id, collection: TARGET[r.collection], book_ar: (r.book_ar || '').trim(), chapter_ar: (r.chapter_ar || '').trim(), matn: ((r.arabic_matn || '').trim() || (r.arabic_full || '').trim()), grade, url });
  }
  return out;
}

const ayahDoc = (r) => `سورة ${r.surah_name} الآية ${r.ayah}: ${r.text}\nالتفسير: ${String(r.tafsir).slice(0, 600)}`;
const hadithDoc = (r) => `${r.collection} - ${r.book_ar} - ${r.chapter_ar}: ${r.matn}`;

async function importAyahs(offset, limit) {
  const rows = await loadQuran();
  const slice = rows.slice(offset, offset + limit);
  if (slice.length) {
    const embs = await embedBatch(slice.map(ayahDoc));
    const payload = slice.map((r, i) => ({ ...r, embedding: JSON.stringify(embs[i]) }));
    const r = await sb('/rest/v1/qa_ayahs', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify(payload) });
    if (!r.ok) { console.log('import ayahs', r.status, (await r.text()).slice(0, 400)); throw new Error('import_failed'); }
  }
  return { done: offset + limit >= rows.length, total: rows.length, offset: offset + limit };
}

// offset = position in the source dataset (0..39318); keeps Bukhari/Muslim only. Returns next offset.
async function importHadiths(offset, pages) {
  let kept = [];
  for (let p = 0; p < pages && offset < HF_TOTAL; p++, offset += 100) kept = kept.concat(await hadithPage(offset, 100));
  if (kept.length) {
    for (let i = 0; i < kept.length; i += 100) {
      const slice = kept.slice(i, i + 100);
      const embs = await embedBatch(slice.map(hadithDoc));
      const payload = slice.map((r, j) => ({ ...r, embedding: JSON.stringify(embs[j]) }));
      const r = await sb('/rest/v1/qa_hadiths', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify(payload) });
      if (!r.ok) { console.log('import hadiths', r.status, (await r.text()).slice(0, 400)); throw new Error('import_failed'); }
    }
  }
  return { done: offset >= HF_TOTAL, total: HF_TOTAL, offset, kept: kept.length };
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
      const out = b.kind === 'hadiths'
        ? await importHadiths(Math.max(0, Number(b.offset) || 0), Math.min(20, Number(b.pages) || 10))
        : await importAyahs(Math.max(0, Number(b.offset) || 0), Math.min(100, Number(b.limit) || 100));
      return send(res, 200, out);
    }
    if (u.pathname === '/api/admin/gemini-test' && req.method === 'POST') {
      const b = await body(req);
      if (!ADMIN || b.token !== ADMIN) return send(res, 403, { error: 'forbidden' });
      const info = { key_present: !!KEY, key_len: (KEY || '').length, key_starts_ai: (KEY || '').startsWith('AIza') };
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEN_MODELS[0]}:generateContent`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
          body: JSON.stringify({ contents: [{ parts: [{ text: 'قل: تم' }] }] }),
        });
        info.generate_status = r.status;
        if (r.ok) { const j = await r.json(); info.generate_ok = !!(j.candidates && j.candidates[0]); }
        else info.generate_err = (await r.text()).slice(0, 200);
      } catch (e) { info.generate_err = String(e.message); }
      return send(res, 200, info);
    }
    if (u.pathname === '/api/admin/load' && req.method === 'POST') {
      const b = await body(req);
      if (!ADMIN || b.token !== ADMIN) return send(res, 403, { error: 'forbidden' });
      const tbl = b.kind === 'hadiths' ? 'qa_hadiths' : 'qa_ayahs';
      const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, 200).map((r) => ({ ...r, embedding: JSON.stringify(r.embedding) }));
      const r = await sb('/rest/v1/' + tbl, { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify(rows) });
      if (!r.ok) { console.log('load', r.status, (await r.text()).slice(0, 300)); return send(res, 500, { error: 'load_failed ' + r.status }); }
      return send(res, 200, { loaded: rows.length });
    }
    if (u.pathname === '/api/admin/reembed' && req.method === 'POST') {
      const b = await body(req);
      if (!ADMIN || b.token !== ADMIN) return send(res, 403, { error: 'forbidden' });
      const had = b.kind === 'hadiths';
      const tbl = had ? 'qa_hadiths' : 'qa_ayahs';
      const cols = had ? 'id,collection,book_ar,chapter_ar,matn,grade,url,simple_explanation' : 'id,surah,surah_name,ayah,text,tafsir';
      const off = Math.max(0, Number(b.offset) || 0), lim = Math.min(100, Number(b.limit) || 100);
      const g = await sb(`/rest/v1/${tbl}?select=${cols}&order=id&offset=${off}&limit=${lim}`);
      if (!g.ok) return send(res, 500, { error: 'read_failed ' + g.status });
      const rows = await g.json();
      if (rows.length) {
        const embs = await embedBatch(rows.map(had ? hadithDoc : ayahDoc));
        const payload = rows.map((r, i) => ({ ...r, embedding: JSON.stringify(embs[i]) }));
        const w = await sb('/rest/v1/' + tbl, { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify(payload) });
        if (!w.ok) { console.log('reembed', w.status, (await w.text()).slice(0, 300)); return send(res, 500, { error: 'write_failed ' + w.status }); }
      }
      return send(res, 200, { offset: off + rows.length, done: rows.length < lim });
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
