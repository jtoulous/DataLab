import React, { useState, useEffect, useMemo, useRef } from "react";

import { GlobalState } from '../../State.jsx';
import { apiRequests } from '../../services/api_requests.js';
import { appEvents } from '../../services/events.js';
import { buildCatalog } from '../../services/catalog.js';
import { formatCount, formatDate, formatNumber } from '../../services/format.js';
import { AppLoader, CloseIcon } from '../../components/Utils.jsx';

import "../dataset/SubsetModal.css";
import "./Resample.css";


const AGG_ORDER = ['first', 'last', 'offset', 'sum', 'mean', 'median', 'min', 'max', 'std', 'count', 'quantile'];
const newId = () => Math.random().toString(36).slice(2, 9);
// '5 minutes' -> '5m' (suffixe propose pour le nom de la nouvelle colonne)
const slug = (label) => (label || 'fine').replace(/\s*minutes?/, 'm').replace(/\s*hours?/, 'h').replace(/\s*days?/, 'd').replace(/\s*seconds?/, 's').replace(/\s+/g, '');
const blank = () => ({ id: newId(), name: '', source: '', agg: 'mean' });

// Nouvelles colonnes du dataset COURANT, calculees sur les lignes d'un dataset plus fin (l'original, un subset...) :
// chaque bougie du dataset courant regroupe les lignes fines de sa fenetre.
function AggregateModal({ dataset, onClose, onChanged }) {
    const { datasetsList } = GlobalState();
    const step = dataset.profile.time?.median_step_seconds || 0;

    // sources possibles : datasets a axe temporel plus fins que le courant, la famille d'abord
    const sources = useMemo(() => {
        const family = new Set((dataset.family || []).map(f => f.dataset_id));
        const finer = (datasetsList || []).filter(d => d.dataset_id !== dataset.dataset_id && d.summary?.time?.median_step_seconds && d.summary.time.median_step_seconds < step);
        return {
            family: finer.filter(d => family.has(d.dataset_id)),
            others: finer.filter(d => !family.has(d.dataset_id)),
        };
    }, [datasetsList, dataset.family, dataset.dataset_id, step]);
    const firstSource = sources.family[0]?.dataset_id || sources.others[0]?.dataset_id || '';

    const [visible, setVisible] = useState(false);
    const [sourceId, setSourceId] = useState(firstSource);
    const [source, setSource] = useState(null);
    const [convention, setConvention] = useState('start');
    const [preview, setPreview] = useState(null);
    const [previewError, setPreviewError] = useState(null);
    const [items, setItems] = useState([blank()]);
    const [job, setJob] = useState(null);
    const [error, setError] = useState(null);
    const jobId = useRef(null);

    useEffect(() => { requestAnimationFrame(() => setVisible(true)); }, []);
    const close = () => { if (job?.status === 'running') return; setVisible(false); setTimeout(onClose, 300); };

    // colonnes de la source (pour le selecteur des formules)
    useEffect(() => {
        if (!sourceId) return;
        setSource(null);
        apiRequests.getDataset(sourceId).then(setSource).catch(err => setPreviewError(err.message));
    }, [sourceId]);
    const sourceCatalog = useMemo(() => buildCatalog(source), [source]);

    useEffect(() => {
        if (!sourceId) return;
        setPreviewError(null);
        apiRequests.previewAggregate(dataset.dataset_id, sourceId, convention)
            .then(setPreview)
            .catch(err => { setPreview(null); setPreviewError(err.message); });
    }, [sourceId, convention, dataset.dataset_id]);

    useEffect(() => appEvents.on('job', payload => {
        if (payload.job_id !== jobId.current) return;
        setJob(payload);
        if (payload.status === 'done') {
            apiRequests.getDataset(dataset.dataset_id).then(record => { onChanged(record); onClose(); });
        }
        if (payload.status === 'error') setError(payload.error);
    }), [dataset.dataset_id, onChanged, onClose]);

    const update = (id, patch) => setItems(prev => prev.map(i => (i.id === id ? { ...i, ...patch } : i)));
    const ready = items.filter(i => i.name && i.source);
    const leadColumns = preview?.lead_columns || [];
    const looksTarget = (item) => /\blead\s*\(/.test(item.source || '') || leadColumns.some(c => new RegExp(`\\b${c}\\b`).test(item.source || ''));

    const create = () => {
        setError(null);
        const keys = ['name', 'source', 'agg', 'q', 'k', 'restrict', 'restrict_n'];
        const payload = ready.map(i => Object.fromEntries(keys.filter(k => i[k] !== undefined && i[k] !== null).map(k => [k, i[k]])));
        apiRequests.createAggregate(dataset.dataset_id, sourceId, payload, convention)
            .then(({ job_id }) => { jobId.current = job_id; setJob({ status: 'running', progress: { done: 0, total: 1, label: 'starting' } }); })
            .catch(err => setError(err.message));
    };

    const ex = preview?.example;
    const running = job?.status === 'running';
    const aggregations = preview?.aggregations;
    const option = (d) => <option key={d.dataset_id} value={d.dataset_id}>{d.name} · every {d.summary.time.step_label} · {formatCount(d.summary.rows)} rows</option>;

    return (
        <div className={`settings-backdrop ${visible ? 'visible' : ''}`} onClick={(e) => e.target === e.currentTarget && close()}>
            <div className={`settings-modal subset-modal--SB ${visible ? 'visible' : ''}`}>
                <div className="settings-header">
                    <h2>Aggregate a finer granularity <span className="subset-of--SB">into {dataset.name} ({dataset.profile.time?.step_label})</span></h2>
                    <button className="settings-close-btn" onClick={close}><CloseIcon /></button>
                </div>

                <div className="subset-body--SB">
                    {!firstSource ? (
                        <div className="subset-empty--SB">
                            No dataset with a finer time step than {dataset.profile.time?.step_label}. Import the finest data you have (e.g. 5 min candles),
                            or resample a fine dataset to this timeframe.
                        </div>
                    ) : (
                        <>
                            <div className="rs-top--RS">
                                <div className="subset-section--SB">
                                    <h4>Finer dataset to aggregate (source)</h4>
                                    <select className="subset-input--SB" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                                        {sources.family.length > 0 && <optgroup label="same data (original / subsets)">{sources.family.map(option)}</optgroup>}
                                        {sources.others.length > 0 && <optgroup label="other datasets">{sources.others.map(option)}</optgroup>}
                                    </select>
                                    <p className="subset-note--SB">Each {dataset.profile.time?.step_label} candle of {dataset.name} gathers the source rows of its own window.</p>
                                </div>
                                <div className="subset-section--SB">
                                    <h4>Timestamps mark the</h4>
                                    <div className="subset-toggle--SB small">
                                        <button type="button" className={convention === 'start' ? 'active' : ''} onClick={() => setConvention('start')}>start of the candle</button>
                                        <button type="button" className={convention === 'end' ? 'active' : ''} onClick={() => setConvention('end')}>end of the candle</button>
                                    </div>
                                </div>
                            </div>

                            <div className="subset-preview--SB rs-preview--RS" title={ex ? `Candle ${formatDate(ex.label)} = source rows in ${ex.window_closed === 'left' ? '[' : '('}${formatDate(ex.window_start)} → ${formatDate(ex.window_end)}${ex.window_closed === 'left' ? ')' : ']'} (${ex.rows} rows). Nothing after the end of a candle is used.` : undefined}>
                                {previewError && <span className="error">{previewError}</span>}
                                {!preview && !previewError && <AppLoader size="sm" label="Checking" />}
                                {preview && !previewError && (
                                    <div>
                                        <b>{formatCount(preview.covered)}</b> / {formatCount(preview.candles)} candles filled · {formatNumber(preview.expected_rows_per_candle, 0)} rows of {preview.fine_step} per candle
                                        {preview.not_covered > 0 && <span className="warn"> · {formatCount(preview.not_covered)} without data</span>}
                                    </div>
                                )}
                            </div>

                            {aggregations && (
                                    <div className="subset-section--SB">
                                        <div className="subset-section-head--SB">
                                            <h4>Columns to create in {dataset.name}</h4>
                                            <span className="subset-note--SB">need a calculation first (returns…)? create it as a column of {source?.name || 'the source'}</span>
                                        </div>
                                        <div className="rs-table--RS">
                                            <div className="rs-row--RS head"><span /><span>New column name</span><span>Source column</span><span>Aggregation per candle</span><span>Only rows</span><span /></div>
                                            {items.map((item, n) => (
                                                <div key={item.id} className="rs-row--RS extra">
                                                    <span className="rs-num--RS">{n + 1}</span>
                                                    <input className="mono--DS" value={item.name} placeholder="name" spellCheck={false}
                                                        onChange={(e) => update(item.id, { name: e.target.value.replace(/[^A-Za-z0-9_]/g, '_') })} />
                                                    <div className="rs-source--RS">
                                                        <select value={item.source} onChange={(e) => update(item.id, { source: e.target.value, name: item.name || `${e.target.value}_${slug(source?.profile.time?.step_label)}` })}>
                                                            <option value="">choose a column…</option>
                                                            {(sourceCatalog?.numeric || []).map(c => <option key={c} value={c}>{c}</option>)}
                                                        </select>
                                                        {looksTarget(item) && <i className="ex-target-tag--EX" title="looks at following rows: the column will be a target, never a model input">target</i>}
                                                    </div>
                                                    <div className="rs-agg--RS">
                                                        <select value={item.agg} onChange={(e) => update(item.id, { agg: e.target.value })} title={aggregations[item.agg]?.help}>
                                                            {AGG_ORDER.filter(a => aggregations[a]).map(a => <option key={a} value={a}>{aggregations[a].label}</option>)}
                                                        </select>
                                                        {item.agg === 'quantile' && <input type="number" min={0} max={1} step={0.05} value={item.q ?? 0.5} title="q" onChange={(e) => update(item.id, { q: Number(e.target.value) })} />}
                                                        {item.agg === 'offset' && <input type="number" min={0} step={1} value={item.k ?? 0} title="k (0 = first source row)" onChange={(e) => update(item.id, { k: Number(e.target.value) })} />}
                                                    </div>
                                                    <div className="rs-agg--RS">
                                                        <select value={item.restrict || ''} onChange={(e) => update(item.id, { restrict: e.target.value || null, restrict_n: item.restrict_n || 3 })}>
                                                            <option value="">all</option>
                                                            <option value="first">first N</option>
                                                            <option value="last">last N</option>
                                                        </select>
                                                        {item.restrict && <input type="number" min={1} step={1} value={item.restrict_n || 3} title="N source rows" onChange={(e) => update(item.id, { restrict_n: Number(e.target.value) })} />}
                                                    </div>
                                                    <button type="button" className="rs-remove--RS" title="Remove" onClick={() => setItems(prev => (prev.length > 1 ? prev.filter(i => i.id !== item.id) : [blank()]))}>✕</button>
                                                </div>
                                            ))}
                                        </div>
                                        <div className="rs-add--RS">
                                            <button type="button" className="subset-add--SB" onClick={() => setItems(prev => [...prev, blank()])}>+ Add a column</button>
                                        </div>
                                    </div>
                            )}

                            {error && <div className="feedback--DS error">{error}</div>}
                            {job && !error && (
                                <div className="rs-progress--RS">
                                    <div><i style={{ width: `${job.status === 'done' ? 100 : Math.max(4, (job.progress.done / Math.max(1, job.progress.total)) * 100)}%` }} /></div>
                                    <span>{job.status === 'done' ? 'Done' : job.progress?.label}</span>
                                </div>
                            )}
                            <div className="subset-actions--SB">
                                <button type="button" className="lab-ghost-btn--DS" onClick={close} disabled={running}>Cancel</button>
                                <button type="button" className="form-button" disabled={!preview || !!previewError || !ready.length || running} onClick={create}>
                                    {running ? 'Computing…' : `Create ${ready.length || ''} column${ready.length > 1 ? 's' : ''}`}
                                </button>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

export default AggregateModal;
