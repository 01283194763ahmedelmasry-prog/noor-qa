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
const STOP = new Set('كيف ما ماذا هل هو هي هم من في علي الي عن او ان لا اذا اذ ثم قد لم لن كل هذا هذه ذلك التي الذي الذين انا انت نحن انه انها كان كانت يكون تكون ايه ازاي ليه امتي فين مين يعني بتاع حكم معني ماهو ماهي لماذا متي اين يجب ينبغي عند بين مع كما بل لو ام اي ايها يا الا غير بعد قبل حتي اللي ولا انهي مش وامتي منين عشان لحد'.split(' '));
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
  // Word-frequency index over the bundled Tanzil text (normalized: no diacritics, unified hamzas):
  // powers the word-count answers, computed from the corpus itself, never invented.
  const wf = new Map(), wAy = new Map();
  for (let i = 0; i < A.length; i++) for (const w of norm(A[i][4]).split(' ')) {
    if (!w) continue;
    wf.set(w, (wf.get(w) || 0) + 1);
    let a = wAy.get(w); if (!a) wAy.set(w, a = []); if (a.length < 5) a.push(i);
  }
  return { H, hids, hix, A, aix, aById, wf, wAy };
}

function queryTerms(q, kw) {
  const m = new Map();
  const GEN = new Set(['فضل', 'حكم', 'معني', 'ماهو', 'اهميه', 'ماذا', 'كيف', 'لماذا', 'هل', 'ما', 'هو', 'هي', 'اريد', 'عايز', 'ايه', 'ازاي', 'قيمه', 'عمل', 'العمل', 'طريقه', 'الطريقه', 'طريق', 'حاجه', 'شيء', 'وصف', 'حرمه', 'كام', 'كم', 'عدد', 'عده']);
  for (const t of toks(q)) if (!GEN.has(t)) m.set(t, Math.max(m.get(t) || 0, 1));
  for (const k of kw || []) for (const t of toks(k)) m.set(t, Math.max(m.get(t) || 0, 0.9));
  return m;
}
function rank(ix, qt, k, minFrac) {
  const { sc, hit } = ix.score(qt); const tot = [...qt.values()].reduce((a, b) => a + b, 0) || 1;
  const arr = [...sc].map(([d, s]) => [d, s * (0.4 + 0.6 * Math.min(1, (hit.get(d) / tot) * 2.2)), hit.get(d) / tot]).sort((a, b) => b[1] - a[1]);
  return arr.slice(0, k);
}
const FILL = new Set(['كام', 'كم', 'عدد', 'عده', 'عايز', 'عاوز', 'اعرف', 'ممكن', 'سمحت', 'اشرح', 'اشرحلي', 'قولي', 'بالتفصيل', 'نصيحه', 'رايك', 'كلام', 'موضوع', 'سوال', 'ابغي', 'اريد', 'احتاج', 'محتاج', 'عندي', 'مشكله', 'اسال', 'اسأل', 'معلومات', 'تفاصيل', 'بخصوص', 'عن', 'الاسلام', 'اسلام', 'شرعا', 'شرعي', 'الشرع', 'الشريعه', 'الدين', 'الاسلاميه', 'مسلم', 'القران', 'السنه', 'الاحاديث', 'حديث', 'ايه', 'اية', 'آية', 'الايات', 'ايات', 'دليل', 'يوجد', 'موجود', 'موجوده', 'يحدث', 'يصير', 'يحصل', 'تقول', 'يقال', 'نقول', 'اقول', 'فلوس', 'فلوسي', 'الفلوس', 'كيلو', 'كيلوجرام', 'جرام', 'بنك', 'بنكي', 'تماني', 'تمانيه', 'فضل', 'ثواب', 'اجر', 'ضلها', 'ضل', 'البنكي', 'بنكيه', 'مبتديين', 'مبتدئ', 'بيتقال', 'رايح', 'جت', 'الست', 'ست', 'مالي'].map((x) => stem(norm(x)))); FILL.add('بنكي');
// Modern / out-of-scope / ambiguous concepts: the corpus has a same-spelled word with a different meaning, so answer nothing.
const OUT = new Set(['سحر', 'سحره', 'ساحر', 'تامين', 'تامينات', 'بيتكوين', 'بتكوين', 'كريبتو', 'اسهم', 'بورصه', 'فوركس', 'تداول', 'تبرع', 'اسم', 'مرحبا', 'اهلا', 'هلا', 'شكرا', 'تمام', 'اوكي', 'موسيقي', 'اغاني', 'غناء', 'تصوير', 'فيديو', 'انترنت', 'فيس', 'فيسبوك', 'يوتيوب', 'تجميل', 'جراحه', 'تطعيم', 'لقاح', 'يانصيب', 'قمار', 'سياره', 'موبايل', 'كمبيوتر', 'برمجه', 'لعبه', 'العاب', 'كره', 'ماتش', 'بنك', 'بنوك', 'قهوه', 'شاي', 'تدخين', 'سيجاره', 'شيشه'].map((x) => stem(norm(x))));
const OUT_PH = ['النوم بعد الفجر', 'النوم بعد صلاه الفجر', 'نوم بعد الفجر'];
export function searchLocal(D, q, kw, ka = 8, kh = 8, minFrac = 0.34, strict = false) {
  // Strict (no-topic) mode ignores Gemini expansion keywords: their extra weight dilutes
  // hit fractions and flaps borderline answers between runs; only the asked terms count.
  const qt = strict ? queryTerms(q, []) : queryTerms(q, kw);
  if (!qt.size) return { ayahs: [], hadiths: [] };
  if (strict) {
    // Fail-safe: a question about something the corpus does not contain yields no text, and every
    // returned text must contain the question's rarest (most distinctive) term.
    const qs = [...toks(q)].filter((t) => !FILL.has(t) && qt.get(t) === 1);
    const known = qs.filter((t) => D.hix.post.has(t) || D.aix.post.has(t));
    if (!qs.length || qs.some((t) => t.length >= 4 && !known.includes(t))) return { ayahs: [], hadiths: [] };
    const df = (t) => (D.hix.post.get(t)?.length || 0) / D.hix.n + (D.aix.post.get(t)?.length || 0) / D.aix.n;
    const must = [...known].sort((a, b) => df(a) - df(b))[0];
    const hasH = new Set((D.hix.post.get(must) || []).map((x) => x[0])), hasA = new Set((D.aix.post.get(must) || []).map((x) => x[0]));
    if (qs.some((t) => OUT.has(t)) || OUT.has(norm(q)) || OUT_PH.some((p) => norm(q).includes(p))) return { ayahs: [], hadiths: [] };
    const multi = known.length >= 2;
    const titleHas = (d) => toks(D.H[D.hids[d]][2], true).includes(must);
    const ayHas = (d) => toks(D.A[d][4], true).includes(must) || toks(D.A[d][2], true).includes(must);
    const near = (d) => { // all question terms inside one window of 25 words of title+text (proximity = same topic)
      if (known.length < 2) return true;
      const h = D.H[D.hids[d]], tk = toks(h[2] + ' ' + (h[3] || h[4]), true), need = new Set(known);
      const pos = []; tk.forEach((t, i) => { if (need.has(t)) pos.push([i, t]); });
      for (let a = 0; a < pos.length; a++) { const seen = new Set(); for (let b = a; b < pos.length && pos[b][0] - pos[a][0] <= 25; b++) seen.add(pos[b][1]); if (seen.size === need.size) return true; }
      return false; };
    const hr = rank(D.hix, qt, 80, 1).filter((x) => x[2] >= minFrac && hasH.has(x[0]) && near(x[0]) && ((titleHas(x[0]) && x[2] >= minFrac) || (multi && x[2] >= 0.99 && (D.H[D.hids[x[0]]][3] || D.H[D.hids[x[0]]][4] || '').length < 500))).slice(0, 5), ar = rank(D.aix, qt, 80, 1).filter((x) => x[2] >= minFrac && hasA.has(x[0]) && ayHas(x[0]) && x[2] >= 0.99).slice(0, 4);
    const ruling = /^(?:ما |هل )?(?:حكم|يجوز|يحل|حلال|حرام)/.test(norm(q)) || /(?:هل يجوز|حلال ام حرام|حكمه)/.test(norm(q));
    if (ruling) ar.length = 0; // ruling questions: narrative mentions in the Quran are not the ruling
    return { hadiths: hr.map(([d, s]) => ({ id: D.hids[d], score: s })), ayahs: ar.map(([d, s]) => ({ id: D.A[d][0], score: s })) };
  }
  const hr = rank(D.hix, qt, kh, 1).filter((x) => x[2] >= minFrac), ar = rank(D.aix, qt, ka, 1).filter((x) => x[2] >= minFrac);
  const hTop = hr.length ? hr[0][1] : 0, aTop = ar.length ? ar[0][1] : 0;
  return {
    hadiths: hr.filter(([, s]) => s >= hTop * 0.45).map(([d, s]) => ({ id: D.hids[d], score: s })),
    ayahs: ar.filter(([, s]) => s >= aTop * 0.45).map(([d, s]) => ({ id: D.A[d][0], score: s })),
  };
}

