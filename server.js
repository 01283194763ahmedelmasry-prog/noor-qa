// نور — zero-dependency Node server: static site + /api/search (hybrid Quran/hadith retrieval),
// /api/explain (plain-language hadith meaning, cached), /api/admin/import (one-time data loader).
// Rule #1: answers come from verified texts with citations. The LLM never writes rulings.
// Fallback: only when the verified bank has no answer, Gemini answers and the UI labels it as AI outside the verified sources.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { loadData, loadTopics, answer, nearestTopics, searchLocal } from './engine.js';
import { hisnMatch, hisnPublic } from './hisn.js';
const D = loadData(), TOPICS = loadTopics();
let N99 = []; try { N99 = JSON.parse(fs.readFileSync(new URL('./data/names99.json', import.meta.url), 'utf8')); } catch {}
const names99 = () => ({ list: N99.map((x) => { const i = x.r ? D.aById.get(x.r) : undefined; return { n: x.n, k: x.k, ...(i != null ? { ref: D.A[i][2] + ' ' + D.A[i][3], text: D.A[i][4], url: 'https://quran.com/' + x.r.replace(':', '/') } : {}) }; }) });
const explainCache = new Map();
if (fs.existsSync('.env')) for (const l of fs.readFileSync('.env', 'utf8').split('\n')) { const m = /^([A-Z_]+)=(.*)$/.exec(l.trim()); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]; }
const KEY = process.env.GEMINI_API_KEY;
const ADMIN = process.env.ADMIN_TOKEN || '';
const PORT = Number(process.env.PORT || 3000);
const SB = process.env.SUPABASE_URL, SBK = process.env.SUPABASE_SERVICE_KEY;
const GEN_MODELS = [...new Set([process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite', 'gemini-3.5-flash'])];
// Each model has its own free-tier quota bucket: try several, skip a model briefly after a 429, never for long after a 404.
const MODEL_LIST = [...new Set([process.env.GEMINI_MODEL, 'gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-2.0-flash', 'gemini-flash-lite-latest', 'gemini-flash-latest'].filter(Boolean))];
const cool = new Map(); const genStats = {};
// Several keys: GEMINI_API_KEY, GEMINI_API_KEY_2, GEMINI_API_KEY_3 (each from a separate Google project = separate quota).
// Round robin across keys; cooldown and last status are tracked per key + model. Optional per-key model list: GEMINI_MODELS_2, GEMINI_MODELS_3 (comma separated).
const KEYS = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2, process.env.GEMINI_API_KEY_3].map((k) => (k || '').trim()).filter(Boolean);
const KEY_MODELS = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2, process.env.GEMINI_API_KEY_3].map((k, i) => ({ k: (k || '').trim(), m: (process.env[i === 0 ? 'GEMINI_MODELS' : 'GEMINI_MODELS_' + (i + 1)] || '').split(',').map((x) => x.trim()).filter(Boolean) })).filter((x) => x.k).map((x) => ({ k: x.k, models: x.m.length ? x.m : MODEL_LIST }));
let rr = 0;
async function genText(prompt, ms = 9000, budget = 30000) {
  const t0 = Date.now();
  const n = KEY_MODELS.length; if (!n) return null;
  const start = rr++ % n;
  let pairs = [];
  for (let o = 0; o < n; o++) { const ki = (start + o) % n; for (const m of KEY_MODELS[ki].models) pairs.push([ki, m]); }
  let order = pairs.filter(([ki, m]) => (cool.get(ki + '|' + m) || 0) < t0); if (!order.length) order = pairs;
  for (const [ki, m] of order) {
    if (Date.now() - t0 > budget) break;
    const id = ki + '|' + m, label = 'key' + (ki + 1) + ':' + m;
    for (let a = 0; a < 2; a++) {
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY_MODELS[ki].k },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }), signal: AbortSignal.timeout(ms),
        });
        genStats[label] = { status: r.status, at: new Date().toISOString() };
        if (r.ok) { const j = await r.json(); const t = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim(); if (t) return t; break; }
        console.log('gen', label, r.status);
        if (r.status === 429) { cool.set(id, Date.now() + 45000); break; }
        if (r.status === 404 || r.status === 400 || r.status === 403) { cool.set(id, Date.now() + 3600000); break; }
        await sleep(700 * (a + 1));
      } catch (err) { genStats[label] = { status: 'err ' + String(err.message).slice(0, 40), at: new Date().toISOString() }; console.log('gen err', label, String(err.message)); break; }
    }
  }
  return null;
}
const sb = (p, o = {}) => fetch(SB + p, { ...o, headers: { apikey: SBK, ...(SBK && !SBK.startsWith('sb_') ? { Authorization: 'Bearer ' + SBK } : {}), 'Content-Type': 'application/json', ...(o.headers || {}) } });
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Personal-fatwa topics: the app shows verified texts, it never issues rulings on personal cases.
const FATWA_TOPICS = ['طلاق', 'طلقت', 'مطلقة', 'ميراث', 'ورث', 'إرث', 'إجهاض', 'اجهاض', 'انتحار', 'نذر شخصي'];
const FATWA_MSG = 'هذا السؤال يتعلق بحالة شخصية تحتاج فتوى من عالم مؤهل يسمع تفاصيلها. التطبيق يعرض النصوص الموثقة من القرآن والسنة فقط ولا يُفتي في الحالات الشخصية.';

