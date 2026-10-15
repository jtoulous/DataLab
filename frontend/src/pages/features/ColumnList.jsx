import React, { useMemo, useState } from "react";

import { formatCount, formatNumber } from '../../services/format.js';
import { TypeBadge } from '../../components/Utils.jsx';


// Toutes les colonnes du dataset, groupees : creees par formule, issues d'un modele, heritees du dataset
// d'origine (sous-dataset / resample), puis celles du fichier par type. Sans `actions` : lecture seule.
function ColumnList({ dataset, catalog, actions = null, emptyHint = 'Create columns in the Features tab' }) {
    const [filter, setFilter] = useState('');
    const f = filter.toLowerCase();
    const inherited = dataset.origin?.inherited || {};
    const frozen = dataset.frozen || {};
    const isResample = dataset.origin?.kind === 'resample';

    const groups = useMemo(() => {
        const byType = {};
        catalog.columns.filter(c => !inherited[c.key] && !frozen[c.key]).forEach(c => { (byType[c.type] ||= []).push(c); });
        return byType;
    }, [catalog, inherited, frozen]);

    const match = (...texts) => !f || texts.some(t => (t || '').toLowerCase().includes(f));
    const derived = catalog.derived.filter(c => match(c.key, c.formula));
    const models = Object.entries(frozen).filter(([key, c]) => !['aggregate', 'first_touch'].includes(c.kind) && match(key));
    const touches = Object.entries(frozen).filter(([key, c]) => c.kind === 'first_touch' && match(key, c.recipe));
    const aggregated = Object.entries(frozen).filter(([key, c]) => c.kind === 'aggregate' && match(key, c.recipe));
    const inheritedShown = Object.entries(inherited).filter(([key, c]) => match(key, c.formula));

    return (
        <>
            <input className="ex-search--EX" placeholder="filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <div className="ex-columns--EX">
                <div className="ex-columns-group--EX"><TypeBadge type="derived" /> my columns</div>
                {catalog.derived.length === 0 && <div className="ex-columns-empty--EX">{emptyHint}</div>}
                {derived.map(c => (
                    <div key={c.key} className="ex-column--EX derived" title={c.description || c.formula}>
                        <div><b>{c.key}</b><code>{c.formula}</code></div>
                        {actions && (
                            <div className="ex-column-actions--EX">
                                <button type="button" title="Edit" onClick={() => actions.edit(c)}>✎</button>
                                <button type="button" title="Delete" onClick={() => actions.deleteColumn(c.key)}>✕</button>
                            </div>
                        )}
                    </div>
                ))}

                {models.length > 0 && (
                    <>
                        <div className="ex-columns-group--EX"><span className="ex-model-badge--EX">◆ model</span> predictions kept as values</div>
                        {models.map(([key, c]) => (
                            <div key={key} className="ex-column--EX derived model" title={`${c.run_name} · trained on ${c.trained_on}\ntarget: ${c.target}\n${formatCount(c.predicted)} rows predicted, ${formatCount(c.left_empty)} left empty`}>
                                <div><b>{key}</b><code>{c.model_label} · {c.output} · trained on {c.trained_on}</code></div>
                                {actions && (
                                    <div className="ex-column-actions--EX">
                                        <button type="button" title="Delete" onClick={() => actions.deleteModelColumn(key)}>✕</button>
                                    </div>
                                )}
                            </div>
                        ))}
                    </>
                )}

                {aggregated.length > 0 && (
                    <>
                        <div className="ex-columns-group--EX"><span className="ex-agg-badge--EX">⇣ finer data</span> aggregated per candle</div>
                        {aggregated.map(([key, c]) => (
                            <div key={key} className="ex-column--EX derived aggregate" title={`${c.recipe}\nfrom ${c.source_name}\n${formatCount(c.filled)} candles filled`}>
                                <div><b>{key}{c.lookahead && <i className="ex-target-tag--EX">target</i>}</b><code>{c.recipe} · from {c.source_name}</code></div>
                                {actions && (
                                    <div className="ex-column-actions--EX">
                                        <button type="button" title="Delete" onClick={() => actions.deleteModelColumn(key)}>✕</button>
                                    </div>
                                )}
                            </div>
                        ))}
                    </>
                )}

                {touches.length > 0 && (
                    <>
                        <div className="ex-columns-group--EX"><span className="ex-touch-badge--EX">⇥ first touch</span> labels (targets)</div>
                        {touches.map(([key, c]) => (
                            <div key={key} className="ex-column--EX derived touch" title={c.recipe}>
                                <div><b>{key}<i className="ex-target-tag--EX">target</i></b><code>{c.output === 'rows' ? 'rows until the touch' : `1 / -1 / 0 within ${c.horizon} rows`}</code></div>
                                {actions && (
                                    <div className="ex-column-actions--EX">
                                        <button type="button" title="Delete" onClick={() => actions.deleteModelColumn(key)}>✕</button>
                                    </div>
                                )}
                            </div>
                        ))}
                    </>
                )}

                {inheritedShown.length > 0 && (
                    <>
                        <div className="ex-columns-group--EX">
                            <span className="ex-inherited-badge--EX">⤷ {isResample ? 'resampled' : 'inherited'}</span>
                            {isResample ? `aggregated from ${dataset.origin.parent_name}` : `frozen values from ${dataset.origin.parent_name}`}
                        </div>
                        {inheritedShown.map(([key, c]) => (
                            <div key={key} className="ex-column--EX inherited" title={`${c.description ? `${c.description}\n` : ''}Computed on ${c.from} with: ${c.formula}`}>
                                <div><b>{key}{c.lookahead && <i className="ex-target-tag--EX">target</i>}</b><code>{c.formula}</code></div>
                            </div>
                        ))}
                    </>
                )}

                {Object.entries(groups).map(([type, cols]) => {
                    const shown = cols.filter(c => match(c.key, c.label));
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
        </>
    );
}

export default ColumnList;
