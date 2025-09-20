// script.js
(async function () {
    const GEOJSON_URL = './prefectures.json';
    const CAPITALS_URL = './capitals.json';
    const PADDING = 20;
    const ZOOM_STEP = 1.12;

    const canvas = document.getElementById('map');
    const ctx = canvas.getContext('2d');

    let gj;
    let features = [];
    let bounds = null;

    // ビュー
    let scale = 1, translateX = 0, translateY = 0;
    let minScale = 25;
    let maxScale = 1000;

    // 状態（選択）
    let selectedFeature = null;

    // Pointer Events 用の状態
    const activePointers = new Map(); // pointerId -> {x,y,type}
    let isPinching = false;
    let pinchStartDist = 0;
    let pinchStartScale = 1;
    let pinchCenterX = 0, pinchCenterY = 0;

    // パン/タップ判定
    let isPanning = false;
    let lastX = 0, lastY = 0;

    // タップ（クリック相当）のしきい値
    const TAP_MOVE_THRESH = 6;    // px
    const TAP_TIME_THRESH = 350;  // ms
    let tapStartX = 0, tapStartY = 0, tapStartTime = 0, tapMoved = false, tapPointerType = null;

    // 高DPI & リサイズ
    function resizeCanvas() {
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth, h = canvas.clientHeight;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (ready) draw();
    }
    new ResizeObserver(resizeCanvas).observe(canvas);

    // capitals.json 読み込み（DMS→度）
    const dmsToDeg = (s) => {
        if (typeof s === 'number') return s;
        const [d, m, sec] = String(s).split(':').map(Number);
        return d + (m || 0) / 60 + (sec || 0) / 3600;
    };
    let capitalsMap = {}; // { '北海道': { city, lonDeg, latDeg, elev_m } }
    async function loadCapitals() {
        const resp = await fetch(CAPITALS_URL, { cache: 'no-cache' });
        if (!resp.ok) throw new Error('failed to load capitals.json: ' + resp.status);
        const arr = await resp.json();
        capitalsMap = Object.fromEntries(arr.map(row => {
            const lonDeg = dmsToDeg(row.lon_dms ?? row.lon);
            const latDeg = dmsToDeg(row.lat_dms ?? row.lat);
            return [row.pref, { city: row.city, lonDeg, latDeg, elev_m: row.elev_m ?? null }];
        }));
    }

    // データ読込
    let ready = false;
    try {
        const [prefResp] = await Promise.all([
            fetch(GEOJSON_URL, { cache: 'no-cache' }),
            loadCapitals(),
        ]);
        if (!prefResp.ok) throw new Error('failed to load GeoJSON: ' + prefResp.status);
        gj = await prefResp.json();
    } catch (e) { console.error(e); return; }

    // 投影（上下左右修正のため lat 反転）
    const lonLatToXY = ([lon, lat]) => [lon, -lat];
    const projectCoords = (coords) => (typeof coords[0] === 'number') ? lonLatToXY(coords) : coords.map(projectCoords);

    features = gj.features.map(f => ({ type: f.geometry.type, coords: projectCoords(f.geometry.coordinates), props: f.properties }));

    function computeBounds() {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const visit = ([x, y]) => { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; };
        const walk = a => { (typeof a[0] === 'number') ? visit(a) : a.forEach(walk); };
        features.forEach(f => walk(f.coords));
        return { minX, minY, maxX, maxY };
    }
    bounds = computeBounds();

    function fitToCanvas() {
        const w = canvas.clientWidth, h = canvas.clientHeight;
        const worldW = bounds.maxX - bounds.minX;
        const worldH = bounds.maxY - bounds.minY;
        const sx = (w - 2 * PADDING) / worldW;
        const sy = (h - 2 * PADDING) / worldH;
        scale = Math.min(sx, sy);
        const offsetX = (w - worldW * scale) / 2;
        const offsetY = (h - worldH * scale) / 2;
        translateX = -bounds.minX * scale + offsetX;
        translateY = -bounds.minY * scale + offsetY;
        maxScale = Math.max(500, scale * 10);
    }

    const worldToScreen = ([x, y]) => [x * scale + translateX, y * scale + translateY];

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

    function featureBounds(f) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const visit = ([x, y]) => { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; };
        const walk = a => { (typeof a[0] === 'number') ? visit(a) : a.forEach(walk); };
        if (f.type === 'Polygon') walk(f.coords); else f.coords.forEach(poly => walk(poly));
        return { minX, minY, maxX, maxY };
    }

    function ringAreaAndCentroid(ring) {
        let A = 0, Cx = 0, Cy = 0, n = ring.length;
        for (let i = 0; i < n; i++) {
            const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % n];
            const cross = x1 * y2 - x2 * y1;
            A += cross;
            Cx += (x1 + x2) * cross;
            Cy += (y1 + y2) * cross;
        }
        A *= 0.5;
        if (A === 0) return { A: 0, cx: ring[0][0], cy: ring[0][1] };
        return { A, cx: Cx / (6 * A), cy: Cy / (6 * A) };
    }
    function featureCentroid(f) {
        if (f.type === 'Polygon') {
            const { cx, cy } = ringAreaAndCentroid(f.coords[0]); return [cx, cy];
        } else {
            let best = { area: -Infinity, cx: 0, cy: 0 };
            for (const poly of f.coords) {
                const { A, cx, cy } = ringAreaAndCentroid(poly[0]);
                const area = Math.abs(A);
                if (area > best.area) best = { area, cx, cy };
            }
            return [best.cx, best.cy];
        }
    }

    // ===== 描画 =====
    function draw() {
        if (!ready) return;
        const w = canvas.clientWidth, h = canvas.clientHeight;
        ctx.clearRect(0, 0, w, h);

        // ポリゴン
        ctx.strokeStyle = '#334155';
        ctx.lineWidth = 1;
        for (const f of features) {
            const isSel = (f === selectedFeature);
            ctx.fillStyle = isSel ? '#9ad0ff' : '#cfe8ff';
            if (f.type === 'Polygon') { drawPolygon(f.coords); ctx.fill(); ctx.stroke(); }
            else { for (const poly of f.coords) { drawPolygon(poly); ctx.fill(); ctx.stroke(); } }
        }

        // ラベル & 県庁所在地
        if (selectedFeature) {
            const name = selectedFeature.props?.N03_001 || '';
            const [cx, cy] = featureCentroid(selectedFeature);
            const [sx, sy] = worldToScreen([cx, cy]);
            ctx.font = 'bold 16px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.lineWidth = 4;
            ctx.strokeStyle = 'rgba(255,255,255,0.9)';
            ctx.strokeText(name, sx, sy);
            ctx.fillStyle = '#1f2937';
            ctx.fillText(name, sx, sy);

            const cap = capitalsMap[name];
            if (cap) {
                const [px, py] = worldToScreen(lonLatToXY([cap.lonDeg, cap.latDeg]));
                ctx.beginPath();
                ctx.arc(px, py, 5, 0, Math.PI * 2);
                ctx.fillStyle = '#ffd400';
                ctx.fill();
                ctx.lineWidth = 2;
                ctx.strokeStyle = '#000';
                ctx.stroke();
            }
        }
    }

    // ===== 汎用 =====
    function constrainPan() {
        const w = canvas.clientWidth, h = canvas.clientHeight;
        const minX = bounds.minX * scale + translateX, minY = bounds.minY * scale + translateY;
        const maxX = bounds.maxX * scale + translateX, maxY = bounds.maxY * scale + translateY;
        const margin = 50;
        if (minX > w - margin) translateX -= minX - (w - margin);
        if (maxX < margin) translateX += margin - maxX;
        if (minY > h - margin) translateY -= minY - (h - margin);
        if (maxY < margin) translateY += margin - maxY;
    }
    function distance(p1, p2) { const dx = p2.x - p1.x, dy = p2.y - p1.y; return Math.hypot(dx, dy); }
    function midpoint(p1, p2) { return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }; }

    function hitTest(mx, my) {
        let hit = null;
        for (const f of features) {
            if (f.type === 'Polygon') {
                drawPolygon(f.coords);
                if (ctx.isPointInPath(mx, my)) { hit = f; break; }
            } else {
                for (const poly of f.coords) {
                    drawPolygon(poly);
                    if (ctx.isPointInPath(mx, my)) { hit = f; break; }
                }
                if (hit) break;
            }
        }
        return hit;
    }

    // ===== アニメーションズーム =====
    function zoomToFeatureAnimated(f) {
        const fb = featureBounds(f);
        const w = canvas.clientWidth, h = canvas.clientHeight;
        const worldW = fb.maxX - fb.minX;
        const worldH = fb.maxY - fb.minY;
        const pad = Math.max(PADDING, 30);
        let targetScale = Math.min((w - 2 * pad) / worldW, (h - 2 * pad) / worldH);
        targetScale = Math.max(minScale, Math.min(maxScale, targetScale));
        const offX = (w - worldW * targetScale) / 2;
        const offY = (h - worldH * targetScale) / 2;
        const targetX = -fb.minX * targetScale + offX;
        const targetY = -fb.minY * targetScale + offY;

        const startScale = scale, startX = translateX, startY = translateY;
        const duration = 500;
        const t0 = performance.now();

        function animate(t) {
            const p = Math.min((t - t0) / duration, 1);
            const ease = 1 - Math.pow(1 - p, 3); // easeOutCubic
            scale = startScale + (targetScale - startScale) * ease;
            translateX = startX + (targetX - startX) * ease;
            translateY = startY + (targetY - startY) * ease;
            constrainPan(); draw();
            if (p < 1) requestAnimationFrame(animate);
        }
        requestAnimationFrame(animate);
    }

    // ===== Pointer Events（マウス/タッチ統合）=====
    canvas.addEventListener('pointerdown', (e) => {
        // ブラウザの既定ジェスチャ無効化（特にタッチ）
        e.preventDefault();

        // キャプチャして pointerup を必ずこの要素で受ける
        canvas.setPointerCapture(e.pointerId);

        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left, y = e.clientY - rect.top;
        activePointers.set(e.pointerId, { x, y, type: e.pointerType });

        if (activePointers.size === 1) {
            // 1本指（またはマウス）: パン or タップ候補
            isPanning = true;
            lastX = e.clientX; lastY = e.clientY;

            tapStartX = e.clientX; tapStartY = e.clientY;
            tapStartTime = performance.now();
            tapMoved = false;
            tapPointerType = e.pointerType; // 'touch' or 'mouse' or 'pen'
        } else if (activePointers.size === 2) {
            // 2本指: ピンチ開始
            isPanning = false;
            isPinching = true;
            const it = activePointers.values();
            const p1 = it.next().value, p2 = it.next().value;
            pinchStartDist = distance(p1, p2);
            pinchStartScale = scale;
            const m = midpoint(p1, p2);
            pinchCenterX = m.x; pinchCenterY = m.y;
            tapMoved = true; // タップではない
        }
    }, { passive: false });

    canvas.addEventListener('pointermove', (e) => {
        e.preventDefault();
        if (!ready) return;

        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left, y = e.clientY - rect.top;
        if (activePointers.has(e.pointerId)) {
            activePointers.set(e.pointerId, { x, y, type: e.pointerType });
        }

        if (isPinching && activePointers.size >= 2) {
            // ピンチズーム
            const it = activePointers.values();
            const p1 = it.next().value, p2 = it.next().value;
            const dist = distance(p1, p2);
            const factor = dist / pinchStartDist;
            let newScale = Math.max(minScale, Math.min(maxScale, pinchStartScale * factor));

            // 中点を不変点に
            const k = newScale / scale;
            translateX = pinchCenterX - (pinchCenterX - translateX) * k;
            translateY = pinchCenterY - (pinchCenterY - translateY) * k;
            scale = newScale;

            constrainPan(); draw();
        } else if (isPanning && activePointers.size === 1) {
            // パン
            const dx = e.clientX - lastX, dy = e.clientY - lastY;
            if (Math.abs(e.clientX - tapStartX) > TAP_MOVE_THRESH || Math.abs(e.clientY - tapStartY) > TAP_MOVE_THRESH) {
                tapMoved = true; // タップではなくパン
            }
            translateX += dx; translateY += dy;
            lastX = e.clientX; lastY = e.clientY;

            constrainPan(); draw();
        }
    }, { passive: false });

    canvas.addEventListener('pointerup', (e) => {
        e.preventDefault();

        // タップ判定（クリック相当）
        const now = performance.now();
        const isTapCandidate = (
            !isPinching &&
            activePointers.size <= 1 &&               // 指が残っていない（または1本→すぐ離れ）
            !tapMoved &&
            (now - tapStartTime) <= TAP_TIME_THRESH
        );

        // pointer を削除
        activePointers.delete(e.pointerId);

        if (activePointers.size < 2) isPinching = false;
        if (activePointers.size === 0) isPanning = false;

        if (isTapCandidate) {
            // クリック/タップ選択（マウスでもOK）
            handlePointerSelect(e.clientX, e.clientY);
        }
    }, { passive: false });

    canvas.addEventListener('pointercancel', (e) => {
        e.preventDefault();
        activePointers.delete(e.pointerId);
        if (activePointers.size < 2) isPinching = false;
        if (activePointers.size === 0) isPanning = false;
        tapMoved = true;
    }, { passive: false });

    // ホイールズーム（マウス用）
    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (!ready) return;
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        const oldScale = scale;
        const factor = (e.deltaY < 0) ? ZOOM_STEP : (1 / ZOOM_STEP);
        const newScale = Math.max(minScale, Math.min(maxScale, scale * factor));
        const k = newScale / oldScale;
        translateX = mx - (mx - translateX) * k;
        translateY = my - (my - translateY) * k;
        scale = newScale;
        constrainPan(); draw();
    }, { passive: false });

    // クリック/タップ共通の選択処理
    function handlePointerSelect(clientX, clientY) {
        const rect = canvas.getBoundingClientRect();
        const mx = clientX - rect.left, my = clientY - rect.top;
        const hit = hitTest(mx, my);
        if (!hit) return;
        selectedFeature = hit;
        zoomToFeatureAnimated(hit);
    }

    // 初期表示
    fitToCanvas();
    ready = true;
    resizeCanvas();
})();
