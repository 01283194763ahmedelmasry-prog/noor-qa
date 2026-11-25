// In-memory Arabic search: diacritics-stripped, lightly stemmed BM25 over verified Quran/hadith texts.
import fs from 'node:fs';
import zlib from 'node:zlib';
const findF = (dir, base) => { const re = new RegExp('^(?:\\d+-)?' + base.replace('.', '\\.') + '(?:\\.gz)?$'); const f = fs.readdirSync(dir).filter((x) => re.test(x)).sort((x, y) => (parseInt(y) || 0) - (parseInt(x) || 0))[0]; if (!f) throw new Error('missing data file ' + base); return dir + '/' + f; };
const readJ = (dir, base) => {
  const stem = base.replace('.json', '');
  const parts = fs.readdirSync(dir).filter((x) => x.startsWith(stem + '.b64.')).sort();
  if (parts.length) { const b = parts.map((x) => fs.readFileSync(dir + '/' + x, 'utf8').replace(/\s+/g, '')).join(''); return JSON.parse(zlib.gunzipSync(Buffer.from(b, 'base64')).toString('utf8')); }
  const p = findF(dir, base); return JSON.parse(p.endsWith('.gz') ? zlib.gunzipSync(fs.readFileSync(p)).toString('utf8') : fs.readFileSync(p, 'utf8')); };
