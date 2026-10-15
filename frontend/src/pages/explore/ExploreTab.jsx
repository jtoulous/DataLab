import React, { useState, useEffect, useMemo, useCallback, useRef, memo } from "react";

import { apiRequests } from '../../services/api_requests.js';
import { formatCount, formatDate } from '../../services/format.js';
import { AppLoader, CloseIcon } from '../../components/Utils.jsx';
import ErrorBoundary from '../../components/ErrorBoundary.jsx';
import { PlotScaleContext, PLOT_SCALES, DEFAULT_PLOT_SCALE } from '../../components/plotScale.js';
import ColumnList from '../features/ColumnList.jsx';
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

    const scale = panel.scale ?? DEFAULT_PLOT_SCALE;
    const nextScale = PLOT_SCALES[(PLOT_SCALES.indexOf(scale) + 1) % PLOT_SCALES.length] ?? PLOT_SCALES[0];
    const scaleLabel = (x) => (x <= 1 ? 'normal' : x < 2 ? 'tall' : 'very tall');

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
                    <button type="button" title={`Plot height: ${scaleLabel(scale)} — click for ${scaleLabel(nextScale)}`} onClick={() => onChange({ ...panel, scale: nextScale })}>↕</button>
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
                                    <PlotScaleContext.Provider value={scale}>
                                        <def.Result result={result} params={panel.params} />
                                    </PlotScaleContext.Provider>
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
/*                                     Explore                                         */
/*=====================================================================================*/

function ExploreTab({ dataset, catalog, onChanged }) {
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
    return (
        <div className="explore--EX">
            {/* ─────────────────────────────── Sidebar ─────────────────────────────── */}
            <aside className="ex-sidebar--EX">
                <section className="ex-side--EX ex-columns-side--EX">
                    <h3>Columns <span>{catalog.all.length}</span></h3>
                    <ColumnList dataset={dataset} catalog={catalog} />
                    <p className="ex-columns-note--EX">Create, edit and derive data in the <b>Features</b> tab.</p>
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
