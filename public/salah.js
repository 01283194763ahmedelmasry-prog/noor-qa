// تعلّم الصلاة: درس خطوة بخطوة. الرسوم مرسومة بالكود (SVG)، والنصوص ملخص تعليمي مع أدلة من الصحيحين.
(function () {
  const TRIG = /(عايز|عاوز|عايزه|اريد|أريد|ابغى|أبغى|علمني|علّمني|تعلم|اتعلم|أتعلم|تعليم)\s+(ان\s+|أن\s+)?(اتعلم\s+|أتعلم\s+|تعلم\s+)?(ال)?(صلا[هة]|اصلي|أصلي)\s*[؟?!.]*\s*$|^\s*(كيف|ازاي|إزاي)\s+(اصلي|أصلي|تصلي|اتصلي|أتصلي|الصلا[هة]|اتعلم الصلا[هة]|أتعلم الصلا[هة])\s*(صح)?\s*[؟?!.]*\s*$/;
  const SKIN = '#c99a74', SKIN_D = '#a87b58', ROBE = '#f2efe6', ROBE_D = '#c9c4b4', ROBE_F = '#dcd7c8';
  const seg = (p, w, c) => `<polyline points="${p}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
  const lim = (p, w) => seg(p, w + 3, ROBE_D) + seg(p, w, 'url(#robeG)');
  const hand = (x, y, c) => `<circle cx="${x}" cy="${y}" r="6.5" fill="${c || SKIN}"/>`;
  const foot = (x, y, rot) => `<ellipse cx="${x}" cy="${y}" rx="13" ry="5.5" fill="${SKIN}" transform="rotate(${rot || 0} ${x} ${y})"/>`;
  const head = (x, y, o) => { o = o || {}; const rx = o.rx || 12, tilt = o.tilt || 0;
    return `<g transform="rotate(${tilt} ${x} ${y})"><rect x="${x - 5}" y="${y + 8}" width="10" height="14" rx="4" fill="${SKIN_D}"/>
      <ellipse cx="${x}" cy="${y}" rx="${rx}" ry="14.5" fill="url(#skinG)"/>
      <path d="M${x - rx - 1} ${y - 2} Q${x - rx} ${y - 17} ${x} ${y - 17.5} Q${x + rx} ${y - 17} ${x + rx + 1} ${y - 2} Q${x} ${y - 7} ${x - rx - 1} ${y - 2} Z" fill="url(#capG)" stroke="${ROBE_D}" stroke-width="1"/>
      <path d="M${x - rx + 1} ${y - 8} Q${x} ${y - 13} ${x + rx - 1} ${y - 8}" fill="none" stroke="${ROBE_D}" stroke-width="1"/></g>`; };
  const fig = (body, o) => `<svg viewBox="0 0 240 210" role="img" aria-hidden="true">
    <defs>
      <linearGradient id="robeG" gradientUnits="userSpaceOnUse" x1="0" y1="40" x2="0" y2="190"><stop offset="0" stop-color="#fbf9f2"/><stop offset="1" stop-color="#d9d4c3"/></linearGradient>
      <linearGradient id="skinG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#d9ac85"/><stop offset="1" stop-color="#b98b66"/></linearGradient>
      <linearGradient id="capG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#e1ddcf"/></linearGradient>
      <linearGradient id="matG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4f9a70"/><stop offset="1" stop-color="#2f6046"/></linearGradient>
      <filter id="blur"><feGaussianBlur stdDeviation="4"/></filter>
    </defs>
    <rect x="8" y="184" width="224" height="16" rx="5" fill="url(#matG)"/>
    <rect x="14" y="187" width="212" height="10" rx="3" fill="none" stroke="#c9a959" stroke-width="1.2" opacity=".8"/>
    <path d="M120 187 Q120 191 120 197" stroke="#c9a959" stroke-width="1" opacity=".6"/>
    <ellipse cx="${(o && o.sx) || 110}" cy="185" rx="${(o && o.sr) || 55}" ry="5" fill="#000" opacity=".35" filter="url(#blur)"/>
    ${body}</svg>`;
  const robeStand = (x) => `<path d="M${x - 17} 66 Q${x - 20} 120 ${x - 21} 176 L${x + 21} 176 Q${x + 20} 120 ${x + 17} 66 Z" fill="url(#robeG)" stroke="${ROBE_D}" stroke-width="1"/><path d="M${x + 2} 100 L${x + 4} 176" stroke="${ROBE_D}" stroke-width="1" opacity=".6"/>`;
  const farArm = (pts) => seg(pts, 13, ROBE_D) ;
  const nearArm = (pts, hx, hy) => lim(pts, 14) + hand(hx, hy);
  const stand = (x, arm) => `${farArm(`${x - 2},72 ${x - 3},104 ${x - 2},128`)}${robeStand(x)}${foot(x + 12, 180)}${arm}${head(x, 44)}`;
  const POSE = {
    ready: fig(stand(100, nearArm('100,72 101,104 102,130', 102, 134))),
    takbir: fig(stand(100, nearArm('100,72 116,76 117,48', 117, 41))),
    stand: fig(stand(100, nearArm('100,72 104,98 122,88', 124, 87))),
    qawma: fig(stand(100, nearArm('100,72 101,104 102,130', 102, 134))),
    ruku: fig(`${seg('146,114 92,150', 13, ROBE_D)}<path d="M64 118 Q62 150 62 176 L102 176 Q102 150 98 120 Z" fill="url(#robeG)" stroke="${ROBE_D}"/>${foot(86, 180)}${lim('80,118 148,112', 30)}${lim('146,114 94,150', 14)}${hand(90, 150)}${head(172, 112, { tilt: 82 })}`, { sx: 105, sr: 60 }),
    sujud: fig(`${foot(44, 178, -20)}${seg('116,176 66,172', 20, ROBE_D)}${seg('84,132 116,176', 24, ROBE_D)}${lim('88,130 138,152', 28)}${lim('116,176 66,174', 21)}${lim('90,134 116,176', 25)}${lim('138,152 128,176 152,182', 13)}${hand(154, 182)}${head(166, 172, { tilt: 100 })}`, { sx: 105, sr: 70 }),
    jalsa: fig(sit(false)),
    tashah: fig(sit(true)),
    salam: fig(sit(false, true)),
  };
  function sit(finger, turn) {
    return `${seg('96,100 112,128 128,150', 13, ROBE_D)}${seg('76,150 126,160', 26, ROBE_D)}${lim('126,160 74,178', 22)}${lim('76,150 126,162', 27)}${foot(138, 176, -80)}
      ${lim('76,150 78,100', 30)}${lim('76,100 102,124 124,150', 14)}${hand(126, 151)}${finger ? `<line x1="128" y1="148" x2="136" y2="128" stroke="${SKIN}" stroke-width="3.5" stroke-linecap="round"/>` : ''}
      ${head(76, 72, turn ? { rx: 9 } : {})}${turn ? `<g stroke="#c9a959" stroke-width="3" fill="none" stroke-linecap="round"><path d="M96 58 Q118 38 142 58"/><path d="M135 51 L143 59 L132 62"/></g>` : ''}`;
  }
  const kaaba = '';
  const STEPS = [
    { t: 'قبل ما تبدأ', p: 'ready', n: ['اتوضّأ، وادخل وقت الصلاة، واستقبل القبلة.', 'انوِ الصلاة بقلبك من غير ما تنطق بالنية.'], r: ['bukhari:1', 'الأعمال بالنيات'], s: 'النية بالقلب' },
    { t: '١. تكبيرة الإحرام', p: 'takbir', n: ['قُل «الله أكبر» وارفع يديك حذو منكبيك أو أذنيك.', 'بتكبيرتك دي بتدخل في الصلاة.'], r: ['bukhari:757', 'إذا قمت إلى الصلاة فكبّر'], s: 'الله أكبر' },
    { t: '٢. القيام والقراءة', p: 'stand', n: ['ضع يدك اليمنى على اليسرى على صدرك.', 'اقرأ سورة الفاتحة في كل ركعة، ثم سورة أو آيات من القرآن في الأولى والثانية.', 'قال ﷺ للمسيء صلاته: «ثم اقرأ ما تيسر معك من القرآن».'], r: ['bukhari:757', 'حديث المسيء صلاته'], s: 'الفاتحة وما تيسر' },
    { t: '٣. الركوع', p: 'ruku', n: ['كبّر «الله أكبر» وانحنِ، وضع يديك على ركبتيك وظهرك مستوٍ.', 'قُل: «سبحان ربي العظيم» ثلاث مرات.', 'قال ﷺ: «ثم اركع حتى تطمئن راكعًا».'], r: ['bukhari:757', 'حديث المسيء صلاته'], s: 'سبحان ربي العظيم' },
    { t: '٤. الرفع من الركوع', p: 'qawma', n: ['قُل «سمع الله لمن حمده» وأنت ترفع، ثم «ربنا ولك الحمد».', 'قال ﷺ: «ثم ارفع حتى تعتدل قائمًا».'], r: ['bukhari:757', 'حديث المسيء صلاته'], s: 'ربنا ولك الحمد' },
    { t: '٥. السجود', p: 'sujud', n: ['كبّر واسجد على سبعة أعضاء: الجبهة مع الأنف، والكفين، والركبتين، وأطراف القدمين.', 'قُل: «سبحان ربي الأعلى» ثلاث مرات.', 'قال ﷺ: «ثم اسجد حتى تطمئن ساجدًا».'], r: ['bukhari:812', 'السجود على سبعة أعظم'], s: 'سبحان ربي الأعلى' },
    { t: '٦. الجلوس بين السجدتين', p: 'jalsa', n: ['كبّر وارفع من السجود واجلس مطمئنًا، وقُل: «رب اغفر لي».', 'ثم كبّر واسجد السجدة الثانية.', 'قال ﷺ: «ثم ارفع حتى تطمئن جالسًا».'], r: ['bukhari:757', 'حديث المسيء صلاته'], s: 'رب اغفر لي' },
    { t: '٧. التشهد', p: 'tashah', n: ['في الركعة الثانية (وفي الأخيرة) اجلس واقرأ التشهد: «التحيات لله والصلوات والطيبات، السلام عليك أيها النبي ورحمة الله وبركاته، السلام علينا وعلى عباد الله الصالحين، أشهد أن لا إله إلا الله وأشهد أن محمدًا عبده ورسوله».', 'وفي التشهد الأخير صلِّ على النبي ﷺ.'], r: ['bukhari:6265', 'تعليم النبي ﷺ التشهد'], s: 'التحيات لله' },
    { t: '٨. التسليم', p: 'salam', n: ['التفت يمينًا وقُل «السلام عليكم ورحمة الله»، ثم يسارًا مثلها.', 'كده خلصت صلاتك.'], r: [], s: 'السلام عليكم ورحمة الله' },
  ];
  const RAK = [['الفجر', 2], ['الظهر', 4], ['العصر', 4], ['المغرب', 3], ['العشاء', 4]];
  const css = `<style>
  .lesson .stepbar{display:flex;gap:6px;justify-content:center;margin:6px 0 14px;flex-wrap:wrap}
  .lesson .dot{width:10px;height:10px;border-radius:50%;background:var(--line);cursor:pointer;border:0}
  .lesson .dot.on{background:var(--gold)}
  .lesson .fig{background:#141a15;border:1px solid var(--line);border-radius:12px;padding:10px;text-align:center}
  .lesson svg{width:100%;max-width:320px;height:auto}
  .lesson h3{color:var(--gold);font-size:22px;margin:14px 0 8px}
  .lesson ul{list-style:none;padding:0}
  .lesson li{line-height:2.1;font-size:18px;padding:2px 0}
  .lesson .say{display:inline-block;background:var(--green);color:#eaf4ee;border-radius:8px;padding:2px 12px;font-size:15px;margin-top:8px}
  .lesson .nav{display:flex;justify-content:space-between;gap:10px;margin-top:14px}
  .lesson .nav button{flex:1;background:var(--card);border:1px solid var(--line);color:var(--ink);border-radius:10px;padding:11px;font-size:16px;cursor:pointer}
  .lesson .nav button.pri{background:var(--gold);color:#141a15;border:0;font-weight:700}
  .lesson .nav button:disabled{opacity:.4}
  .lesson table{width:100%;border-collapse:collapse;margin-top:8px}
  .lesson td,.lesson th{border-bottom:1px solid var(--line);padding:8px;text-align:center}
  .lesson .evid{margin-top:12px;font-size:13px;color:var(--dim)}
  </style>`;
  function show(out, i) {
    const s = STEPS[i], last = i === STEPS.length - 1;
    const dots = STEPS.map((_, k) => `<button class="dot${k === i ? ' on' : ''}" data-k="${k}" aria-label="خطوة ${k + 1}"></button>`).join('');
    const ev = s.r.length ? `<div class="evid">الدليل: ${s.r[1]} (<a class="src" target="_blank" rel="noopener" href="https://sunnah.com/${s.r[0].replace(':', '/')}">${s.r[0].startsWith('bukhari') ? 'صحيح البخاري' : 'صحيح مسلم'} ${s.r[0].split(':')[1]}</a>)</div>` : '';
    const tbl = last ? `<h3>عدد الركعات</h3><table><tr><th>الصلاة</th><th>الركعات</th></tr>${RAK.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('')}</table><div class="evid">كرّر الركوع والسجود في كل ركعة؛ والتشهد الأول في الثلاثية والرباعية بعد الركعة الثانية.</div>` : '';
    out.innerHTML = `${css}<div class="card lesson"><div class="ref">تعلّم الصلاة • ${i === 0 ? 'تمهيد' : 'خطوة ' + i + ' من ' + (STEPS.length - 1)}</div>
      <div class="stepbar">${dots}</div><div class="fig">${POSE[s.p]}</div>
      <h3>${s.t}</h3><ul>${s.n.map((x) => `<li>${x}</li>`).join('')}</ul><span class="say">${s.s}</span>${ev}${tbl}
      <div class="nav"><button id="lprev" ${i === 0 ? 'disabled' : ''}>السابق</button><button id="lnext" class="pri" ${last ? 'disabled' : ''}>التالي</button></div>
      <div class="evid">ملخص تعليمي للصلاة المشهورة، ولا يغني عن التعلّم من عالم أو معلّم، خصوصًا في اختلاف المذاهب.</div></div>`;
    out.querySelectorAll('.dot').forEach((d) => (d.onclick = () => show(out, +d.dataset.k)));
    const pv = out.querySelector('#lprev'), nx = out.querySelector('#lnext');
    if (pv) pv.onclick = () => show(out, i - 1);
    if (nx) nx.onclick = () => show(out, i + 1);
  }
  window.noorLesson = function (query, out) { query = query.replace(/[\u064B-\u0652\u0670]/g, ''); if (!TRIG.test(query)) return false; show(out, 0); return true; };
  window.noorLessonStep = show;
})();
