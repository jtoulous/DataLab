import React, { useState, useEffect, useRef } from "react";

import { apiRequests } from '../../services/api_requests.js';
import { appEvents } from '../../services/events.js';
import { formatCount } from '../../services/format.js';
import { AppLoader, CloseIcon } from '../../components/Utils.jsx';
import { ColumnInput } from '../../components/ColumnInput.jsx';

import "../dataset/SubsetModal.css";
import "./Resample.css";


const pct = (x) => `${(x * 100).toFixed(1)}%`;


// Colonne label : pour chaque ligne, lequel des deux niveaux (figes a cette ligne) est touche en premier
// dans les lignes suivantes. 1 = haut, -1 = bas, 0 = aucun dans la limite. Generique (pas que du trading).
function FirstTouchModal({ dataset, catalog, onClose, onChanged }) {
    const has = (c) => catalog.all.includes(c);
    const [visible, setVisible] = useState(false);
    const [spec, setSpec] = useState({
        upper: '', lower: '',
        high: has('high') ? 'high' : (catalog.numeric[0] || ''),
        low: has('low') ? 'low' : (catalog.numeric[0] || ''),
        horizon: 24, name: 'first_touch_24', rows_name: '',
    });
    const [withRows, setWithRows] = useState(false);
    const [preview, setPreview] = useState(null);
    const [previewError, setPreviewError] = useState(null);
    const [job, setJob] = useState(null);
    const [error, setError] = useState(null);
    const jobId = useRef(null);

    useEffect(() => { requestAnimationFrame(() => setVisible(true)); }, []);
    const close = () => { if (job?.status === 'running') return; setVisible(false); setTimeout(onClose, 300); };
    const set = (patch) => setSpec(prev => ({ ...prev, ...patch }));

    // le nom propose suit la limite tant que l'utilisateur ne l'a pas change
    const setHorizon = (h) => set({ horizon: h, ...(spec.name === `first_touch_${spec.horizon}` ? { name: `first_touch_${h}` } : {}) });

    const ready = spec.upper.trim() && spec.lower.trim() && spec.high.trim() && spec.low.trim() && spec.horizon >= 1;
    useEffect(() => {
        if (!ready) { setPreview(null); setPreviewError(null); return; }
        const timer = setTimeout(() => {
            apiRequests.previewFirstTouch(dataset.dataset_id, { upper: spec.upper, lower: spec.lower, high: spec.high, low: spec.low, horizon: spec.horizon })
                .then(p => { setPreview(p); setPreviewError(null); })
                .catch(err => { setPreview(null); setPreviewError(err.message); });
        }, 400);
        return () => clearTimeout(timer);
    }, [spec.upper, spec.lower, spec.high, spec.low, spec.horizon, ready, dataset.dataset_id]);

    useEffect(() => appEvents.on('job', payload => {
        if (payload.job_id !== jobId.current) return;
        setJob(payload);
        if (payload.status === 'done') apiRequests.getDataset(dataset.dataset_id).then(record => { onChanged(record); onClose(); });
        if (payload.status === 'error') setError(payload.error);
    }), [dataset.dataset_id, onChanged, onClose]);

    const create = () => {
        setError(null);
        apiRequests.createFirstTouch(dataset.dataset_id, { ...spec, rows_name: withRows ? (spec.rows_name || `${spec.name}_rows`) : '' })
            .then(({ job_id }) => { jobId.current = job_id; setJob({ status: 'running', progress: { done: 0, total: 1, label: 'starting' } }); })
            .catch(err => setError(err.message));
    };

    const running = job?.status === 'running';

    return (
        <div className={`settings-backdrop ${visible ? 'visible' : ''}`} onClick={(e) => e.target === e.currentTarget && close()}>
            <div className={`settings-modal subset-modal--SB rs-small--RS ${visible ? 'visible' : ''}`}>
                <div className="settings-header">
                    <h2>First touch label <span className="subset-of--SB">in {dataset.name}</span></h2>
                    <button className="settings-close-btn" onClick={close}><CloseIcon /></button>
                </div>

                <div className="subset-body--SB">
                    <p className="subset-note--SB">
                        From each row, which level is reached first in the following rows? The levels are fixed at the start row.
                        Label: <b>1</b> upper first · <b>-1</b> lower first · <b>0</b> neither within the limit.
                    </p>

                    <div className="ft-pairs--FT">
                        <label className="ft-field--FT"><span>Upper level</span>
                            <ColumnInput value={spec.upper} onChange={(upper) => set({ upper })} placeholder="column or formula, e.g. your take-profit" />
                        </label>
                        <label className="ft-field--FT"><span>reached when this column ≥ it</span>
                            <ColumnInput value={spec.high} onChange={(high) => set({ high })} placeholder="e.g. high" />
                        </label>
                        <label className="ft-field--FT"><span>Lower level</span>
                            <ColumnInput value={spec.lower} onChange={(lower) => set({ lower })} placeholder="column or formula, e.g. your stop-loss" />
                        </label>
                        <label className="ft-field--FT"><span>reached when this column ≤ it</span>
                            <ColumnInput value={spec.low} onChange={(low) => set({ low })} placeholder="e.g. low" />
                        </label>
                    </div>
                    <p className="subset-note--SB">Only one series of values? Put the same column in both. Both levels hit in the same row: the lower one counts first.</p>

                    <div className="ft-pairs--FT">
                        <label className="ft-field--FT"><span>Look at most this many rows ahead</span>
                            <input className="subset-input--SB" type="number" min={1} max={20000} value={spec.horizon} onChange={(e) => setHorizon(Math.max(1, Number(e.target.value) || 1))} />
                        </label>
                        <label className="ft-field--FT"><span>New column name</span>
                            <input className="subset-input--SB mono--DS" value={spec.name} spellCheck={false} onChange={(e) => set({ name: e.target.value.replace(/[^A-Za-z0-9_]/g, '_') })} />
                        </label>
                    </div>
                    <label className="ft-check--FT">
                        <input type="checkbox" checked={withRows} onChange={(e) => setWithRows(e.target.checked)} />
                        Also save the number of rows until the touch ({spec.rows_name || `${spec.name}_rows`})
                    </label>

                    <div className="subset-preview--SB rs-preview--RS">
                        {!ready && <span className="muted">Fill the two levels and the two compared columns.</span>}
                        {ready && previewError && <span className="error">{previewError}</span>}
                        {ready && !preview && !previewError && <AppLoader size="sm" label="Checking" />}
                        {ready && preview && !previewError && (
                            <div title={preview.sample ? `Computed on the last ${formatCount(preview.sample)} rows` : 'Computed on all the rows'}>
                                upper first <b>{pct(preview.up)}</b> · lower first <b>{pct(preview.down)}</b> · neither <b>{pct(preview.none)}</b>
                                {preview.median_rows !== null && <> · touched after <b>{preview.median_rows}</b> rows (median)</>}
                                {preview.inverted > 0 && <span className="warn"> · {formatCount(preview.inverted)} rows have the upper level below the lower one</span>}
                            </div>
                        )}
                    </div>

                    {error && <div className="feedback--DS error">{error}</div>}
                    {job && !error && (
                        <div className="rs-progress--RS">
                            <div><i style={{ width: `${job.status === 'done' ? 100 : Math.max(4, (job.progress.done / Math.max(1, job.progress.total)) * 100)}%` }} /></div>
                            <span>{job.status === 'done' ? 'Done' : job.progress?.label}</span>
                        </div>
                    )}
                    <div className="subset-actions--SB">
                        <button type="button" className="lab-ghost-btn--DS" onClick={close} disabled={running}>Cancel</button>
                        <button type="button" className="form-button" disabled={!ready || !preview || !!previewError || !spec.name || running} onClick={create}>
                            {running ? 'Computing…' : 'Create label column'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default FirstTouchModal;
