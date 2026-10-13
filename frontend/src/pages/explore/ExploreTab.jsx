import React, { useState, useEffect, useMemo, useCallback, useRef, memo } from "react";

import { GlobalState } from '../../State.jsx';
import { apiRequests } from '../../services/api_requests.js';
import { formatCount, formatNumber, formatDate } from '../../services/format.js';
import { AppLoader, TypeBadge, CloseIcon } from '../../components/Utils.jsx';
import Plot from '../../components/Plot.jsx';
import ErrorBoundary from '../../components/ErrorBoundary.jsx';
import { PLOT_COLORS } from '../../components/plotTheme.js';
import { ColumnInput } from '../../components/ColumnInput.jsx';
import ModelColumn from './ModelColumn.jsx';
import ViewBar from '../dataset/ViewBar.jsx';
import { PANEL_TYPES, PANEL_GROUPS } from './ExplorePanels.jsx';

import "./Explore.css";


const newId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const WIDE = ['series', 'correlation', 'runs', 'splom', 'pca', 'regression', 'missing', 'binned'];

// Premiers panneaux proposes selon le contenu du dataset (aucune hypothese sur le metier)
function starterPanels(catalog) {
    const make = (type) => ({ id: newId(), type, params: PANEL_TYPES[type].defaults(catalog), wide: WIDE.includes(type) });
    const panels = [];
    if (catalog.time && catalog.numeric.length) panels.push(make('series'));
    if (catalog.numeric.length) panels.push(make('stats'), make('histogram'));
    if (catalog.numeric.length >= 2) panels.push(make('correlation'));
    if (catalog.categorical.length && catalog.numeric.length) panels.push(make('box'));
    return panels;
}


/*=====================================================================================*/
/*                                      Panel                                          */
/*=====================================================================================*/