export const norm = (s) => String(s || '')
  .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, '')
  .replace(/[إأآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
  .replace(/[^\u0621-\u064A0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set('كيف ما ماذا هل هو هي هم من في علي الي عن او ان لا اذا اذ ثم قد لم لن كل هذا هذه ذلك التي الذي الذين انا انت نحن انه انها كان كانت يكون تكون ايه ازاي ليه امتي فين مين يعني بتاع حكم معني ماهو ماهي لماذا متي اين يجب ينبغي عند بين مع كما بل لو ام اي ايها يا الا غير بعد قبل حتي'.split(' '));
const PRE = ['وبال', 'وال', 'بال', 'كال', 'فال', 'لل', 'ال', 'ول', 'وب', 'و', 'ب', 'ل', 'ف'];
const SUF = ['ات', 'ون', 'ين', 'ان', 'ها', 'هم', 'هن', 'كم', 'نا', 'ه', 'ي'];
export function stem(w) {
  if (w.length <= 3) return w;
  for (const p of PRE) if (w.startsWith(p) && w.length - p.length >= 3) { w = w.slice(p.length); break; }
  for (const s of SUF) if (w.endsWith(s) && w.length - s.length >= 3) { w = w.slice(0, -s.length); break; }
  return w;
}
export const toks = (s, keepStop = false) => norm(s).split(' ').filter((w) => w && (keepStop || !STOP.has(w)) && w.length > 1).map(stem);

class Index {
  constructor() { this.post = new Map(); this.len = []; this.n = 0; this.avg = 1; }
  add(fields) { // fields: [[text, weight], ...]
    const id = this.n++; const tf = new Map(); let L = 0;
    for (const [text, wt] of fields) for (const t of toks(text, true)) { tf.set(t, (tf.get(t) || 0) + wt); if (wt >= 1) L += wt; }
    this.len.push(L);
    for (const [t, c] of tf) { let a = this.post.get(t); if (!a) this.post.set(t, a = []); a.push([id, c]); }
    return id;
  }
  done() { this.avg = this.len.reduce((a, b) => a + b, 0) / Math.max(1, this.n); }
  score(qt) { // qt: Map term -> weight ; returns Map doc -> score and matched counts
    const sc = new Map(), hit = new Map(); const k1 = 1.4, b = 0.6;
    for (const [t, qw] of qt) {
      const a = this.post.get(t); if (!a) continue;
      const idf = Math.log(1 + (this.n - a.length + 0.5) / (a.length + 0.5));
      for (const [d, c] of a) {
        const s = idf * (c * (k1 + 1)) / (c + k1 * (1 - b + b * this.len[d] / this.avg)) * qw;
        sc.set(d, (sc.get(d) || 0) + s); hit.set(d, (hit.get(d) || 0) + qw);
      }
    }
    return { sc, hit };
  }
}


const dw = (w) => w.split('').map((c) => c + '[\\u064B-\\u0652\\u0670]*').join('');
const SL = '(?:' + ['صلى', 'صلي'].map(dw).join('|') + ')\\s*' + dw('الله') + '\\s*' + dw('عليه') + '\\s*' + dw('وسلم');
const RA = new RegExp('(' + dw('عن') + '\\s*' + dw('النبي') + '[^.،]{0,60}?' + SL + '[\\s.:،]*)');
const RB = new RegExp('(?:^|[\\s،])(?:(?:' + ['قال', 'يقول', 'سمعت', 'ان', 'أن'].map(dw).join('|') + ')\\s*(?:' + ['رسول', 'النبي'].map(dw).join('|') + ')[^.،]{0,40}?' + SL + ')');
function splitSanad(t) {
  let m = RA.exec(t);
  if (m && m.index < 900) { const cut = m.index + m[0].length; if (t.length - cut >= 12) return [t.slice(0, cut).trim(), t.slice(cut).trim()]; }
  m = RB.exec(t);
  if (m && m.index >= 15 && m.index < 900 && /حدثنا|اخبرنا|حَدَّثَنَا|أَخْبَرَنَا|عَنْ/.test(t.slice(0, m.index))) return [t.slice(0, m.index).trim(), t.slice(m.index).trim()];
  return null;
}
export function loadData(dir = 'data') {
  const H = readJ(dir, 'hadiths.json');
  const A = readJ(dir, 'ayahs.json');
  for (const id of Object.keys(H)) { const h = H[id]; if (!h[4] && h[3]) { const r = splitSanad(h[3]); if (r) { h[4] = r[0]; h[3] = r[1]; } } }
  const hids = Object.keys(H), hix = new Index();
  for (const id of hids) { const [, bk, ch, t, s] = H[id]; hix.add([[ch, 4], [bk, 1.5], [t || s, 1]]); }
  hix.done();
  const aix = new Index();
  for (const r of A) aix.add([[r[2], 1.5], [r[4], 2], [r[5], 0.7]]);
  aix.done();
  const aById = new Map(A.map((r, i) => [r[0], i]));
  return { H, hids, hix, A, aix, aById };
}

function queryTerms(q, kw) {
  const m = new Map();
  const GEN = new Set(['فضل', 'حكم', 'معني', 'ماهو', 'اهميه', 'ماذا', 'كيف', 'لماذا', 'هل', 'ما', 'هو', 'هي', 'اريد', 'عايز', 'ايه', 'ازاي', 'قيمه']);
  for (const t of toks(q)) if (!GEN.has(t)) m.set(t, Math.max(m.get(t) || 0, 1));
  for (const k of kw || []) for (const t of toks(k)) m.set(t, Math.max(m.get(t) || 0, 0.9));
  return m;
}
function rank(ix, qt, k, minFrac) {
  const { sc, hit } = ix.score(qt); const tot = [...qt.values()].reduce((a, b) => a + b, 0) || 1;
  const arr = [...sc].map(([d, s]) => [d, s * (0.4 + 0.6 * Math.min(1, (hit.get(d) / tot) * 2.2)), hit.get(d) / tot]).sort((a, b) => b[1] - a[1]);
  return arr.slice(0, k);
}
export function searchLocal(D, q, kw, ka = 8, kh = 8) {
  const qt = queryTerms(q, kw);
  if (!qt.size) return { ayahs: [], hadiths: [] };
  const hr = rank(D.hix, qt, kh, 1).filter((x) => x[2] >= 0.34), ar = rank(D.aix, qt, ka, 1).filter((x) => x[2] >= 0.34);
  const hTop = hr.length ? hr[0][1] : 0, aTop = ar.length ? ar[0][1] : 0;
  return {
    hadiths: hr.filter(([, s]) => s >= hTop * 0.45).map(([d, s]) => ({ id: D.hids[d], score: s })),
    ayahs: ar.filter(([, s]) => s >= aTop * 0.45).map(([d, s]) => ({ id: D.A[d][0], score: s })),
  };
}

// ---------------- curated topics ----------------
const WEAK = new Set(['الله', 'ربنا', 'عمل', 'العمل', 'هم', 'الهم', 'الام', 'الاب', 'امي', 'ابي', 'الحرام', 'الحلال', 'الكلام', 'الكلمه', 'النساء', 'المراه', 'الزوج', 'الزوجه', 'الرسول', 'رسول الله', 'محمد', 'الاخره', 'الاجل', 'الغني', 'الرضا', 'الحمد', 'نعمه', 'الحكم', 'الدين', 'دين', 'السفر', 'المسافر', 'الطريق', 'المعروف', 'القبر', 'الموت', 'السر', 'الوقت', 'العمر', 'الايام', 'الرزق', 'رزق', 'الدنيا', 'علم', 'العلم', 'الاكل', 'اكل', 'شرب', 'الشرب', 'نوم', 'النوم', 'الطعام', 'المسجد', 'الجار', 'جار', 'الضيف', 'ضيف', 'الاسلام', 'الايمان', 'اركان', 'المرض', 'مرض', 'الفقر', 'فقر', 'الحكم', 'السنه', 'الصحه', 'خلق', 'الاخلاق', 'الادب', 'السلوك', 'اولاد', 'الاولاد', 'الطفل', 'الاطفال', 'البصر', 'النظر', 'الزينه', 'عمره', 'ملابس', 'الاقارب', 'الصديق', 'صديق', 'السلام', 'سلام', 'الجمع', 'الفطر', 'الفجر', 'الصبح', 'صبح', 'قدر', 'القدر', 'الحج', 'حج', 'شكر', 'الشكر', 'عهد', 'العهد', 'وعد', 'الوعد', 'ذكر', 'الذكر', 'الكسب', 'الغش', 'غش', 'الظلم', 'ظلم', 'الصدق', 'صدق', 'كذب', 'الكذب', 'نار', 'النار', 'جنه', 'الجنه', 'عذاب', 'الاحسان', 'العدل', 'عدل', 'الحيوان', 'حيوان', 'الذبح', 'ذبح', 'النهار', 'العيد', 'عيد', 'الابتلاء', 'البلاء', 'الدوره', 'الشباب', 'الحشر', 'الحساب', 'البعث', 'الامير', 'السلطان', 'الخوف']);
const nTrig = (s) => norm(s);
export function loadTopics(dir = 'data') {
  const T = readJ(dir, 'topics.json');
  for (const t of T) { t.n = t.trig.map(nTrig).filter(Boolean); const alts = []; { let d = 0, cur = ''; for (const c of t.hch) { if (c === '(') d++; if (c === ')') d--; if (c === '|' && !d) { alts.push(cur); cur = ''; } else cur += c; } alts.push(cur); }
    const nrm = (a) => a.replace(/[\u0600-\u06FF]+/g, (m) => norm(m));
    const bk = alts.filter((a) => a.startsWith('كتاب ')).map(nrm), ch = alts.filter((a) => !a.startsWith('كتاب ')).map(nrm);
    t.rxCh = ch.length ? new RegExp(ch.join('|')) : null; t.rxBk = bk.length ? new RegExp(bk.join('|')) : null; t.hqt = toks(t.hq); }
  return T;
}
const variants = (w) => { const v = new Set([w]); for (const sx of ['ي', 'ك', 'ها', 'ه', 'نا']) if (w.endsWith(sx) && w.length - sx.length >= 3) v.add(w.slice(0, -sx.length)); const base = [...v]; for (const b of base) for (const p of ['وال', 'بال', 'فال', 'كال', 'لل', 'ال', 'و', 'ب', 'ل']) if (b.startsWith(p) && b.length - p.length >= 2) v.add(b.slice(p.length)); return [...v]; };
export function matchTopics(T, q) {
  const nq = norm(q); const words = nq.split(' ').filter(Boolean);
  const meaningful = words.filter((w) => !STOP.has(w)).length;
  const vs = new Set(words.flatMap(variants));
  const padded = ' ' + nq + ' ';
  const res = [];
  for (const t of T) {
    let s = 0;
    for (const g of t.n) {
      const multi = g.includes(' ');
      const hit = multi ? padded.includes(' ' + g + ' ') || padded.includes(' ' + g) : vs.has(g);
      if (!hit) continue;
      const weak = WEAK.has(g) && !multi;
      if (weak && meaningful > 3) continue;
      s = Math.max(s, (multi ? 2.5 : 1) * (weak ? 0.5 : 1) * (g.length >= 5 ? 1.2 : 1) + (multi ? 0.5 : 0));
    }
    if (s > 0) res.push([t, s]);
  }
  res.sort((a, b) => b[1] - a[1]);
  if (!res.length) return [];
  return res.filter(([, s]) => s >= res[0][1] * 0.6).slice(0, 2).map(([t]) => t);
}
export function topicHadiths(D, topic, q, k = 6) {
  const qt = new Map();
  for (const t of topic.hqt) qt.set(t, 1);
  for (const t of toks(q)) if (!qt.has(t)) qt.set(t, 0.25);
  const { sc } = D.hix.score(qt);
  if (!D.nch) { D.nch = D.hids.map((id) => norm(D.H[id][2])); D.nbk = D.hids.map((id) => norm(D.H[id][1])); }
  const cand = [];
  for (const [d, s] of sc) if ((topic.rxCh && topic.rxCh.test(D.nch[d])) || (topic.rxBk && topic.rxBk.test(D.nbk[d]))) { const h = D.H[D.hids[d]]; cand.push([d, s * (h[3] ? ((h[3].length < 45) ? 0.6 : 1.2) : 1) * ((h[3] || h[4]).length > 1500 ? 0.6 : 1)]); }
  cand.sort((a, b) => b[1] - a[1]);
  const per = new Map(), out = [];
  for (const id of topic.hf || []) if (D.H[id] && out.length < k) { out.push({ id, score: 99, curated: true }); per.set(D.H[id][2], (per.get(D.H[id][2]) || 0) + 1); }
  for (const [d, s] of cand) {
    if (out.some((o) => o.id === D.hids[d])) continue;
    const ch = D.H[D.hids[d]][2]; const c = per.get(ch) || 0;
    if (c >= 2) continue; per.set(ch, c + 1); out.push({ id: D.hids[d], score: s, curated: true });
    if (out.length >= k) break;
  }
  return out;
}
export function answer(D, T, q, kw) {
  const topics = matchTopics(T, q);
  const gen = searchLocal(D, q, kw, 8, 8);
  if (!topics.length) return { topics: [], ...gen };
  const ayahs = [], seenA = new Set(), hads = [], seenH = new Set();
  const hl = topics.map((t) => topicHadiths(D, t, q, 6));
  const al = topics.map((t) => t.ay.slice(0, 7));
  for (let i = 0; i < 8; i++) for (const l of al) if (l[i] && !seenA.has(l[i]) && ayahs.length < 7) { seenA.add(l[i]); ayahs.push({ id: l[i], curated: true }); }
  for (let i = 0; i < 6; i++) for (const l of hl) if (l[i] && !seenH.has(l[i].id) && hads.length < 6) { seenH.add(l[i].id); hads.push(l[i]); }
  if (hads.length < 3) for (const h of gen.hadiths) if (hads.length < 4 && !seenH.has(h.id)) { seenH.add(h.id); hads.push(h); }
  return { topics: topics.map((t) => t.name), ayahs, hadiths: hads };
}
