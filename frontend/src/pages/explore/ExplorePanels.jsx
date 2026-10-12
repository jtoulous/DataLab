/* eslint-disable react-refresh/only-export-components */
import React, { useState } from "react";
import Plot from '../../components/Plot.jsx';
import { PLOT_COLORS, DIVERGING, SEQUENTIAL } from '../../components/plotTheme.js';
import { formatNumber, formatCount, formatPct, formatDate } from '../../services/format.js';


/*=====================================================================================*/
/*                                  Shared inputs                                      */
/*=====================================================================================*/

export function FormulaInput({ value, onChange, placeholder = 'column or formula', label, wide }) {
    return (
        <label className={`ex-field--EX ${wide ? 'wide' : ''}`}>
            {label && <span>{label}</span>}
            <input className="mono--DS" list="dv-columns-list" value={value || ''} placeholder={placeholder} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
        </label>
    );
}

export function MultiInput({ values, onChange, label, max = 10 }) {
    const [draft, setDraft] = useState('');
    const add = () => {
        const v = draft.trim();
        if (v && !values.includes(v) && values.length < max) onChange([...values, v]);
        setDraft('');
    };
    return (
        <div className="ex-field--EX wide">
            {label && <span>{label}</span>}
            <div className="ex-chips--EX">
                {values.map(v => (
                    <span key={v} className="ex-chip--EX"><code>{v}</code><button type="button" onClick={() => onChange(values.filter(x => x !== v))}>✕</button></span>
                ))}
                <input className="mono--DS" list="dv-columns-list" value={draft} placeholder={values.length < max ? '+ column / formula (Enter)' : `max ${max}`} spellCheck={false}
                    onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} onBlur={add} />
            </div>
        </div>
    );
}

function NumberInput({ label, value, onChange, min, max, step = 1 }) {
    return (
        <label className="ex-field--EX small">
            <span>{label}</span>
            <input type="number" value={value} min={min} max={max} step={step} onChange={(e) => onChange(Number(e.target.value))} />
        </label>
    );
}

function Toggle({ label, value, onChange }) {
    return (
        <label className="ex-toggle--EX">
            <button type="button" className={`toggle ${value ? 'active' : ''}`} onClick={() => onChange(!value)}><span className="toggle-knob" /></button>
            <span>{label}</span>
        </label>
    );
}

function Select({ label, value, onChange, options }) {
    return (
        <label className="ex-field--EX small">
            <span>{label}</span>
            <select value={value} onChange={(e) => onChange(e.target.value)}>
                {options.map(o => (typeof o === 'string' ? <option key={o} value={o}>{o}</option> : <option key={o.value} value={o.value}>{o.label}</option>))}
            </select>
        </label>
    );
}

// "Grouper par" : une colonne (categorielle / numerique decoupee) ou une periode de l'axe temporel
function GroupByInput({ label, value, rule, onChange, catalog }) {
    const isTime = value === '__time__';
    return (
        <div className="ex-field--EX ex-groupby--EX">
            <span>{label}</span>
            <div className="ex-groupby-row--EX">
                <select value={isTime ? '__time__' : '__column__'} onChange={(e) => onChange(e.target.value === '__time__' ? { by: '__time__', rule: rule || '1D' } : { by: catalog.categorical[0] || catalog.all[0] })}>
                    <option value="__column__">column</option>
                    {catalog.time && <option value="__time__">time period</option>}
                </select>
                {isTime ? (
                    <select value={rule || '1D'} onChange={(e) => onChange({ by: '__time__', rule: e.target.value })}>
                        {['1h', '4h', '1D', '1W', '1M', '1Q', '1Y'].map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                ) : (
                    <input className="mono--DS" list="dv-columns-list" value={value || ''} spellCheck={false} onChange={(e) => onChange({ by: e.target.value })} />
                )}
            </div>
        </div>
    );
}


/*=====================================================================================*/
/*                                     Helpers                                         */
/*=====================================================================================*/

const fmt = (x, d = 4) => formatNumber(x, d);
const pval = (p) => (p === null || p === undefined ? '—' : p < 0.0001 ? '< 0.0001' : p.toFixed(4));
const CATEGORY_COLORS = PLOT_COLORS.series;
const OTHER_COLOR = 'rgba(224, 224, 224, 0.45)';

function Reading({ children }) {
    return <div className="ex-reading--EX"><b>How to read it</b>{children}</div>;
}

function Figures({ items }) {
    return (
        <div className="ex-figures--EX">
            {items.filter(Boolean).map(([label, value, tone]) => (
                <div key={label} className={`ex-figure--EX ${tone || ''}`}><span>{label}</span><b>{value}</b></div>
            ))}
        </div>
    );
}

function LookaheadNote({ columns }) {
    if (!columns?.length) return null;
    return <div className="ex-lookahead--EX">LOOKAHEAD — {columns.join(', ')} uses following rows (lead): fine as a target to explain, never as an input.</div>;
}

const STAT_ROWS = [
    ['count', 'Count', formatCount], ['missing', 'Missing', formatCount], ['unique', 'Unique', formatCount],
    ['mean', 'Mean', fmt], ['std', 'Std', fmt], ['skew', 'Skewness', v => fmt(v, 2)], ['kurtosis', 'Excess kurtosis', v => fmt(v, 2)],
    ['min', 'Min', fmt], ['p1', '1%', fmt], ['p5', '5%', fmt], ['p25', '25%', fmt], ['median', 'Median', fmt],
    ['p75', '75%', fmt], ['p95', '95%', fmt], ['p99', '99%', fmt], ['max', 'Max', fmt], ['positive', '> 0', v => formatPct(v)],
];

function StatsTable({ columns }) {
    const names = Object.keys(columns);
    return (
        <div className="ex-table-wrapper--EX">
            <table className="ex-table--EX">
                <thead><tr><th />{names.map(n => <th key={n}><code>{n}</code></th>)}</tr></thead>
                <tbody>{STAT_ROWS.map(([key, label, f]) => (
                    <tr key={key}><td>{label}</td>{names.map(n => <td key={n}>{columns[n]?.[key] === undefined ? '—' : f(columns[n][key])}</td>)}</tr>
                ))}</tbody>
            </table>
        </div>
    );
}

// Couleur par categorie : 5 teintes fixes dans l'ordre d'apparition (frequence), le reste en "autres"
function splitByCategory(values) {
    const counts = {};
    values.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, CATEGORY_COLORS.length).map(([k]) => k);
    return { top, colorOf: (v) => (top.includes(String(v)) ? CATEGORY_COLORS[top.indexOf(String(v))] : OTHER_COLOR), label: (v) => (top.includes(String(v)) ? String(v) : 'other') };
}

const xValues = (result) => result.x;
const xType = (result) => (result.x_kind === 'time' ? 'date' : '-');


/*=====================================================================================*/
/*                                    Panel types                                      */
/*=====================================================================================*/

