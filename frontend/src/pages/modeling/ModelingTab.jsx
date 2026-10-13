import React, { useState, useEffect, useMemo, useCallback } from "react";

import { apiRequests } from '../../services/api_requests.js';
import { appEvents } from '../../services/events.js';
import { formatCount, formatNumber, formatPct, formatDate, parseUtc } from '../../services/format.js';
import { AppLoader, TrashIcon } from '../../components/Utils.jsx';
import { MultiInput, FormulaInput } from '../explore/ExplorePanels.jsx';
import ViewBar from '../dataset/ViewBar.jsx';
import ModelingResults from './ModelingResults.jsx';

import "./Modeling.css";


const STORAGE_KEY = (id) => `dv_modeling_${id}`;

const defaultConfig = (catalog) => {
    const base = catalog.numeric[0] || '';
    return {
        target: base ? `lead(${base}, 1) > ${base}` : '',
        task: 'auto',
        positive_class: '',
        features: catalog.numeric.filter(c => c !== base).slice(0, 5),
        scaling: 'standard',
        missing: 'drop',
        one_hot: true,
        max_rows: 0,
        split: catalog.time ? 'chrono_holdout' : 'random_holdout',
        test_size: 0.2,
        n_splits: 5,
        gap: 1,
        window: 'expanding',
        max_train_size: 0,
        stratify: true,
        seed: 42,
        permutation: true,
        models: [],
        model_params: {},
    };
};


/*=====================================================================================*/
/*                                  Split diagram                                      */
/*=====================================================================================*/

// Schema des folds calcule cote client avec la meme logique que le backend (proportions)
function splitSchema(config, n = 1000) {
    const gap = Math.min(Number(config.gap) || 0, n / 10);
    const k = Math.max(2, Number(config.n_splits) || 5);
    switch (config.split) {
        case 'chrono_holdout': {
            const test = Math.round(n * config.test_size);
            return [[{ kind: 'train', from: 0, to: n - test - gap }, { kind: 'gap', from: n - test - gap, to: n - test }, { kind: 'test', from: n - test, to: n }]];
        }
        case 'walk_forward': {
            const testSize = Math.floor(n / (k + 1));
            return Array.from({ length: k }, (_, i) => {
                const testStart = n - (k - i) * testSize;
                const trainEnd = testStart - gap;
                const trainStart = config.window === 'sliding' && config.max_train_size ? Math.max(0, trainEnd - (config.max_train_size / Math.max(1, config.rows || n)) * n) : 0;
                return [{ kind: 'unused', from: 0, to: trainStart }, { kind: 'train', from: trainStart, to: trainEnd }, { kind: 'gap', from: trainEnd, to: testStart }, { kind: 'test', from: testStart, to: testStart + testSize }, { kind: 'unused', from: testStart + testSize, to: n }];
            });
        }
        case 'blocked_kfold': {
            const size = n / k;
            return Array.from({ length: k }, (_, i) => {
                const a = i * size, b = (i + 1) * size;
                return [{ kind: 'train', from: 0, to: Math.max(0, a - gap) }, { kind: 'gap', from: Math.max(0, a - gap), to: a }, { kind: 'test', from: a, to: b }, { kind: 'gap', from: b, to: Math.min(n, b + gap) }, { kind: 'train', from: Math.min(n, b + gap), to: n }];
            });
        }
        case 'random_holdout':
        case 'kfold': {
            // lignes tirees au hasard : on represente des petits blocs disperses
            const folds = config.split === 'kfold' ? k : 1;
            const share = config.split === 'kfold' ? 1 / k : config.test_size;
            let seed = 7;
            const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
            return Array.from({ length: folds }, () => {
                const segs = [];
                for (let x = 0; x < n; x += 20) segs.push({ kind: rand() < share ? 'test' : 'train', from: x, to: x + 20 });
                return segs;
            });
        }
        default:
            return [];
    }
}

