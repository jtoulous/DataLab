import React, { useState, useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";

import { apiRequests } from '../../services/api_requests.js';
import { appEvents } from '../../services/events.js';
import { formatCount, formatDate } from '../../services/format.js';
import { AppLoader, CloseIcon } from '../../components/Utils.jsx';

import "../dataset/SubsetModal.css";
import "./Resample.css";


const RULES = [
    ['10min', 600], ['15min', 900], ['30min', 1800], ['1h', 3600], ['2h', 7200], ['4h', 14400],
    ['6h', 21600], ['12h', 43200], ['1D', 86400], ['7D', 604800],
];


// Nouveau dataset a une timeframe plus grosse, derive du dataset courant : on choisit la timeframe, c'est tout
// (OHLC et sommes proposes d'apres les noms). Les statistiques sur la granularite fine se font dans
// « Aggregate temporal granularity ».
function ResampleModal({ dataset, onClose }) {
    const navigate = useNavigate();
    const stepSeconds = dataset.profile.time?.median_step_seconds || 0;
    const rules = RULES.filter(([, s]) => !stepSeconds || (s > stepSeconds && Math.round(s * 1000) % Math.round(stepSeconds * 1000) === 0));

    const [visible, setVisible] = useState(false);
    const [rule, setRule] = useState(rules.find(([r]) => r === '1h')?.[0] || rules[0]?.[0] || '1h');
    const [customRule, setCustomRule] = useState('');
    const [convention, setConvention] = useState('start');
    const [fill, setFill] = useState('empty');
    const [preview, setPreview] = useState(null);
    const [previewError, setPreviewError] = useState(null);
    const [name, setName] = useState('');
    const [job, setJob] = useState(null);
    const [error, setError] = useState(null);
    const jobId = useRef(null);

    const effectiveRule = (customRule.trim() || rule).trim();
    const spec = useMemo(() => ({ rule: effectiveRule, convention, fill }), [effectiveRule, convention, fill]);

    useEffect(() => { requestAnimationFrame(() => setVisible(true)); }, []);
    const close = () => { if (job?.status === 'running') return; setVisible(false); setTimeout(onClose, 300); };

    useEffect(() => {
        const timer = setTimeout(() => {
            apiRequests.previewResample(dataset.dataset_id, spec)
                .then(p => { setPreview(p); setPreviewError(null); })
                .catch(err => { setPreview(null); setPreviewError(err.message); });
        }, 300);
        return () => clearTimeout(timer);
    }, [JSON.stringify(spec), dataset.dataset_id]);

    useEffect(() => appEvents.on('job', payload => {
        if (payload.job_id !== jobId.current) return;
        setJob(payload);
        if (payload.status === 'done') setTimeout(() => { onClose(); navigate(`/dataset?id=${payload.result}`); }, 400);
        if (payload.status === 'error') setError(payload.error);
    }), [navigate, onClose]);

    const create = () => {
        setError(null);
        apiRequests.createResample(dataset.dataset_id, name.trim() || `${dataset.name} ${preview?.rule_label || effectiveRule}`, spec)
            .then(({ job_id }) => { jobId.current = job_id; setJob({ status: 'running', progress: { done: 0, total: 1, label: 'starting' } }); })
            .catch(err => setError(err.message));
    };

    const ex = preview?.example;
    const running = job?.status === 'running';

    return (
        <div className={`settings-backdrop ${visible ? 'visible' : ''}`} onClick={(e) => e.target === e.currentTarget && close()}>
            <div className={`settings-modal subset-modal--SB rs-small--RS ${visible ? 'visible' : ''}`}>
                <div className="settings-header">
                    <h2>Resample <span className="subset-of--SB">{dataset.name} ({dataset.profile.time?.step_label})</span></h2>
                    <button className="settings-close-btn" onClick={close}><CloseIcon /></button>
                </div>

                <div className="subset-body--SB">
                    <div className="subset-section--SB">
                        <h4>New timeframe</h4>
                        <div className="rs-rules--RS">
                            {rules.map(([r]) => (
                                <button key={r} type="button" className={!customRule && rule === r ? 'active' : ''} onClick={() => { setRule(r); setCustomRule(''); }}>{r}</button>
                            ))}
                            <input className="subset-input--SB" value={customRule} placeholder="other: 3h, 90min…" onChange={(e) => setCustomRule(e.target.value)} />
                        </div>
                    </div>

                    <div className="rs-top--RS">
                        <div className="subset-section--SB">
                            <h4>Timestamps mark the</h4>
                            <div className="subset-toggle--SB small">
                                <button type="button" className={convention === 'start' ? 'active' : ''} onClick={() => setConvention('start')}>start of the candle</button>
                                <button type="button" className={convention === 'end' ? 'active' : ''} onClick={() => setConvention('end')}>end of the candle</button>
                            </div>
                        </div>
                        <div className="subset-section--SB">
                            <h4>Candle without row</h4>
                            <div className="subset-toggle--SB small">
                                <button type="button" className={fill === 'empty' ? 'active' : ''} onClick={() => setFill('empty')}>keep it empty</button>
                                <button type="button" className={fill === 'ffill' ? 'active' : ''} onClick={() => setFill('ffill')}>repeat last value</button>
                            </div>
                        </div>
                    </div>

                    <div className="subset-preview--SB rs-preview--RS" title={ex ? `Candle ${formatDate(ex.label)} = rows in ${ex.window_closed === 'left' ? '[' : '('}${formatDate(ex.window_start)} → ${formatDate(ex.window_end)}${ex.window_closed === 'left' ? ')' : ']'} (${ex.rows} rows). Columns: ${preview.defaults.map(d => `${d.name} (${d.agg})`).join(', ')}, n_rows.` : undefined}>
                        {previewError && <span className="error">{previewError}</span>}
                        {!preview && !previewError && <AppLoader size="sm" label="Checking" />}
                        {preview && !previewError && (
                            <div>
                                <b>{formatCount(preview.candles)}</b> candles of {preview.rule_label} from {formatCount(preview.fine_rows)} rows
                                {preview.empty_candles > 0 && <span className="warn"> · {formatCount(preview.empty_candles)} empty (gaps)</span>}
                            </div>
                        )}
                    </div>

                    <input className="subset-input--SB" value={name} placeholder={`${dataset.name} ${preview?.rule_label || effectiveRule}`} onChange={(e) => setName(e.target.value)} />

                    {error && <div className="feedback--DS error">{error}</div>}
                    {job && !error && (
                        <div className="rs-progress--RS">
                            <div><i style={{ width: `${job.status === 'done' ? 100 : Math.max(4, (job.progress.done / Math.max(1, job.progress.total)) * 100)}%` }} /></div>
                            <span>{job.status === 'done' ? 'Done — opening the new dataset…' : job.progress?.label}</span>
                        </div>
                    )}
                    <div className="subset-actions--SB">
                        <button type="button" className="lab-ghost-btn--DS" onClick={close} disabled={running}>Cancel</button>
                        <button type="button" className="form-button" disabled={!preview || !!previewError || running || job?.status === 'done'} onClick={create}>
                            {running ? 'Creating…' : 'Resample'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default ResampleModal;
