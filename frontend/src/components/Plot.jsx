import React, { useEffect, useRef, useState } from "react";
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
    dragmode: 'zoom',
};

const CONFIG = { responsive: true, displaylogo: false, modeBarButtonsToRemove: ['lasso2d', 'select2d', 'autoScale2d'], toImageButtonOptions: { format: 'png', scale: 2 } };

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


function Plot({ data, layout, height = 340, className = '' }) {
    const ref = useRef(null);
    const [error, setError] = useState(null);

    useEffect(() => {
        const node = ref.current;
        if (!node) return;
        const fullLayout = styleAxes(deepMerge(BASE_LAYOUT, { ...layout, height }));
        // une erreur Plotly (donnees / config invalides) reste confinee a ce graphique
        Promise.resolve()
            .then(() => Plotly.react(node, data, fullLayout, CONFIG))
            .then(() => setError(null))
            .catch(err => { console.error('Plotly error', err); setError(err?.message || String(err)); });
    }, [data, layout, height]);

    useEffect(() => {
        const node = ref.current;
        return () => { if (node) Plotly.purge(node); };
    }, []);

    return (
        <>
            {error && <div className="plot-error--P">Chart error: {error}</div>}
            <div ref={ref} className={`plot--P ${className}`} style={{ width: '100%', height, display: error ? 'none' : 'block' }} />
        </>
    );
}

export default Plot;