function SplitDiagram({ config }) {
    const folds = splitSchema(config);
    return (
        <div className="md-split-diagram--MD">
            {folds.map((segs, i) => (
                <div key={i} className="md-split-row--MD">
                    <span>{folds.length > 1 ? `fold ${i + 1}` : ''}</span>
                    <div className="md-split-bar--MD">
                        {segs.filter(s => s.to > s.from).map((s, j) => (
                            <i key={j} className={s.kind} style={{ left: `${s.from / 10}%`, width: `${(s.to - s.from) / 10}%` }} />
                        ))}
                    </div>
                </div>
            ))}
            <div className="md-split-legend--MD"><i className="train" /> train <i className="test" /> test <i className="gap" /> gap (removed) {config.split === 'walk_forward' && <><i className="unused" /> not used</>}</div>
        </div>
    );
}


/*=====================================================================================*/
/*                                 Model parameters                                    */
/*=====================================================================================*/

function ParamInput({ spec, value, onChange }) {
    const v = value ?? spec.default;
    if (spec.type === 'select') {
        return <select value={v} onChange={(e) => onChange(e.target.value)}>{spec.options.map(o => <option key={o} value={o}>{o}</option>)}</select>;
    }
    if (spec.type === 'bool') {
        return <button type="button" className={`toggle md-toggle--MD ${v ? 'active' : ''}`} onClick={() => onChange(!v)}><span className="toggle-knob" /></button>;
    }
    if (spec.type === 'text') {
        return <input value={v} onChange={(e) => onChange(e.target.value)} />;
    }
    return <input type="number" value={v} min={spec.min} max={spec.max} step={spec.type === 'int' ? 1 : 'any'} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />;
}

