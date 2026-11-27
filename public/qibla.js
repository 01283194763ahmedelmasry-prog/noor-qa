// بوصلة القبلة: حساب الاتجاه على جهاز المستخدم فقط (لا يُرسل موقعه لأي خادم). الكعبة: 21.4225, 39.8262.
(() => {
  const K = { lat: 21.4225 * Math.PI / 180, lon: 39.8262 * Math.PI / 180 };
  const bearing = (la, lo) => { const p = la * Math.PI / 180, l = lo * Math.PI / 180, d = K.lon - l;
    const y = Math.sin(d) * Math.cos(K.lat), x = Math.cos(p) * Math.sin(K.lat) - Math.sin(p) * Math.cos(K.lat) * Math.cos(d);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360; };
  const dist = (la, lo) => { const p = la * Math.PI / 180, d = K.lon - lo * Math.PI / 180, c = Math.acos(Math.min(1, Math.sin(p) * Math.sin(K.lat) + Math.cos(p) * Math.cos(K.lat) * Math.cos(d))); return Math.round(c * 6371); };
  const card = `<div class="card" id="qib" style="text-align:center">
    <div class="ref">بوصلة القبلة</div>
    <div style="color:var(--dim);font-size:14px;margin:6px 0 12px">يُحسب الاتجاه على جهازك فقط، ولا يُرسل موقعك إلى أي مكان.</div>
    <button class="explain-btn" id="qgo" style="display:inline-block">حدّد اتجاه القبلة من موقعي</button>
    <div id="qres" style="margin-top:14px"></div></div>`;
  const prev = window.render;
  window.render = function (j) {
    prev(j);
    if (j && j.topics && j.topics.includes('اتجاه القبلة')) {
      out.insertAdjacentHTML('afterbegin', card);
      document.getElementById('qgo').onclick = go;
    }
  };
  function go() {
    const r = document.getElementById('qres');
    if (!navigator.geolocation) { r.textContent = 'المتصفح لا يدعم تحديد الموقع.'; return; }
    r.textContent = 'جاري تحديد الموقع…';
    navigator.geolocation.getCurrentPosition((p) => {
      const b = bearing(p.coords.latitude, p.coords.longitude), km = dist(p.coords.latitude, p.coords.longitude);
      r.innerHTML = `<div id="qarrow" style="width:120px;height:120px;border:2px solid var(--gold);border-radius:50%;margin:0 auto;position:relative">
        <div id="qneedle" style="position:absolute;left:50%;top:50%;width:0;height:0;transform-origin:0 0;transform:rotate(${b}deg)">
          <div style="position:absolute;left:-5px;top:-52px;width:10px;height:52px;background:var(--gold);border-radius:5px 5px 0 0"></div></div>
        <div style="position:absolute;top:2px;left:0;right:0;font-size:12px;color:var(--dim)">شمال</div></div>
        <div style="font-size:22px;color:var(--gold);margin-top:10px">${Math.round(b)}° من الشمال (باتجاه عقارب الساعة)</div>
        <div style="color:var(--dim);font-size:13px">المسافة التقريبية إلى الكعبة: ${km.toLocaleString('ar-EG')} كم · الدقة: ±${Math.round(p.coords.accuracy)} م</div>
        <div style="color:var(--dim);font-size:12px;margin-top:6px">السهم يشير للزاوية بالنسبة للشمال الحقيقي. ضع الجهاز أفقيًا وشمالك الحقيقي من بوصلة الهاتف؛ بوصلات الهواتف قد تنحرف بالقرب من المعادن، فتأكد بمعلم آخر عند الحاجة.</div>`;
      if (window.DeviceOrientationEvent) {
        const on = (e) => { const h = e.webkitCompassHeading != null ? e.webkitCompassHeading : (e.alpha != null ? 360 - e.alpha : null);
          const n = document.getElementById('qneedle'); if (h == null || !n) return; n.style.transform = `rotate(${(b - h + 360) % 360}deg)`; };
        const start = () => window.addEventListener('deviceorientation', on, true);
        if (typeof DeviceOrientationEvent.requestPermission === 'function') DeviceOrientationEvent.requestPermission().then((s) => s === 'granted' && start()).catch(() => {}); else start();
      }
    }, (e) => { r.textContent = e.code === 1 ? 'لم يُسمح بالوصول إلى الموقع. فعّل إذن الموقع للمتصفح ثم أعد المحاولة.' : 'تعذر تحديد الموقع الآن.'; }, { enableHighAccuracy: true, timeout: 15000 });
  }
})();