export const PANEL_TYPES = {

    series: {
        label: 'Line chart', icon: '〰', group: 'Explore',
        description: 'Columns plotted along the time axis (or any X), stacked or overlaid.',
        defaults: (c) => ({ columns: c.numeric.slice(0, 2), x: '', mode: 'stack', log: false }),
        Params: ({ params, set }) => (
            <>
                <MultiInput label="Y columns" values={params.columns} onChange={(columns) => set({ columns })} />
                <FormulaInput label="X (empty = time axis / row order)" value={params.x} onChange={(x) => set({ x })} />
                <Select label="Layout" value={params.mode} onChange={(mode) => set({ mode })} options={[{ value: 'stack', label: 'stacked panes' }, { value: 'overlay', label: 'overlaid' }]} />
                <Toggle label="Log scale" value={params.log} onChange={(log) => set({ log })} />
            </>
        ),
        Result: ({ result, params }) => {
            const names = Object.keys(result.columns);
            const x = xValues(result);
            if (params.mode === 'overlay' || names.length === 1) {
                const data = names.map((n, i) => ({ x, y: result.columns[n], type: 'scattergl', mode: 'lines', name: n, line: { color: CATEGORY_COLORS[i % 5], width: 1.4 } }));
                return <><LookaheadNote columns={result.lookahead} /><Plot data={data} layout={{ hovermode: 'x unified', xaxis: { type: xType(result) }, yaxis: { type: params.log ? 'log' : 'linear' } }} height={380} /></>;
            }
            const rows = names.length, gap = 0.03, h = (1 - gap * (rows - 1)) / rows;
            const layout = { hovermode: 'x unified', xaxis: { type: xType(result), anchor: `y${rows}` } };
            const data = names.map((n, i) => {
                const axis = i === 0 ? '' : String(i + 1);
                layout[`yaxis${axis}`] = { domain: [1 - (i + 1) * h - i * gap, 1 - i * h - i * gap], type: params.log ? 'log' : 'linear', title: { text: n.length > 22 ? `${n.slice(0, 20)}…` : n, font: { size: 10 } } };
                return { x, y: result.columns[n], type: 'scattergl', mode: 'lines', name: n, xaxis: 'x', yaxis: `y${axis}`, line: { color: CATEGORY_COLORS[i % 5], width: 1.3 } };
            });
            return <><LookaheadNote columns={result.lookahead} /><Plot data={data} layout={layout} height={Math.max(320, 170 * rows)} /></>;
        },
    },

    stats: {
        label: 'Descriptive statistics', icon: '∑', group: 'Explore',
        description: 'Count, missing, mean, dispersion, shape and percentiles of each column.',
        defaults: (c) => ({ columns: c.numeric.slice(0, 5) }),
        Params: ({ params, set }) => <MultiInput label="Columns" values={params.columns} onChange={(columns) => set({ columns })} max={12} />,
        Result: ({ result }) => (
            <>
                <StatsTable columns={result.stats} />
                <Reading>Skewness ≠ 0 = asymmetric distribution (long tail on one side). Excess kurtosis &gt; 0 = more extreme values than a normal distribution would produce.</Reading>
            </>
        ),
    },

    histogram: {
        label: 'Distribution', icon: '▥', group: 'Distributions',
        description: 'Histogram (density) of one or several columns, optionally split by a category.',
        defaults: (c) => ({ columns: c.numeric.slice(0, 1), group: '', bins: 50, clip: true, normal: false }),
        Params: ({ params, set }) => (
            <>
                <MultiInput label="Columns" values={params.columns} onChange={(columns) => set({ columns })} max={4} />
                <FormulaInput label="Split by (optional category)" value={params.group} onChange={(group) => set({ group })} />
                <NumberInput label="Bins" value={params.bins} min={5} max={300} onChange={(bins) => set({ bins })} />
                <Toggle label="Clip 0.5% tails" value={params.clip} onChange={(clip) => set({ clip })} />
                <Toggle label="Normal fit" value={params.normal} onChange={(normal) => set({ normal })} />
            </>
        ),
        Result: ({ result, params }) => {
            const data = [];
            result.series.forEach((s, i) => {
                const centers = s.edges.slice(0, -1).map((e, k) => (e + s.edges[k + 1]) / 2);
                data.push({ x: centers, y: s.density, type: 'bar', name: s.label, marker: { color: CATEGORY_COLORS[i % 5] }, opacity: result.series.length > 1 ? 0.55 : 0.85 });
                if (params.normal && s.stats.std) {
                    const { mean, std } = s.stats;
                    const xs = Array.from({ length: 120 }, (_, k) => s.edges[0] + (k / 119) * (s.edges[s.edges.length - 1] - s.edges[0]));
                    data.push({ x: xs, y: xs.map(v => Math.exp(-0.5 * ((v - mean) / std) ** 2) / (std * Math.sqrt(2 * Math.PI))), type: 'scatter', mode: 'lines', name: `${s.label} (normal)`, line: { color: CATEGORY_COLORS[i % 5], dash: 'dot', width: 1.5 } });
                }
            });
            return (
                <>
                    <LookaheadNote columns={result.lookahead} />
                    <Plot data={data} layout={{ barmode: 'overlay', bargap: 0.02, yaxis: { title: { text: 'density', font: { size: 10 } } } }} />
                    <StatsTable columns={Object.fromEntries(result.series.map(s => [s.label, s.stats]))} />
                </>
            );
        },
    },

    box: {
        label: 'Box plots', icon: '▯', group: 'Distributions',
        description: 'Median, quartiles and outliers — compare a column across the groups of a category.',
        defaults: (c) => ({ columns: c.numeric.slice(0, 1), group: c.categorical[0] || '' }),
        Params: ({ params, set }) => (
            <>
                <MultiInput label="Columns" values={params.columns} onChange={(columns) => set({ columns })} max={4} />
                <FormulaInput label="Group by (optional)" value={params.group} onChange={(group) => set({ group })} />
            </>
        ),
        Result: ({ result }) => {
            const columns = [...new Set(result.boxes.map(b => b.column))];
            const data = columns.map((col, i) => {
                const boxes = result.boxes.filter(b => b.column === col);
                return {
                    type: 'box', name: col, x: boxes.map(b => b.group ?? col),
                    q1: boxes.map(b => b.q1), median: boxes.map(b => b.median), q3: boxes.map(b => b.q3),
                    lowerfence: boxes.map(b => b.lowerfence), upperfence: boxes.map(b => b.upperfence), mean: boxes.map(b => b.mean),
                    marker: { color: CATEGORY_COLORS[i % 5] }, line: { width: 1.5 }, fillcolor: 'rgba(255,255,255,0.04)',
                };
            });
            return (
                <>
                    <Plot data={data} layout={{ boxmode: 'group', xaxis: { type: 'category' } }} height={380} />
                    <div className="ex-table-wrapper--EX">
                        <table className="ex-table--EX">
                            <thead><tr><th>Column</th><th>Group</th><th>n</th><th>Median</th><th>Mean</th><th>Q1 – Q3</th><th>Outliers</th></tr></thead>
                            <tbody>{result.boxes.map((b, i) => (
                                <tr key={i}><td>{b.column}</td><td>{b.group ?? '—'}</td><td>{formatCount(b.n)}</td><td>{fmt(b.median)}</td><td>{fmt(b.mean)}</td><td>{fmt(b.q1)} – {fmt(b.q3)}</td><td>{formatCount(b.outliers)}</td></tr>
                            ))}</tbody>
                        </table>
                    </div>
                    <Reading>The box spans the middle 50% of values (Q1 to Q3), the line is the median, whiskers reach the last values within 1.5 × the box height; beyond are outliers.</Reading>
                </>
            );
        },
    },

    compare: {
        label: 'Compare two groups', icon: '⇄', group: 'Distributions',
        description: 'Is a column different between two groups? Welch t-test, Kolmogorov-Smirnov, effect size.',
        defaults: (c) => ({ column: c.numeric[0] || '', condition: '', group: c.categorical[0] || '', a: '', b: '', bins: 40 }),
        Params: ({ params, set }) => (
            <>
                <FormulaInput label="Column" value={params.column} onChange={(column) => set({ column })} />
                <FormulaInput label="Split by condition (A = true)" value={params.condition} placeholder="e.g. value > 10" onChange={(condition) => set({ condition })} />
                <FormulaInput label="…or by category column" value={params.group} onChange={(group) => set({ group })} />
                <FormulaInput label="Group A (empty = most frequent)" value={params.a} placeholder="category value" onChange={(a) => set({ a })} />
                <FormulaInput label="Group B" value={params.b} placeholder="category value" onChange={(b) => set({ b })} />
            </>
        ),
        Result: ({ result }) => {
            const centers = result.edges.slice(0, -1).map((e, k) => (e + result.edges[k + 1]) / 2);
            const w = result.welch || {}, ks = result.ks || {};
            const significant = (w.p_value ?? 1) < 0.05 || (ks.p_value ?? 1) < 0.05;
            return (
                <>
                    <Figures items={[
                        ['Mean A − B', fmt(w.mean_diff)],
                        ['Effect size (Cohen d)', fmt(w.cohen_d, 3)],
                        ['Welch t-test p', pval(w.p_value), (w.p_value ?? 1) < 0.05 ? 'good' : ''],
                        ['KS distance', fmt(ks.d, 3)],
                        ['KS p', pval(ks.p_value), (ks.p_value ?? 1) < 0.05 ? 'good' : ''],
                    ]} />
                    <Plot data={result.density.map((d, i) => ({ x: centers, y: d, type: 'bar', name: result.labels[i], marker: { color: CATEGORY_COLORS[i] }, opacity: 0.55 }))}
                        layout={{ barmode: 'overlay', bargap: 0.02 }} />
                    <StatsTable columns={Object.fromEntries(result.labels.map((l, i) => [l, result.stats[i]]))} />
                    <Reading>
                        The t-test checks whether the MEANS differ, Kolmogorov-Smirnov whether the whole DISTRIBUTIONS differ (shape, spread).
                        p &lt; 0.05 = unlikely to be chance. {significant ? 'Here at least one test is significant — ' : ''}
                        Check the effect size too: with many rows a tiny, useless difference can be "significant" (|d| ≈ 0.2 small, 0.5 medium, 0.8 large).
                    </Reading>
                </>
            );
        },
    },

    scatter: {
        label: 'Scatter', icon: '⁘', group: 'Relations',
        description: 'Relation between two columns, colored / sized by others, with the mean of Y along X.',
        defaults: (c) => ({ x: c.numeric[0] || '', y: c.numeric[1] || c.numeric[0] || '', color: '', size: '' }),
        Params: ({ params, set }) => (
            <>
                <FormulaInput label="X" value={params.x} onChange={(x) => set({ x })} />
                <FormulaInput label="Y" value={params.y} onChange={(y) => set({ y })} />
                <FormulaInput label="Color (optional)" value={params.color} onChange={(color) => set({ color })} />
                <FormulaInput label="Size (optional)" value={params.size} onChange={(size) => set({ size })} />
            </>
        ),
        Result: ({ result, params }) => {
            const sizes = result.size ? (() => {
                const v = result.size.filter(s => s !== null);
                const lo = Math.min(...v), hi = Math.max(...v);
                return result.size.map(s => (s === null || hi === lo ? 5 : 3 + 12 * ((s - lo) / (hi - lo))));
            })() : 4;
            let data;
            if (result.color_kind === 'category') {
                const { colorOf, label } = splitByCategory(result.color);
                const groups = {};
                result.x.forEach((x, i) => {
                    const g = label(result.color[i]);
                    (groups[g] ||= { x: [], y: [], s: [], color: colorOf(result.color[i]) });
                    groups[g].x.push(x); groups[g].y.push(result.y[i]); groups[g].s.push(Array.isArray(sizes) ? sizes[i] : sizes);
                });
                data = Object.entries(groups).map(([g, v]) => ({ x: v.x, y: v.y, type: 'scattergl', mode: 'markers', name: g, marker: { color: v.color, size: v.s, opacity: 0.6 } }));
            } else {
                data = [{
                    x: result.x, y: result.y, type: 'scattergl', mode: 'markers', name: 'rows',
                    marker: result.color
                        ? { size: sizes, color: result.color, colorscale: 'Viridis', opacity: 0.6, colorbar: { thickness: 10, title: { text: params.color, font: { size: 10 } } } }
                        : { size: sizes, color: CATEGORY_COLORS[0], opacity: 0.4 },
                }];
            }
            if (result.binned) data.push({ x: result.binned.x, y: result.binned.y, type: 'scatter', mode: 'lines+markers', name: 'mean of Y per X slice', line: { color: PLOT_COLORS.real, width: 3 }, marker: { size: 5 } });
            if (result.fit) {
                const xs = [Math.min(...result.x), Math.max(...result.x)];
                data.push({ x: xs, y: xs.map(v => result.fit.intercept + result.fit.slope * v), type: 'scatter', mode: 'lines', name: 'linear fit', line: { color: 'rgba(255,255,255,0.5)', dash: 'dash', width: 1.5 } });
            }
            return (
                <>
                    <LookaheadNote columns={result.lookahead} />
                    <Figures items={[['Rows', formatCount(result.n)], ['Pearson r', fmt(result.pearson, 4)], ['Spearman ρ', fmt(result.spearman, 4)], result.fit && ['Slope', fmt(result.fit.slope)]]} />
                    <Plot data={data} layout={{ xaxis: { title: { text: params.x, font: { size: 10 } } }, yaxis: { title: { text: params.y, font: { size: 10 } } } }} height={440} />
                    <Reading>Pearson measures a straight-line relation, Spearman any monotonic one (rank-based, robust to outliers). The orange line shows the average Y in each slice of X: it reveals curved relations the numbers miss.</Reading>
                </>
            );
        },
    },

    splom: {
        label: 'Scatter matrix', icon: '⊞', group: 'Relations',
        description: 'Every pair of a few columns at once (pair plot).',
        defaults: (c) => ({ columns: c.numeric.slice(0, 4), color: c.categorical[0] || '' }),
        Params: ({ params, set }) => (
            <>
                <MultiInput label="Columns (2-7)" values={params.columns} onChange={(columns) => set({ columns })} max={7} />
                <FormulaInput label="Color (optional)" value={params.color} onChange={(color) => set({ color })} />
            </>
        ),
        Result: ({ result }) => {
            const names = Object.keys(result.columns);
            const dims = names.map(n => ({ label: n.length > 14 ? `${n.slice(0, 12)}…` : n, values: result.columns[n] }));
            let marker = { size: 3, color: CATEGORY_COLORS[0], opacity: 0.45 };
            if (result.color) {
                const numeric = result.color.every(v => typeof v === 'number' || v === null);
                marker = numeric ? { size: 3, color: result.color, colorscale: 'Viridis', opacity: 0.55 } : { size: 3, color: result.color.map(splitByCategory(result.color).colorOf), opacity: 0.55 };
            }
            return (
                <Plot height={Math.max(420, 150 * names.length)} data={[{ type: 'splom', dimensions: dims, marker, diagonal: { visible: names.length < 3 }, showupperhalf: false }]}
                    layout={{ dragmode: 'select', hovermode: 'closest', margin: { l: 70, r: 20, t: 20, b: 60 }, ...Object.fromEntries(names.flatMap((_, i) => [[`xaxis${i ? i + 1 : ''}`, { gridcolor: PLOT_COLORS.grid, tickfont: { size: 9 } }], [`yaxis${i ? i + 1 : ''}`, { gridcolor: PLOT_COLORS.grid, tickfont: { size: 9 } }]])) }} />
            );
        },
    },

    correlation: {
        label: 'Correlation matrix', icon: '▦', group: 'Relations',
        description: 'All pairwise correlations, reordered so that related columns sit together.',
        defaults: (c) => ({ columns: c.numeric.slice(0, 12), method: 'pearson', cluster: true }),
        Params: ({ params, set }) => (
            <>
                <MultiInput label="Columns" values={params.columns} onChange={(columns) => set({ columns })} max={30} />
                <Select label="Method" value={params.method} onChange={(method) => set({ method })} options={[{ value: 'pearson', label: 'Pearson' }, { value: 'spearman', label: 'Spearman (rank)' }]} />
                <Toggle label="Group related columns" value={params.cluster} onChange={(cluster) => set({ cluster })} />
            </>
        ),
        Result: ({ result }) => {
            const labels = result.columns.map(c => (c.length > 18 ? `${c.slice(0, 16)}…` : c));
            return (
                <>
                    <Plot height={Math.max(340, 38 * labels.length + 110)} data={[{
                        z: result.matrix, x: labels, y: labels, type: 'heatmap', colorscale: DIVERGING, zmin: -1, zmax: 1,
                        text: result.matrix.map(r => r.map(v => (v === null ? '' : v.toFixed(2)))), texttemplate: labels.length <= 16 ? '%{text}' : '', textfont: { size: 10, color: '#fff' },
                        colorbar: { thickness: 10 }, hovertemplate: '%{y} × %{x}: %{z:.3f}<extra></extra>',
                    }]} layout={{ margin: { l: 130, r: 20, t: 10, b: 120 }, xaxis: { type: 'category' }, yaxis: { autorange: 'reversed', type: 'category' } }} />
                    <Reading>Orange = move together, blue = opposite directions. |r| &gt; 0.8 between two columns = they carry the same information. Computed on {formatCount(result.n)} complete rows.</Reading>
                </>
            );
        },
    },

    xcorr: {
        label: 'Lead / lag correlation', icon: '⇆', group: 'Relations',
        description: 'Does X move BEFORE Y? Correlation between X shifted by k rows and Y.',
        defaults: (c) => ({ x: c.numeric[0] || '', y: c.numeric[1] || '', max_lag: 30 }),
        Params: ({ params, set }) => (
            <>
                <FormulaInput label="X" value={params.x} onChange={(x) => set({ x })} />
                <FormulaInput label="Y" value={params.y} onChange={(y) => set({ y })} />
                <NumberInput label="Max lag" value={params.max_lag} min={1} max={500} onChange={(max_lag) => set({ max_lag })} />
            </>
        ),
        Result: ({ result }) => (
            <>
                <Figures items={[['Strongest at lag', result.best_lag], ['Correlation there', fmt(result.best_corr, 3)], ['Rows', formatCount(result.n)]]} />
                <Plot data={[
                    { x: result.lags, y: result.corr, type: 'bar', name: 'corr(X shifted by k, Y)', marker: { color: result.corr.map(v => (v !== null && Math.abs(v) > result.band ? PLOT_COLORS.real : 'rgba(255,127,50,0.3)')) } },
                    { x: result.lags, y: result.lags.map(() => result.band), type: 'scatter', mode: 'lines', name: '95% noise band', line: { color: PLOT_COLORS.null, dash: 'dash', width: 1 } },
                    { x: result.lags, y: result.lags.map(() => -result.band), type: 'scatter', mode: 'lines', showlegend: false, line: { color: PLOT_COLORS.null, dash: 'dash', width: 1 } },
                ]} layout={{ xaxis: { title: { text: 'k (k > 0: X leads Y by k rows)', font: { size: 10 } } } }} />
                <Reading>A peak at k &gt; 0 means past values of X are related to the current Y — X may anticipate Y. Bars inside the dashed band are compatible with no relation.</Reading>
            </>
        ),
    },

    regression: {
        label: 'Linear regression', icon: '⟋', group: 'Relations',
        description: 'Explain Y with several columns at once: coefficients, significance, R².',
        defaults: (c) => ({ y: c.numeric[0] || '', x: c.numeric.slice(1, 3) }),
        Params: ({ params, set }) => (
            <>
                <FormulaInput label="Y (to explain)" value={params.y} onChange={(y) => set({ y })} />
                <MultiInput label="X (explanatory columns)" values={params.x} onChange={(x) => set({ x })} max={20} />
            </>
        ),
        Result: ({ result }) => {
            const s = result.sample;
            const lo = Math.min(...s.actual, ...s.fitted), hi = Math.max(...s.actual, ...s.fitted);
            return (
                <>
                    <Figures items={[['R²', fmt(result.r2, 4)], ['Adjusted R²', fmt(result.adj_r2, 4)], ['RMSE', fmt(result.rmse)], ['Rows', formatCount(result.n)], result.residual_acf1 !== null && result.residual_acf1 !== undefined && ['Residual autocorr.', fmt(result.residual_acf1, 3), Math.abs(result.residual_acf1) > 0.3 ? 'bad' : '']]} />
                    <div className="ex-table-wrapper--EX">
                        <table className="ex-table--EX">
                            <thead><tr><th>Term</th><th>Coefficient</th><th>Std error</th><th>t</th><th>p-value</th><th>Standardized</th></tr></thead>
                            <tbody>{result.coefficients.map(c => (
                                <tr key={c.name}><td><code>{c.name}</code></td><td>{fmt(c.coef)}</td><td>{fmt(c.se)}</td><td>{fmt(c.t, 2)}</td>
                                    <td className={c.p_value !== null && c.p_value < 0.05 ? 'good' : ''}>{pval(c.p_value)}</td><td>{fmt(c.standardized, 3)}</td></tr>
                            ))}</tbody>
                        </table>
                    </div>
                    <div className="ex-grid-2--EX">
                        <Plot height={300} data={[
                            { x: s.fitted, y: s.actual, type: 'scattergl', mode: 'markers', name: 'rows', marker: { size: 3, color: CATEGORY_COLORS[0], opacity: 0.45 } },
                            { x: [lo, hi], y: [lo, hi], type: 'scatter', mode: 'lines', name: 'perfect fit', line: { color: PLOT_COLORS.null, dash: 'dash' } },
                        ]} layout={{ title: { text: 'Actual vs predicted', font: { size: 11 } }, margin: { l: 50, r: 10, t: 34, b: 40 }, showlegend: false }} />
                        <Plot height={300} data={[{ x: result.residual_hist.edges.slice(0, -1), y: result.residual_hist.counts, type: 'bar', marker: { color: PLOT_COLORS.real }, opacity: 0.8 }]}
                            layout={{ title: { text: 'Residuals', font: { size: 11 } }, margin: { l: 50, r: 10, t: 34, b: 40 }, showlegend: false }} />
                    </div>
                    <Reading>R² = share of Y's variance explained. p &lt; 0.05 = the column adds information given the others. "Standardized" compares columns of different units (effect of 1 std of X, in std of Y). With time-ordered data, autocorrelated residuals make p-values optimistic.</Reading>
                </>
            );
        },
    },

    pca: {
        label: 'PCA', icon: '◎', group: 'Relations',
        description: 'Principal components: the few directions that summarize most of the variation of many columns.',
        defaults: (c) => ({ columns: c.numeric.slice(0, 8), color: c.categorical[0] || '' }),
        Params: ({ params, set }) => (
            <>
                <MultiInput label="Columns" values={params.columns} onChange={(columns) => set({ columns })} max={40} />
                <FormulaInput label="Color points by (optional)" value={params.color} onChange={(color) => set({ color })} />
            </>
        ),
        Result: ({ result }) => {
            const cumulative = result.explained.reduce((acc, v) => [...acc, (acc.at(-1) || 0) + v], []);
            let marker = { size: 4, color: CATEGORY_COLORS[0], opacity: 0.45 };
            if (result.color) {
                const numeric = result.color.every(v => typeof v === 'number' || v === null);
                marker = numeric ? { size: 4, color: result.color, colorscale: 'Viridis', opacity: 0.6, colorbar: { thickness: 10 } } : { size: 4, color: result.color.map(splitByCategory(result.color).colorOf), opacity: 0.6 };
            }
            return (
                <>
                    <div className="ex-grid-2--EX">
                        <Plot height={300} data={[
                            { x: result.explained.map((_, i) => `PC${i + 1}`), y: result.explained, type: 'bar', name: 'explained', marker: { color: PLOT_COLORS.real } },
                            { x: result.explained.map((_, i) => `PC${i + 1}`), y: cumulative, type: 'scatter', mode: 'lines+markers', name: 'cumulative', line: { color: CATEGORY_COLORS[0] } },
                        ]} layout={{ title: { text: 'Variance explained', font: { size: 11 } }, yaxis: { tickformat: '.0%' }, xaxis: { type: 'category' }, margin: { l: 50, r: 10, t: 34, b: 40 } }} />
                        <Plot height={300} data={[{ x: result.pc1, y: result.pc2, type: 'scattergl', mode: 'markers', marker }]}
                            layout={{ title: { text: 'Rows projected on PC1 / PC2', font: { size: 11 } }, xaxis: { title: { text: 'PC1', font: { size: 10 } } }, yaxis: { title: { text: 'PC2', font: { size: 10 } } }, margin: { l: 50, r: 10, t: 34, b: 40 }, showlegend: false }} />
                    </div>
                    <Plot height={Math.max(220, 26 * result.columns.length + 60)} data={[{
                        z: result.columns.map((_, j) => result.loadings.map(l => l[j])), x: result.loadings.map((_, i) => `PC${i + 1}`), y: result.columns,
                        type: 'heatmap', colorscale: DIVERGING, zmid: 0, colorbar: { thickness: 10 },
                        text: result.columns.map((_, j) => result.loadings.map(l => l[j].toFixed(2))), texttemplate: '%{text}', textfont: { size: 10, color: '#fff' },
                    }]} layout={{ title: { text: 'Loadings (contribution of each column)', font: { size: 11 } }, margin: { l: 140, r: 20, t: 34, b: 30 }, xaxis: { type: 'category' }, yaxis: { type: 'category', autorange: 'reversed' } }} />
                    <Reading>If 2-3 components explain most of the variance, your columns are largely redundant. The loadings show which columns drive each component.</Reading>
                </>
            );
        },
    },

    groupby: {
        label: 'Group & aggregate', icon: '▤', group: 'Groups',
        description: 'Aggregate columns per category, per numeric bin or per time period (mean, sum, count…).',
        defaults: (c) => ({ by: c.categorical[0] || (c.time ? '__time__' : c.numeric[0] || ''), rule: '1D', values: c.numeric.slice(0, 1), agg: 'mean', chart: 'bar', sort: 'count' }),
        Params: ({ params, set, catalog }) => (
            <>
                <GroupByInput label="Group by" value={params.by} rule={params.rule} catalog={catalog} onChange={(patch) => set(patch)} />
                <MultiInput label="Values" values={params.values} onChange={(values) => set({ values })} max={6} />
                <Select label="Aggregation" value={params.agg} onChange={(agg) => set({ agg })} options={['mean', 'sum', 'median', 'min', 'max', 'std', 'count']} />
                <Select label="Chart" value={params.chart} onChange={(chart) => set({ chart })} options={['bar', 'line']} />
                <Select label="Order" value={params.sort} onChange={(sort) => set({ sort })} options={[{ value: 'count', label: 'by size' }, { value: 'value', label: 'by value' }, { value: 'name', label: 'by name' }]} />
            </>
        ),
        Result: ({ result, params }) => {
            const names = Object.keys(result.values);
            const isTime = result.kind === 'time';
            const data = names.map((n, i) => ({
                x: result.keys, y: result.values[n], name: `${result.agg}(${n})`,
                type: params.chart === 'line' || isTime ? 'scatter' : 'bar', mode: 'lines+markers',
                marker: { color: CATEGORY_COLORS[i % 5], size: 4 }, line: { color: CATEGORY_COLORS[i % 5], width: 2 },
                customdata: result.counts, hovertemplate: '%{x}<br>%{y:.4g}<br>%{customdata} rows<extra></extra>',
            }));
            return (
                <>
                    <Plot data={data} layout={{ barmode: 'group', xaxis: { type: isTime ? 'date' : 'category' } }} height={380} />
                    <Reading>Each {isTime ? 'period' : 'group'} shows the {result.agg} of the values over its rows (hover for the number of rows). Groups with few rows are noisy.</Reading>
                </>
            );
        },
    },

    pivot: {
        label: 'Pivot heatmap', icon: '▩', group: 'Groups',
        description: 'Aggregate a value over two dimensions (two categories, numeric bins, or time parts like hour()).',
        // a defaut de 2 categories : parties de l'axe temporel, sinon colonnes numeriques decoupees en tranches
        defaults: (c) => ({
            rows: c.categorical[0] || (c.time ? 'weekday()' : c.numeric[0] || ''),
            cols: c.categorical[1] || (c.time ? 'hour()' : c.numeric.find(n => n !== c.numeric[0]) || c.numeric[0] || ''),
            value: c.numeric[c.numeric.length > 2 ? 2 : 0] || '', agg: 'mean',
        }),
        Params: ({ params, set }) => (
            <>
                <FormulaInput label="Rows" value={params.rows} onChange={(rows) => set({ rows })} />
                <FormulaInput label="Columns" value={params.cols} onChange={(cols) => set({ cols })} />
                <FormulaInput label="Value (empty = count rows)" value={params.value} onChange={(value) => set({ value })} />
                <Select label="Aggregation" value={params.agg} onChange={(agg) => set({ agg })} options={['mean', 'sum', 'median', 'min', 'max', 'std', 'count']} />
            </>
        ),
        Result: ({ result }) => {
            const flat = result.matrix.flat().filter(v => v !== null);
            const diverging = flat.length && Math.min(...flat) < 0 && Math.max(...flat) > 0;
            const bound = flat.length ? Math.max(...flat.map(Math.abs)) : 1;
            return (
                <Plot height={Math.max(300, 30 * result.rows.length + 120)} data={[{
                    z: result.matrix, x: result.cols.map(String), y: result.rows.map(String), type: 'heatmap',
                    colorscale: diverging ? DIVERGING : SEQUENTIAL, zmin: diverging ? -bound : undefined, zmax: diverging ? bound : undefined,
                    customdata: result.counts, hovertemplate: '%{y} × %{x}<br>%{z:.4g}<br>%{customdata} rows<extra></extra>', colorbar: { thickness: 10 },
                }]} layout={{ xaxis: { type: 'category' }, yaxis: { type: 'category', autorange: 'reversed' }, margin: { l: 110, r: 20, t: 10, b: 80 } }} />
            );
        },
    },

    time_heatmap: {
        label: 'Calendar heatmap', icon: '◷', group: 'Time',
        description: 'Average of a column by two parts of the time axis (weekday × hour, year × month…). Needs a time axis.',
        needsTime: true,
        defaults: (c) => ({ column: c.numeric[0] || '', rows: 'weekday', cols: 'hour', agg: 'mean' }),
        Params: ({ params, set }) => {
            const parts = ['hour', 'weekday', 'day', 'month', 'quarter', 'year', 'minute'];
            return (
                <>
                    <FormulaInput label="Column" value={params.column} onChange={(column) => set({ column })} />
                    <Select label="Rows" value={params.rows} onChange={(rows) => set({ rows })} options={parts} />
                    <Select label="Columns" value={params.cols} onChange={(cols) => set({ cols })} options={parts} />
                    <Select label="Aggregation" value={params.agg} onChange={(agg) => set({ agg })} options={['mean', 'median', 'sum', 'std', 'count']} />
                </>
            );
        },
        Result: ({ result }) => {
            const names = { weekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], month: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] };
            const label = (part, v) => (part === 'weekday' ? names.weekday[v] : part === 'month' ? names.month[v - 1] : part === 'hour' ? `${v}h` : String(v));
            const flat = result.matrix.flat().filter(v => v !== null);
            const diverging = flat.length && Math.min(...flat) < 0 && Math.max(...flat) > 0;
            const bound = flat.length ? Math.max(...flat.map(Math.abs)) : 1;
            return (
                <>
                    <Plot height={Math.max(280, 34 * result.rows.length + 90)} data={[{
                        z: result.matrix, x: result.cols.map(v => label(result.cols_part, v)), y: result.rows.map(v => label(result.rows_part, v)), type: 'heatmap',
                        colorscale: diverging ? DIVERGING : SEQUENTIAL, zmin: diverging ? -bound : undefined, zmax: diverging ? bound : undefined,
                        customdata: result.counts, hovertemplate: '%{y} · %{x}<br>%{z:.4g}<br>%{customdata} rows<extra></extra>', colorbar: { thickness: 10 },
                    }]} layout={{ xaxis: { type: 'category' }, yaxis: { type: 'category', autorange: 'reversed' }, margin: { l: 60, r: 20, t: 10, b: 40 } }} />
                    <Reading>Times are in UTC as stored in the file. Use it to spot daily / weekly / seasonal cycles.</Reading>
                </>
            );
        },
    },

    acf: {
        label: 'Autocorrelation', icon: '⟲', group: 'Time',
        description: 'Correlation of a column with its own past (ACF) and the direct effect of each lag (PACF).',
        defaults: (c) => ({ column: c.numeric[0] || '', max_lag: 40 }),
        Params: ({ params, set }) => (
            <>
                <FormulaInput label="Column" value={params.column} onChange={(column) => set({ column })} />
                <NumberInput label="Max lag" value={params.max_lag} min={2} max={1000} onChange={(max_lag) => set({ max_lag })} />
            </>
        ),
        Result: ({ result }) => {
            const bars = (values, color, name, yaxis) => ({ x: result.lags, y: values, type: 'bar', name, yaxis, marker: { color: values.map(v => (v !== null && Math.abs(v) > result.band ? color : 'rgba(255,255,255,0.18)')) } });
            const band = (axis) => [result.band, -result.band].map(b => ({ x: result.lags, y: result.lags.map(() => b), type: 'scatter', mode: 'lines', showlegend: false, yaxis: axis, line: { color: PLOT_COLORS.null, dash: 'dash', width: 1 } }));
            return (
                <>
                    <Plot height={420} data={[bars(result.acf, PLOT_COLORS.real, 'ACF', 'y'), ...band('y'), bars(result.pacf, CATEGORY_COLORS[0], 'PACF', 'y2'), ...band('y2')]}
                        layout={{ yaxis: { domain: [0.55, 1], title: { text: 'ACF', font: { size: 10 } } }, yaxis2: { domain: [0, 0.45], title: { text: 'PACF', font: { size: 10 } } }, xaxis: { anchor: 'y2', title: { text: 'lag (rows)', font: { size: 10 } } } }} />
                    <Reading>Bars outside the dashed band are significant. A slowly decaying ACF = strong persistence (trend, level series — try diff(x)). Peaks at a fixed lag = a cycle (e.g. 24 for hourly data with a daily pattern). The PACF shows how many lags directly matter.</Reading>
                </>
            );
        },
    },

    binned: {
        label: 'Conditional mean (deciles)', icon: '▤', group: 'Predictive',
        description: 'Split X into quantiles and look at the average of Y in each — with a permutation test and stability over time.',
        defaults: (c) => ({ x: c.numeric[0] || '', y: c.numeric[1] ? (c.time ? `lead(${c.numeric[1]}, 1) - ${c.numeric[1]}` : c.numeric[1]) : '', buckets: 10, block: 1 }),
        Params: ({ params, set }) => (
            <>
                <FormulaInput label="X (condition)" value={params.x} onChange={(x) => set({ x })} />
                <FormulaInput label="Y (outcome — can be future: lead(y, n) - y)" value={params.y} onChange={(y) => set({ y })} wide />
                <NumberInput label="Buckets" value={params.buckets} min={2} max={30} onChange={(buckets) => set({ buckets })} />
                <NumberInput label="Permutation block" value={params.block} min={1} max={5000} onChange={(block) => set({ block })} />
            </>
        ),
        Result: ({ result }) => {
            const b = result.buckets;
            const significant = result.p_value < 0.05;
            const periods = Object.entries(result.stability || {});
            return (
                <>
                    {result.lookahead_y && <div className="ex-lookahead--EX ok">Y uses following rows: this measures how well X anticipates the future of Y.</div>}
                    <Figures items={[
                        ['Rank correlation', fmt(result.ic, 4)],
                        ['Top − bottom', fmt(result.spread), significant ? 'good' : ''],
                        ['p-value vs random', pval(result.p_value), significant ? 'good' : 'bad'],
                        ['Random 90% band', `${fmt(result.null_spread.p5)} … ${fmt(result.null_spread.p95)}`],
                    ]} />
                    <Plot data={[
                        {
                            x: b.map(r => `Q${r.bucket}`), y: b.map(r => r.mean), type: 'bar', name: 'mean of Y',
                            marker: { color: b.map(r => (r.mean >= result.baseline ? PLOT_COLORS.up : PLOT_COLORS.down)) },
                            error_y: { type: 'data', array: b.map(r => (r.std ? 1.96 * r.std / Math.sqrt(r.count) : 0)), color: 'rgba(255,255,255,0.4)', thickness: 1 },
                            customdata: b.map(r => [r.x_min, r.x_max, r.count]), hovertemplate: 'X in [%{customdata[0]:.4g}, %{customdata[1]:.4g}]<br>mean Y %{y:.4g}<br>%{customdata[2]} rows<extra></extra>',
                        },
                        { x: b.map(r => `Q${r.bucket}`), y: b.map(() => result.baseline), type: 'scatter', mode: 'lines', name: 'overall mean', line: { color: PLOT_COLORS.null, dash: 'dash', width: 1 } },
                    ]} layout={{ xaxis: { type: 'category', title: { text: 'X quantile (low → high)', font: { size: 10 } } } }} />
                    <div className="ex-grid-2--EX">
                        <div className="ex-table-wrapper--EX">
                            <table className="ex-table--EX">
                                <thead><tr><th>Q</th><th>X range</th><th>Rows</th><th>Mean Y</th><th>Y &gt; 0</th><th>t</th></tr></thead>
                                <tbody>{b.map(r => (
                                    <tr key={r.bucket}><td>Q{r.bucket}</td><td>{fmt(r.x_min, 3)} … {fmt(r.x_max, 3)}</td><td>{formatCount(r.count)}</td><td>{fmt(r.mean)}</td><td>{formatPct(r.positive)}</td><td className={Math.abs(r.t_stat || 0) > 2 ? 'strong' : ''}>{fmt(r.t_stat, 2)}</td></tr>
                                ))}</tbody>
                            </table>
                        </div>
                        <Plot height={260} data={[{ x: periods.map(([k]) => k), y: periods.map(([, v]) => v), type: 'bar', marker: { color: periods.map(([, v]) => (v >= 0 ? PLOT_COLORS.up : PLOT_COLORS.down)) } }]}
                            layout={{ title: { text: 'Rank correlation per period (stability)', font: { size: 11 } }, xaxis: { type: 'category' }, margin: { l: 50, r: 10, t: 34, b: 50 }, showlegend: false }} />
                    </div>
                    <Reading>
                        A real effect shows a regular staircase from Q1 to the last bucket, a spread outside the random band (p &lt; 0.05) and the same sign in every period.
                        For time-ordered rows, set the permutation block to roughly the horizon of Y (e.g. 12 for lead(y, 12)) so autocorrelation does not fake significance.
                    </Reading>
                </>
            );
        },
    },

    event_study: {
        label: 'Event study', icon: '⚑', group: 'Predictive',
        description: 'Each time a condition becomes true, how does a column evolve before and after? Compared with random rows.',
        defaults: (c) => ({ condition: c.numeric[0] ? `crossup(${c.numeric[0]}, mean(${c.numeric[0]}, 50))` : '', value: c.numeric[0] || '', mode: 'diff', horizon: 20, lookback: 10, gap: 20 }),
        Params: ({ params, set }) => (
            <>
                <FormulaInput label="Condition (event)" value={params.condition} onChange={(condition) => set({ condition })} wide />
                <FormulaInput label="Track column" value={params.value} onChange={(value) => set({ value })} />
                <Select label="Change as" value={params.mode} onChange={(mode) => set({ mode })} options={[{ value: 'diff', label: 'difference' }, { value: 'ratio', label: '% change' }]} />
                <NumberInput label="Rows after" value={params.horizon} min={1} max={2000} onChange={(horizon) => set({ horizon })} />
                <NumberInput label="Rows before" value={params.lookback} min={0} max={2000} onChange={(lookback) => set({ lookback })} />
                <NumberInput label="Min gap" value={params.gap} min={1} max={10000} onChange={(gap) => set({ gap })} />
            </>
        ),
        Result: ({ result }) => {
            const x = result.offsets;
            const band = (lo, hi, color, name) => [
                { x, y: hi, type: 'scatter', mode: 'lines', line: { width: 0 }, showlegend: false, hoverinfo: 'skip' },
                { x, y: lo, type: 'scatter', mode: 'lines', line: { width: 0 }, fill: 'tonexty', fillcolor: color, name, hoverinfo: 'skip' },
            ];
            const f = result.final;
            const tick = result.mode === 'ratio' ? '.1%' : undefined;
            return (
                <>
                    <Figures items={[
                        ['Events', formatCount(result.count)],
                        ['Mean change at end', result.mode === 'ratio' ? formatPct(f.mean, 2) : fmt(f.mean), f.p_value < 0.05 ? 'good' : ''],
                        ['Median at end', result.mode === 'ratio' ? formatPct(f.median, 2) : fmt(f.median)],
                        ['Positive at end', formatPct(f.positive)],
                        ['p-value vs random', pval(f.p_value), f.p_value < 0.05 ? 'good' : 'bad'],
                    ]} />
                    <Plot height={380} data={[
                        ...band(result.q10, result.q90, 'rgba(255,127,50,0.08)', '10-90% of events'),
                        ...band(result.q25, result.q75, 'rgba(255,127,50,0.16)', '25-75% of events'),
                        ...band(result.null_p5, result.null_p95, 'rgba(224,224,224,0.12)', 'random rows (90% band)'),
                        { x, y: result.null_mean, type: 'scatter', mode: 'lines', name: 'random rows mean', line: { color: PLOT_COLORS.null, dash: 'dot', width: 1.5 } },
                        { x, y: result.median, type: 'scatter', mode: 'lines', name: 'median', line: { color: PLOT_COLORS.real, dash: 'dash', width: 1.5 } },
                        { x, y: result.mean, type: 'scatter', mode: 'lines', name: 'mean', line: { color: PLOT_COLORS.real, width: 3 } },
                    ]} layout={{ yaxis: { tickformat: tick, title: { text: 'change vs event row', font: { size: 10 } } }, xaxis: { title: { text: 'rows from event', font: { size: 10 } } }, shapes: [{ type: 'line', x0: 0, x1: 0, yref: 'paper', y0: 0, y1: 1, line: { color: 'rgba(255,255,255,0.35)', dash: 'dot' } }] }} />
                    <Reading>The thick line is the average path around the event (row 0). It only means something if it leaves the grey band, built from the same number of random rows.</Reading>
                </>
            );
        },
    },

    runs: {
        label: 'Runs & durations', icon: '⏳', group: 'Predictive',
        description: 'Split the series where a score changes sign, then study how long each run lasts (survival analysis).',
        defaults: (c) => ({ column: c.numeric[0] ? `${c.numeric[0]} - mean(${c.numeric[0]}, 50)` : '', threshold: 0, amplitude: c.numeric[0] || '', null_mode: 'rows', max_duration: 0 }),
        Params: ({ params, set }) => (
            <>
                <FormulaInput label="Score (sign = state)" value={params.column} onChange={(column) => set({ column })} wide />
                <NumberInput label="Dead zone ±" value={params.threshold} step={0.0001} min={0} onChange={(threshold) => set({ threshold })} />
                <FormulaInput label="Amplitude column (optional)" value={params.amplitude} onChange={(amplitude) => set({ amplitude })} />
                <Select label="Random baseline" value={params.null_mode} onChange={(null_mode) => set({ null_mode })} options={[{ value: 'rows', label: 'shuffle rows' }, { value: 'increments', label: 'shuffle increments (level series)' }]} />
                <NumberInput label="Max duration (0 = auto)" value={params.max_duration} min={0} onChange={(max_duration) => set({ max_duration })} />
            </>
        ),
        Result: ({ result }) => {
            const r = result.real, n = result.null;
            const line = (s, key, color, dash, name) => (s.count ? { x: s.t, y: s[key], type: 'scatter', mode: 'lines', name, line: { color, dash, width: dash ? 1.5 : 2.2 } } : null);
            const curves = (key) => [line(r.up, key, PLOT_COLORS.up, null, 'positive runs'), line(n.up, key, PLOT_COLORS.up, 'dot', 'positive (random)'), line(r.down, key, PLOT_COLORS.down, null, 'negative runs'), line(n.down, key, PLOT_COLORS.down, 'dot', 'negative (random)')].filter(Boolean);
            const rows = [['Runs', s => formatCount(s.count)], ['Mean length', s => fmt(s.mean, 1)], ['Median', s => s.median], ['Std', s => fmt(s.std, 1)], ['75% / 90% shorter than', s => `${s.p75} / ${s.p90}`], ['Longest', s => s.max], ['Mean amplitude', s => fmt(s.mean_amplitude)]];
            const cur = result.current;
            const curStats = cur ? r[cur.direction] : null;
            return (
                <>
                    {cur && curStats?.count > 0 && (
                        <Figures items={[
                            ['Current run', cur.direction === 'up' ? '▲ positive' : '▼ negative', cur.direction === 'up' ? 'good' : 'bad'],
                            ['Length so far', `${cur.duration} rows`],
                            ['Runs that got this long', formatPct(curStats.survival[Math.min(cur.duration, curStats.t.length) - 1])],
                            ['Expected rows left', fmt(curStats.remaining[Math.min(cur.duration, curStats.t.length) - 1], 1)],
                        ]} />
                    )}
                    <div className="ex-table-wrapper--EX">
                        <table className="ex-table--EX">
                            <thead><tr><th /><th>Positive</th><th>Positive (random)</th><th>Negative</th><th>Negative (random)</th></tr></thead>
                            <tbody>{rows.map(([label, f]) => (
                                <tr key={label}><td>{label}</td>{[r.up, n.up, r.down, n.down].map((s, i) => <td key={i}>{s.count ? f(s) : '—'}</td>)}</tr>
                            ))}</tbody>
                        </table>
                    </div>
                    <div className="ex-grid-2--EX">
                        <Plot height={270} data={[r.up, r.down].map((s, i) => (s.count ? { x: s.t, y: s.hist, type: 'bar', name: i ? 'negative' : 'positive', marker: { color: i ? PLOT_COLORS.down : PLOT_COLORS.up }, opacity: 0.65 } : null)).filter(Boolean)}
                            layout={{ barmode: 'overlay', title: { text: 'Length distribution (rows)', font: { size: 11 } }, margin: { l: 50, r: 10, t: 34, b: 30 } }} />
                        <Plot height={270} data={curves('survival')} layout={{ title: { text: 'Survival: share of runs longer than t', font: { size: 11 } }, yaxis: { type: 'log', tickformat: '.0%' }, margin: { l: 56, r: 10, t: 34, b: 30 } }} />
                        <Plot height={270} data={curves('hazard')} layout={{ title: { text: 'Ending rate at t, given it lasted until t', font: { size: 11 } }, yaxis: { tickformat: '.0%' }, margin: { l: 56, r: 10, t: 34, b: 30 } }} />
                        <Plot height={270} data={curves('remaining')} layout={{ title: { text: 'Expected rows left, given length t', font: { size: 11 } }, margin: { l: 50, r: 10, t: 34, b: 30 } }} />
                    </div>
                    <Reading>Dotted curves = the same score on a shuffled version of the data. Runs lasting longer than random = persistence you can rely on; shorter = the series tends to revert. A rolling-window score always creates some persistence by construction — only the gap with random counts.</Reading>
                </>
            );
        },
    },

    missing: {
        label: 'Missing values map', icon: '░', group: 'Explore',
        description: 'Where the missing values are, column by column, along the rows.',
        defaults: () => ({ bins: 60 }),
        Params: ({ params, set }) => <NumberInput label="Row bins" value={params.bins} min={5} max={300} onChange={(bins) => set({ bins })} />,
        Result: ({ result }) => (
            <>
                <Plot height={Math.max(240, 24 * result.columns.length + 80)} data={[{
                    z: result.matrix, x: result.labels.map((l, i) => (typeof l === 'string' && l.includes('T') ? formatDate(l, false) : `bin ${i + 1}`)), y: result.columns,
                    type: 'heatmap', colorscale: [[0, '#1b1b22'], [1, '#ef5350']], zmin: 0, zmax: 1, colorbar: { thickness: 10, tickformat: '.0%' },
                    hovertemplate: '%{y} · %{x}<br>%{z:.1%} missing<extra></extra>',
                }]} layout={{ xaxis: { type: 'category', showticklabels: true, tickfont: { size: 9 } }, yaxis: { type: 'category', autorange: 'reversed' }, margin: { l: 140, r: 20, t: 10, b: 70 } }} />
                <Reading>Red = share of missing values in each slice of rows. Missing values grouped in time often mean an acquisition problem rather than random gaps.</Reading>
            </>
        ),
    },
};

export const PANEL_GROUPS = ['Explore', 'Distributions', 'Relations', 'Groups', 'Time', 'Predictive'];
