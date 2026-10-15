import React, { useState, useEffect, useMemo } from "react";

import { apiRequests } from '../../services/api_requests.js';
import { formatCount, formatNumber } from '../../services/format.js';
import Plot from '../../components/Plot.jsx';
import { PLOT_COLORS } from '../../components/plotTheme.js';


// nom de lancement automatique (« cible · N models ») : pas un vrai nom choisi
const AUTO_NAME = / · \d+ models?$/;
const slug = (text) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

const OUTPUT_LABEL = { value: 'predicted value', proba: 'probability of the positive class', class: 'predicted class (0 / 1)' };

// Nouvelle colonne = predictions d'un modele deja entraine (onglet Modelling), calculees sur CE dataset.
// Les lignes que le modele a vues a l'entrainement restent vides : sinon la colonne serait trop belle.
function ModelColumn({ dataset, onSaved }) {
    const [models, setModels] = useState(null);
    const [unsaved, setUnsaved] = useState([]);
    const [loadError, setLoadError] = useState(null);
    const [pick, setPick] = useState('');
    const [output, setOutput] = useState('');
    const [threshold, setThreshold] = useState(0.5);
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [preview, setPreview] = useState(null);
    const [previewError, setPreviewError] = useState(null);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        apiRequests.getSavedModels(dataset.dataset_id).then(r => { setModels(r.models); setUnsaved(r.unsaved); }).catch(err => setLoadError(err.message));
    }, [dataset.dataset_id]);

    const model = useMemo(() => (models || []).find(m => `${m.run_id}:${m.model_key}` === pick) || null, [models, pick]);

    useEffect(() => {
        if (!model) return;
        setOutput(model.outputs[0]);
        const custom = model.run_name && !AUTO_NAME.test(model.run_name) ? slug(model.run_name) : '';
        setName(/^[a-z_]/.test(custom) ? `pred_${custom}` : `pred_${model.model_key}_${model.run_id}`);
    }, [model]);

    useEffect(() => {
        if (!model || !output) { setPreview(null); return; }
        setLoading(true);
        setPreviewError(null);
        const timer = setTimeout(() => {
            apiRequests.predictPreview(dataset.dataset_id, model.run_id, model.model_key, output, threshold)
                .then(p => { setPreview(p); setPreviewError(null); })
                .catch(err => { setPreview(null); setPreviewError(err.message); })
                .finally(() => setLoading(false));
        }, 300);
        return () => clearTimeout(timer);
    }, [model, output, threshold, dataset.dataset_id]);

    const create = () => {
        setSaving(true);
        setError(null);
        apiRequests.predictColumn(dataset.dataset_id, { name: name.trim(), run_id: model.run_id, model_key: model.model_key, output, threshold, description })
            .then(record => { onSaved(record); setPick(''); setPreview(null); })
            .catch(err => setError(err.message))
            .finally(() => setSaving(false));
    };

    const groups = useMemo(() => {
        const byDataset = {};
        (models || []).forEach(m => { (byDataset[m.dataset_id] ||= { name: m.dataset_name, items: [] }).items.push(m); });
        return Object.entries(byDataset);
    }, [models]);

    const score = (m) => (m.score === null || m.score === undefined ? '' : ` · ${m.metric === 'r2' ? 'R²' : 'AUC'} ${formatNumber(m.score, 3)}`);

    if (loadError) return <div className="ex-error--EX small">{loadError}</div>;
    if (models && models.length === 0) {
        return (
            <div className="ex-modelcol-empty--EX">
                No model to apply yet. Train models in the <b>Modelling</b> tab — on any dataset or subset, the one you want to learn from —
                and they will show up here, ready to be applied to <b>{dataset.name}</b>.
                {unsaved.length > 0 && (
                    <div className="ex-modelcol-unsaved--EX">
                        These runs were made before models were kept, train them again:
                        {unsaved.slice(0, 5).map(u => <div key={u.run_id}>#{u.run_id} · {u.run_name} <span>on {u.dataset_name}</span></div>)}
                    </div>
                )}
            </div>
        );
    }

    const seen = preview?.seen_in_training || 0;
    const sameDataset = model && model.dataset_id === dataset.dataset_id;

    return (
        <div className="ex-modelcol--EX">
            {unsaved.length > 0 && <div className="ex-modelcol-note--EX">{unsaved.length} older run{unsaved.length > 1 ? 's' : ''} kept no model (train again to use {unsaved.length > 1 ? 'them' : 'it'}).</div>}
            <label className="ex-modelcol-field--EX">
                <span>Model</span>
                <select value={pick} onChange={(e) => setPick(e.target.value)}>
                    <option value="">{models ? 'choose a trained model…' : 'loading…'}</option>
                    {groups.map(([id, g]) => (
                        <optgroup key={id} label={`trained on ${g.name}${id === dataset.dataset_id ? ' (this dataset)' : ''}`}>
                            {g.items.map(m => (
                                <option key={`${m.run_id}:${m.model_key}`} value={`${m.run_id}:${m.model_key}`}>{m.run_name} · {m.label}{score(m)}</option>
                            ))}
                        </optgroup>
                    ))}
                </select>
            </label>

            {model && (
                <>
                    <div className="ex-modelcol-info--EX">
                        <div><span>name</span>{model.run_name} <span>· run #{model.run_id}</span></div>
                        <div><span>target</span><code>{model.target}</code></div>
                        <div><span>{model.task}</span>{model.positive_class ? `positive class = ${model.positive_class}` : ''} · fitted on {formatCount(model.fit_rows)} rows</div>
                    </div>
                    {sameDataset && <div className="ex-lookahead--EX ok">Trained on this very dataset: only the rows it did not learn from (its test part) will get a value.</div>}

                    <div className="ex-modelcol-row--EX">
                        <label className="ex-modelcol-field--EX">
                            <span>Column content</span>
                            <select value={output} onChange={(e) => setOutput(e.target.value)}>
                                {model.outputs.map(o => <option key={o} value={o}>{OUTPUT_LABEL[o]}</option>)}
                            </select>
                        </label>
                        {output === 'class' && (
                            <label className="ex-modelcol-field--EX small">
                                <span>Threshold</span>
                                <input type="number" min={0} max={1} step={0.05} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
                            </label>
                        )}
                    </div>

                    <input className="mono--DS" value={name} placeholder="new_column_name" spellCheck={false}
                        onChange={(e) => setName(e.target.value.replace(/[^A-Za-z0-9_]/g, '_'))} />
                    <input value={description} placeholder="description (optional)" onChange={(e) => setDescription(e.target.value)} />

                    {previewError && <div className="ex-error--EX small">{previewError}</div>}
                    {loading && !preview && <div className="ex-modelcol-note--EX">computing…</div>}
                    {preview && !previewError && (
                        <div className="ex-preview--EX">
                            <div className="ex-preview-stats--EX">
                                <span>predicted <b>{formatCount(preview.predicted)}</b> / {formatCount(preview.rows)} rows</span>
                                {preview.stats && <span>mean <b>{formatNumber(preview.stats.mean, 4)}</b></span>}
                                {preview.stats && <span>std <b>{formatNumber(preview.stats.std, 4)}</b></span>}
                            </div>
                            {seen > 0 && (
                                <div className="ex-lookahead--EX">
                                    {formatCount(seen)} rows were used to train this model: left empty — a prediction there would look far better than it is.
                                </div>
                            )}
                            {preview.missing_inputs > 0 && <div className="ex-modelcol-note--EX">{formatCount(preview.missing_inputs)} rows left empty: an input is missing there.</div>}
                            {!preview.overlap_checked && <div className="ex-modelcol-note--EX">No common time axis with the training data: overlap could not be checked.</div>}
                            {preview.tail?.x?.length > 0 && (
                                <Plot height={80} data={[{ x: preview.tail.x, y: preview.tail.y, type: 'scatter', mode: 'lines', line: { color: PLOT_COLORS.series[2], width: 1.2 }, hoverinfo: 'y' }]}
                                    layout={{ margin: { l: 4, r: 4, t: 4, b: 4 }, xaxis: { visible: false, type: 'date' }, yaxis: { visible: false }, showlegend: false }} />
                            )}
                        </div>
                    )}
                    {error && <div className="ex-error--EX small">{error}</div>}
                    <div className="ex-editor-actions--EX">
                        <button type="button" className="form-button" disabled={!name || !preview || !!previewError || saving || preview.predicted === 0} onClick={create}>
                            {saving ? 'Creating…' : 'Create column'}
                        </button>
                    </div>
                </>
            )}
        </div>
    );
}

export default ModelColumn;