const ExplorePanel = memo(function ExplorePanel({ panel, dataset, catalog, view, runToken, onChange, onRemove, onDuplicate, onMove }) {
    const def = PANEL_TYPES[panel.type];
    const [result, setResult] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [collapsed, setCollapsed] = useState(false);
    const lastRun = useRef(null);

    const run = useCallback(() => {
        const key = JSON.stringify([view, panel.params, panel.type]);
        lastRun.current = key;
        setLoading(true);
        setError(null);
        apiRequests.analyze(dataset.dataset_id, panel.type, panel.params, view)
            .then(data => { if (lastRun.current === key) setResult(data); })
            .catch(err => { if (lastRun.current === key) { setError(err.message); setResult(null); } })
            .finally(() => { if (lastRun.current === key) setLoading(false); });
    }, [dataset.dataset_id, panel.type, panel.params, view]);

    useEffect(() => {
        if (def.needsTime && !catalog.time) return;
        run();
    }, [runToken, JSON.stringify(view)]);

    const set = (patch) => onChange({ ...panel, params: { ...panel.params, ...patch } });
    const stale = !loading && lastRun.current !== JSON.stringify([view, panel.params, panel.type]);

    return (
        <div className={`ex-panel--EX ${panel.wide ? 'wide' : ''}`}>
            <div className="ex-panel-header--EX">
                <span className="ex-panel-icon--EX">{def.icon}</span>
                <div className="ex-panel-title--EX">
                    <b>{def.label}</b>
                    <span>{def.description}</span>
                </div>
                <div className="ex-panel-actions--EX">
                    <button type="button" title="Move up" onClick={() => onMove(-1)}>↑</button>
                    <button type="button" title="Move down" onClick={() => onMove(1)}>↓</button>
                    <button type="button" title={panel.wide ? 'Half width' : 'Full width'} onClick={() => onChange({ ...panel, wide: !panel.wide })}>{panel.wide ? '⇥⇤' : '⇤⇥'}</button>
                    <button type="button" title="Duplicate" onClick={onDuplicate}>⧉</button>
                    <button type="button" title={collapsed ? 'Expand' : 'Collapse'} onClick={() => setCollapsed(!collapsed)}>{collapsed ? '▸' : '▾'}</button>
                    <button type="button" title="Remove" className="danger" onClick={onRemove}>✕</button>
                </div>
            </div>

            {!collapsed && (
                <>
                    <div className="ex-panel-params--EX">
                        <def.Params params={panel.params} set={set} catalog={catalog} />
                        <button type="button" className={`ex-run--EX ${stale && result ? 'stale' : ''}`} onClick={run} disabled={loading || (def.needsTime && !catalog.time)}>
                            {loading ? 'Running…' : stale && result ? '▶ Run (changed)' : '▶ Run'}
                        </button>
                    </div>
                    <div className="ex-panel-body--EX">
                        {def.needsTime && !catalog.time && <div className="ex-error--EX">This analysis needs a time axis — set one in the Overview tab.</div>}
                        {loading && !result && <div className="ex-panel-loading--EX"><AppLoader size="sm" label="Computing" /></div>}
                        {error && <div className="ex-error--EX">{error}</div>}
                        {result && !error && (
                            <div className={loading ? 'ex-result-loading--EX' : ''}>
                                <ErrorBoundary className="ex-error--EX" resetKey={result}>
                                    <def.Result result={result} params={panel.params} />
                                </ErrorBoundary>
                                <div className="ex-panel-meta--EX">
                                    {formatCount(result.meta.rows)} rows{result.meta.start ? ` · ${formatDate(result.meta.start)} → ${formatDate(result.meta.end)}` : ''} · {result.meta.duration.toFixed(2)}s
                                </div>
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
});


/*=====================================================================================*/
/*                                  Column editor                                      */
/*=====================================================================================*/

function ColumnEditor({ dataset, catalog, view, editing, onSaved, onCancel }) {
    const empty = { name: '', formula: '', description: '' };
    const [form, setForm] = useState(editing || empty);
    const [preview, setPreview] = useState(null);
    const [error, setError] = useState(null);
    const [saving, setSaving] = useState(false);
    const [recipe, setRecipe] = useState({ base: '', horizon: 12 });

    useEffect(() => { setForm(editing || empty); }, [editing]);

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


/*=====================================================================================*/
/*                                     Explore                                         */
/*=====================================================================================*/

function ExploreTab({ dataset, catalog, onChanged }) {
    const { meta } = GlobalState();
    const storageKey = `dv_explore_${dataset.dataset_id}`;
    const view = useMemo(() => dataset.view_settings || {}, [dataset.view_settings]);

    const [panels, setPanels] = useState(() => {
        try {
            const saved = JSON.parse(localStorage.getItem(storageKey));
            if (saved?.length) return saved;
        } catch {
            // stockage indisponible
        }
        return starterPanels(catalog);
    });
    const [runToken, setRunToken] = useState(0);
    const [showAdd, setShowAdd] = useState(false);
    const [editing, setEditing] = useState(null);
    const [columnFilter, setColumnFilter] = useState('');
    const [showFunctions, setShowFunctions] = useState(false);
    const [columnMode, setColumnMode] = useState('formula');
    const [workspaceName, setWorkspaceName] = useState('');
    const [workspaces, setWorkspaces] = useState(dataset.workspaces || []);
    const [feedback, setFeedback] = useState(null);

    useEffect(() => {
        try {
            localStorage.setItem(storageKey, JSON.stringify(panels));
        } catch {
            // stockage indisponible : l'espace reste en memoire
        }
    }, [panels, storageKey]);

    useEffect(() => {
        if (!feedback) return;
        const timer = setTimeout(() => setFeedback(null), 3500);
        return () => clearTimeout(timer);
    }, [feedback]);

    const update = (id, next) => setPanels(prev => prev.map(p => (p.id === id ? next : p)));
    const remove = (id) => setPanels(prev => prev.filter(p => p.id !== id));
    const duplicate = (panel) => setPanels(prev => {
        const i = prev.findIndex(p => p.id === panel.id);
        return [...prev.slice(0, i + 1), { ...panel, id: newId() }, ...prev.slice(i + 1)];
    });
    const move = (id, delta) => setPanels(prev => {
        const i = prev.findIndex(p => p.id === id), j = i + delta;
        if (j < 0 || j >= prev.length) return prev;
        const next = [...prev];
        [next[i], next[j]] = [next[j], next[i]];
        return next;
    });
    const add = (type) => {
        setPanels(prev => [{ id: newId(), type, params: PANEL_TYPES[type].defaults(catalog), wide: WIDE.includes(type) }, ...prev]);
        setShowAdd(false);
    };

    const saveWorkspace = () => {
        if (!workspaceName.trim()) { setFeedback('Name the workspace first'); return; }
        apiRequests.saveWorkspace(dataset.dataset_id, workspaceName, { panels })
            .then(data => { setWorkspaces(data.workspaces); setFeedback(`Workspace “${workspaceName}” saved`); })
            .catch(err => setFeedback(err.message));
    };
    const loadWorkspace = (name) => {
        apiRequests.getWorkspace(dataset.dataset_id, name)
            .then(ws => { setPanels(ws.config.panels); setWorkspaceName(name); setRunToken(t => t + 1); })
            .catch(err => setFeedback(err.message));
    };
    const deleteModelColumn = (name) => {
        apiRequests.deleteFrozen(dataset.dataset_id, name)
            .then(record => onChanged(record))
            .catch(err => setFeedback(err.message));
    };
    const deleteColumn = (name) => {
        apiRequests.deleteColumn(dataset.dataset_id, name)
            .then(data => onChanged({ ...dataset, derived_columns: data.derived_columns }))
            .catch(err => setFeedback(err.message));
    };

    const f = columnFilter.toLowerCase();
    const modelColumns = Object.entries(dataset.frozen || {}).filter(([key]) => !f || key.toLowerCase().includes(f));
    // colonnes figees heritees du dataset parent : groupe a part (formule d'origine, pas modifiables)
    const inherited = dataset.origin?.inherited || {};
    const groups = useMemo(() => {
        const byType = {};
        catalog.columns.filter(c => !inherited[c.key] && !(dataset.frozen || {})[c.key]).forEach(c => { (byType[c.type] ||= []).push(c); });
        return byType;
    }, [catalog, inherited, dataset.frozen]);
    const inheritedShown = Object.entries(inherited).filter(([key, c]) => !f || key.toLowerCase().includes(f) || c.formula.toLowerCase().includes(f));

    return (
        <div className="explore--EX">
            {/* ─────────────────────────────── Sidebar ─────────────────────────────── */}
            <aside className="ex-sidebar--EX">
                <section className="ex-side--EX">
                    <h3>{editing ? `Edit “${editing.name}”` : 'New column'}</h3>
                    {!editing && (
                        <div className="ex-mode--EX">
                            <button type="button" className={columnMode === 'formula' ? 'active' : ''} onClick={() => setColumnMode('formula')}>ƒ Formula</button>
                            <button type="button" className={columnMode === 'model' ? 'active' : ''} onClick={() => setColumnMode('model')}>◆ Model prediction</button>
                        </div>
                    )}
                    {!editing && columnMode === 'model' ? (
                        <ModelColumn dataset={dataset} onSaved={(record) => { onChanged(record); setFeedback('Model column saved'); }} />
                    ) : (
                        <ColumnEditor dataset={dataset} catalog={catalog} view={view} editing={editing} onCancel={() => setEditing(null)}
                            onSaved={(columns) => { onChanged({ ...dataset, derived_columns: columns }); setEditing(null); setFeedback('Column saved'); }} />
                    )}
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
                </section>

                <section className="ex-side--EX ex-columns-side--EX">
                    <h3>Columns <span>{catalog.all.length}</span></h3>
                    <input className="ex-search--EX" placeholder="filter…" value={columnFilter} onChange={(e) => setColumnFilter(e.target.value)} />
                    <div className="ex-columns--EX">
                        <div className="ex-columns-group--EX"><TypeBadge type="derived" /> my columns</div>
                        {catalog.derived.length === 0 && <div className="ex-columns-empty--EX">Create columns with formulas above</div>}
                        {catalog.derived.filter(c => !f || c.key.toLowerCase().includes(f) || c.formula.toLowerCase().includes(f)).map(c => (
                            <div key={c.key} className="ex-column--EX derived" title={c.description || c.formula}>
                                <div><b>{c.key}</b><code>{c.formula}</code></div>
                                <div className="ex-column-actions--EX">
                                    <button type="button" title="Edit" onClick={() => setEditing({ name: c.key, formula: c.formula, description: c.description })}>✎</button>
                                    <button type="button" title="Delete" onClick={() => deleteColumn(c.key)}>✕</button>
                                </div>
                            </div>
                        ))}
                        {modelColumns.length > 0 && (
                            <>
                                <div className="ex-columns-group--EX"><span className="ex-model-badge--EX">◆ model</span> predictions kept as values</div>
                                {modelColumns.map(([key, c]) => (
                                    <div key={key} className="ex-column--EX derived model" title={`${c.run_name} · trained on ${c.trained_on}\ntarget: ${c.target}\n${formatCount(c.predicted)} rows predicted, ${formatCount(c.left_empty)} left empty`}>
                                        <div><b>{key}</b><code>{c.model_label} · {c.output} · trained on {c.trained_on}</code></div>
                                        <div className="ex-column-actions--EX">
                                            <button type="button" title="Delete" onClick={() => deleteModelColumn(key)}>✕</button>
                                        </div>
                                    </div>
                                ))}
                            </>
                        )}
                        {inheritedShown.length > 0 && (
                            <>
                                <div className="ex-columns-group--EX"><span className="ex-inherited-badge--EX">⤷ inherited</span> frozen values from {dataset.origin.parent_name}</div>
                                {inheritedShown.map(([key, c]) => (
                                    <div key={key} className="ex-column--EX inherited" title={`${c.description ? `${c.description}\n` : ''}Computed on ${c.from} with: ${c.formula}`}>
                                        <div><b>{key}{c.lookahead && <i className="ex-target-tag--EX">target</i>}</b><code>{c.formula}</code></div>
                                    </div>
                                ))}
                            </>
                        )}
                        {Object.entries(groups).map(([type, cols]) => {
                            const shown = cols.filter(c => !f || c.key.includes(f) || c.label.toLowerCase().includes(f));
                            if (!shown.length) return null;
                            return (
                                <React.Fragment key={type}>
                                    <div className="ex-columns-group--EX"><TypeBadge type={type} /> {cols.length}</div>
                                    {shown.map(c => (
                                        <div key={c.key} className="ex-column--EX" title={c.label}>
                                            <div>
                                                <b>{c.key}</b>
                                                <span>{c.stats?.mean !== undefined ? `mean ${formatNumber(c.stats.mean, 3)} · ` : ''}{c.missing ? `${formatCount(c.missing)} missing · ` : ''}{formatCount(c.unique)} unique</span>
                                            </div>
                                        </div>
                                    ))}
                                </React.Fragment>
                            );
                        })}
                    </div>
                </section>
            </aside>

            {/* ─────────────────────────────── Workspace ───────────────────────────── */}
            <main className="ex-main--EX">
                <ViewBar dataset={dataset} onSaved={(settings) => onChanged({ ...dataset, view_settings: settings })} />

                <div className="ex-toolbar--EX">
                    <div className="ex-add--EX">
                        <button type="button" className="top-button ex-top-btn--EX" onClick={() => setShowAdd(!showAdd)}>+ Add analysis</button>
                        {showAdd && (
                            <div className="ex-add-menu--EX" onMouseLeave={() => setShowAdd(false)}>
                                {PANEL_GROUPS.map(group => (
                                    <div key={group} className="ex-add-group--EX">
                                        <span>{group}</span>
                                        {Object.entries(PANEL_TYPES).filter(([, d]) => d.group === group).map(([type, d]) => (
                                            <button key={type} type="button" onClick={() => add(type)} disabled={d.needsTime && !catalog.time}>
                                                <span className="ex-panel-icon--EX">{d.icon}</span>
                                                <div><b>{d.label}</b><span>{d.needsTime && !catalog.time ? 'needs a time axis' : d.description}</span></div>
                                            </button>
                                        ))}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                    <button type="button" className="top-button ex-top-btn--EX" onClick={() => setRunToken(t => t + 1)}>↻ Run all</button>
                    <button type="button" className="lab-ghost-btn--DS" onClick={() => { setPanels(starterPanels(catalog)); setRunToken(t => t + 1); }}>Reset to starter panels</button>
                    <div className="ex-workspace--EX">
                        <input placeholder="workspace name" value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} />
                        <button type="button" className="lab-ghost-btn--DS" onClick={saveWorkspace}>Save</button>
                        {workspaces.length > 0 && (
                            <select value="" onChange={(e) => e.target.value && loadWorkspace(e.target.value)}>
                                <option value="">Open…</option>
                                {workspaces.map(w => <option key={w.name} value={w.name}>{w.name}</option>)}
                            </select>
                        )}
                    </div>
                </div>

                {panels.length === 0 && (
                    <div className="empty-state ex-empty--EX"><p>No analysis — click “+ Add analysis”.</p></div>
                )}

                <div className="ex-panels--EX">
                    {panels.map(panel => (
                        <ExplorePanel key={panel.id} panel={panel} dataset={dataset} catalog={catalog} view={view} runToken={runToken}
                            onChange={(next) => update(panel.id, next)} onRemove={() => remove(panel.id)}
                            onDuplicate={() => duplicate(panel)} onMove={(delta) => move(panel.id, delta)} />
                    ))}
                </div>
            </main>

            {feedback && <div className="ex-feedback--EX" onClick={() => setFeedback(null)}>{feedback}<CloseIcon size={12} /></div>}
        </div>
    );
}

export default ExploreTab;
