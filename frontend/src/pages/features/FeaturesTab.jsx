import React, { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";

import { GlobalState } from '../../State.jsx';
import { apiRequests } from '../../services/api_requests.js';
import { appEvents } from '../../services/events.js';
import { formatCount } from '../../services/format.js';
import { CloseIcon } from '../../components/Utils.jsx';
import ColumnEditor from './ColumnEditor.jsx';
import ModelColumn from './ModelColumn.jsx';
import ColumnList from './ColumnList.jsx';
import SavedFormulas from './SavedFormulas.jsx';
import ResampleModal from './ResampleModal.jsx';
import AggregateModal from './AggregateModal.jsx';
import FirstTouchModal from './FirstTouchModal.jsx';
import SubsetModal from '../dataset/SubsetModal.jsx';

import "../explore/Explore.css";
import "./Features.css";


// Datasets derives directement du dataset courant (sous-datasets / resamples), depuis la famille
function useChildren(dataset) {
    return useMemo(() => (dataset.family || []).filter(f => f.parent_id === dataset.dataset_id), [dataset.family, dataset.dataset_id]);
}


function ChildRow({ child, extra }) {
    const navigate = useNavigate();
    return (
        <button type="button" className="ft-child--FT" onClick={() => navigate(`/dataset?id=${child.dataset_id}`)}>
            <b>{child.name}</b>
            <span>{formatCount(child.rows)} rows{extra ? ` · ${extra}` : ''}</span>
            <i>open →</i>
        </button>
    );
}


/*=====================================================================================*/
/*                                     Features                                        */
/*=====================================================================================*/

// Tout ce qui cree ou transforme de la donnee : colonnes (formule, modele), sous-datasets, timeframes.
function FeaturesTab({ dataset, catalog, onChanged }) {
    const { meta } = GlobalState();
    const view = useMemo(() => dataset.view_settings || {}, [dataset.view_settings]);
    const [columnMode, setColumnMode] = useState('formula');
    const [editing, setEditing] = useState(null);
    const [draft, setDraft] = useState(null);          // formulaire en cours (pour la bibliotheque)
    const [loaded, setLoaded] = useState(null);        // formule de la bibliotheque a charger
    const [showFunctions, setShowFunctions] = useState(false);
    const [modal, setModal] = useState(null);           // 'subset' | 'resample'
    const [jobs, setJobs] = useState([]);
    const [feedback, setFeedback] = useState(null);

    const children = useChildren(dataset);
    const subsets = children.filter(c => c.origin?.kind !== 'resample');
    const resamples = children.filter(c => c.origin?.kind === 'resample');
    const time = dataset.profile.time;
    const aggregated = Object.entries(dataset.frozen || {}).filter(([, c]) => c.kind === 'aggregate');
    const touches = Object.entries(dataset.frozen || {}).filter(([, c]) => c.kind === 'first_touch');

    useEffect(() => {
        if (!feedback) return;
        const timer = setTimeout(() => setFeedback(null), 3500);
        return () => clearTimeout(timer);
    }, [feedback]);

    // creations en cours (resample sur ~1 M de lignes) : retrouvees apres un rechargement de la page
    useEffect(() => {
        apiRequests.getJobs(dataset.dataset_id).then(list => setJobs(list.filter(j => j.status === 'running'))).catch(() => {});
        return appEvents.on('job', payload => {
            if (payload.dataset_id !== dataset.dataset_id) return;
            setJobs(prev => [...prev.filter(j => j.job_id !== payload.job_id), ...(payload.status === 'running' ? [payload] : [])]);
        });
    }, [dataset.dataset_id]);

    const actions = {
        edit: (c) => { setColumnMode('formula'); setEditing({ name: c.key, formula: c.formula, description: c.description }); },
        deleteColumn: (name) => apiRequests.deleteColumn(dataset.dataset_id, name)
            .then(data => onChanged({ ...dataset, derived_columns: data.derived_columns }))
            .catch(err => setFeedback(err.message)),
        deleteModelColumn: (name) => apiRequests.deleteFrozen(dataset.dataset_id, name)
            .then(record => onChanged(record))
            .catch(err => setFeedback(err.message)),
    };

    return (
        <div className="features--FT">
            {/* ─────────────────────────────── Colonnes ─────────────────────────────── */}
            <section className="ft-card--FT ft-columns--FT">
                <div className="ft-card-head--FT">
                    <h3>{editing ? `Edit “${editing.name}”` : 'New column'}</h3>
                    <span>a new column in {dataset.name}</span>
                </div>
                {!editing && (
                    <div className="ex-mode--EX">
                        <button type="button" className={columnMode === 'formula' ? 'active' : ''} onClick={() => setColumnMode('formula')}>ƒ Formula</button>
                        <button type="button" className={columnMode === 'model' ? 'active' : ''} onClick={() => setColumnMode('model')}>◆ Model prediction</button>
                    </div>
                )}
                {!editing && columnMode === 'model' ? (
                    <ModelColumn dataset={dataset} onSaved={(record) => { onChanged(record); setFeedback('Model column saved'); }} />
                ) : (
                    <ColumnEditor dataset={dataset} catalog={catalog} view={view} editing={editing} loaded={loaded} onFormChange={setDraft} onCancel={() => setEditing(null)}
                        onSaved={(columns) => { onChanged({ ...dataset, derived_columns: columns }); setEditing(null); setFeedback('Column saved'); }} />
                )}
                {columnMode === 'formula' && (
                    <>
                        <button type="button" className="ex-link--EX" onClick={() => setShowFunctions(!showFunctions)}>
                            {showFunctions ? '▾' : '▸'} Formula reference
                        </button>
                        {showFunctions && meta && (
                            <div className="ex-functions--EX">
                                {Object.entries(meta.functions).map(([fn, doc]) => (
                                    <div key={fn} className={doc.startsWith('LOOKAHEAD') ? 'lookahead' : ''}><code>{fn}</code><span>{doc}</span></div>
                                ))}
                                <div><code>+ - * / ** % &gt; &lt; == != &amp; | ~</code><span>operators — combine conditions with &amp; (and), | (or), ~ (not)</span></div>
                                <div><code>"text"</code><span>compare categories: status == "OK"</span></div>
                            </div>
                        )}
                        {!editing && (
                            <SavedFormulas dataset={dataset} catalog={catalog} draft={draft} onLoad={(f) => setLoaded({ ...f })} onMessage={setFeedback}
                                onApplied={(columns) => onChanged({ ...dataset, derived_columns: columns })} />
                        )}
                    </>
                )}
            </section>

            <div className="ft-right--FT">
                {/* ─────────────────────────── Mes colonnes ─────────────────────────── */}
                <section className="ft-card--FT ft-list--FT">
                    <div className="ft-card-head--FT">
                        <h3>Columns <span className="ft-count--FT">{catalog.all.length}</span></h3>
                        <span>edit or delete the ones you created</span>
                    </div>
                    <ColumnList dataset={dataset} catalog={catalog} actions={actions} emptyHint="Create columns with the form on the left" />
                </section>

                <div className="ft-derive--FT">
                    {/* ───────────────────────────── Sous-datasets ───────────────────────────── */}
                    <section className="ft-card--FT">
                        <div className="ft-card-head--FT">
                            <h3>Subsets</h3>
                            <span>a new dataset made of some periods / rows of this one</span>
                        </div>
                        <button type="button" className="ft-action--FT subset" onClick={() => setModal('subset')}>+ New subset</button>
                        <p className="ft-note--FT">Isolate regimes, or split into train / test datasets. Each subset is a full dataset: its own columns, analyses and models.</p>
                        {subsets.length > 0 && (
                            <div className="ft-children--FT">
                                {subsets.map(c => <ChildRow key={c.dataset_id} child={c} extra={c.origin?.pieces > 1 ? `${formatCount(c.origin.pieces)} pieces` : null} />)}
                            </div>
                        )}
                    </section>

                    {/* ───────────────────────────── Timeframes ───────────────────────────── */}
                    <section className={`ft-card--FT ${time ? '' : 'disabled'}`}>
                        <div className="ft-card-head--FT">
                            <h3>Timeframes</h3>
                            <span>{time ? `this dataset: one row every ${time.step_label}` : 'needs a time axis'}</span>
                        </div>
                        {time ? (
                            <>
                                <button type="button" className="ft-action--FT resample" onClick={() => setModal('resample')}>+ Resample to a bigger timeframe</button>
                                <p className="ft-note--FT">
                                    A new dataset at a bigger timeframe (e.g. 1 h candles from this {time.step_label} data): OHLC, sums, n_rows.
                                    Import the finest data you have, then derive the bigger timeframes from it.
                                </p>
                                {dataset.origin?.kind === 'resample' && (
                                    <p className="ft-note--FT">This dataset is itself a {dataset.origin.resample?.rule_label} resample of <b>{dataset.origin.parent_name}</b>.</p>
                                )}
                                {jobs.map(j => (
                                    <div key={j.job_id} className="rs-progress--RS">
                                        <div><i style={{ width: `${Math.max(4, (j.progress.done / Math.max(1, j.progress.total)) * 100)}%` }} /></div>
                                        <span>{j.label} — {j.progress.label}</span>
                                    </div>
                                ))}
                                {resamples.length > 0 && (
                                    <div className="ft-children--FT">
                                        {resamples.map(c => <ChildRow key={c.dataset_id} child={c} extra={c.origin?.resample?.rule_label ? `every ${c.origin.resample.rule_label}` : null} />)}
                                    </div>
                                )}
                            </>
                        ) : (
                            <p className="ft-note--FT">Set a time axis in the <b>Overview</b> tab (a datetime column) to resample this dataset. Everything else works without one.</p>
                        )}
                    </section>

                    {/* ─────────────────────── Agregation d'une granularite fine ─────────────────────── */}
                    <section className={`ft-card--FT ${time ? '' : 'disabled'}`}>
                        <div className="ft-card-head--FT">
                            <h3>Aggregate temporal granularity</h3>
                            <span>new columns of {dataset.name} computed on a finer dataset</span>
                        </div>
                        {time ? (
                            <>
                                <button type="button" className="ft-action--FT aggregate" onClick={() => setModal('aggregate')}>+ Columns from a finer dataset</button>
                                <p className="ft-note--FT">
                                    Pick the finer dataset (the original, a subset…), write what to compute on its rows and how to sum it up per {time.step_label} candle:
                                    realized volatility, biggest move, activity in the last minutes of the candle…
                                </p>
                                {aggregated.length > 0 && (
                                    <div className="ft-children--FT">
                                        {aggregated.map(([key, c]) => (
                                            <div key={key} className="ft-agg--FT" title={c.recipe}>
                                                <b>{key}{c.lookahead && <i className="ex-target-tag--EX">target</i>}</b>
                                                <span>{c.recipe} · from {c.source_name}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </>
                        ) : (
                            <p className="ft-note--FT">Needs a time axis (set it in the <b>Overview</b> tab).</p>
                        )}
                    </section>

                    {/* ─────────────────────── Premier niveau touche (labels) ─────────────────────── */}
                    <section className="ft-card--FT">
                        <div className="ft-card-head--FT">
                            <h3>First touch label</h3>
                            <span>which of two levels is reached first, row after row</span>
                        </div>
                        <button type="button" className="ft-action--FT touch" onClick={() => setModal('first_touch')}>+ First touch label</button>
                        <p className="ft-note--FT">
                            Give an upper and a lower level (columns or formulas, e.g. a take-profit and a stop-loss): each row gets 1, -1 or 0
                            depending on which one the following rows reach first. A target, never a model input.
                        </p>
                        {touches.length > 0 && (
                            <div className="ft-children--FT">
                                {touches.map(([key, c]) => (
                                    <div key={key} className="ft-agg--FT touch" title={c.recipe}>
                                        <b>{key}<i className="ex-target-tag--EX">target</i></b>
                                        <span>{c.output === 'rows' ? 'rows until the touch' : `${(c.stats.up * 100).toFixed(0)}% upper · ${(c.stats.down * 100).toFixed(0)}% lower · ${(c.stats.none * 100).toFixed(0)}% neither`} · within {c.horizon} rows</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </section>
                </div>
            </div>

            {modal === 'subset' && <SubsetModal dataset={dataset} catalog={catalog} onClose={() => setModal(null)} />}
            {modal === 'resample' && <ResampleModal dataset={dataset} onClose={() => setModal(null)} />}
            {modal === 'first_touch' && <FirstTouchModal dataset={dataset} catalog={catalog} onClose={() => setModal(null)} onChanged={(record) => { onChanged(record); setFeedback('Label column created'); }} />}
            {modal === 'aggregate' && <AggregateModal dataset={dataset} onClose={() => setModal(null)} onChanged={(record) => { onChanged(record); setFeedback('Columns created'); }} />}
            {feedback && <div className="ex-feedback--EX" onClick={() => setFeedback(null)}>{feedback}<CloseIcon size={12} /></div>}
        </div>
    );
}

export default FeaturesTab;
