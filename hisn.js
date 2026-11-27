// حصن المسلم (سعيد بن علي بن وهف القحطاني): مصدر منفصل عن الصحيحين، يُعرض بتمييز واضح مع التخريج كما في الكتاب.
import fs from 'node:fs';
import path from 'node:path';
import { norm, stem } from './engine.js';
const SYN = { بيت: 'منزل', البيت: 'منزل', حمام: 'خلاء', الحمام: 'خلاء', مرحاض: 'خلاء', الخروج: 'خروج', الدخول: 'دخول', اكل: 'طعام', الاكل: 'طعام', اكله: 'طعام', اكلت: 'طعام', شرب: 'طعام', نايم: 'نوم', النوم: 'نوم', بنام: 'نوم', نمت: 'نوم', صحيت: 'استيقاظ', الصحيان: 'استيقاظ', اصحي: 'استيقاظ', مصيبه: 'مصيبه', المطر: 'مطر', الريح: 'ريح', الرياح: 'ريح', سيارة: 'ركوب', السياره: 'ركوب', سياره: 'ركوب', الدابه: 'ركوب', الركوب: 'ركوب', مستشفي: 'مريض', مرض: 'مريض', تعبان: 'مريض', ميت: 'ميت', الجنازه: 'ميت', مسجد: 'مسجد', المسجد: 'مسجد', حزين: 'حزن', حزن: 'حزن', قلق: 'هم', همي: 'هم', خايف: 'خوف', خوف: 'خوف', الخوف: 'خوف', مديون: 'دين', الدين: 'دين', ديون: 'دين', كرب: 'كرب', الكرب: 'كرب' };
const FILLER = new Set(['دعاء', 'الدعاء', 'ادعيه', 'الادعيه', 'ذكر', 'الذكر', 'اذكار', 'الاذكار', 'ما', 'يقول', 'يقال', 'اقول', 'نقول', 'ماذا', 'عند', 'اذا', 'كيف', 'في', 'من', 'علي', 'الي', 'ايه', 'هو', 'هي', 'و', 'لمن', 'قبل', 'بعد', 'ال', 'عن', 'له', 'لها', 'حينما', 'ان', 'ما يقول', 'المسلم', 'مسلم', 'النبي', 'صلي', 'الله', 'عليه', 'وسلم', 'اللي', 'لو', 'بتاع', 'دعاء', 'ادعيه']);
const ASK = /(دعاء|ادعيه|أدعية|الدعاء|ذكر|اذكار|أذكار|الاذكار|الأذكار|ماذا يقول|ما يقال|ما يقول|اقول|أقول|حصن)/;
const toks = (s) => norm(s).split(' ').filter(Boolean).map((w) => SYN[w] || w).filter((w) => !FILLER.has(w)).map(stem);
let H = null;
export function loadHisn(dir = 'data') {
  if (H) return H;
  try { H = JSON.parse(fs.readFileSync(path.join(dir, 'hisn.json'), 'utf8')); } catch { H = []; }
  for (const c of H) { c.n = norm(c.t); c.tk = [...new Set(toks(c.t))]; }
  return H;
}
export function hisnMatch(q, max = 3) {
  const C = loadHisn(); const nq = norm(q);
  const exact = C.filter((c) => c.n === nq);
  if (exact.length) return exact.slice(0, 1);
  const qt = [...new Set(toks(q))]; if (!qt.length) return [];
  const asked = ASK.test(q);
  const sc = [];
  for (const c of C) {
    if (!c.tk.length) continue;
    const inter = c.tk.filter((t) => qt.includes(t)).length;
    const full = inter === c.tk.length; // the whole chapter title is inside the question
    const covered = qt.every((t) => c.tk.includes(t)); // every content word of the question is in the title
    if (!((full && (c.tk.length >= 2 || asked)) || (asked && covered))) continue;
    sc.push([c, inter / Math.max(c.tk.length, qt.length) + (full && covered ? 1 : 0)]);
  }
  sc.sort((a, b) => b[1] - a[1]);
  const top = sc.length ? sc[0][1] : 0;
  return sc.filter((x) => x[1] >= top * 0.6).slice(0, max).map((x) => x[0]);
}
export const hisnPublic = (c) => ({ title: c.t, kind: c.k, items: c.i, gloss: c.g, takhrij: c.f });
