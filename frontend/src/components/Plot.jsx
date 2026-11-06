import React, { useEffect, useRef, useState, useCallback, memo } from "react";
import Plotly from 'plotly.js-dist-min';
import { PLOT_COLORS } from './plotTheme.js';


const BASE_LAYOUT = {
    paper_bgcolor: 'rgba(0, 0, 0, 0)',
    plot_bgcolor: '#131317',
    font: { family: "'Inter', 'Segoe UI', sans-serif", size: 11, color: PLOT_COLORS.text },
    margin: { l: 56, r: 18, t: 18, b: 40 },
    hoverlabel: { bgcolor: '#1e1e1e', bordercolor: 'rgba(255, 127, 50, 0.5)', font: { family: "'JetBrains Mono', monospace", size: 11, color: '#fff' } },
    legend: { orientation: 'h', y: 1.08, x: 0, font: { size: 11 }, bgcolor: 'rgba(0,0,0,0)' },
    xaxis: { gridcolor: PLOT_COLORS.grid, zerolinecolor: 'rgba(255,255,255,0.15)', linecolor: 'rgba(255,255,255,0.1)' },
    yaxis: { gridcolor: PLOT_COLORS.grid, zerolinecolor: 'rgba(255,255,255,0.15)', linecolor: 'rgba(255,255,255,0.1)' },
    hovermode: 'closest',
    dragmode: 'pan',
};

const CONFIG = {
    responsive: true,
    displaylogo: false,
    scrollZoom: true,
    modeBarButtonsToRemove: ['lasso2d', 'select2d'],
    toImageButtonOptions: { format: 'png', scale: 2 },
    plotGlPixelRatio: 1,
};

function deepMerge(base, extra) {
    const out = { ...base };
    Object.entries(extra || {}).forEach(([key, value]) => {
        out[key] = value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object'
            ? deepMerge(base[key], value)
            : value;
    });
    return out;
}

// Applique le style d'axe par defaut a xaxis2, yaxis3, ... (sous-graphiques)
function styleAxes(layout) {
    Object.keys(layout).forEach(key => {
        if (/^[xy]axis\d+$/.test(key)) layout[key] = deepMerge(BASE_LAYOUT.xaxis, layout[key]);
    });
    return layout;
}


// Signature bon marche du contenu : tant qu'elle ne change pas, Plotly garde le zoom / pan de
// l'utilisateur (uirevision) meme si le parent recree data / layout a chaque rendu.
function dataSignature(data) {
    const ends = (a) => (Array.isArray(a) && a.length ? `${a.length}:${a[0]}:${a[a.length - 1]}` : '');
    // couleurs / visibilite comprises : changer la couleur d'une ligne doit redessiner
    const style = (t) => JSON.stringify([t.mode, t.visible, t.line?.color, typeof t.marker?.color === 'string' ? t.marker.color : '', t.hoverinfo]);
    return (data || []).map(t => `${t.type}|${t.name ?? ''}|${ends(t.x)}|${ends(t.y)}|${ends(t.z?.[0])}|${style(t)}`).join('~');
}


// Plotly ne comprend pas le suffixe de fuseau ('...T04:00:00+00:00') : l'autorange interne de
// l'axe date est faux et zoom / pan partent sur 1970. Les dates du backend sont en UTC naif.
const TZ_SUFFIX = /(?:Z|[+-]00:00)$/;
function normalizeDates(data) {
    return (data || []).map(trace => {
        const x = trace.x;
        if (!Array.isArray(x) || typeof x[0] !== 'string' || !TZ_SUFFIX.test(x[0])) return trace;
        return { ...trace, x: x.map(v => (typeof v === 'string' ? v.replace('T', ' ').replace(TZ_SUFFIX, '') : v)) };
    });
}


// Borne d'une selection Plotly -> nombre (ms UTC sur un axe date, sinon la valeur)
function axisValue(v) {
    if (typeof v === 'number') return v;
    const ms = Date.parse(String(v).replace(' ', 'T') + (String(v).includes('Z') ? '' : 'Z'));
    return Number.isNaN(ms) ? Number(v) : ms;
}


