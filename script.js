// script.js
(async function () {
    const GEOJSON_URL = './prefectures.json';
    const PADDING = 20;
    const ZOOM_STEP = 1.12;

    const canvas = document.getElementById('map');
    const hud = document.getElementById('hud');
    const ctx = canvas.getContext('2d');

    let gj;
    let features = [];
    let bounds = null;
    let scale = 1, translateX = 0, translateY = 0;
    let minScale = 12;
    let maxScale = 1000;
    let isDragging = false, lastX = 0, lastY = 0;
    let currentHover = null;
    let ready = false;

    // --- タッチ操作用 ---
    let isTouchPanning = false;
    let lastTouchX = 0, lastTouchY = 0;
    let isPinching = false;
    let pinchStartDist = 0;
    let pinchStartScale = 1;
    let pinchCenterX = 0, pinchCenterY = 0;

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

    try {
        const resp = await fetch(GEOJSON_URL, { cache: 'no-cache' });
        if (!resp.ok) throw new Error('failed to load GeoJSON: ' + resp.status);
        gj = await resp.json();
    } catch (e) {
        hud.textContent = 'prefectures.json の読み込みに失敗しました。配置場所/ファイル名を確認してください。';
        console.error(e);
        return;
    }

    function lonLatToXY([lon, lat]) { return [lon, -lat]; }
    function projectCoords(coords) { return (typeof coords[0] === 'number') ? lonLatToXY(coords) : coords.map(projectCoords); }

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

        // 中央に配置するためのオフセット
        const offsetX = (w - worldW * scale) / 2;
        const offsetY = (h - worldH * scale) / 2;
        translateX = -bounds.minX * scale + offsetX;
        translateY = -bounds.minY * scale + offsetY;

        maxScale = Math.max(500, scale * 10);
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

    // --- マウスドラッグ ---
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
        hud.textContent = currentHover?.props?.N03_001 || 'ホイール/ピンチで拡大縮小、ドラッグ/スワイプでパン';
        draw();
    });

    function logScale(tag) { console.log(tag, 'scale =', scale.toFixed(4), '(min', minScale, 'max', maxScale + ')'); }

    // --- ホイールズーム ---
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

    // --- タッチ（スマホ対応） ---
    function distance(t1, t2) {
        const dx = t2.clientX - t1.clientX;
        const dy = t2.clientY - t1.clientY;
        return Math.hypot(dx, dy);
    }
    function midpoint(t1, t2, rect) {
        return {
            x: ((t1.clientX + t2.clientX) / 2) - rect.left,
            y: ((t1.clientY + t2.clientY) / 2) - rect.top
        };
    }

    canvas.addEventListener('touchstart', (e) => {
        e.preventDefault();
        if (!ready) return;
        const rect = canvas.getBoundingClientRect();
        if (e.touches.length === 1) {
            isTouchPanning = true;
            isPinching = false;
            lastTouchX = e.touches[0].clientX;
            lastTouchY = e.touches[0].clientY;
        } else if (e.touches.length === 2) {
            isTouchPanning = false;
            isPinching = true;
            pinchStartDist = distance(e.touches[0], e.touches[1]);
            pinchStartScale = scale;
            const m = midpoint(e.touches[0], e.touches[1], rect);
            pinchCenterX = m.x;
            pinchCenterY = m.y;
        }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
        e.preventDefault();
        if (!ready) return;
        const rect = canvas.getBoundingClientRect();
        if (isPinching && e.touches.length === 2) {
            const dist = distance(e.touches[0], e.touches[1]);
            const factor = dist / pinchStartDist;
            const newScale = Math.max(minScale, Math.min(maxScale, pinchStartScale * factor));
            const k = newScale / scale;
            translateX = pinchCenterX - (pinchCenterX - translateX) * k;
            translateY = pinchCenterY - (pinchCenterY - translateY) * k;
            scale = newScale;
            constrainPan();
            draw();
            console.log('[pinch] scale =', scale.toFixed(4), '(min', minScale, 'max', maxScale + ')');
        } else if (isTouchPanning && e.touches.length === 1) {
            const cx = e.touches[0].clientX;
            const cy = e.touches[0].clientY;
            translateX += (cx - lastTouchX);
            translateY += (cy - lastTouchY);
            lastTouchX = cx; lastTouchY = cy;
            constrainPan();
            draw();
        } else if (e.touches.length === 2) {
            isTouchPanning = false;
            isPinching = true;
            pinchStartDist = distance(e.touches[0], e.touches[1]);
            pinchStartScale = scale;
            const m = midpoint(e.touches[0], e.touches[1], rect);
            pinchCenterX = m.x; pinchCenterY = m.y;
        }
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
        e.preventDefault();
        if (e.touches.length === 0) {
            isTouchPanning = false;
            isPinching = false;
        } else if (e.touches.length === 1) {
            isPinching = false;
            isTouchPanning = true;
            lastTouchX = e.touches[0].clientX;
            lastTouchY = e.touches[0].clientY;
        }
    }, { passive: false });

    canvas.addEventListener('touchcancel', (e) => {
        e.preventDefault();
        isTouchPanning = false;
        isPinching = false;
    }, { passive: false });

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

    fitToCanvas();
    ready = true;
    resizeCanvas();
})();
