import React, { useState, useEffect } from "react";
import { apiRequests } from '../../services/api_requests.js';
import { formatCount } from '../../services/format.js';


const RESAMPLE_RULES = [
    { value: '', label: 'No resampling' }, { value: '1min', label: '1 minute' }, { value: '5min', label: '5 minutes' },
    { value: '15min', label: '15 minutes' }, { value: '1h', label: '1 hour' }, { value: '4h', label: '4 hours' },
    { value: '1D', label: '1 day' }, { value: '1W', label: '1 week' }, { value: '1ME', label: '1 month' },
];
const AGGS = ['mean', 'sum', 'median', 'min', 'max', 'first', 'last', 'std', 'count'];


// Vue appliquee au dataset pour les onglets Data et Explore : plage, reechantillonnage, filtre de lignes
function ViewBar({ dataset, onSaved }) {
    const saved = dataset.view_settings || {};
    const hasTime = !!dataset.profile.time;
    const [draft, setDraft] = useState(saved);
    const [error, setError] = useState(null);
    const [rows, setRows] = useState(null);
    const [open, setOpen] = useState(false);

    useEffect(() => { setDraft(dataset.view_settings || {}); }, [dataset.view_settings]);

    const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
    const set = (patch) => setDraft(prev => ({ ...prev, ...patch }));

    const apply = (settings = draft) => {
        setError(null);
        apiRequests.updateView(dataset.dataset_id, settings)
            .then(res => { setRows(res.rows); onSaved(settings); })
            .catch(err => setError(err.message));
    };

    const clear = () => {
        setDraft({});
        apply({});
    };

    const active = [];
    if (saved.range?.start || saved.range?.end) active.push(`${hasTime ? 'dates' : 'rows'} ${saved.range.start || '…'} → ${saved.range.end || '…'}`);
    if (saved.resample?.rule) active.push(`resampled ${saved.resample.rule} (${saved.resample.agg || 'mean'})`);
    if (saved.filter) active.push(`filter: ${saved.filter}`);

    return (
        <div className={`viewbar--DS ${active.length ? 'active' : ''}`}>
            <div className="viewbar-summary--DS" onClick={() => setOpen(!open)}>
                <span className="viewbar-icon--DS">⛃</span>
                <b>View</b>
                {active.length
                    ? active.map(a => <span key={a} className="viewbar-chip--DS">{a}</span>)
                    : <span className="viewbar-muted--DS">full dataset — click to restrict the range, resample or filter rows</span>}
                {rows !== null && <span className="viewbar-rows--DS">{formatCount(rows)} rows</span>}
                <span className="viewbar-toggle--DS">{open ? '▾' : '▸'}</span>
            </div>

            {open && (
                <div className="viewbar-body--DS">
                    <div className="viewbar-group--DS">
                        <span>{hasTime ? 'Date range' : 'Row range'}</span>
                        <div className="viewbar-row--DS">
                            <input type={hasTime ? 'date' : 'number'} value={draft.range?.start || ''} placeholder="start"
                                onChange={(e) => set({ range: { ...draft.range, start: e.target.value } })} />
                            <span>→</span>
                            <input type={hasTime ? 'date' : 'number'} value={draft.range?.end || ''} placeholder="end"
                                onChange={(e) => set({ range: { ...draft.range, end: e.target.value } })} />
                        </div>
                    </div>

                    <div className={`viewbar-group--DS ${hasTime ? '' : 'disabled'}`} title={hasTime ? '' : 'Needs a time axis'}>
                        <span>Resample</span>
                        <div className="viewbar-row--DS">
                            <select disabled={!hasTime} value={draft.resample?.rule || ''} onChange={(e) => set({ resample: { ...draft.resample, rule: e.target.value } })}>
                                {RESAMPLE_RULES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                            </select>
                            <select disabled={!hasTime || !draft.resample?.rule} value={draft.resample?.agg || 'mean'} onChange={(e) => set({ resample: { ...draft.resample, agg: e.target.value } })}>
                                {AGGS.map(a => <option key={a} value={a}>{a}</option>)}
                            </select>
                        </div>
                    </div>

                    <div className="viewbar-group--DS viewbar-filter--DS">
                        <span>Row filter (formula, true = kept)</span>
                        <input className="mono--DS" list="dv-columns-list" value={draft.filter || ''} placeholder={`e.g. (status == "OK") & (value > 0)`}
                            onChange={(e) => set({ filter: e.target.value })} />
                    </div>

                    <div className="viewbar-actions--DS">
                        {(active.length > 0 || dirty) && <button type="button" className="lab-ghost-btn--DS" onClick={clear}>Clear all</button>}
                        <button type="button" className={`form-button ${dirty ? 'pending--DS' : ''}`} onClick={() => apply()} disabled={!dirty}>Apply view</button>
                    </div>
                    {error && <div className="feedback--DS error">{error}</div>}
                </div>
            )}
        </div>
    );
}

export default ViewBar;
