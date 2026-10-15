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
    return (data || []).map(t => `${t.type}|${t.name ?? ''}|${ends(t.x)}|${ends(t.y)}|${ends(t.z?.[0])}`).join('~');
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


// onSelectX(x0, x1) : appele a chaque selection horizontale (dragmode 'select').
// live : cles de layout appliquees sans redessiner (shapes, dragmode) -> le zoom de l'utilisateur est garde.
function PlotInner({ data, layout, height = 340, className = '', onSelectX, live }) {
    const ref = useRef(null);
    const wrapRef = useRef(null);
    const [error, setError] = useState(null);
    const [visible, setVisible] = useState(false);
    const [ready, setReady] = useState(false);
    const pendingRef = useRef(null);
    const drawnRef = useRef(null);
    const onSelectRef = useRef(onSelectX);
    const liveRef = useRef(live);
    onSelectRef.current = onSelectX;
    liveRef.current = live;

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
        // une erreur Plotly (donnees / config invalides) reste confinee a ce graphique
        Promise.resolve()
            .then(() => Plotly.react(node, normalizeDates(d.data), { ...fullLayout, ...(liveRef.current || {}) }, CONFIG))
            .then(() => {
                if (!node.__selectBound) {
                    node.__selectBound = true;
                    node.on('plotly_selected', (event) => {
                        const range = event?.range?.x;
                        if (!range || !onSelectRef.current) return;
                        const [a, b] = range.map(axisValue);
                        onSelectRef.current(Math.min(a, b), Math.max(a, b));
                        // la zone vient d'etre enregistree : on efface le cadre et le grisage des points
                        Plotly.relayout(node, { selections: [] });
                        Plotly.restyle(node, { selectedpoints: [null] });
                    });
                }
                setError(null);
                setReady(true);
            })
            .catch(err => { drawnRef.current = null; console.error('Plotly error', err); setError(err?.message || String(err)); });
    }, [data, layout, height, visible]);

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
        Plotly.relayout(node, {
            'xaxis.autorange': true,
            'yaxis.autorange': true,
            'xaxis2.autorange': true,
            'yaxis2.autorange': true,
            'xaxis3.autorange': true,
            'yaxis3.autorange': true,
        });
    }, [ready]);

    return (
        <div ref={wrapRef} className={`plot-wrap--P ${className}`} style={{ position: 'relative', width: '100%', minHeight: height }}>
            {error && <div className="plot-error--P">Chart error: {error}</div>}
            <div ref={ref} className="plot--P" style={{ width: '100%', height, display: error ? 'none' : 'block' }} />
            {!error && ready && (
                <button type="button" className="plot-reset--P" onClick={resetScale} title="Reset zoom (or double-click the chart)">⟲</button>
            )}
        </div>
    );
}

const Plot = memo(PlotInner);
export default Plot;
