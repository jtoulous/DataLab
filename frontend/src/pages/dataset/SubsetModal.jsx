import React, { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";

import { apiRequests } from '../../services/api_requests.js';
import { formatCount, formatDate } from '../../services/format.js';
import { AppLoader, CloseIcon } from '../../components/Utils.jsx';
import { ColumnInput } from '../../components/ColumnInput.jsx';
import Plot from '../../components/Plot.jsx';
import { PLOT_COLORS } from '../../components/plotTheme.js';

import "./SubsetModal.css";


const pad = (n) => String(n).padStart(2, '0');
// ms UTC -> 'YYYY-MM-DD HH:MM' (coordonnee d'axe Plotly ; toutes les dates de l'appli sont en UTC)
const toAxis = (ms) => {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};
// saisie europeenne 'dd-mm-yyyy hh:mm' <-> ms UTC
const toText = (ms) => {
    if (ms === null || ms === undefined) return '';
    const d = new Date(ms);
    return `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};
const DATE_TEXT = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[ T]+(\d{1,2})(?::(\d{2}))?)?$/;
const fromText = (text) => {
    const t = text.trim();
    if (!t) return null;
    const m = t.match(DATE_TEXT);
    if (!m) return undefined;
    const [, dd, mm, yyyy, hh = '0', mi = '0'] = m;
    const ms = Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(mi));
    return Number.isNaN(ms) ? undefined : ms;
};

// Champ date jj-mm-aaaa hh:mm : valide a la sortie du champ / Entree, revient a la valeur precedente si illisible
function DateField({ value, onChange }) {
    const [draft, setDraft] = useState(toText(value));
    const [bad, setBad] = useState(false);
    useEffect(() => { setDraft(toText(value)); setBad(false); }, [value]);
    const commit = () => {
        const ms = fromText(draft);
        if (ms === undefined) { setBad(true); return; }
        setBad(false);
        if (ms !== value) onChange(ms);
    };
    return (
        <input className={bad ? 'bad' : ''} value={draft} placeholder="dd-mm-yyyy hh:mm" spellCheck={false}
            onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
    );
}

const newId = () => Math.random().toString(36).slice(2, 9);


// Creation d'un sous-dataset : periodes tracees a la souris sur un graphe ou saisies par dates,
// a garder ou a retirer, eventuellement restreintes par une condition. Le resultat est un dataset
// a part entiere (ses colonnes, ses analyses, ses modeles).
function SubsetModal({ dataset, catalog, onClose }) {
    const navigate = useNavigate();
    const time = !!dataset.profile.time;
    const [visible, setVisible] = useState(false);
    const [column, setColumn] = useState(catalog.numeric.find(c => c === 'close') || catalog.numeric[0] || '');
    const [series, setSeries] = useState(null);
    const [seriesError, setSeriesError] = useState(null);
    const [selecting, setSelecting] = useState(true);
    const [ranges, setRanges] = useState([]);
    const [mode, setMode] = useState('include');
    const [condition, setCondition] = useState('');
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [preview, setPreview] = useState(null);
    const [previewError, setPreviewError] = useState(null);
    const [creating, setCreating] = useState(false);
    const [createError, setCreateError] = useState(null);

    useEffect(() => { requestAnimationFrame(() => setVisible(true)); }, []);
    const close = () => { setVisible(false); setTimeout(onClose, 300); };

    // courbe de reference sur tout le dataset (sans la vue courante)
    useEffect(() => {
        if (!column) return;
        setSeriesError(null);
        const timer = setTimeout(() => {
            apiRequests.analyze(dataset.dataset_id, 'series', { columns: [column], x: '' }, {})
                .then(setSeries)
                .catch(err => { setSeries(null); setSeriesError(err.message); });
        }, 300);
        return () => clearTimeout(timer);
    }, [column, dataset.dataset_id]);

    const spec = useMemo(() => ({
        ranges: ranges.filter(r => r.start !== null || r.end !== null).map(({ start, end }) => ({ start, end })),
        mode, condition: condition.trim(),
    }), [ranges, mode, condition]);
    const specKey = JSON.stringify(spec);
    const empty = !spec.ranges.length && !spec.condition;

    useEffect(() => {
        if (empty) { setPreview(null); setPreviewError(null); return; }
        const timer = setTimeout(() => {
            apiRequests.previewSubset(dataset.dataset_id, spec)
                .then(p => { setPreview(p); setPreviewError(null); })
                .catch(err => { setPreview(null); setPreviewError(err.message); });
        }, 400);
        return () => clearTimeout(timer);
    }, [specKey, dataset.dataset_id]);

    const addRange = (start, end) => setRanges(prev => [...prev, { id: newId(), start, end }]);
    const updateRange = (id, patch) => setRanges(prev => prev.map(r => (r.id === id ? { ...r, ...patch } : r)));

    const create = () => {
        setCreating(true);
        setCreateError(null);
        apiRequests.createSubset(dataset.dataset_id, name.trim() || `${dataset.name} · subset`, spec, description)
            .then(record => { onClose(); navigate(`/dataset?id=${record.dataset_id}`); })
            .catch(err => setCreateError(err.message))
            .finally(() => setCreating(false));
    };

    const plotData = useMemo(() => (series ? [{
        x: series.x, y: series.columns[Object.keys(series.columns)[0]], type: 'scattergl', mode: 'lines',
        name: column, line: { color: PLOT_COLORS.series[0], width: 1.2 },
    }] : null), [series, column]);
    const plotLayout = useMemo(() => ({
        xaxis: { type: time ? 'date' : '-' }, hovermode: 'x', showlegend: false, selectdirection: 'h', margin: { l: 56, r: 18, t: 10, b: 36 },
    }), [time]);

    const keep = mode === 'include';
    const color = keep ? '38, 166, 154' : '239, 83, 80';
    const axis = (v) => (time ? toAxis(v) : v);
    const shapes = ranges.filter(r => r.start !== null || r.end !== null).map(r => ({
        type: 'rect', xref: 'x', yref: 'paper', y0: 0, y1: 1, layer: 'below', line: { width: 1, color: `rgba(${color}, 0.6)` },
        fillcolor: `rgba(${color}, 0.16)`,
        x0: r.start !== null ? axis(r.start) : (time ? axis(dataset.profile.time.start) : 0),
        x1: r.end !== null ? axis(r.end) : (time ? axis(dataset.profile.time.end) : dataset.profile.rows - 1),
    }));
    const live = { shapes, dragmode: selecting ? 'select' : 'pan' };

    const inherited = [
        ...Object.keys(dataset.origin?.inherited || {}),
        ...Object.keys(dataset.derived_columns || {}),
    ];
    const fmtBound = (v) => (v === null || v === undefined ? '—' : time ? formatDate(v) : `row ${formatCount(v)}`);

    return (
        <div className={`settings-backdrop ${visible ? 'visible' : ''}`} onClick={(e) => e.target === e.currentTarget && close()}>
            <div className={`settings-modal subset-modal--SB ${visible ? 'visible' : ''}`}>
                <div className="settings-header">
                    <h2>New subset <span className="subset-of--SB">of {dataset.name}</span></h2>
                    <button className="settings-close-btn" onClick={close}><CloseIcon /></button>
                </div>

                <div className="subset-body--SB">
                    {/* ── Graphe : glisser pour tracer une periode ── */}
                    <div className="subset-plot-bar--SB">
                        <div className="subset-column--SB"><span>Curve</span><ColumnInput value={column} onChange={setColumn} single placeholder="column to display" /></div>
                        <div className="subset-toggle--SB">
                            <button type="button" className={selecting ? 'active' : ''} onClick={() => setSelecting(true)}>⬚ Select periods</button>
                            <button type="button" className={!selecting ? 'active' : ''} onClick={() => setSelecting(false)}>✥ Move / zoom</button>
                        </div>
                    </div>
                    <div className="subset-plot--SB">
                        {seriesError && <div className="plot-error--P">{seriesError}</div>}
                        {!series && !seriesError && <div className="subset-loading--SB"><AppLoader size="sm" label="Loading curve" /></div>}
                        {plotData && <Plot data={plotData} layout={plotLayout} height={300} live={live} onSelectX={(a, b) => addRange(Math.round(a), Math.round(b))} />}
                    </div>
                    <p className="subset-hint--SB">
                        {selecting ? 'Drag across the chart to add a period (as many as you want). ' : 'Drag to move, scroll to zoom, then switch back to select. '}
                        Scroll zooms in both modes.
                    </p>

                    <div className="subset-grid--SB">
                        {/* ── Periodes ── */}
                        <div className="subset-section--SB">
                            <div className="subset-section-head--SB">
                                <h4>Periods</h4>
                                <div className="subset-toggle--SB small">
                                    <button type="button" className={keep ? 'active keep' : ''} onClick={() => setMode('include')}>Keep them</button>
                                    <button type="button" className={!keep ? 'active drop' : ''} onClick={() => setMode('exclude')}>Remove them</button>
                                </div>
                            </div>
                            {ranges.length === 0 && <div className="subset-empty--SB">No period yet — drag on the chart, or add one by {time ? 'dates' : 'row numbers'}.</div>}
                            {ranges.map((r, i) => (
                                <div key={r.id} className={`subset-range--SB ${keep ? 'keep' : 'drop'}`}>
                                    <b>{i + 1}</b>
                                    {time ? (
                                        <>
                                            <DateField value={r.start} onChange={(start) => updateRange(r.id, { start })} />
                                            <span>→</span>
                                            <DateField value={r.end} onChange={(end) => updateRange(r.id, { end })} />
                                        </>
                                    ) : (
                                        <>
                                            <input type="number" min={0} value={r.start ?? ''} placeholder="first row" onChange={(e) => updateRange(r.id, { start: e.target.value === '' ? null : Number(e.target.value) })} />
                                            <span>→</span>
                                            <input type="number" min={0} value={r.end ?? ''} placeholder="last row" onChange={(e) => updateRange(r.id, { end: e.target.value === '' ? null : Number(e.target.value) })} />
                                        </>
                                    )}
                                    <button type="button" title="Remove" onClick={() => setRanges(prev => prev.filter(x => x.id !== r.id))}>✕</button>
                                </div>
                            ))}
                            <button type="button" className="subset-add--SB" onClick={() => addRange(null, null)}>+ Add by {time ? 'dates' : 'row numbers'}</button>
                            <p className="subset-note--SB">dd-mm-yyyy hh:mm, UTC, both bounds included — an empty bound means from the start / to the end.</p>
                        </div>

                        {/* ── Condition + nom + apercu ── */}
                        <div className="subset-section--SB">
                            <h4>Condition <em>(optional)</em></h4>
                            <ColumnInput value={condition} onChange={setCondition} placeholder="e.g. volatilty > mean(volatilty, 500)" />
                            <p className="subset-note--SB">Only rows where it is true are kept — on top of the periods. It may only use the past.</p>

                            <h4>Name</h4>
                            <input className="subset-input--SB" value={name} placeholder={`${dataset.name} · subset`} onChange={(e) => setName(e.target.value)} />
                            <input className="subset-input--SB" value={description} placeholder="description (optional)" onChange={(e) => setDescription(e.target.value)} />

                            <div className="subset-preview--SB">
                                {empty && <span className="muted">Select at least one period or a condition.</span>}
                                {previewError && <span className="error">{previewError}</span>}
                                {preview && !previewError && (
                                    <>
                                        <div><b>{formatCount(preview.rows)}</b> rows kept <span className="muted">/ {formatCount(preview.parent_rows)} ({((preview.rows / preview.parent_rows) * 100).toFixed(1)}%)</span></div>
                                        <div><b>{formatCount(preview.pieces)}</b> continuous piece{preview.pieces > 1 ? 's' : ''} · {fmtBound(preview.start)} → {fmtBound(preview.end)}</div>
                                        {preview.pieces > 1 && <div className="note">lead(), lag() and rolling windows of columns created in the subset restart at each piece — they never jump over a gap.</div>}
                                        {preview.pieces > 300 && <div className="warn">Many tiny pieces: windows will be mostly empty. A condition on a smoothed column gives longer pieces.</div>}
                                    </>
                                )}
                            </div>
                            {inherited.length > 0 && (
                                <div className="subset-inherited--SB">
                                    <div><b>{inherited.length} derived column{inherited.length > 1 ? 's' : ''} copied as frozen values</b>, computed on the whole {dataset.name} (no warm-up gap at the start of each piece):</div>
                                    <span>{inherited.join(' · ')}</span>
                                </div>
                            )}
                        </div>
                    </div>

                    {createError && <div className="feedback--DS error">{createError}</div>}
                    <div className="subset-actions--SB">
                        <button type="button" className="lab-ghost-btn--DS" onClick={close}>Cancel</button>
                        <button type="button" className="form-button" disabled={empty || !preview || !!previewError || creating} onClick={create}>
                            {creating ? 'Creating…' : 'Create subset'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default SubsetModal;
