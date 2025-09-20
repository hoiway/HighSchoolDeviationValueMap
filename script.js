// script.js
(async function () {
    const GEOJSON_URL = './prefectures.json';
    const CAPITALS_URL = './capitals.json';

    const PADDING = 20;
    const ZOOM_STEP = 1.12;

    const canvas = document.getElementById('map');
    const ctx = canvas.getContext('2d', { alpha: false });

    // --- ビュー状態 ---
    let scale = 1, translateX = 0, translateY = 0;
    const minScale = 25;
    let maxScale = 1000;

    // --- データ ---
    let features = [];
    let bounds = null;   // {minX,minY,maxX,maxY}
    let capitalsMap = {};  // { '北海道': { city, lonDeg, latDeg, elev_m } }
    let selectedFeature = null;
    let ready = false;

    // --- Pointer Events 状態 ---
    const activePointers = new Map(); // pointerId -> {x,y,type}
    let isPanning = false;
    let isPinching = false;
    let lastX = 0, lastY = 0;

    // ピンチ用
    let pinchStartDist = 0;
    let pinchStartScale = 1;
    let pinchCenterX = 0, pinchCenterY = 0; // CSS px (canvas 内)

    // タップ判定（クリック相当）
    const TAP_MOVE_THRESH = 12;  // iPhone 11 mini 向けに広め
    const TAP_TIME_THRESH = 400; // ms
    let tapStartX = 0, tapStartY = 0, tapStartTime = 0, tapMoved = false;

    // iOS Safari での既定挙動の保険（CSSが効かない環境向け）
    try { canvas.style.touchAction = 'none'; } catch { }

    // --- 高DPI対応 ---
    function resizeCanvas() {
        const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        // 以降の描画座標は「CSSピクセル」で扱う
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (ready) draw();
    }
    new ResizeObserver(resizeCanvas).observe(canvas);

    // --- utils ---
    const dmsToDeg = (s) => {
        if (typeof s === 'number') return s;
        const [d, m, sec] = String(s).split(':').map(Number);
        return d + (m || 0) / 60 + (sec || 0) / 3600;
    };
    const lonLatToXY = ([lon, lat]) => [lon, -lat]; // 緯度反転（上下正しい表示）
    const worldToScreen = ([x, y]) => [x * scale + translateX, y * scale + translateY];

    function projectCoords(coords) {
        return (typeof coords[0] === 'number') ? lonLatToXY(coords) : coords.map(projectCoords);
    }

    function computeBounds(fs) {
        let minX = Infinity, minY = Infinity;
        let maxX = -Infinity, maxY = -Infinity;
        const visit = ([x, y]) => { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; };
        const walk = (a) => { (typeof a[0] === 'number') ? visit(a) : a.forEach(walk); };
        fs.forEach(f => walk(f.coords));
        return { minX, minY, maxX, maxY };
    }

    function fitToCanvas() {
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        const worldW = bounds.maxX - bounds.minX;
        const worldH = bounds.maxY - bounds.minY;

        const sx = (w - 2 * PADDING) / worldW;
        const sy = (h - 2 * PADDING) / worldH;
        scale = Math.min(sx, sy);

        // 中央寄せ
        const offsetX = (w - worldW * scale) / 2;
        const offsetY = (h - worldH * scale) / 2;
        translateX = -bounds.minX * scale + offsetX;
        translateY = -bounds.minY * scale + offsetY;

        maxScale = Math.max(500, scale * 10);
    }

    // --- GeoJSON + capitals 読み込み ---
    try {
        const [prefRes, capitalsRes] = await Promise.all([
            fetch(GEOJSON_URL, { cache: 'no-cache' }),
            fetch(CAPITALS_URL, { cache: 'no-cache' }),
        ]);
        if (!prefRes.ok) throw new Error('prefectures.json load error: ' + prefRes.status);
        if (!capitalsRes.ok) throw new Error('capitals.json load error: ' + capitalsRes.status);

        const gj = await prefRes.json();
        const capitalsArr = await capitalsRes.json();

        features = gj.features.map(f => ({
            type: f.geometry.type,
            coords: projectCoords(f.geometry.coordinates),
            props: f.properties
        }));
        bounds = computeBounds(features);

        capitalsMap = Object.fromEntries(capitalsArr.map(row => {
            const lonDeg = dmsToDeg(row.lon_dms ?? row.lon);
            const latDeg = dmsToDeg(row.lat_dms ?? row.lat);
            return [row.pref, { city: row.city, lonDeg, latDeg, elev_m: row.elev_m ?? null }];
        }));
    } catch (err) {
        console.error(err);
        return;
    }

    // --- 多角形描画 ---
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

    // --- 多角形重心（ラベル座標） ---
    function ringAreaAndCentroid(ring) {
        let A = 0, Cx = 0, Cy = 0;
        const n = ring.length;
        for (let i = 0; i < n; i++) {
            const [x1, y1] = ring[i];
            const [x2, y2] = ring[(i + 1) % n];
            const cross = x1 * y2 - x2 * y1;
            A += cross; Cx += (x1 + x2) * cross; Cy += (y1 + y2) * cross;
        }
        A *= 0.5;
        if (!A) return { cx: ring[0][0], cy: ring[0][1] };
        return { cx: Cx / (6 * A), cy: Cy / (6 * A) };
    }
    function featureCentroid(f) {
        if (f.type === 'Polygon') {
            const { cx, cy } = ringAreaAndCentroid(f.coords[0]); return [cx, cy];
        }
        // MultiPolygon: 面積最大のポリゴン
        let best = { area: -Infinity, cx: 0, cy: 0 };
        for (const poly of f.coords) {
            const outer = poly[0];
            let A = 0;
            for (let i = 0; i < outer.length; i++) {
                const [x1, y1] = outer[i];
                const [x2, y2] = outer[(i + 1) % outer.length];
                A += (x1 * y2 - x2 * y1);
            }
            const area = Math.abs(A * 0.5);
            const { cx, cy } = ringAreaAndCentroid(outer);
            if (area > best.area) best = { area, cx, cy };
        }
        return [best.cx, best.cy];
    }

    // --- 厳密ヒットテスト（画面→ワールド→ray casting） ---
    function pointInRing(wx, wy, ring) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i][0], yi = ring[i][1];
            const xj = ring[j][0], yj = ring[j][1];
            const intersect = ((yi > wy) !== (yj > wy)) &&
                (wx < (xj - xi) * (wy - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }
    function pointInPolygonRings(wx, wy, rings) {
        // rings[0]: outer、以降は穴
        if (!pointInRing(wx, wy, rings[0])) return false;
        for (let h = 1; h < rings.length; h++) if (pointInRing(wx, wy, rings[h])) return false;
        return true;
    }
    function hitFeatureAtClient(clientX, clientY) {
        const rect = canvas.getBoundingClientRect();
        const mx = clientX - rect.left;
        const my = clientY - rect.top;
        // 画面→ワールド座標
        const wx = (mx - translateX) / scale;
        const wy = (my - translateY) / scale;

        for (const f of features) {
            if (f.type === 'Polygon') {
                if (pointInPolygonRings(wx, wy, f.coords)) return f;
            } else {
                for (const poly of f.coords) {
                    if (pointInPolygonRings(wx, wy, poly)) return f;
                }
            }
        }
        return null;
    }

    // --- 描画 ---
    function draw() {
        if (!ready) return;
        const w = canvas.clientWidth, h = canvas.clientHeight;
        ctx.clearRect(0, 0, w, h);

        ctx.strokeStyle = '#334155';
        ctx.lineWidth = 1;

        for (const f of features) {
            const isSel = (f === selectedFeature);
            ctx.fillStyle = isSel ? '#9ad0ff' : '#cfe8ff';
            if (f.type === 'Polygon') {
                drawPolygon(f.coords); ctx.fill(); ctx.stroke();
            } else {
                for (const poly of f.coords) { drawPolygon(poly); ctx.fill(); ctx.stroke(); }
            }
        }

        // 選択ラベル & 県庁所在地
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

    // --- ズーム（アニメーション） ---
    function featureBounds(f) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const visit = ([x, y]) => { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; };
        const walk = (a) => { (typeof a[0] === 'number') ? visit(a) : a.forEach(walk); };
        if (f.type === 'Polygon') walk(f.coords); else f.coords.forEach(poly => walk(poly));
        return { minX, minY, maxX, maxY };
    }
    function zoomToFeatureAnimated(f) {
        const fb = featureBounds(f);
        const w = canvas.clientWidth, h = canvas.clientHeight;
        const worldW = fb.maxX - fb.minX, worldH = fb.maxY - fb.minY;
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

    // --- パン制限 ---
    function constrainPan() {
        const w = canvas.clientWidth, h = canvas.clientHeight;
        const minX = bounds.minX * scale + translateX;
        const minY = bounds.minY * scale + translateY;
        const maxX = bounds.maxX * scale + translateX;
        const maxY = bounds.maxY * scale + translateY;
        const margin = 50;

        if (minX > w - margin) translateX -= minX - (w - margin);
        if (maxX < margin) translateX += margin - maxX;
        if (minY > h - margin) translateY -= minY - (h - margin);
        if (maxY < margin) translateY += margin - maxY;
    }

    // --- Pointer Events（マウス/タッチ統合） ---
    canvas.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);

        const rect = canvas.getBoundingClientRect();
        activePointers.set(e.pointerId, { x: e.clientX - rect.left, y: e.clientY - rect.top, type: e.pointerType });

        if (activePointers.size === 1) {
            isPanning = true; isPinching = false;
            lastX = e.clientX; lastY = e.clientY;
            tapStartX = e.clientX; tapStartY = e.clientY; tapStartTime = performance.now(); tapMoved = false;
        } else if (activePointers.size === 2) {
            isPanning = false; isPinching = true; tapMoved = true; // タップではない
            const it = activePointers.values();
            const p1 = it.next().value, p2 = it.next().value;
            pinchStartDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
            pinchStartScale = scale;
            const m = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
            pinchCenterX = m.x; pinchCenterY = m.y;
        }
    }, { passive: false });

    canvas.addEventListener('pointermove', (e) => {
        e.preventDefault();
        if (!ready) return;

        const rect = canvas.getBoundingClientRect();
        if (activePointers.has(e.pointerId)) {
            activePointers.set(e.pointerId, { x: e.clientX - rect.left, y: e.clientY - rect.top, type: e.pointerType });
        }

        if (isPinching && activePointers.size >= 2) {
            const it = activePointers.values();
            const p1 = it.next().value, p2 = it.next().value;
            const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
            let newScale = Math.max(minScale, Math.min(maxScale, pinchStartScale * (dist / pinchStartDist)));
            const k = newScale / scale;
            translateX = pinchCenterX - (pinchCenterX - translateX) * k;
            translateY = pinchCenterY - (pinchCenterY - translateY) * k;
            scale = newScale;
            constrainPan(); draw();
        } else if (isPanning && activePointers.size === 1) {
            const dx = e.clientX - lastX, dy = e.clientY - lastY;
            if (Math.abs(e.clientX - tapStartX) > TAP_MOVE_THRESH || Math.abs(e.clientY - tapStartY) > TAP_MOVE_THRESH) {
                tapMoved = true;
            }
            translateX += dx; translateY += dy;
            lastX = e.clientX; lastY = e.clientY;
            constrainPan(); draw();
        }
    }, { passive: false });

    canvas.addEventListener('pointerup', (e) => {
        e.preventDefault();

        const now = performance.now();
        const wasTap = (!isPinching &&
            activePointers.size <= 1 &&
            !tapMoved &&
            (now - tapStartTime) <= TAP_TIME_THRESH);

        activePointers.delete(e.pointerId);
        if (activePointers.size < 2) isPinching = false;
        if (activePointers.size === 0) isPanning = false;

        if (wasTap) {
            const hit = hitFeatureAtClient(e.clientX, e.clientY);
            if (hit) { selectedFeature = hit; zoomToFeatureAnimated(hit); }
        }
    }, { passive: false });

    canvas.addEventListener('pointercancel', (e) => {
        e.preventDefault();
        activePointers.delete(e.pointerId);
        if (activePointers.size < 2) isPinching = false;
        if (activePointers.size === 0) isPanning = false;
        tapMoved = true;
    }, { passive: false });

    // --- マウスホイール（iOS では起きないがPC用に残す） ---
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

    // --- 初期表示 ---
    fitToCanvas();
    ready = true;
    resizeCanvas();
})();