function ModelPicker({ task, catalog, config, setConfig }) {
    const [open, setOpen] = useState(null);
    const models = catalog.models[task] || {};
    const selected = new Set(config.models);
    const toggle = (key) => setConfig(c => ({ ...c, models: selected.has(key) ? c.models.filter(m => m !== key) : [...c.models, key] }));
    const setParam = (key, name, value) => setConfig(c => ({ ...c, model_params: { ...c.model_params, [key]: { ...(c.model_params[key] || {}), [name]: value } } }));
    const families = [...new Set(Object.values(models).map(m => m.family))];

    return (
        <div className="md-models--MD">
            <div className="md-models-actions--MD">
                <button type="button" className="lab-ghost-btn--DS" onClick={() => setConfig(c => ({ ...c, models: Object.keys(models).filter(k => k !== 'baseline') }))}>All</button>
                <button type="button" className="lab-ghost-btn--DS" onClick={() => setConfig(c => ({ ...c, models: Object.keys(models).filter(k => !['svr', 'svc', 'mlp', 'knn', 'baseline'].includes(k)) }))}>Fast set</button>
                <button type="button" className="lab-ghost-btn--DS" onClick={() => setConfig(c => ({ ...c, models: [] }))}>None</button>
            </div>
            {families.map(family => (
                <div key={family} className="md-model-family--MD">
                    <span className="md-family-label--MD">{family}</span>
                    {Object.entries(models).filter(([, m]) => m.family === family).map(([key, m]) => {
                        const isOn = key === 'baseline' || selected.has(key);
                        const hasParams = Object.keys(m.params).length > 0;
                        return (
                            <div key={key} className={`md-model--MD ${isOn ? 'on' : ''}`}>
                                <div className="md-model-head--MD">
                                    <button type="button" className={`md-check--MD ${isOn ? 'on' : ''}`} disabled={key === 'baseline'} onClick={() => toggle(key)}>{isOn ? '✓' : ''}</button>
                                    <div className="md-model-name--MD" onClick={() => key !== 'baseline' && toggle(key)}>
                                        <b>{m.label}</b>
                                        <span>{key === 'baseline' ? 'always included — the bar to beat' : m.help}</span>
                                    </div>
                                    {hasParams && (
                                        <button type="button" className="md-params-btn--MD" onClick={() => setOpen(open === key ? null : key)} title="Hyperparameters">⚙</button>
                                    )}
                                </div>
                                {open === key && hasParams && (
                                    <div className="md-params--MD">
                                        {Object.entries(m.params).map(([name, spec]) => (
                                            <label key={name} title={spec.help}>
                                                <span>{name}{spec.help ? <em> — {spec.help}</em> : null}</span>
                                                <ParamInput spec={spec} value={config.model_params[key]?.[name]} onChange={(v) => setParam(key, name, v)} />
                                            </label>
                                        ))}
                                        <button type="button" className="md-link--MD" onClick={() => setConfig(c => ({ ...c, model_params: { ...c.model_params, [key]: {} } }))}>reset defaults</button>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            ))}
        </div>
    );
}


/*=====================================================================================*/
/*                                      Tab                                            */
/*=====================================================================================*/

function Section({ title, children, hint }) {
    return (
        <section className="md-section--MD">
            <h3>{title}</h3>
            {hint && <p className="md-hint--MD">{hint}</p>}
            {children}
        </section>
    );
}

function ModelingTab({ dataset, catalog, onChanged }) {
    const view = useMemo(() => dataset.view_settings || {}, [dataset.view_settings]);
    const [modelCatalog, setModelCatalog] = useState(null);
    const [config, setConfig] = useState(() => {
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY(dataset.dataset_id)));
            if (saved) return { ...defaultConfig(catalog), ...saved };
        } catch {
            // stockage indisponible
        }
        return defaultConfig(catalog);
    });
    const [preview, setPreview] = useState(null);
    const [previewError, setPreviewError] = useState(null);
    const [runs, setRuns] = useState([]);
    const [selectedRun, setSelectedRun] = useState(null);
    const [runName, setRunName] = useState('');
    const [renaming, setRenaming] = useState(null); // { id, value }
    const [starting, setStarting] = useState(false);
    const [startError, setStartError] = useState(null);

    useEffect(() => { apiRequests.getModelCatalog().then(setModelCatalog).catch(err => setStartError(err.message)); }, []);

    useEffect(() => {
        try {
            localStorage.setItem(STORAGE_KEY(dataset.dataset_id), JSON.stringify(config));
        } catch {
            // stockage indisponible
        }
    }, [config, dataset.dataset_id]);

    const loadRuns = useCallback(() => {
        apiRequests.getModelRuns(dataset.dataset_id)
            .then(list => { setRuns(list); setSelectedRun(prev => prev ?? list.find(r => r.status === 'done')?.run_id ?? null); })
            .catch(err => setStartError(err.message));
    }, [dataset.dataset_id]);

    useEffect(() => { loadRuns(); }, [loadRuns]);

    // progression en direct des lancements
    useEffect(() => appEvents.on('model_run', payload => {
        if (payload.dataset_id !== dataset.dataset_id) return;
        if (payload.status === 'running') {
            setRuns(prev => prev.map(r => (r.run_id === payload.run_id ? { ...r, progress: payload.progress } : r)));
        } else {
            loadRuns();
            if (payload.status === 'done') setSelectedRun(payload.run_id);
        }
    }), [dataset.dataset_id, loadRuns]);

    // apercu (tache, classes, gap suggere, avertissements) a chaque changement de la configuration
    const previewKey = JSON.stringify([config.target, config.features, config.task, config.split, config.gap, config.missing, config.one_hot, config.max_rows, view]);
    useEffect(() => {
        if (!config.target || !config.features.length) {
            setPreview(null);
            return;
        }
        const timer = setTimeout(() => {
            apiRequests.modelPreview(dataset.dataset_id, config, view)
                .then(p => { setPreview(p); setPreviewError(null); })
                .catch(err => { setPreview(null); setPreviewError(err.message); });
        }, 500);
        return () => clearTimeout(timer);
    }, [previewKey, dataset.dataset_id]);

    const set = (patch) => setConfig(c => ({ ...c, ...patch }));
    const task = config.task === 'auto' ? (preview?.task || 'regression') : config.task;
    const isCv = ['walk_forward', 'blocked_kfold', 'kfold'].includes(config.split);
    const timeSafe = modelCatalog?.splits[config.split]?.time_safe;

    const run = () => {
        setStarting(true);
        setStartError(null);
        apiRequests.runModels(dataset.dataset_id, config, view, runName || null)
            .then(({ run_id }) => { setSelectedRun(run_id); loadRuns(); })
            .catch(err => setStartError(err.message))
            .finally(() => setStarting(false));
    };

    const commitRename = () => {
        const { id, value } = renaming;
        setRenaming(null);
        if (!value.trim()) return;
        apiRequests.renameModelRun(id, value.trim()).then(loadRuns).catch(err => setStartError(err.message));
    };

    const deleteRun = (runId) => {
        apiRequests.deleteModelRun(runId).then(() => {
            if (selectedRun === runId) setSelectedRun(null);
            loadRuns();
        });
    };

    if (!modelCatalog) return <div className="md-loading--MD"><AppLoader label="Loading models" /></div>;

    const running = runs.filter(r => r.status === 'running');
    const current = runs.find(r => r.run_id === selectedRun);

    return (
        <div className="modeling--MD">
            {/* ─────────────────────────── Configuration ─────────────────────────── */}
            <aside className="md-config--MD">
                <Section title="1 · Target" hint="The column to predict — create it in Explore › New column (e.g. a shifted column with lead()).">
                    <FormulaInput value={config.target} onChange={(target) => set({ target })} placeholder="target column" wide single />
                    <div className="md-row--MD">
                        <label className="md-field--MD">
                            <span>Task</span>
                            <select value={config.task} onChange={(e) => set({ task: e.target.value })}>
                                <option value="auto">Auto{preview ? ` (${preview.task})` : ''}</option>
                                <option value="regression">Regression (a number)</option>
                                <option value="classification">Classification (a class)</option>
                            </select>
                        </label>
                        {preview?.task === 'classification' && preview.classes?.length === 2 && (
                            <label className="md-field--MD">
                                <span>Positive class</span>
                                <select value={config.positive_class || preview.classes[1]} onChange={(e) => set({ positive_class: e.target.value })}>
                                    {preview.classes.map(c => <option key={c} value={c}>{c}</option>)}
                                </select>
                            </label>
                        )}
                    </div>

                    {previewError && <div className="md-error--MD">{previewError}</div>}
                    {preview && (
                        <div className="md-preview--MD">
                            <div className="md-preview-line--MD">
                                <b>{formatCount(preview.rows)}</b> usable rows · <b>{preview.features.length}</b> inputs
                                {preview.encoded?.length > 0 && <> (one-hot: {preview.encoded.join(', ')})</>}
                            </div>
                            {preview.class_counts && (
                                <div className="md-classes--MD">
                                    {Object.entries(preview.class_counts).map(([c, n]) => (
                                        <div key={c}><span>{c}</span><i style={{ width: `${(n / preview.rows) * 100}%` }} /><em>{formatPct(n / preview.rows)}</em></div>
                                    ))}
                                </div>
                            )}
                            {preview.target_stats && (
                                <div className="md-preview-line--MD">target mean {formatNumber(preview.target_stats.mean)} · std {formatNumber(preview.target_stats.std)} · range {formatNumber(preview.target_stats.min)} … {formatNumber(preview.target_stats.max)}</div>
                            )}
                            {preview.target_lookahead && (
                                <div className="md-preview-line--MD look--MD">
                                    Target looks {preview.lead_horizon} row{preview.lead_horizon > 1 ? 's' : ''} ahead
                                    {timeSafe && config.gap < preview.suggested_gap && (
                                        <button type="button" onClick={() => set({ gap: preview.suggested_gap })}>use gap = {preview.suggested_gap}</button>
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                </Section>

                <Section title="2 · Inputs" hint="Explanatory columns or formulas. Anything using lead() is refused: it would leak the future.">
                    <MultiInput values={config.features} onChange={(features) => set({ features })} max={60} />
                    <div className="md-models-actions--MD">
                        <button type="button" className="lab-ghost-btn--DS" onClick={() => set({ features: catalog.numeric.filter(c => !config.target.includes(c)) })}>All numeric (except target)</button>
                        <button type="button" className="lab-ghost-btn--DS" onClick={() => set({ features: [] })}>Clear</button>
                    </div>
                </Section>

                <Section title="3 · Preprocessing">
                    <div className="md-row--MD">
                        <label className="md-field--MD">
                            <span>Scaling</span>
                            <select value={config.scaling} onChange={(e) => set({ scaling: e.target.value })}>
                                <option value="none">None</option>
                                <option value="standard">Standard (z-score)</option>
                                <option value="minmax">Min-max (0-1)</option>
                                <option value="robust">Robust (median / IQR)</option>
                            </select>
                        </label>
                        <label className="md-field--MD">
                            <span>Missing values</span>
                            <select value={config.missing} onChange={(e) => set({ missing: e.target.value })}>
                                <option value="drop">Drop rows</option>
                                <option value="mean">Fill with mean</option>
                                <option value="median">Fill with median</option>
                            </select>
                        </label>
                    </div>
                    <div className="md-row--MD">
                        <label className="md-field--MD">
                            <span>Max rows (0 = all, keeps the latest)</span>
                            <input type="number" min={0} value={config.max_rows} onChange={(e) => set({ max_rows: Number(e.target.value) || 0 })} />
                        </label>
                        <label className="md-inline--MD">
                            <button type="button" className={`toggle md-toggle--MD ${config.one_hot ? 'active' : ''}`} onClick={() => set({ one_hot: !config.one_hot })}><span className="toggle-knob" /></button>
                            One-hot categoricals
                        </label>
                    </div>
                    <p className="md-hint--MD">Scalers and imputers are fitted on the training rows only (inside each fold), never on the test.</p>
                </Section>

                <Section title="4 · Train / test split">
                    <div className="md-splits--MD">
                        {Object.entries(modelCatalog.splits).map(([key, s]) => (
                            <button key={key} type="button" className={`md-split--MD ${config.split === key ? 'on' : ''} ${catalog.time && !s.time_safe ? 'risky' : ''}`} onClick={() => set({ split: key })}>
                                <b>{s.label}{catalog.time && !s.time_safe && <em> ⚠ leaks on time series</em>}</b>
                                <span>{s.help}</span>
                            </button>
                        ))}
                    </div>
                    <div className="md-row--MD">
                        {!isCv && (
                            <label className="md-field--MD">
                                <span>Test size: {Math.round(config.test_size * 100)}%</span>
                                <input type="range" min={0.05} max={0.5} step={0.05} value={config.test_size} onChange={(e) => set({ test_size: Number(e.target.value) })} />
                            </label>
                        )}
                        {isCv && (
                            <label className="md-field--MD">
                                <span>{config.split === 'walk_forward' ? 'Number of tests' : 'Folds'}</span>
                                <input type="number" min={2} max={20} value={config.n_splits} onChange={(e) => set({ n_splits: Number(e.target.value) || 2 })} />
                            </label>
                        )}
                        {timeSafe && (
                            <label className="md-field--MD">
                                <span>Gap (rows removed)</span>
                                <input type="number" min={0} value={config.gap} onChange={(e) => set({ gap: Number(e.target.value) || 0 })} />
                            </label>
                        )}
                        {!timeSafe && (
                            <label className="md-field--MD">
                                <span>Random seed</span>
                                <input type="number" value={config.seed} onChange={(e) => set({ seed: Number(e.target.value) || 0 })} />
                            </label>
                        )}
                    </div>
                    {config.split === 'walk_forward' && (
                        <div className="md-row--MD">
                            <label className="md-field--MD">
                                <span>Training window</span>
                                <select value={config.window} onChange={(e) => set({ window: e.target.value })}>
                                    <option value="expanding">Expanding (all the past)</option>
                                    <option value="sliding">Sliding (last N rows)</option>
                                </select>
                            </label>
                            {config.window === 'sliding' && (
                                <label className="md-field--MD">
                                    <span>Window size (rows)</span>
                                    <input type="number" min={10} value={config.max_train_size || 5000} onChange={(e) => set({ max_train_size: Number(e.target.value) || 0 })} />
                                </label>
                            )}
                        </div>
                    )}
                    {task === 'classification' && ['random_holdout', 'kfold'].includes(config.split) && (
                        <label className="md-inline--MD">
                            <button type="button" className={`toggle md-toggle--MD ${config.stratify ? 'active' : ''}`} onClick={() => set({ stratify: !config.stratify })}><span className="toggle-knob" /></button>
                            Stratify (same class proportions in train and test)
                        </label>
                    )}
                    <SplitDiagram config={{ ...config, rows: preview?.rows }} />
                </Section>

                <Section title={`5 · Models (${task})`}>
                    <ModelPicker task={task} catalog={modelCatalog} config={config} setConfig={setConfig} />
                    <label className="md-inline--MD">
                        <button type="button" className={`toggle md-toggle--MD ${config.permutation ? 'active' : ''}`} onClick={() => set({ permutation: !config.permutation })}><span className="toggle-knob" /></button>
                        Permutation importance (slower, model-agnostic)
                    </label>
                </Section>

                {preview?.warnings?.length > 0 && (
                    <div className="md-warnings--MD">
                        {preview.warnings.map(w => <div key={w}>⚠ {w}</div>)}
                    </div>
                )}

                <div className="md-run--MD">
                    <input placeholder="model name (optional) — names the kept model" value={runName} onChange={(e) => setRunName(e.target.value)} />
                    <button type="button" className="form-button md-run-btn--MD" onClick={run} disabled={starting || !preview || config.models.length === 0}>
                        {starting ? 'Starting…' : `Train ${config.models.length + 1} model${config.models.length ? 's' : ''}`}
                    </button>
                </div>
                {startError && <div className="md-error--MD">{startError}</div>}
            </aside>

            {/* ─────────────────────────────── Results ─────────────────────────────── */}
            <main className="md-main--MD">
                <ViewBar dataset={dataset} onSaved={(settings) => onChanged({ ...dataset, view_settings: settings })} />

                <div className="md-runs--MD">
                    {runs.length === 0 && <div className="empty-state"><p>No run yet — configure the target, inputs and models, then train.</p></div>}
                    {runs.map(r => {
                        const p = r.progress;
                        const best = r.summary?.filter(m => !m.error && m.key !== 'baseline')
                            .sort((a, b) => (b.test?.[r.info?.task === 'classification' ? 'roc_auc' : 'r2'] ?? -1e9) - (a.test?.[r.info?.task === 'classification' ? 'roc_auc' : 'r2'] ?? -1e9))[0];
                        return (
                            <div key={r.run_id} className={`md-run-card--MD ${selectedRun === r.run_id ? 'on' : ''} ${r.status}`} onClick={() => r.status === 'done' && setSelectedRun(r.run_id)}>
                                <div className="md-run-card-head--MD">
                                    {renaming?.id === r.run_id ? (
                                        <input className="md-run-rename--MD" autoFocus value={renaming.value} maxLength={80}
                                            onClick={(e) => e.stopPropagation()} onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
                                            onBlur={commitRename} onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(null); }} />
                                    ) : (
                                        <b>#{r.run_id} {r.name}<button type="button" className="md-run-edit--MD" title="Rename (this is also the name of the kept model)"
                                            onClick={(e) => { e.stopPropagation(); setRenaming({ id: r.run_id, value: r.name }); }}>✎</button></b>
                                    )}
                                    <span className={`md-status--MD ${r.status}`}>{r.status}</span>
                                </div>
                                <span className="md-run-meta--MD">{formatDate(parseUtc(r.created_at))} · {r.config?.split?.replace('_', ' ')} · {(r.config?.models?.length || 0) + 1} models</span>
                                {r.status === 'running' && (
                                    <div className="md-run-progress--MD">
                                        <div><i style={{ width: `${p ? (p.done / Math.max(1, p.total)) * 100 : 3}%` }} /></div>
                                        <span>{p?.label || 'starting'}</span>
                                        <button type="button" onClick={(e) => { e.stopPropagation(); apiRequests.cancelModelRun(r.run_id); }}>cancel</button>
                                    </div>
                                )}
                                {r.status === 'done' && best && (
                                    <span className="md-run-best--MD">best: {best.label} · {r.info.task === 'classification' ? `AUC ${formatNumber(best.test.roc_auc, 3)}` : `R² ${formatNumber(best.test.r2, 3)}`}</span>
                                )}
                                {r.error && <span className="md-run-error--MD">{r.error}</span>}
                                <button type="button" className="md-run-delete--MD" title="Delete run" onClick={(e) => { e.stopPropagation(); deleteRun(r.run_id); }}><TrashIcon size={12} /></button>
                            </div>
                        );
                    })}
                </div>

                {running.length > 0 && !current && <div className="md-loading--MD"><AppLoader label="Training" /></div>}
                {current && current.status === 'done' && <ModelingResults run={current} catalog={modelCatalog} />}
            </main>
        </div>
    );
}

export default ModelingTab;
