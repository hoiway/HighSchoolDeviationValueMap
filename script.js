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

    // マウス
    let isDragging = false, lastX = 0, lastY = 0, dragMoved = false;

    // タッチ
    let isTouchPanning = false, lastTouchX = 0, lastTouchY = 0;
    let isPinching = false, pinchStartDist = 0, pinchStartScale = 1, pinchCenterX = 0, pinchCenterY = 0;

    // タップ判定（クリック相当）
    const TAP_MOVE_THRESH = 6;   // px
    const TAP_TIME_THRESH = 350; // ms（長押しは無視）
    let tapStartX = 0, tapStartY = 0, tapMoved = false, tapStartTime = 0;

    // 状態
    let ready = false;
    let selectedFeature = null;

    // ========== capitals.json ==========
    const dmsToDeg = (s) => {
        if (typeof s === 'number') return s;
        const [d, m, sec] = String(s).split(':').map(Number);
        return d + (m || 0) / 60 + (sec || 0) / 3600;
    };
    let capitalsMap = {};
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

    // ========== 高DPI & リサイズ ==========
    function resizeCanvas() {
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth, h = canvas.clientHeight;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (ready) draw();
    }
    new ResizeObserver(resizeCanvas).observe(canvas);

    // ========== データ読込 ==========
    try {
        const [prefResp] = await Promise.all([
            fetch(GEOJSON_URL, { cache: 'no-cache' }),
            loadCapitals(),
        ]);
        if (!prefResp.ok) throw new Error('failed to load GeoJSON: ' + prefResp.status);
        gj = await prefResp.json();
    } catch (e) { console.error(e); return; }

    // ========== 投影 & 前処理 ==========
    const lonLatToXY = ([lon, lat]) => [lon, -lat]; // 上下左右の修正でlat反転
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
            Cx += (x1 + x2) * cross; Cy += (y1 + y2) * cross;
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

    // ========== 描画 ==========
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

        // ラベル＆県庁所在地（選択時）
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
                ctx.fillStyle = '#ffd400'; // 黄色
                ctx.fill();
                ctx.lineWidth = 2;
                ctx.strokeStyle = '#000000';
                ctx.stroke();
            }
        }
    }

    // ========== 入力（マウス：パン & クリック） ==========
    canvas.addEventListener('mousedown', e => {
        isDragging = true; dragMoved = false;
        lastX = e.clientX; lastY = e.clientY;
    });
    window.addEventListener('mouseup', e => {
        if (isDragging && !dragMoved) handlePointerSelect(e.clientX, e.clientY);
        isDragging = false;
    });
    window.addEventListener('mousemove', e => {
        if (!ready) return;
        if (isDragging) {
            const dx = e.clientX - lastX, dy = e.clientY - lastY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragMoved = true;
            translateX += dx; translateY += dy;
            lastX = e.clientX; lastY = e.clientY;
            constrainPan(); draw();
        }
    });

    // ========== ホイールズーム ==========
    canvas.addEventListener('wheel', e => {
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

    // ========== タッチ（スマホ：パン・ピンチ・タップ） ==========
    const distance = (t1, t2) => Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
    const midpoint = (t1, t2, rect) => ({ x: ((t1.clientX + t2.clientX) / 2) - rect.left, y: ((t1.clientY + t2.clientY) / 2) - rect.top });

    canvas.addEventListener('touchstart', e => {
        e.preventDefault(); if (!ready) return;
        const rect = canvas.getBoundingClientRect();

        if (e.touches.length === 1) {
            // 1本指：パン or タップ開始
            isTouchPanning = true; isPinching = false;
            lastTouchX = e.touches[0].clientX; lastTouchY = e.touches[0].clientY;

            tapStartX = lastTouchX; tapStartY = lastTouchY;
            tapMoved = false; tapStartTime = performance.now();
        } else if (e.touches.length === 2) {
            // 2本指：ピンチ開始（タップは無効化）
            isTouchPanning = false; isPinching = true;
            tapMoved = true; // タップ扱いしない
            pinchStartDist = distance(e.touches[0], e.touches[1]);
            pinchStartScale = scale;
            const m = midpoint(e.touches[0], e.touches[1], rect);
            pinchCenterX = m.x; pinchCenterY = m.y;
        }
    }, { passive: false });

    canvas.addEventListener('touchmove', e => {
        e.preventDefault(); if (!ready) return;
        const rect = canvas.getBoundingClientRect();

        if (isPinching && e.touches.length === 2) {
            const dist = distance(e.touches[0], e.touches[1]);
            let newScale = Math.max(minScale, Math.min(maxScale, pinchStartScale * (dist / pinchStartDist)));
            const k = newScale / scale;
            translateX = pinchCenterX - (pinchCenterX - translateX) * k;
            translateY = pinchCenterY - (pinchCenterY - translateY) * k;
            scale = newScale; constrainPan(); draw();
        } else if (isTouchPanning && e.touches.length === 1) {
            const cx = e.touches[0].clientX, cy = e.touches[0].clientY;
            const dx = cx - lastTouchX, dy = cy - lastTouchY;
            if (Math.abs(cx - tapStartX) > TAP_MOVE_THRESH || Math.abs(cy - tapStartY) > TAP_MOVE_THRESH) {
                tapMoved = true; // タップではなくパン扱い
            }
            translateX += dx; translateY += dy;
            lastTouchX = cx; lastTouchY = cy; constrainPan(); draw();
        } else if (e.touches.length === 2) {
            // 途中から2本になった場合
            isTouchPanning = false; isPinching = true;
            tapMoved = true;
            pinchStartDist = distance(e.touches[0], e.touches[1]);
            pinchStartScale = scale;
            const m = midpoint(e.touches[0], e.touches[1], rect);
            pinchCenterX = m.x; pinchCenterY = m.y;
        }
    }, { passive: false });

    canvas.addEventListener('touchend', e => {
        e.preventDefault();
        if (!ready) return;

        // タップ判定：1本指で開始し、移動が小さく、短時間で、ピンチ中でない
        const now = performance.now();
        if (!isPinching && e.touches.length === 0 && !tapMoved && (now - tapStartTime) <= TAP_TIME_THRESH) {
            const touch = e.changedTouches[0];
            handlePointerSelect(touch.clientX, touch.clientY);
        }

        // 状態遷移
        if (e.touches.length === 0) { isTouchPanning = false; isPinching = false; }
        else if (e.touches.length === 1) {
            isPinching = false; isTouchPanning = true;
            lastTouchX = e.touches[0].clientX; lastTouchY = e.touches[0].clientY;
            tapStartX = lastTouchX; tapStartY = lastTouchY;
            tapMoved = false; tapStartTime = performance.now();
        }
    }, { passive: false });

    canvas.addEventListener('touchcancel', e => {
        e.preventDefault(); isTouchPanning = false; isPinching = false; tapMoved = true;
    }, { passive: false });

    // ========== 選択（クリック/タップ共通） ==========
    function handlePointerSelect(clientX, clientY) {
        const rect = canvas.getBoundingClientRect();
        const mx = clientX - rect.left, my = clientY - rect.top;

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
        if (!hit) return;
        selectedFeature = hit;
        zoomToFeatureAnimated(hit);
    }

    // ========== アニメーションズーム ==========
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
        const duration = 500; // ms
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

    // ========== パン制限 ==========
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

    // ========== 初期表示 ==========
    fitToCanvas();
    ready = true;
    resizeCanvas();
})();