const TRIVIA_RE = /^\s*(كم|كام|متى|امتى|متي|امتي|من|مين|اول|أول|ما اسم|ايه اسم|ما هو اول|ما هي اول|في اي|في أي|اين|أين|فين)\s/;
const COUNT_RE = /^\s*(كم|كام|متى|امتى|متي|امتي)\s/;
const body = (req) => new Promise((resolve, reject) => { let b = '', n = 0, dead = false;
  req.on('data', (c) => { n += c.length; if (n > 8e6) { dead = true; reject(Object.assign(new Error('too_large'), { code: 413 })); req.destroy(); } else b += c; });
  req.on('end', () => { if (dead) return; try { const v = JSON.parse(b || '{}'); resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {}); } catch { reject(Object.assign(new Error('bad_json'), { code: 400 })); } });
  req.on('error', () => { if (!dead) reject(Object.assign(new Error('bad_request'), { code: 400 })); }); });
process.on('uncaughtException', (e) => console.error('uncaughtException', e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

// Local multilingual embeddings (no API key): paraphrase-multilingual-MiniLM-L12-v2, 384 dims, int8.
let embedderP = null;
function getEmbedder() {
  if (!embedderP) embedderP = import('@huggingface/transformers').then((m) =>
    m.pipeline('feature-extraction', process.env.EMB_MODEL || 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', { dtype: 'int8' }));
  return embedderP;
}
async function embedBatch(texts) {
  const ex = await getEmbedder();
  const out = [];
  for (let i = 0; i < texts.length; i += 25) {
    const t = await ex(texts.slice(i, i + 25), { pooling: 'mean', normalize: true, truncation: true, max_length: 256 });
    out.push(...t.tolist());
  }
  return out;
}
const embedOne = async (t) => (await embedBatch([t]))[0];

// Query expansion: the LLM only rewrites the question into classical Arabic search keywords; it never answers.
const expCache = new Map();
async function expandQuery(q) {
  if (expCache.has(q)) return expCache.get(q);
  const prompt = `حوّل السؤال التالي إلى كلمات بحث عربية فصيحة تظهر في نصوص القرآن الكريم وكتب الحديث (الصحيحين) المتعلقة بموضوعه، مثل المصطلحات الشرعية والألفاظ الواردة في النصوص. أعد من 4 إلى 8 كلمات أو عبارات قصيرة مفصولة بفاصلة فقط، بدون شرح وبدون أي حكم.\n\nالسؤال: ${q}`;
  let kw = [];
  try { const t = await genText(prompt, 6000, 9000); if (t) kw = t.split(/[,،\n]/).map((x) => x.replace(/[^\u0600-\u06FF\s]/g, '').trim()).filter((x) => x && x.length < 40).slice(0, 8); } catch (err) { console.log('expand err', String(err.message)); }
  if (expCache.size > 500) expCache.clear();
  expCache.set(q, kw);
  return kw;
}

const pubA = (id) => { const x = D.A[D.aById.get(id)]; return { id, ref: x[2] + ' ' + x[3], text: x[4], tafsir: x[5], url: 'https://quran.com/' + id.replace(':', '/') }; };
const pubH = (id) => { const x = D.H[id]; return { id, ref: x[0] + ' - ' + x[1], matn: x[3] || x[4], sanad: x[3] ? x[4] : '', chapter: x[2], grade: 'صحيح', url: x[5] || ('https://sunnah.com/' + id) }; };
// Last resort: a user query never ends in "not found". Show the nearest verified texts with an honest label.
function lastResort(q, out) {
  const res = { fallback: true, topics: [], facts: [], ayahs: [], hadiths: [] };
  const nt = nearestTopics(TOPICS, q, 2);
  if (nt.length) {
    res.topics = nt.map((t) => t.name);
    for (const t of nt) { for (const id of (t.ay || []).slice(0, 3)) if (D.aById.has(id) && !res.ayahs.some((x) => x.id === id)) res.ayahs.push(pubA(id)); for (const id of (t.hf || []).slice(0, 3)) if (D.H[id] && !res.hadiths.some((x) => x.id === id)) res.hadiths.push(pubH(id)); if (t.fa) res.facts.push({ text: t.fa, src: t.fas || '', url: t.fau || '' }); }
  }
  if (!res.ayahs.length && !res.hadiths.length) {
    try { const g = searchLocal(D, q, [], 4, 4, 0.05, false); res.ayahs = (g.ayahs || []).map(({ id }) => pubA(id)); res.hadiths = (g.hadiths || []).map(({ id }) => pubH(id)); } catch {}
  }
  if (!res.ayahs.length && !res.hadiths.length) { res.ayahs = (out && out.ayahs) || []; res.hadiths = (out && out.hadiths) || []; }
  if (!res.ayahs.length && !res.hadiths.length) res.suggest = TOPICS.filter((t) => t.ch).slice(0, 400).sort(() => Math.random() - 0.5).slice(0, 8).map((t) => t.name);
  return res;
}
const STORY_R = (() => { try { return JSON.parse(fs.readFileSync(new URL('./data/story_ranges.json', import.meta.url), 'utf8')); } catch (e) { return {}; } })();
function storyOf(names) {
  const t = (names || []).map((n) => TOPICS.find((x) => x.name === n)).find((x) => x && x.ch === 'qisas');
  if (!t) return null;
  const ids = [];
  const add = (id) => { if (D.aById.has(id) && !ids.includes(id)) ids.push(id); };
  for (const rg of (STORY_R[t.name] || (t.ay || []))) {
    const m = String(rg).match(/^(\d+):(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    for (let a = +m[2]; a <= +(m[3] || m[2]); a++) add(m[1] + ':' + a);
  }
  if (!ids.length) return null;
  return { name: t.name, thin: !STORY_R[t.name], parts: ids.map((id) => pubA(id)), hadiths: (t.hf || []).filter((h) => D.H[h]).map((h) => pubH(h)) };
}
async function search(q) {
  const kw = await expandQuery(q);
  const r = answer(D, TOPICS, q, kw);
  return {
    story: storyOf(r.topics),
    topics: r.topics,
    facts: r.facts || [],
    ayahs: r.ayahs.map(({ id }) => { const x = D.A[D.aById.get(id)]; return { id, ref: x[2] + ' ' + x[3], text: x[4], tafsir: x[5], url: 'https://quran.com/' + id.replace(':', '/') }; }),
    hadiths: r.hadiths.map(({ id }) => { const x = D.H[id]; return { id, ref: x[0] + ' - ' + x[1], matn: x[3] || x[4], sanad: x[3] ? x[4] : '', chapter: x[2], grade: 'صحيح', url: x[5] || ('https://sunnah.com/' + id) }; }),
  };
}

async function explainHadith(id) {
  const x = D.H[id];
  if (!x) return null;
  if (explainCache.has(id)) return explainCache.get(id);
  const h = { matn: (x[3] || x[4]).slice(0, 2500) };
  const prompt = `اشرح معنى الحديث التالي بلغة عربية بسيطة جدًا يفهمها الناس العاديون، في 3 إلى 5 جمل قصيرة. التزم بمعنى نص الحديث فقط: لا تضف أحكامًا ولا معلومات من خارجه ولا تُفتي. اكتب الشرح مباشرة بدون مقدمات.\n\nالحديث: ${h.matn}`;
  const out = await genText(prompt, 10000, 40000);
  if (out) explainCache.set(id, out);
  return out;
}

// AI fallback: only when the verified bank has no answer. Never overrides verified answers; UI labels it.
const aiCache = new Map();
async function geminiAnswer(q, fatwa) {
  const ck = q + '|' + (fatwa ? '1' : '0');
  if (aiCache.has(ck)) return aiCache.get(ck);
  const prompt = `أجب عن السؤال الإسلامي التالي بالعربية البسيطة في إجابة مختصرة من 3 إلى 6 جمل، بنص عادي بدون أي تنسيق Markdown. القواعد: الْزم أقوال جمهور أهل العلم المعتبرين، وبيّن موضع الخلاف المعتبر باختصار إن وُجد، ولا تُفتي في حالة شخصية بعينها بل اذكر القاعدة العامة، ولا تختلق مراجع أو أرقاماً أو أقوالاً. الاستشهاد بالآيات يكون بهذه الصيغة حصراً: [آية: اسم السورة: رقم الآية] مثل [آية: البقرة: 255]، ولا تكتب نص الآية بنفسك إطلاقاً. الاستشهاد بالأحاديث يكون بهذه الصيغة حصراً: [حديث: بخاري: رقم الحديث] أو [حديث: مسلم: رقم الحديث]، ولا تكتب متن الحديث بنفسك إطلاقاً، ولا تستشهد بغير صحيحي البخاري ومسلم. اكتب الإجابة مباشرة بدون مقدمات.\n\nالسؤال: ${q}`;
  let out = null;
  { const t = await genText(prompt); if (t) out = verifyAiCitations(t); }
  if (out) { if (aiCache.size > 300) aiCache.clear(); aiCache.set(ck, out); } // never cache a failure
  return out;
}

// --- AI citation verification: Gemini cites by strict tokens only. Every ayah renders from our
// mushaf text (never Gemini's wording); every hadith number is checked against the Bukhari/Muslim
// corpus and dropped when unverifiable, per the user's rule.
const AR_DIAC = /[\u064B-\u0652\u0670\u0640]/g;
const AR_DIG = '٠١٢٣٤٥٦٧٨٩';
const nrmAr = (s) => String(s || '').replace(AR_DIAC, '').replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/\s+/g, ' ').trim();
const nrmNum = (s) => +String(s).replace(/[٠-٩]/g, (d) => AR_DIG.indexOf(d));
let suraMap = null;
function suraNum(name) {
  if (!suraMap) { suraMap = new Map(); SURAH_NAMES.forEach((n, i) => suraMap.set(nrmAr(n).replace(/^ال/, ''), i + 1)); }
  return suraMap.get(nrmAr(name).replace(/^سوره\s+/, '').replace(/^ال/, '')) || 0;
}
export function verifyAiCitations(text) {
  if (!text) return text;
  // 1) strict ayah tokens: [آية: البقرة: 255] -> mushaf text + reference, dropped when unverifiable
  text = text.replace(/\[آية\s*[:：]\s*([^:\[\]：]+?)\s*[:：]\s*([0-9٠-٩]{1,3})\s*\]/g, (m, sn, an) => {
    const s = suraNum(sn), a = nrmNum(an), i = s && a ? D.aById.get(`${s}:${a}`) : undefined;
    if (i == null) return '';
    const r = D.A[i];
    return `﴿${r[4]}﴾ [سورة ${r[2]}، الآية ${r[3]}]`;
  });
  // 2) strict hadith tokens: [حديث: بخاري: 1938] / [حديث: مسلم: 123]; the number stays only if verified
  text = text.replace(/\[حديث\s*[:：]\s*([^:\[\]：]+?)\s*[:：]\s*([0-9٠-٩]{1,5})\s*\]/g, (m, coll, num) => {
    const c = /بخاري/.test(nrmAr(coll)) ? 'bukhari' : /مسلم/.test(nrmAr(coll)) ? 'muslim' : null;
    if (!c) return '';
    const n = nrmNum(num), label = c === 'bukhari' ? 'صحيح البخاري' : 'صحيح مسلم';
    return n && D.H[`${c}:${n}`] ? `(${label}، حديث رقم ${n})` : `(${label})`;
  });
  // 3) inline free-form hadith refs (رواه البخاري رقم 123، صحيح مسلم: 456 ...): same verification;
  // a bare number with no citation marker is left alone so ordinary prose is never mangled
  text = text.replace(/(صحيح البخاري|صحيح مسلم|البخاري|مسلم)((?:\s*[\(:：،,\-–]\s*|\s+)(?:حديث\s*)?(?:(?:برقم|رقم)\s*)?)([0-9٠-٩]{1,5})(\s*\)?)/g, (m, name, mid, num) => {
    if (!/[\(:：،,\-–]|رقم|حديث/.test(mid)) return m;
    const c = /بخاري/.test(name) ? 'bukhari' : 'muslim';
    return nrmNum(num) && D.H[`${c}:${nrmNum(num)}`] ? m : name;
  });
  // 4) inline free-form ayah refs (سورة آل عمران، آية 190): kept only if the ayah exists in the mushaf
  text = text.replace(/سورة\s+([^،,():.]{1,30}?)\s*[،,]?\s*(?:ال)?آية\s*(?:رقم\s*)?([0-9٠-٩]{1,3})/g, (m, sn, an) => {
    const s = suraNum(sn), a = nrmNum(an);
    return s && a && D.aById.has(`${s}:${a}`) ? m : '';
  });
  return text.replace(/[ \t]{2,}/g, ' ').replace(/\(\s*\)/g, '').replace(/\[\s*\]/g, '').replace(/ +\n/g, '\n').trim();
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
      const fat = FATWA_TOPICS.some((w) => q.includes(w));
      if (fat && !/ميراث|ورث|إرث|ارث|تركة|فرائض/.test(q)) {
        const ai = await geminiAnswer(q, true);
        return send(res, 200, { fatwa: FATWA_MSG, ...(ai ? { ai: { text: ai } } : {}), ayahs: [], hadiths: [] });
      }
      const hs = hisnMatch(q).map(hisnPublic);
      const out = await search(q);
      if (out.topics && out.topics.includes('أسماء الله الحسنى')) out.names99 = names99();
      if (hs.length) {
        // Hisn al-Muslim is a separate, labeled source. Without a Sahihayn topic, keyword noise is dropped.
        if (!(out.topics && out.topics.length)) { out.ayahs = []; out.hadiths = []; out.facts = []; }
        out.hisn = hs;
        return send(res, 200, out);
      }
      if (fat) out.fatwa = FATWA_MSG;
      // Trivia-style questions (counts, dates, who/where) with no curated topic only match unrelated hadiths by keyword:
      // answer them through the labeled AI fallback instead of showing weak matches.
      if (!fat && !(out.topics && out.topics.length) && !(out.facts && out.facts.length) && TRIVIA_RE.test(q) && (COUNT_RE.test(q) || !out.ayahs.length)) {
        const ai = await geminiAnswer(q, false);
        if (ai) return send(res, 200, { ai: { text: ai }, ayahs: [], hadiths: [] });
        return send(res, 200, lastResort(q, out));
      }
      if (!out.ayahs.length && !out.hadiths.length && !(out.facts && out.facts.length)) {
        const ai = await geminiAnswer(q, fat);
        if (ai) return send(res, 200, { ai: { text: ai }, ayahs: [], hadiths: [] });
        return send(res, 200, lastResort(q, out));
      }
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
    if (u.pathname === '/api/admin/status' && req.method === 'POST') {
      const b = await body(req);
      if (!ADMIN || b.token !== ADMIN) return send(res, 403, { error: 'forbidden' });
      const ca = (await sb('/rest/v1/qa_ayahs?select=id&embedding=not.is.null', { headers: { Prefer: 'count=exact', Range: '0-0' } })).headers.get('content-range');
      const ch = (await sb('/rest/v1/qa_hadiths?select=id&embedding=not.is.null', { headers: { Prefer: 'count=exact', Range: '0-0' } })).headers.get('content-range');
      return send(res, 200, { ayahs_embedded: ca, hadiths_embedded: ch });
    }
    if (u.pathname === '/api/ai-status') return send(res, 200, { key_present: !!KEY, keys: KEYS.length, models: genStats, cooling: Object.fromEntries([...cool].filter(([, t]) => t > Date.now()).map(([m, t]) => ['key' + (Number(m.split('|')[0]) + 1) + ':' + m.split('|')[1], Math.round((t - Date.now()) / 1000)])) });
    if (u.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
    const f = path.join('public', u.pathname === '/' ? 'index.html' : path.normalize(u.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); return fs.createReadStream(f).pipe(res); }
    res.writeHead(404); res.end('not found');
  } catch (e) { if (!res.headersSent) send(res, e.code === 400 || e.code === 413 ? e.code : 500, { error: String(e.message) }); }
}).listen(PORT, () => console.log('http://localhost:' + PORT));
