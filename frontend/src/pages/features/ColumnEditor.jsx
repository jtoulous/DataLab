import React, { useState, useEffect } from "react";

import { apiRequests } from '../../services/api_requests.js';
import { formatCount, formatNumber } from '../../services/format.js';
import Plot from '../../components/Plot.jsx';
import { PLOT_COLORS } from '../../components/plotTheme.js';
import { ColumnInput } from '../../components/ColumnInput.jsx';


/*=====================================================================================*/
/*                                  Column editor                                      */
/*=====================================================================================*/

export default function ColumnEditor({ dataset, catalog, view, editing, loaded, onFormChange, onSaved, onCancel }) {
    const empty = { name: '', formula: '', description: '' };
    const [form, setForm] = useState(editing || empty);
    const [preview, setPreview] = useState(null);
    const [error, setError] = useState(null);
    const [saving, setSaving] = useState(false);
    const [recipe, setRecipe] = useState({ base: '', horizon: 12 });

    useEffect(() => { setForm(editing || empty); }, [editing]);
    // formule choisie dans la bibliotheque : elle remplit le formulaire
    useEffect(() => { if (loaded) setForm({ name: loaded.name, formula: loaded.formula, description: loaded.description || '' }); }, [loaded]);
    useEffect(() => { onFormChange?.(form); }, [form]);

    // Colonnes "cible" : valeur future d'une colonne, decalee de `horizon` lignes (lead)
    const applyRecipe = (kind) => {
        const base = recipe.base.trim() || catalog?.numeric?.[0];
        if (!base) return;
        const h = recipe.horizon;
        const [suffix, formula, description] = {
            up: ['up', `lead(${base}, ${h}) > ${base}`, `${base} is higher ${h} rows later (true / false)`],
            return: ['ret', `lead(${base}, ${h}) / ${base} - 1`, `% change of ${base} over the next ${h} rows`],
            change: ['diff', `lead(${base}, ${h}) - ${base}`, `change of ${base} over the next ${h} rows`],
            value: ['future', `lead(${base}, ${h})`, `${base} ${h} rows later`],
        }[kind];
        setForm({ ...form, name: `${base}_${suffix}_${h}`.replace(/[^A-Za-z0-9_]/g, '_'), formula, description });
    };

    useEffect(() => {
        if (!form.formula.trim()) {
            setPreview(null);
            setError(null);
            return;
        }
        const timer = setTimeout(() => {
            apiRequests.previewFormula(dataset.dataset_id, form.formula, view)
                .then(data => { setPreview(data); setError(null); })
                .catch(err => { setPreview(null); setError(err.message); });
        }, 400);
        return () => clearTimeout(timer);
    }, [form.formula, dataset.dataset_id, JSON.stringify(view)]);

    const save = () => {
        setSaving(true);
        apiRequests.saveColumn(dataset.dataset_id, form)
            .then(data => { onSaved(data.derived_columns); setForm(empty); setPreview(null); })
            .catch(err => setError(err.message))
            .finally(() => setSaving(false));
    };

    const s = preview?.stats;
    return (
        <div className="ex-editor--EX">
            <input className="mono--DS" placeholder="new_column_name" value={form.name} spellCheck={false}
                onChange={(e) => setForm({ ...form, name: e.target.value.replace(/[^A-Za-z0-9_]/g, '_') })} disabled={!!editing} />
            <textarea className="mono--DS" rows={3} placeholder='e.g. (value - mean(value, 50)) / std(value, 50)' value={form.formula} spellCheck={false}
                onChange={(e) => setForm({ ...form, formula: e.target.value })} />
            <input placeholder="description (optional)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />

            {!editing && (
                <div className="ex-recipes--EX">
                    <span>Target from</span>
                    <ColumnInput placeholder={catalog?.numeric?.[0] || 'column'} value={recipe.base} onChange={(base) => setRecipe({ ...recipe, base })} />
                    <span>in</span>
                    <input type="number" min={1} value={recipe.horizon} onChange={(e) => setRecipe({ ...recipe, horizon: Number(e.target.value) || 1 })} />
                    <span>rows:</span>
                    <div>
                        <button type="button" onClick={() => applyRecipe('up')} title="true / false: usable for classification">goes up?</button>
                        <button type="button" onClick={() => applyRecipe('return')} title="number: usable for regression">% change</button>
                        <button type="button" onClick={() => applyRecipe('change')} title="number: usable for regression">difference</button>
                        <button type="button" onClick={() => applyRecipe('value')} title="number: usable for regression">future value</button>
                    </div>
                </div>
            )}

            {error && <div className="ex-error--EX small">{error}</div>}
            {preview && (
                <div className="ex-preview--EX">
                    {preview.lookahead && <div className="ex-lookahead--EX">LOOKAHEAD — uses following rows: fine as a label/target, just never use it as a model input. The column still saves normally below.</div>}
                    {preview.numeric ? (
                        <>
                            <div className="ex-preview-stats--EX">
                                <span>n <b>{formatCount(s.count)}</b></span>
                                <span>missing <b>{formatCount(s.missing)}</b></span>
                                <span>mean <b>{formatNumber(s.mean, 3)}</b></span>
                                <span>std <b>{formatNumber(s.std, 3)}</b></span>
                            </div>
                            <Plot height={80} data={[{ x: preview.tail.x, y: preview.tail.y, type: 'scatter', mode: 'lines', line: { color: PLOT_COLORS.real, width: 1.2 }, hoverinfo: 'y' }]}
                                layout={{ margin: { l: 4, r: 4, t: 4, b: 4 }, xaxis: { visible: false, type: dataset.profile.time ? 'date' : '-' }, yaxis: { visible: false }, showlegend: false }} />
                        </>
                    ) : (
                        <div className="ex-preview-stats--EX">
                            <span>categories <b>{formatCount(s.unique)}</b></span>
                            {preview.top?.slice(0, 4).map(t => <span key={t.value}>{t.value} <b>{formatCount(t.count)}</b></span>)}
                        </div>
                    )}
                </div>
            )}

            <div className="ex-editor-actions--EX">
                {editing && <button type="button" className="lab-ghost-btn--DS" onClick={onCancel}>Cancel</button>}
                <button type="button" className="form-button" disabled={!form.name || !form.formula || !!error || saving} onClick={save}>
                    {saving ? 'Saving…' : editing ? 'Update' : 'Create column'}
                </button>
            </div>
        </div>
    );
}
