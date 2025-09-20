(async function () {
  const GEOJSON_URL = './prefectures.json';  // ← index.html と同じフォルダに置く
  const PADDING = 20;
  const ZOOM_STEP = 1.12; // ホイール1目盛りの倍率

  const canvas = document.getElementById('map');
  const hud = document.getElementById('hud');
  const ctx = canvas.getContext('2d');

  let gj;
  let features = [];
  let bounds = null;
  let scale = 1, translateX = 0, translateY = 0;
  let minScale = 12;      // ★最小倍率（これ以下に縮小しない）
  let maxScale = 1000;    // fit 後に再調整
  let isDragging = false, lastX = 0, lastY = 0;
  let currentHover = null;
  let ready = false;

  // --- 画面サイズ / DPR ---
  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (ready) draw();
  }
  const ro = new ResizeObserver(resizeCanvas);
  ro.observe(canvas);

  // --- GeoJSON 読み込み ---
  try {
    const resp = await fetch(GEOJSON_URL, { cache: 'no-cache' });
    if (!resp.ok) throw new Error('failed to load GeoJSON: ' + resp.status);
    gj = await resp.json();
  } catch (e) {
    hud.textContent = 'prefectures.json の読み込みに失敗しました。配置場所/ファイル名を確認してください。';
    console.error(e);
    return;
  }

  // --- 投影（lon,lat → XY）: 上下左右修正のため lat を反転 ---
  function lonLatToXY([lon, lat]) { return [lon, -lat]; }
  function projectCoords(coords) {
    return (typeof coords[0] === 'number') ? lonLatToXY(coords) : coords.map(projectCoords);
  }

  features = gj.features.map(f => ({
    type: f.geometry.type,
    coords: projectCoords(f.geometry.coordinates),
    props: f.properties
  }));

  // --- 全体バウンディングボックス ---
  function computeBounds() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const visit = ([x, y]) => { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; };
    const walk = a => { (typeof a[0] === 'number') ? visit(a) : a.forEach(walk); };
    features.forEach(f => walk(f.coords));
    return { minX, minY, maxX, maxY };
  }
  bounds = computeBounds();

  // --- 初期フィット ---
  function fitToCanvas() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const worldW = bounds.maxX - bounds.minX;
    const worldH = bounds.maxY - bounds.minY;
    const sx = (w - 2 * PADDING) / worldW;
    const sy = (h - 2 * PADDING) / worldH;
    scale = Math.min(sx, sy);
    translateX = -bounds.minX * scale + PADDING;
    translateY = -bounds.minY * scale + PADDING;
    maxScale = Math.max(500, scale * 10);  // 充分に拡大できるよう設定
    console.log('[fit] scale =', scale.toFixed(4), 'min =', minScale, 'max =', maxScale);
  }

  function worldToScreen([x, y]) { return [x * scale + translateX, y * scale + translateY]; }

  function drawPolygon(rings) {
    ctx.beginPath();
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const [sx, sy] = worldToScreen(ring[i]);
        if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
      }
      ctx.closePath();
    }
  }

  function draw() {
    if (!ready) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#cfe8ff';
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;

    const hover = currentHover;
    for (const f of features) {
      if (f.type === 'Polygon') {
        drawPolygon(f.coords);
        ctx.fillStyle = (hover === f) ? '#9ad0ff' : '#cfe8ff';
        ctx.fill(); ctx.stroke();
      } else {
        for (const poly of f.coords) {
          drawPolygon(poly);
          ctx.fillStyle = (hover === f) ? '#9ad0ff' : '#cfe8ff';
          ctx.fill(); ctx.stroke();
        }
      }
    }
  }

  // --- 入力: ドラッグでパン & ホバー名前表示 ---
  canvas.addEventListener('mousedown', e => { isDragging = true; lastX = e.clientX; lastY = e.clientY; });
  window.addEventListener('mouseup', () => { isDragging = false; });
  window.addEventListener('mousemove', e => {
    if (!ready) return;
    if (isDragging) {
      translateX += (e.clientX - lastX);
      translateY += (e.clientY - lastY);
      lastX = e.clientX; lastY = e.clientY;
      constrainPan(); draw(); return;
    }
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    currentHover = null;
    for (const f of features) {
      if (f.type === 'Polygon') {
        drawPolygon(f.coords);
        if (ctx.isPointInPath(mx, my)) { currentHover = f; break; }
      } else {
        for (const poly of f.coords) {
          drawPolygon(poly);
          if (ctx.isPointInPath(mx, my)) { currentHover = f; break; }
        }
        if (currentHover) break;
      }
    }
    hud.textContent = currentHover?.props?.N03_001 || 'ホイールで拡大縮小、ドラッグでパン';
    draw();
  });

  // --- ズーム（ホイール: 上=拡大 / 下=縮小）＋ コンソールに倍率を出力 ---
  function logScale(tag) { console.log(tag, 'scale =', scale.toFixed(4), '(min', minScale, 'max', maxScale + ')'); }

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    if (!ready) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const oldScale = scale;
    const factor = (e.deltaY < 0) ? ZOOM_STEP : (1 / ZOOM_STEP);
    let newScale = Math.max(minScale, Math.min(maxScale, scale * factor));
    const k = newScale / oldScale;
    translateX = mx - (mx - translateX) * k;
    translateY = my - (my - translateY) * k;
    scale = newScale;
    constrainPan(); draw();
    logScale('[wheel]');
  }, { passive: false });

  // --- パン制限（地図が画面外へ出すぎない） ---
  function constrainPan() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const minX = bounds.minX * scale + translateX;
    const minY = bounds.minY * scale + translateY;
    const maxX = bounds.maxX * scale + translateX;
    const maxY = bounds.maxY * scale + translateY;
    const margin = 50;
    if (minX > w - margin) translateX -= minX - (w - margin);
    if (maxX < margin)     translateX += margin - maxX;
    if (minY > h - margin) translateY -= minY - (h - margin);
    if (maxY < margin)     translateY += margin - maxY;
  }

  // --- 初期処理 ---
  fitToCanvas();
  ready = true;
  resizeCanvas(); // DPR反映＆初回描画
})();