// --- Echelle Y facon TradingView (prop scaleDrag) ---------------------------------------------
// Les axes Y ne bougent plus au pan / zoom (fixedrange) : ils s'ajustent seuls aux points visibles
// quand X change. Glisser sur l'echelle de droite etire / tasse l'axe et le "verrouille" (il ne
// s'ajuste plus, et le pan vertical redevient possible) ; double-clic dessus = deverrouille + ajuste.
const yAxisNames = (fl) => Object.keys(fl).filter(k => /^yaxis\d*$/.test(k)).sort();
const axisRef = (name) => name.replace('axis', '');   // 'yaxis2' -> 'y2'
const xLinCache = new WeakMap();

function linearX(xa, xs) {
    let out = xLinCache.get(xs);
    if (!out || out.type !== xa.type) {
        out = { type: xa.type, v: Float64Array.from(xs, v => (v === null || v === undefined ? NaN : xa.d2l(v))) };
        xLinCache.set(xs, out);
    }
    return out.v;
}

// Plage [min, max] (en unites lineaires de l'axe, log10 sur un axe log) des points visibles en X
function visibleRange(node, yName) {
    const fl = node._fullLayout;
    const ya = fl[yName];
    let lo = Infinity, hi = -Infinity;
    (node.data || []).forEach(t => {
        if (t.visible === false || t.visible === 'legendonly' || (t.yaxis || 'y') !== axisRef(yName) || !Array.isArray(t.y)) return;
        const xa = fl[(t.xaxis || 'x').replace('x', 'xaxis')];
        if (!xa || !Array.isArray(t.x)) return;
        const [a, b] = xa.range.map(v => xa.r2l(v));
        const xs = linearX(xa, t.x);
        for (let i = 0; i < xs.length; i++) {
            if (!(xs[i] >= a && xs[i] <= b)) continue;
            const v = t.y[i];
            if (v === null || v === undefined) continue;
            const l = ya.d2l(v);
            if (!Number.isFinite(l)) continue;
            if (l < lo) lo = l;
            if (l > hi) hi = l;
        }
    });
    if (!Number.isFinite(lo)) return null;
    const pad = (hi - lo) * 0.06 || Math.abs(hi) * 0.02 || 1;
    return [lo - pad, hi + pad];
}

function fitY(node, names) {
    const patch = {};
    names.forEach(name => {
        const r = visibleRange(node, name);
        if (r) patch[`${name}.range`] = r;
    });
    if (Object.keys(patch).length) Plotly.relayout(node, patch);
}


