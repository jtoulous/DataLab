import React, { useState, useEffect, useMemo } from "react";

import { apiRequests } from '../../services/api_requests.js';
import { formatNumber, formatCount, formatPct, formatDate } from '../../services/format.js';
import { AppLoader } from '../../components/Utils.jsx';
import Plot from '../../components/Plot.jsx';
import ErrorBoundary from '../../components/ErrorBoundary.jsx';
import { PLOT_COLORS, SEQUENTIAL } from '../../components/plotTheme.js';


const PRED = PLOT_COLORS.real;         // prediction : orange (couleur d'accent)
const REAL = 'rgba(224, 224, 224, 0.7)'; // realite : gris clair
const fmt = (v, d = 4) => formatNumber(v, d);

// metriques ou "plus haut = mieux" sont des proportions -> affichage en %
const PERCENT_METRICS = new Set(['accuracy', 'balanced_accuracy', 'precision', 'recall', 'f1', 'sign_accuracy', 'mape']);
const showMetric = (key, v) => (v === null || v === undefined ? '—' : PERCENT_METRICS.has(key) ? formatPct(v, 1) : fmt(v, 4));


function Card({ title, children, hint, wide }) {
    return (
        <div className={`md-card--MD ${wide ? 'wide' : ''}`}>
            <div className="md-card-head--MD"><h4>{title}</h4>{hint && <span>{hint}</span>}</div>
            <ErrorBoundary className="md-error--MD">{children}</ErrorBoundary>
        </div>
    );
}

function Reading({ children }) {
    return <div className="md-reading--MD"><b>How to read it</b>{children}</div>;
}


/*=====================================================================================*/
/*                                   Leaderboard                                       */
/*=====================================================================================*/