// ---------------- curated topics ----------------
const WEAK = new Set(['الله', 'ربنا', 'عمل', 'العمل', 'هم', 'الهم', 'الام', 'الاب', 'امي', 'ابي', 'الحرام', 'الحلال', 'الكلام', 'الكلمه', 'النساء', 'المراه', 'الزوج', 'الزوجه', 'الرسول', 'رسول الله', 'محمد', 'الاخره', 'الاجل', 'الغني', 'الرضا', 'الحمد', 'نعمه', 'الحكم', 'الدين', 'دين', 'السفر', 'المسافر', 'الطريق', 'المعروف', 'القبر', 'الموت', 'السر', 'الوقت', 'العمر', 'الايام', 'الرزق', 'رزق', 'الدنيا', 'علم', 'العلم', 'الاكل', 'اكل', 'شرب', 'الشرب', 'نوم', 'النوم', 'الطعام', 'المسجد', 'الجار', 'جار', 'الضيف', 'ضيف', 'الاسلام', 'الايمان', 'اركان', 'المرض', 'مرض', 'الفقر', 'فقر', 'الحكم', 'السنه', 'الصحه', 'خلق', 'الاخلاق', 'الادب', 'السلوك', 'اولاد', 'الاولاد', 'الطفل', 'الاطفال', 'البصر', 'النظر', 'الزينه', 'عمره', 'ملابس', 'الاقارب', 'الصديق', 'صديق', 'السلام', 'سلام', 'الجمع', 'الفطر', 'الفجر', 'الصبح', 'صبح', 'قدر', 'القدر', 'الحج', 'حج', 'شكر', 'الشكر', 'عهد', 'العهد', 'وعد', 'الوعد', 'ذكر', 'الذكر', 'الكسب', 'الغش', 'غش', 'الظلم', 'ظلم', 'الصدق', 'صدق', 'كذب', 'الكذب', 'نار', 'النار', 'جنه', 'الجنه', 'عذاب', 'الاحسان', 'العدل', 'عدل', 'الحيوان', 'حيوان', 'الذبح', 'ذبح', 'النهار', 'العيد', 'عيد', 'الابتلاء', 'البلاء', 'الدوره', 'الشباب', 'الحشر', 'الحساب', 'البعث', 'الامير', 'السلطان', 'الخوف', 'تربيه', 'تربية', 'مكتوب', 'المكتوب', 'قدر']);
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
const GENQ = new Set(['كام', 'كم', 'عدد', 'عده', 'فضل', 'حكم', 'معني', 'ماهو', 'ماهي', 'اهميه', 'ماذا', 'كيف', 'لماذا', 'هل', 'اريد', 'عايز', 'ايه', 'ازاي', 'قيمه', 'جائز', 'يجوز', 'دليل', 'اية', 'حديث', 'وصف', 'حرمه', 'كيفيه', 'الكيفيه', 'خطوات', 'مكتوبه', 'المكتوبه', 'اعرف', 'ممكن', 'سمحت', 'لو', 'عن', 'ان', 'بتاع', 'بتاعه']);
const BOIL = new Set(['صلاه', 'الصلاه', 'صلاة', 'الصلاة', 'علامات', 'ثواب', 'اجر', 'فوائد', 'مفهوم', 'تعريف', 'انواع', 'احكام', 'شروط', 'اسباب', 'قصه', 'اهميه', 'خطوات', 'يوم', 'حقيقه', 'ربنا', 'الله', 'ايمان', 'الايمان', 'للرجل', 'للرجال', 'للمراه', 'للنساء', 'يجوز', 'ينفع', 'لازم', 'صح', 'صحيح', 'نفسي', 'اعمل', 'ايه', 'الاسلام', 'اسلام', 'القران', 'السنه', 'الاحاديث', 'احاديث', 'الايات', 'ايات', 'تقولي', 'قولي', 'اشرح', 'شرعا', 'الشرع', 'عايز', 'عاوز', 'ممكن', 'اعرف', 'سمحت', 'الكريم', 'النبويه', 'والسنه', 'والقران', 'القرءان', 'بخصوص', 'موضوع', 'معلومات', 'محتاج', 'اريد', 'ابغي', 'تقول', 'يقال', 'نقول', 'اقول', 'بالترتيب', 'ترتيب', 'اثناء', 'مبطلات', 'مفسدات', 'نواقض', 'اهم', 'باقي', 'يفعل', 'تفعل', 'نفعل', 'افعل', 'ينقض', 'تنقض', 'يبطل', 'تبطل', 'يحدث', 'يصير', 'يحصل', 'خطوه', 'الخطوه', 'خطو', 'بخطوه', 'واجبه', 'واجب', 'حلال', 'حرام', 'حكمها', 'بيتقضي', 'بيتم', 'مره', 'بيتقسم', 'فضلها', 'فضله', 'حقيقي'].map((x) => norm(x)));
export function matchTopics(T, q) {
  const nq = (' ' + norm(q) + ' ').replace(/ (?:في|من|حسب|عند) (?:القران|الكتاب|القرءان)(?: الكريم)?(?: و)?(?: ?السنه(?: النبويه)?)? /g, ' ').replace(/ (?:في|من) (?:السنه النبويه|السنه|الاسلام) /g, ' ').replace(/\s+/g, ' ').trim(); const words = nq.split(' ').filter(Boolean);
  const meaningful = words.filter((w) => !STOP.has(w)).length;
  const mwords = words.filter((w) => !STOP.has(w) && !GENQ.has(w) && !BOIL.has(w) && !BOIL.has(stem(w)));
  const vs = new Set(words.flatMap(variants));
  const padded = ' ' + nq + ' ';
  const res = [];
  for (const t of T) {
    let s = 0, strong = false; const covered = new Set();
    for (const g of t.n) {
      const multi = g.includes(' ');
      const hit = multi ? padded.includes(' ' + g + ' ') || padded.includes(' ' + g) : vs.has(g);
      if (!hit) continue;
      const weak = WEAK.has(g) && !multi;
      if (weak && meaningful > 3) continue;
      if (!weak) strong = true;
      covered.add(g);
      s = Math.max(s, (multi ? 2.5 : 1) * (weak ? 0.5 : 1) * (g.length >= 5 ? 1.2 : 1) + (multi ? 0.5 : 0));
    }
    if (s > 0) {
      // Ambiguous one-word (weak) triggers cannot carry a topic alone: they need a
      // distinctive phrase/long word, or corroboration by a second meaningful question term.
      if (!strong && mwords.length) {
        const m = mwords.filter((w) => variants(w).some((v) => covered.has(v))).length;
        if (m < 2 && m < mwords.length) continue;
      }
      const cw = new Set();
      for (const g of covered) for (const gw of g.split(' ')) for (const w of mwords) if (gw === w || variants(w).includes(gw)) cw.add(w);
      res.push([t, s + 0.8 * cw.size, cw]);
    }
  }
  res.sort((a, b) => b[1] - a[1]);
  const out = [];
  out.mwords = mwords; out.cov = new Map(); out.union = new Set();
  if (!res.length) return out;
  const union = new Set(); for (const [, sc, c] of res) if (sc >= res[0][1] * 0.6) for (const w of c) union.add(w);
  const GENERIC = new Set(['الصلاة', 'الطهارة', 'حسن الخلق']);
  if (res.length > 1 && res.some(([t]) => !GENERIC.has(t.name))) for (let i = res.length - 1; i >= 0; i--) if (GENERIC.has(res[i][0].name)) res.splice(i, 1);
  const sel = res.filter(([, s]) => s >= res[0][1] * 0.6).slice(0, 3); out.union = union;
  // a topic whose explained terms are a strict subset of another selected topic's is the generic parent: drop it
  for (const [t, , c] of sel) { if (sel.some(([t2, , c2]) => t2 !== t && c2.size > c.size && [...c].every((w) => c2.has(w)))) continue; if (out.length < 2) { out.push(t); out.cov.set(t, c.size); } }
  return out;
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
// Word-frequency counting over the bundled Tanzil text: answers "اللفظ/كلمة X ذُكر كام مرة في القرآن"
// with a count computed from the bundled corpus itself (never invented), and states the count basis.
const COUNT_Q = /مر[ها]/, COUNT_VERB = /(ذكر|اتذكر|مذكور|ورد|اتقال|تكرر|مكرر|موجود|مكتوب|لفظ|كلمه|كلمات|اسم)/, COUNT_IN = /(قران|قرءان|مصحف|كتاب الله)/;
const COUNT_SKIP = new Set('لفظ لفظه كلمه كلمات اسم ذكر اتذكر اتذكرت مذكور مذكوره ورد وردت اتقال اتقالت تكرر تكررت مكرر مكرره موجود موجوده مكتوب مكتوبه كام كم مره مرات عدد في القران القرءان الكريم المصحف كتاب ايه ازاي هو هي بتاع بيتقال جه جات نزلت'.split(' '));
const COUNT_PRE = ['وال', 'بال', 'كال', 'فال', 'لل', 'وب', 'وك', 'ول', 'يا', 'ال', 'و', 'ب', 'ل', 'ك', 'ف'];
function wordCount(D, q) {
  const nq = norm(q);
  if (!COUNT_Q.test(nq) || !COUNT_IN.test(nq) || !COUNT_VERB.test(nq)) return null;
  let raw = null, explicit = false;
  const m = q.match(/(?:لفظ|لفظة|كلمة|كلمات|اسم)\s+([^\s?؟!,،.:]+)/u);
  if (m) { raw = m[1]; explicit = true; }
  else { for (const w of nq.split(' ')) if (w.length >= 3 && !COUNT_SKIP.has(w) && !STOP.has(w)) { raw = w; break; } }
  if (!raw) return null;
  let t = norm(raw), rasm = null;
  if (t.length < 2) return null;
  if (!D.wf.get(t) && t.endsWith('اه')) { const t2 = t.slice(0, -2) + 'وه'; if (D.wf.get(t2)) { t = t2; rasm = raw.slice(0, raw.search(/[ةا][^ةا]*$/) + 1); } }
  const n = D.wf.get(t) || 0;
  if (!n && !explicit) return null; // uncertain extraction + zero hits: keep the honest fallback
  let pref = 0;
  for (const [k, c] of D.wf) if (k !== t && k.endsWith(t) && COUNT_PRE.includes(k.slice(0, k.length - t.length))) pref += c;
  const ay = (D.wAy.get(t) || []).map((i) => ({ id: D.A[i][0], score: 50, curated: true }));
  const text = n
    ? `كلمة «${raw}» وردت بلفظها ${n} مرة في المصحف${rasm ? ' (برسم المصحف)' : ''}${pref ? `، ومع أدوات الربط مثل «و${raw}» ${pref} مرة أخرى` : ''}. العدّ آلي للّفظ نفسه بعد حذف التشكيل وتوحيد الهمزات، ولا يشمل المشتقات أو صيغ الجذر الأخرى.`
    : `لفظ «${raw}» لم يرد في المصحف بهذا اللفظ. العدّ آلي من نص المصحف بعد حذف التشكيل وتوحيد الهمزات.`;
  return { topics: [], facts: [{ text, src: 'المصحف - عدّ آلي من نص Tanzil', url: '' }], ayahs: ay, hadiths: [] };
}
export function answer(D, T, q, kw) {
  const wc = wordCount(D, q);
  if (wc) return wc;
  let topics = matchTopics(T, q);
  // Coverage gate: if matched topics explain under half of the question's content terms,
  // the question is about something more specific than the topic; do not return generic topic texts.
  if (topics.length) {
    const total = topics.mwords.length;
    const best = Math.max(...topics.map((t) => topics.cov.get(t) || 0));
    const cw = topics.union;
    const unk = topics.mwords.filter((w) => !cw.has(w) && !FILL.has(stem(w)) && w.length >= 4 && !D.hix.post.has(stem(w)) && !D.aix.post.has(stem(w)));
    if ((total >= 2 && cw.size / total <= 0.5) || unk.length) topics = [];
  }
  const gen = topics.length ? searchLocal(D, q, kw, 8, 8, 0.34) : searchLocal(D, q, kw, 8, 8, 0.6, true);
  if (!topics.length) return { topics: [], facts: [], ...gen };
  const ayahs = [], seenA = new Set(), hads = [], seenH = new Set();
  const hl = topics.map((t) => topicHadiths(D, t, q, 5));
  const al = topics.map((t) => t.ay.slice(0, 5));
  for (let i = 0; i < 8; i++) for (const l of al) if (l[i] && !seenA.has(l[i]) && ayahs.length < 5) { seenA.add(l[i]); ayahs.push({ id: l[i], curated: true }); }
  for (let i = 0; i < 6; i++) for (const l of hl) if (l[i] && !seenH.has(l[i].id) && hads.length < 5) { seenH.add(l[i].id); hads.push(l[i]); }
  if (hads.length < 3) for (const h of gen.hadiths) if (hads.length < 4 && !seenH.has(h.id)) { seenH.add(h.id); hads.push(h); }
  // Curated fact answers (encyclopedic Quran facts): hand-written by the maintainer with their
  // source citation; never LLM-generated. Shown alongside the verified texts, not instead of them.
  const facts = topics.filter((t) => t.fa).map((t) => ({ text: t.fa, src: t.fas || '', url: t.fau || '' }));
  return { topics: topics.map((t) => t.name), facts, ayahs, hadiths: hads };
}