// onSelectX(x0, x1) : appele a chaque selection horizontale (dragmode 'select').
// live : cles de layout appliquees sans redessiner (shapes, dragmode) -> le zoom de l'utilisateur est garde.
// onSelectBox(x0, x1, y0, y1) : rectangle trace en mode 'select' ; onRange({ x, y }) : axes visibles apres chaque zoom / pan
function PlotInner({ data, layout, height = 340, className = '', onSelectX, onSelectBox, onRange, live, scaleDrag = false }) {
    const ref = useRef(null);
    const wrapRef = useRef(null);
    const [error, setError] = useState(null);
    const [visible, setVisible] = useState(false);
    const [ready, setReady] = useState(false);
    const pendingRef = useRef(null);
    const drawnRef = useRef(null);
    const onSelectRef = useRef(onSelectX);
    const liveRef = useRef(live);
    const [strips, setStrips] = useState([]);
    const lockedRef = useRef(new Set());
    const [locked, setLocked] = useState([]);
    const onBoxRef = useRef(onSelectBox);
    const onRangeRef = useRef(onRange);
    onSelectRef.current = onSelectX;
    onBoxRef.current = onSelectBox;
    onRangeRef.current = onRange;
    liveRef.current = live;

    const setLock = useCallback((name, on) => {
        const set = lockedRef.current;
        if (on === set.has(name)) return false;
        if (on) set.add(name); else set.delete(name);
        setLocked([...set]);
        return true;
    }, []);

    // position des echelles Y (marge de droite) apres chaque rendu
    const measureStrips = useCallback(() => {
        const node = ref.current;
        const fl = node?._fullLayout;
        if (!fl?._size) return;
        const size = fl._size;
        const next = yAxisNames(fl).filter(n => fl[n].visible !== false && fl[n]._length).map(n => ({
            name: n, top: fl[n]._offset, height: fl[n]._length, left: size.l + size.w, width: Math.max(28, size.r),
        }));
        setStrips(prev => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    }, []);

    // IntersectionObserver : ne dessine le graphique que quand il entre dans le viewport
    useEffect(() => {
        const node = wrapRef.current;
        if (!node) return;
        const io = new IntersectionObserver(([entry]) => {
            setVisible(entry.isIntersecting);
        }, { rootMargin: '200px' });
        io.observe(node);
        return () => io.disconnect();
    }, []);

    // Quand les donnees arrivent hors viewport, on les stocke en attendant
    useEffect(() => {
        pendingRef.current = { data, layout, height };
    }, [data, layout, height]);

    // Rendu Plotly : seulement quand visible
    useEffect(() => {
        const node = ref.current;
        if (!node || !visible) return;
        const d = pendingRef.current || { data, layout, height };
        // le parent recree data / layout a chaque rendu : sans changement reel (contenu, mise en page,
        // hauteur) on ne redessine pas, sinon Plotly recalcule les axes et le zoom de l'utilisateur saute
        const key = `${dataSignature(d.data)}#${JSON.stringify(d.layout)}#${d.height}`;
        if (drawnRef.current === key) return;
        drawnRef.current = key;
        const fullLayout = styleAxes(deepMerge(BASE_LAYOUT, { ...d.layout, height: d.height }));
        if (scaleDrag) {
            lockedRef.current = new Set();
            setLocked([]);
            Object.keys(fullLayout).filter(k => /^yaxis\d*$/.test(k)).forEach(k => { fullLayout[k] = { ...fullLayout[k], fixedrange: true }; });
        }
        // une erreur Plotly (donnees / config invalides) reste confinee a ce graphique
        Promise.resolve()
            .then(() => Plotly.react(node, normalizeDates(d.data), { ...fullLayout, ...(liveRef.current || {}) }, CONFIG))
            .then(() => {
                if (!node.__selectBound) {
                    node.__selectBound = true;
                    const emitRange = () => {
                        const fl = node._fullLayout;
                        if (onRangeRef.current && fl?.xaxis && fl?.yaxis) onRangeRef.current({ x: [...fl.xaxis.range], y: [...fl.yaxis.range] });
                    };
                    node.on('plotly_relayout', emitRange);
                    node.on('plotly_afterplot', emitRange);
                    emitRange();
                    node.on('plotly_selected', (event) => {
                        const range = event?.range?.x;
                        if (!range || !(onSelectRef.current || onBoxRef.current)) return;
                        const [a, b] = range.map(axisValue);
                        if (onBoxRef.current && event.range.y) {
                            const [c, d] = event.range.y;
                            onBoxRef.current(Math.min(a, b), Math.max(a, b), Math.min(c, d), Math.max(c, d));
                        } else if (onSelectRef.current) {
                            onSelectRef.current(Math.min(a, b), Math.max(a, b));
                        }
                        // la zone vient d'etre enregistree : on efface le cadre et le grisage des points
                        Plotly.relayout(node, { selections: [] });
                        Plotly.restyle(node, { selectedpoints: [null] });
                    });
                }
                if (scaleDrag && !node.__scaleBound) {
                    node.__scaleBound = true;
                    node.on('plotly_afterplot', measureStrips);
                    node.on('plotly_relayout', (event) => {
                        const keys = Object.keys(event || {});
                        if (!keys.some(k => /^xaxis\d*\.(range|autorange)/.test(k))) return;
                        fitY(node, yAxisNames(node._fullLayout).filter(n => !lockedRef.current.has(n)));
                    });
                }
                if (scaleDrag) measureStrips();
                setError(null);
                setReady(true);
            })
            .catch(err => { drawnRef.current = null; console.error('Plotly error', err); setError(err?.message || String(err)); });
    }, [data, layout, height, visible]);   // eslint-disable-line react-hooks/exhaustive-deps

    // Surcouches (zones surlignees, mode de glisser) : relayout seul, sans toucher aux axes
    const liveKey = JSON.stringify(live || null);
    useEffect(() => {
        const node = ref.current;
        if (!node || !ready || !live) return;
        Plotly.relayout(node, live);
    }, [liveKey, ready]);

    // Plotly ne suit que la fenetre : quand le panneau change de largeur (plein / demi), on recalcule le graphique
    useEffect(() => {
        const node = ref.current;
        const wrap = wrapRef.current;
        if (!node || !wrap || typeof ResizeObserver === 'undefined') return;
        let frame = null;
        const observer = new ResizeObserver(() => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => { if (node.data) Plotly.Plots.resize(node); });
        });
        observer.observe(wrap);
        return () => { observer.disconnect(); cancelAnimationFrame(frame); };
    }, []);

    // Purge au demontage
    useEffect(() => {
        const node = ref.current;
        return () => { if (node) Plotly.purge(node); };
    }, []);

    // Bouton reset scale : remet les axes a l'etat initial (double-clic marche aussi
    // dans Plotly, mais un bouton c'est plus trouvable)
    const resetScale = useCallback(() => {
        const node = ref.current;
        if (!node || !ready) return;
        if (scaleDrag) {
            lockedRef.current = new Set();
            setLocked([]);
            const patch = { 'xaxis.autorange': true };
            yAxisNames(node._fullLayout).forEach(n => { patch[`${n}.autorange`] = true; patch[`${n}.fixedrange`] = true; });
            Plotly.relayout(node, patch);
            return;
        }
        Plotly.relayout(node, {
            'xaxis.autorange': true,
            'yaxis.autorange': true,
            'xaxis2.autorange': true,
            'yaxis2.autorange': true,
            'xaxis3.autorange': true,
            'yaxis3.autorange': true,
        });
    }, [ready, scaleDrag]);

    // glisser vers le bas = tasser (on voit plus large), vers le haut = etirer, autour du centre
    const startScaleDrag = useCallback((name, e) => {
        const node = ref.current;
        const ax = node?._fullLayout?.[name];
        if (!ax || e.button !== 0) return;
        e.preventDefault();
        const [r0, r1] = ax.range.map(v => ax.r2l(v));
        const center = (r0 + r1) / 2, half = (r1 - r0) / 2, y0 = e.clientY;
        let frame = null, first = true;
        const move = (ev) => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                const k = Math.exp((ev.clientY - y0) / 160);
                const patch = { [`${name}.range`]: [center - half * k, center + half * k] };
                if (first && setLock(name, true)) patch[`${name}.fixedrange`] = false;
                first = false;
                Plotly.relayout(node, patch);
            });
        };
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    }, [setLock]);

    const fitAxis = useCallback((name) => {
        const node = ref.current;
        if (!node) return;
        setLock(name, false);
        Plotly.relayout(node, { [`${name}.fixedrange`]: true });
        fitY(node, [name]);
    }, [setLock]);

    return (
        <div ref={wrapRef} className={`plot-wrap--P ${className}`} style={{ position: 'relative', width: '100%', minHeight: height }}>
            {error && <div className="plot-error--P">Chart error: {error}</div>}
            <div ref={ref} className="plot--P" style={{ width: '100%', height, display: error ? 'none' : 'block' }} />
            {!error && ready && scaleDrag && strips.map(st => (
                <div key={st.name} className={`plot-yscale--P ${locked.includes(st.name) ? 'locked' : ''}`}
                    style={{ top: st.top, left: st.left, width: st.width, height: st.height }}
                    title="Drag up / down to stretch or squeeze this scale · double-click to fit it to the visible data"
                    onPointerDown={(e) => startScaleDrag(st.name, e)} onDoubleClick={() => fitAxis(st.name)} />
            ))}
            {!error && ready && (
                <button type="button" className="plot-reset--P" onClick={resetScale} title="Reset zoom (or double-click the chart)">⟲</button>
            )}
        </div>
    );
}

const Plot = memo(PlotInner);
export default Plot;