function Leaderboard({ run, metrics, selected, onSelect }) {
    const task = run.info.task;
    const main = task === 'classification' ? 'roc_auc' : 'r2';
    const rows = run.summary;
    const baseline = rows.find(r => r.key === 'baseline');
    const [sortKey, setSortKey] = useState(main);

    const best = useMemo(() => {
        const out = {};
        metrics.forEach(m => {
            const values = rows.filter(r => !r.error && r.test?.[m.key] !== null && r.test?.[m.key] !== undefined).map(r => r.test[m.key]);
            if (values.length) out[m.key] = m.better === 'high' ? Math.max(...values) : Math.min(...values);
        });
        return out;
    }, [rows, metrics]);

    const sortSpec = metrics.find(m => m.key === sortKey) || metrics[0];
    const sorted = [...rows].sort((a, b) => {
        if (a.error) return 1;
        if (b.error) return -1;
        const va = a.test?.[sortSpec.key], vb = b.test?.[sortSpec.key];
        if (va === null || va === undefined) return 1;
        if (vb === null || vb === undefined) return -1;
        return sortSpec.better === 'high' ? vb - va : va - vb;
    });

    return (
        <div className="md-table-wrapper--MD">
            <table className="md-leaderboard--MD">
                <thead>
                    <tr>
                        <th>Model</th>
                        {metrics.map(m => (
                            <th key={m.key} title={m.help} className={sortKey === m.key ? 'sorted' : ''} onClick={() => setSortKey(m.key)}>
                                {m.label} {sortKey === m.key ? (m.better === 'high' ? '▼' : '▲') : ''}
                            </th>
                        ))}
                        <th title="Train score minus test score on the main metric — a large gap means the model memorized the training rows">Overfit</th>
                        <th>Time</th>
                    </tr>
                </thead>
                <tbody>
                    {sorted.map(r => {
                        if (r.error) {
                            return <tr key={r.key} className="error"><td>{r.label}</td><td colSpan={metrics.length + 2} className="md-error-cell--MD">{r.error}</td></tr>;
                        }
                        const gap = (r.train?.[main] ?? null) !== null && (r.test?.[main] ?? null) !== null ? r.train[main] - r.test[main] : null;
                        const beatsBaseline = baseline && r.key !== 'baseline' && r.test?.[main] !== null && baseline.test?.[main] !== null && r.test[main] > baseline.test[main];
                        return (
                            <tr key={r.key} className={`${selected === r.key ? 'on' : ''} ${r.key === 'baseline' ? 'baseline' : ''}`} onClick={() => onSelect(r.key)}>
                                <td>
                                    <b>{r.label}</b>
                                    {r.key !== 'baseline' && baseline && <span className={beatsBaseline ? 'beats' : 'loses'}>{beatsBaseline ? 'beats baseline' : 'below baseline'}</span>}
                                </td>
                                {metrics.map(m => {
                                    const v = r.test?.[m.key];
                                    const isBest = v !== null && v !== undefined && best[m.key] === v && rows.length > 1;
                                    return (
                                        <td key={m.key} className={isBest ? 'best' : ''}>
                                            <span>{showMetric(m.key, v)}</span>
                                            {r.fold_std?.[m.key] !== null && r.fold_std?.[m.key] !== undefined && <em>± {showMetric(m.key, r.fold_std[m.key])}</em>}
                                            <i title="score on the training rows">train {showMetric(m.key, r.train?.[m.key])}</i>
                                        </td>
                                    );
                                })}
                                <td className={gap !== null && gap > 0.1 ? 'overfit' : ''}>{gap === null ? '—' : fmt(gap, 3)}</td>
                                <td>{r.duration ? `${r.duration.toFixed(1)}s` : '—'}</td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}


/*=====================================================================================*/
/*                                 Feature importance                                  */
/*=====================================================================================*/

function Importance({ detail }) {
    const perm = detail.permutation_importance;
    const native = detail.native_importance;
    if (!perm && !native) return <p className="md-hint--MD">No importance available for this model.</p>;
    const names = Object.keys((perm || native).mean || native.values);
    const order = perm ? [...names].sort((a, b) => perm.mean[a] - perm.mean[b]) : [...names].sort((a, b) => Math.abs(native.values[a]) - Math.abs(native.values[b]));
    const height = Math.max(220, 26 * names.length + 70);
    return (
        <div className="md-grid-2--MD">
            {perm && (
                <Plot height={height} data={[{
                    type: 'bar', orientation: 'h', y: order, x: order.map(n => perm.mean[n]),
                    error_x: { type: 'data', array: order.map(n => perm.std[n]), color: 'rgba(255,255,255,0.4)', thickness: 1 },
                    marker: { color: order.map(n => (perm.mean[n] > 0 ? PRED : 'rgba(255,255,255,0.25)')) },
                    hovertemplate: '%{y}: %{x:.4f}<extra></extra>',
                }]} layout={{ title: { text: `Permutation importance (drop in ${perm.scoring} on test)`, font: { size: 11 } }, yaxis: { type: 'category', automargin: true }, margin: { l: 10, r: 10, t: 34, b: 30 } }} />
            )}
            {native && (
                <Plot height={height} data={[{
                    type: 'bar', orientation: 'h', y: order, x: order.map(n => native.values[n]),
                    marker: { color: order.map(n => (native.values[n] >= 0 ? PLOT_COLORS.series[0] : PLOT_COLORS.down)) },
                    hovertemplate: '%{y}: %{x:.4g}<extra></extra>',
                }]} layout={{ title: { text: `Model's own view: ${native.kind}`, font: { size: 11 } }, yaxis: { type: 'category', automargin: true }, margin: { l: 10, r: 10, t: 34, b: 30 } }} />
            )}
        </div>
    );
}


/*=====================================================================================*/
/*                                Regression details                                   */
/*=====================================================================================*/

function RegressionDetail({ detail }) {
    const p = detail.predictions;
    const isTime = p.x_kind === 'time';
    const residuals = p.actual.map((a, i) => (a === null || p.predicted[i] === null ? null : a - p.predicted[i]));
    const all = [...p.actual, ...p.predicted].filter(v => v !== null);
    const lo = Math.min(...all), hi = Math.max(...all);
    const centers = detail.residual_hist.edges.slice(0, -1).map((e, i) => (e + detail.residual_hist.edges[i + 1]) / 2);

    return (
        <>
            <Card title="Predicted vs real on the test rows" wide hint={isTime ? 'zoom with the mouse, double-click to reset' : 'rows in test order'}>
                <Plot height={360} data={[
                    { x: p.x, y: p.actual, type: 'scattergl', mode: 'lines', name: 'real', line: { color: REAL, width: 1.2 } },
                    { x: p.x, y: p.predicted, type: 'scattergl', mode: 'lines', name: 'predicted', line: { color: PRED, width: 1.4 } },
                ]} layout={{ hovermode: 'x unified', xaxis: { type: isTime ? 'date' : '-' } }} />
            </Card>
            <Card title="Real vs predicted (each test row)">
                <Plot height={340} data={[
                    { x: p.predicted, y: p.actual, type: 'scattergl', mode: 'markers', name: 'rows', marker: { size: 3, color: PLOT_COLORS.series[0], opacity: 0.35 } },
                    { x: [lo, hi], y: [lo, hi], type: 'scatter', mode: 'lines', name: 'perfect prediction', line: { color: PRED, dash: 'dash', width: 1.5 } },
                ]} layout={{ xaxis: { title: { text: 'predicted', font: { size: 10 } } }, yaxis: { title: { text: 'real', font: { size: 10 } } }, showlegend: false }} />
                <Reading>Points on the dashed line = perfect predictions. A cloud flatter than the line = the model is too cautious (predicts close to the average).</Reading>
            </Card>
            <Card title="Errors (real − predicted)">
                <Plot height={340} data={[{ x: centers, y: detail.residual_hist.counts, type: 'bar', marker: { color: PRED }, opacity: 0.8 }]}
                    layout={{ showlegend: false, xaxis: { title: { text: 'error', font: { size: 10 } } } }} />
                <Reading>Centered on 0 and narrow = good. Shifted from 0 = systematic bias. Long tails = occasional big misses.</Reading>
            </Card>
            <Card title="Error over time" wide>
                <Plot height={220} data={[{ x: p.x, y: residuals, type: 'scattergl', mode: 'markers', marker: { size: 2.5, color: PLOT_COLORS.series[0], opacity: 0.5 } }]}
                    layout={{ xaxis: { type: isTime ? 'date' : '-' }, showlegend: false, margin: { l: 56, r: 18, t: 10, b: 34 } }} />
                <Reading>Errors that drift or cluster in time mean the relation changes (regime change) — the model will degrade on new data.</Reading>
            </Card>
        </>
    );
}


/*=====================================================================================*/
/*                              Classification details                                 */
/*=====================================================================================*/

function ClassificationDetail({ detail, info }) {
    const c = detail.classification;
    const classes = info.classes;
    const positive = info.positive_class;
    const p = detail.predictions;
    const [threshold, setThreshold] = useState(0.5);

    const total = c.confusion.flat().reduce((a, b) => a + b, 0);
    const pctMatrix = c.confusion.map(row => row.map(v => v / total));
    const t = c.thresholds?.reduce((best, row) => (Math.abs(row.threshold - threshold) < Math.abs(best.threshold - threshold) ? row : best), c.thresholds[0]);

    const centers = c.proba_hist ? c.proba_hist.edges.slice(0, -1).map((e, i) => (e + c.proba_hist.edges[i + 1]) / 2) : [];
    const isTime = p.x_kind === 'time';

    return (
        <>
            <Card title="Confusion matrix (test rows)" hint="rows = reality, columns = prediction">
                <Plot height={Math.max(280, 70 * classes.length + 90)} data={[{
                    z: pctMatrix, x: classes.map(cl => `pred ${cl}`), y: classes.map(cl => `real ${cl}`), type: 'heatmap', colorscale: SEQUENTIAL, showscale: false,
                    text: c.confusion.map((row, i) => row.map((v, j) => `${formatCount(v)}<br>${formatPct(pctMatrix[i][j])}`)), texttemplate: '%{text}', textfont: { size: 13, color: '#fff' },
                    hovertemplate: '%{y} · %{x}<br>%{text}<extra></extra>',
                }]} layout={{ xaxis: { type: 'category', side: 'top' }, yaxis: { type: 'category', autorange: 'reversed' }, margin: { l: 80, r: 10, t: 40, b: 10 } }} />
                {classes.length === 2 && (
                    <div className="md-cm-legend--MD">
                        {(() => {
                            const pi = classes.indexOf(positive), ni = 1 - pi;
                            return (
                                <>
                                    <span><b>{formatCount(c.confusion[pi][pi])}</b> true positives</span>
                                    <span className="bad"><b>{formatCount(c.confusion[ni][pi])}</b> false positives (said {positive}, was not)</span>
                                    <span className="bad"><b>{formatCount(c.confusion[pi][ni])}</b> false negatives (missed {positive})</span>
                                    <span><b>{formatCount(c.confusion[ni][ni])}</b> true negatives</span>
                                </>
                            );
                        })()}
                    </div>
                )}
            </Card>

            <Card title="Per class">
                <div className="md-table-wrapper--MD">
                    <table className="md-table--MD">
                        <thead><tr><th>Class</th><th>Precision</th><th>Recall</th><th>F1</th><th>Rows</th></tr></thead>
                        <tbody>{c.per_class.map(r => (
                            <tr key={r.class}><td><b>{r.class}</b>{r.class === positive ? ' (positive)' : ''}</td><td>{formatPct(r.precision)}</td><td>{formatPct(r.recall)}</td><td>{formatPct(r.f1)}</td><td>{formatCount(r.support)}</td></tr>
                        ))}</tbody>
                    </table>
                </div>
                <Reading>Precision: when the model says this class, how often it is right. Recall: share of this class it actually finds. They trade off against each other through the decision threshold.</Reading>
            </Card>

            {c.roc && (
                <>
                    <Card title="ROC curve">
                        <Plot height={320} data={[
                            { x: c.roc.fpr, y: c.roc.tpr, type: 'scatter', mode: 'lines', name: `model (AUC ${fmt(detail.test.roc_auc, 3)})`, line: { color: PRED, width: 2.5 }, fill: 'tozeroy', fillcolor: 'rgba(255,127,50,0.08)' },
                            { x: [0, 1], y: [0, 1], type: 'scatter', mode: 'lines', name: 'random', line: { color: REAL, dash: 'dash', width: 1 } },
                        ]} layout={{ xaxis: { title: { text: 'false positive rate', font: { size: 10 } }, range: [0, 1] }, yaxis: { title: { text: 'true positive rate (recall)', font: { size: 10 } }, range: [0, 1] } }} />
                        <Reading>The further above the diagonal, the better the model separates the classes. On the diagonal = coin flip.</Reading>
                    </Card>
                    <Card title="Precision – recall curve">
                        <Plot height={320} data={[
                            { x: c.pr.recall, y: c.pr.precision, type: 'scatter', mode: 'lines', name: `model (AP ${fmt(detail.test.pr_auc, 3)})`, line: { color: PRED, width: 2.5 } },
                            { x: [0, 1], y: [c.positive_rate, c.positive_rate], type: 'scatter', mode: 'lines', name: `random (${formatPct(c.positive_rate)})`, line: { color: REAL, dash: 'dash', width: 1 } },
                        ]} layout={{ xaxis: { title: { text: 'recall', font: { size: 10 } }, range: [0, 1] }, yaxis: { title: { text: 'precision', font: { size: 10 } }, range: [0, 1.02] } }} />
                        <Reading>How precise the model stays as it tries to catch more positives. The dashed line is what random guessing gives.</Reading>
                    </Card>

                    <Card title="Decision threshold" wide hint="a row is predicted positive when its probability ≥ threshold">
                        <div className="md-threshold--MD">
                            <label>threshold <b>{threshold.toFixed(2)}</b>
                                <input type="range" min={0.05} max={0.95} step={0.05} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
                            </label>
                            {t && (
                                <div className="md-threshold-figures--MD">
                                    <span>predicted {positive}: <b>{formatPct(t.predicted_positive)}</b></span>
                                    <span>precision <b>{t.precision === null ? '—' : formatPct(t.precision)}</b></span>
                                    <span>recall <b>{t.recall === null ? '—' : formatPct(t.recall)}</b></span>
                                    <span className="bad">false positives <b>{formatCount(t.fp)}</b></span>
                                    <span className="bad">false negatives <b>{formatCount(t.fn)}</b></span>
                                    <span>false positive rate <b>{t.fpr === null ? '—' : formatPct(t.fpr)}</b></span>
                                </div>
                            )}
                        </div>
                        <Plot height={260} data={[
                            { x: c.thresholds.map(r => r.threshold), y: c.thresholds.map(r => r.precision), type: 'scatter', mode: 'lines', name: 'precision', line: { color: PRED, width: 2 } },
                            { x: c.thresholds.map(r => r.threshold), y: c.thresholds.map(r => r.recall), type: 'scatter', mode: 'lines', name: 'recall', line: { color: PLOT_COLORS.series[0], width: 2 } },
                            { x: c.thresholds.map(r => r.threshold), y: c.thresholds.map(r => r.fpr), type: 'scatter', mode: 'lines', name: 'false positive rate', line: { color: PLOT_COLORS.down, width: 1.5, dash: 'dot' } },
                            { x: c.thresholds.map(r => r.threshold), y: c.thresholds.map(r => r.predicted_positive), type: 'scatter', mode: 'lines', name: `share predicted ${positive}`, line: { color: REAL, width: 1, dash: 'dash' } },
                        ]} layout={{ yaxis: { tickformat: '.0%', range: [0, 1.02] }, xaxis: { title: { text: 'threshold', font: { size: 10 } } }, shapes: [{ type: 'line', x0: threshold, x1: threshold, yref: 'paper', y0: 0, y1: 1, line: { color: 'rgba(255,255,255,0.5)', dash: 'dot' } }] }} />
                        <Reading>Raising the threshold makes the model pickier: fewer false positives (higher precision) but more missed positives (lower recall). Pick the threshold that matches the cost of each error for your use.</Reading>
                    </Card>

                    <Card title="Predicted probability by real class">
                        <Plot height={300} data={[
                            { x: centers, y: c.proba_hist.negative, type: 'bar', name: `real: not ${positive}`, marker: { color: REAL }, opacity: 0.6 },
                            { x: centers, y: c.proba_hist.positive, type: 'bar', name: `real: ${positive}`, marker: { color: PRED }, opacity: 0.7 },
                        ]} layout={{ barmode: 'overlay', xaxis: { title: { text: `predicted probability of ${positive}`, font: { size: 10 } }, range: [0, 1] } }} />
                        <Reading>Two well separated humps = a confident, useful model. Both piled on top of each other around the same value = the model cannot tell the classes apart.</Reading>
                    </Card>
                    <Card title="Calibration">
                        <Plot height={300} data={[
                            { x: c.calibration.map(r => r.predicted), y: c.calibration.map(r => r.observed), type: 'scatter', mode: 'lines+markers', name: 'model', line: { color: PRED, width: 2 }, marker: { size: c.calibration.map(r => Math.min(16, 5 + Math.log10(r.count + 1) * 3)) }, customdata: c.calibration.map(r => r.count), hovertemplate: 'predicted %{x:.2f}<br>observed %{y:.2f}<br>%{customdata} rows<extra></extra>' },
                            { x: [0, 1], y: [0, 1], type: 'scatter', mode: 'lines', name: 'perfectly calibrated', line: { color: REAL, dash: 'dash', width: 1 } },
                        ]} layout={{ xaxis: { title: { text: 'predicted probability', font: { size: 10 } }, range: [0, 1] }, yaxis: { title: { text: 'observed frequency', font: { size: 10 } }, range: [0, 1] } }} />
                        <Reading>When the model says 70%, does it happen 70% of the time? On the diagonal = probabilities you can trust as such.</Reading>
                    </Card>
                </>
            )}

            <Card title="Predictions over the test rows" wide>
                <Plot height={300} data={[
                    ...(p.score ? [{ x: p.x, y: p.score, type: 'scattergl', mode: 'lines', name: positive ? `probability of ${positive}` : 'confidence', line: { color: PRED, width: 1 } }] : []),
                    { x: p.x, y: p.actual.map(v => (positive ? (v === positive ? 1.04 : -0.04) : classes.indexOf(v))), type: 'scattergl', mode: 'markers', name: 'real class', marker: { size: 3, color: p.actual.map(v => (v === positive ? PLOT_COLORS.up : PLOT_COLORS.down)), opacity: 0.6 } },
                ]} layout={{ hovermode: 'closest', xaxis: { type: isTime ? 'date' : '-' }, yaxis: { range: [-0.1, 1.1] }, shapes: positive ? [{ type: 'line', xref: 'paper', x0: 0, x1: 1, y0: threshold, y1: threshold, line: { color: 'rgba(255,255,255,0.35)', dash: 'dot' } }] : [] }} />
                <Reading>Dots on top = real {positive}, at the bottom = the other class. A useful model has its probability (line) high when dots are on top and low otherwise.</Reading>
            </Card>
        </>
    );
}


/*=====================================================================================*/
/*                                      Results                                        */
/*=====================================================================================*/

function ModelingResults({ run, catalog }) {
    const info = run.info;
    const metrics = catalog.metrics[info.task];
    const [selected, setSelected] = useState(null);
    const [loaded, setDetail] = useState(null);
    const [error, setError] = useState(null);

    // par defaut : le meilleur modele sur la metrique principale
    useEffect(() => {
        const main = info.task === 'classification' ? 'roc_auc' : 'r2';
        const candidates = run.summary.filter(m => !m.error && m.key !== 'baseline');
        const best = [...candidates].sort((a, b) => (b.test?.[main] ?? -1e9) - (a.test?.[main] ?? -1e9))[0];
        setSelected((best || run.summary[0])?.key || null);
    }, [run.run_id]);

    useEffect(() => {
        if (!selected || !run.summary.some(m => m.key === selected)) return;
        let stale = false;
        setDetail(null);
        setError(null);
        apiRequests.getModelResult(run.run_id, selected)
            .then(d => { if (!stale) setDetail({ ...d, run_id: run.run_id }); })
            .catch(err => { if (!stale) setError(err.message); });
        return () => { stale = true; };
    }, [run.run_id, selected]);

    // le detail d'un autre run peut subsister le temps d'un rendu apres un changement de run
    const detail = loaded && loaded.run_id === run.run_id && loaded.key === selected ? loaded : null;
    const main = info.task === 'classification' ? 'roc_auc' : 'r2';
    const ok = run.summary.filter(m => !m.error);

    return (
        <div className="md-results--MD">
            <div className="md-run-info--MD">
                <div><span>Task</span>{info.task}{info.positive_class ? ` · positive = ${info.positive_class}` : ''}</div>
                <div><span>Rows</span>{formatCount(info.rows)}</div>
                <div><span>Inputs</span>{info.features.length}</div>
                <div><span>Split</span>{run.config.split.replace('_', ' ')} · {info.splits.length} test{info.splits.length > 1 ? 's' : ''}{run.config.gap ? ` · gap ${run.config.gap}` : ''}</div>
                <div><span>Scaling</span>{run.config.scaling}</div>
                <div><span>Duration</span>{run.duration ? `${run.duration.toFixed(0)}s` : '—'}</div>
            </div>
            <div className="md-target--MD"><span>target</span><code>{run.config.target}</code><span>inputs</span><code>{run.config.features.join(' · ')}</code></div>

            {info.warnings?.length > 0 && <div className="md-warnings--MD">{info.warnings.map(w => <div key={w}>⚠ {w}</div>)}</div>}

            <details className="md-folds--MD">
                <summary>Train / test periods ({info.splits.length})</summary>
                <table className="md-table--MD">
                    <thead><tr><th>Test</th><th>Train rows</th><th>Train period</th><th>Test rows</th><th>Test period</th></tr></thead>
                    <tbody>{info.splits.map(s => (
                        <tr key={s.fold}><td>{s.fold + 1}</td><td>{formatCount(s.train)}</td><td>{info.time_index ? `${formatDate(s.train_start, false)} → ${formatDate(s.train_end, false)}` : `rows ${s.train_start} → ${s.train_end}`}</td>
                            <td>{formatCount(s.test)}</td><td>{info.time_index ? `${formatDate(s.test_start, false)} → ${formatDate(s.test_end, false)}` : `rows ${s.test_start} → ${s.test_end}`}</td></tr>
                    ))}</tbody>
                </table>
            </details>

            <Card title="Leaderboard" wide hint="test scores (± spread across tests), train score below — click a model for details">
                <Leaderboard run={run} metrics={metrics} selected={selected} onSelect={setSelected} />
                <Plot height={260} data={[
                    { x: ok.map(m => m.label), y: ok.map(m => m.train?.[main]), type: 'bar', name: 'train', marker: { color: 'rgba(224,224,224,0.35)' } },
                    { x: ok.map(m => m.label), y: ok.map(m => m.test?.[main]), type: 'bar', name: 'test', marker: { color: ok.map(m => (m.key === 'baseline' ? REAL : PRED)) } },
                ]} layout={{ barmode: 'group', xaxis: { type: 'category' }, yaxis: { title: { text: metrics.find(m => m.key === main)?.label, font: { size: 10 } } } }} />
                <Reading>
                    Judge models on the TEST score only. A train score much higher than the test score = the model memorized the training rows (overfit) — it will not hold on new data.
                    {info.task === 'classification' ? ' ROC AUC 0.5 = random; with market data, 0.52-0.55 stable across tests can already be meaningful.' : ' R² ≤ 0 = no better than predicting the average.'}
                </Reading>
            </Card>

            {error && <div className="md-error--MD">{error}</div>}
            {selected && !detail && !error && <div className="md-loading--MD"><AppLoader size="sm" /></div>}

            {detail && (
                <>
                    <div className="md-detail-head--MD">
                        <h3>{detail.label}</h3>
                        <code>{Object.entries(detail.params).map(([k, v]) => `${k}=${v}`).join(' · ') || 'no hyperparameter'}</code>
                        {detail.notes?.map(n => <span key={n} className="md-note--MD">{n}</span>)}
                        {selected !== 'baseline' && ((run.saved || []).includes(selected)
                            ? <span className="md-note--MD">kept as “{run.name}” — apply it elsewhere: Explore › New column › Model prediction</span>
                            : (run.saved || []).length
                                ? <span className="md-note--MD">not kept — only the best model of a run is ({run.summary.find(m => m.key === run.saved[0])?.label})</span>
                                : <span className="md-note--MD">no model kept (older run) — train again to apply it elsewhere</span>)}
                    </div>
                    <div className="md-cards--MD">
                        {info.task === 'regression' ? <RegressionDetail detail={detail} /> : <ClassificationDetail detail={detail} info={info} />}
                        <Card title="Which inputs matter" wide>
                            <Importance detail={detail} />
                            <Reading>Permutation importance = how much the test score drops when an input is shuffled. Around 0 (or negative) = the model does not really use it, or it only helped on the training rows.</Reading>
                        </Card>
                        {detail.folds.length > 1 && (
                            <Card title="Score on each test period" wide>
                                <Plot height={260} data={metrics.filter(m => ['r2', 'roc_auc', 'balanced_accuracy', 'spearman', 'sign_accuracy'].includes(m.key)).map((m, i) => ({
                                    x: detail.folds.map((_, j) => `test ${j + 1}`), y: detail.folds.map(f => f[m.key]), type: 'scatter', mode: 'lines+markers', name: m.label,
                                    line: { color: PLOT_COLORS.series[i % 5], width: 2 },
                                }))} layout={{ xaxis: { type: 'category' } }} />
                                <Reading>A model you can rely on keeps a similar score on every period. Big swings = the result depends on luck or on one market regime.</Reading>
                            </Card>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}

export default ModelingResults;
