import React, { useState, useMemo } from "react";

import { apiRequests } from '../../services/api_requests.js';
import { formatNumber, formatPct, formatCount, formatDate, COLUMN_TYPE_STYLE } from '../../services/format.js';
import { TypeBadge, MiniHistogram } from '../../components/Utils.jsx';


const EDITABLE_TYPES = ['numeric', 'datetime', 'categorical', 'boolean', 'text', 'identifier', 'ignore'];

const TYPE_HELP = {
    datetime: 'Dates / times — can be the time axis',
    numeric: 'Numbers — usable in every calculation',
    boolean: 'Two states (true/false, yes/no, 0/1) — stored as 1 / 0',
    categorical: 'A limited set of labels — usable to group, color, split',
    text: 'Free text (many different values)',
    identifier: 'Unique value per row (ids, keys)',
    empty: 'No value at all',
    ignore: 'Excluded from the analyses',
};


function ColumnDistribution({ column }) {
    if (column.histogram) {
        return (
            <div className="col-dist--OV">
                <MiniHistogram counts={column.histogram.counts} width={130} height={26} color={COLUMN_TYPE_STYLE[column.type]?.color} />
                <span>{formatNumber(column.histogram.edges[0], 3)} … {formatNumber(column.histogram.edges[column.histogram.edges.length - 1], 3)}</span>
            </div>
        );
    }
    if (column.type === 'datetime' && column.stats) {
        return <div className="col-dist--OV"><span>{formatDate(column.stats.min)} → {formatDate(column.stats.max)}</span></div>;
    }
    if (column.top) {
        const total = column.top.reduce((acc, t) => acc + t.count, 0) || 1;
        return (
            <div className="col-top--OV">
                {column.top.slice(0, 4).map(t => (
                    <div key={t.value}>
                        <span className="col-top-label--OV" title={t.value}>{t.value}</span>
                        <span className="col-top-bar--OV"><i style={{ width: `${(t.count / total) * 100}%` }} /></span>
                        <span className="col-top-count--OV">{formatCount(t.count)}</span>
                    </div>
                ))}
            </div>
        );
    }
    return null;
}


function OverviewTab({ dataset, onChanged }) {
    const profile = dataset.profile;
    const [overrides, setOverrides] = useState(dataset.type_overrides || {});
    const [timeColumn, setTimeColumn] = useState(dataset.time_column || 'auto');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const [filter, setFilter] = useState('');
    const [typeFilter, setTypeFilter] = useState(null);

    const dirty = JSON.stringify(overrides) !== JSON.stringify(dataset.type_overrides || {}) || timeColumn !== (dataset.time_column || 'auto');

    const counts = useMemo(() => {
        const out = {};
        Object.values(profile.columns).forEach(c => { out[c.type] = (out[c.type] || 0) + 1; });
        return out;
    }, [profile]);

    const datetimeColumns = profile.order.filter(k => profile.columns[k].type === 'datetime');
    const report = dataset.read_report || {};
    const t = profile.time;

    const setType = (key, type, detected) => {
        setOverrides(prev => {
            const next = { ...prev };
            if (type === detected && !prev[key]) return prev;
            if (type === '__auto__') delete next[key];
            else next[key] = type;
            return next;
        });
    };

    const apply = () => {
        setSaving(true);
        setError(null);
        apiRequests.updateDataset(dataset.dataset_id, { type_overrides: overrides, time_column: timeColumn })
            .then(record => onChanged(record))
            .catch(err => setError(err.message))
            .finally(() => setSaving(false));
    };

    const reset = () => {
        setOverrides(dataset.type_overrides || {});
        setTimeColumn(dataset.time_column || 'auto');
    };

    const visible = profile.order.filter(k => {
        const c = profile.columns[k];
        if (typeFilter && c.type !== typeFilter) return false;
        const f = filter.toLowerCase();
        return !f || k.includes(f) || c.label.toLowerCase().includes(f);
    });

    const warnings = profile.order.filter(k => profile.columns[k].failed > 0 || (profile.columns[k].note || '').includes('ambiguous'));

    return (
        <div className="tab-container--DS">

            {/* ── Lecture + axe temporel ─────────────────────────────── */}
            <div className="overview-cards--OV">
                <div className="ov-card--OV">
                    <h3>File reading</h3>
                    <dl>
                        <dt>Format</dt><dd>{report.format}{report.sheet ? ` (sheet “${report.sheet}”)` : ''}</dd>
                        {report.encoding && <><dt>Encoding</dt><dd>{report.encoding}</dd></>}
                        {report.delimiter && <><dt>Separator</dt><dd><code>{report.delimiter}</code></dd></>}
                        {report.header !== undefined && <><dt>Header row</dt><dd>{report.header ? 'yes' : 'no (columns named col_1, col_2…)'}</dd></>}
                        {report.skipped_lines > 0 && <><dt>Malformed lines</dt><dd className="warn--OV">{report.skipped_lines} skipped</dd></>}
                        <dt>Size</dt><dd>{formatCount(profile.rows)} rows × {profile.order.length} columns</dd>
                    </dl>
                </div>

                <div className="ov-card--OV">
                    <h3>Time axis</h3>
                    <label className="ov-select--OV">
                        <select value={timeColumn} onChange={(e) => setTimeColumn(e.target.value)}>
                            <option value="auto">Automatic</option>
                            <option value="none">None (rows are not ordered in time)</option>
                            {datetimeColumns.map(k => <option key={k} value={k}>{k}</option>)}
                        </select>
                    </label>
                    {t ? (
                        <dl>
                            <dt>Column</dt><dd><code>{t.column}</code></dd>
                            <dt>Range</dt><dd>{formatDate(t.start)} → {formatDate(t.end)}</dd>
                            <dt>Step</dt><dd>{t.step_label || '—'} {t.regular ? <span className="ok--OV">regular</span> : <span className="warn--OV">irregular</span>}</dd>
                            <dt>Gaps</dt><dd className={t.gaps ? 'warn--OV' : ''}>{formatCount(t.gaps)} {t.gaps ? '(steps longer than 1.5× the usual)' : ''}</dd>
                            <dt>Duplicates</dt><dd className={t.duplicates ? 'warn--OV' : ''}>{formatCount(t.duplicates)} timestamps</dd>
                            <dt>Order</dt><dd>{t.was_sorted ? 'already sorted' : <span className="warn--OV">re-sorted by time</span>}</dd>
                            {t.dropped_missing > 0 && <><dt>Dropped</dt><dd className="warn--OV">{t.dropped_missing} rows without date</dd></>}
                        </dl>
                    ) : (
                        <p className="ov-muted--OV">
                            {datetimeColumns.length ? 'No time axis selected: rows are analysed in file order.' : 'No date column detected. If one exists, set its type to datetime below.'}
                            {' '}Time-based features (duration windows, resampling, hour/weekday views) need one.
                        </p>
                    )}
                </div>

                <div className="ov-card--OV">
                    <h3>Column types</h3>
                    <div className="ov-types--OV">
                        {Object.entries(counts).map(([type, n]) => (
                            <button key={type} type="button" className={`ov-type-chip--OV ${typeFilter === type ? 'active' : ''}`} onClick={() => setTypeFilter(typeFilter === type ? null : type)}>
                                <TypeBadge type={type} /> <b>{n}</b>
                            </button>
                        ))}
                    </div>
                    {warnings.length > 0 && (
                        <div className="ov-warnings--OV">
                            {warnings.map(k => {
                                const c = profile.columns[k];
                                return <div key={k}>⚠ <code>{k}</code> {c.failed > 0 ? `${formatCount(c.failed)} values could not be converted (set to empty)` : c.note}</div>;
                            })}
                        </div>
                    )}
                </div>
            </div>

            {/* ── Colonnes ───────────────────────────────────────────── */}
            <div className="ov-columns-head--OV">
                <h2>Columns</h2>
                <input placeholder="filter columns…" value={filter} onChange={(e) => setFilter(e.target.value)} />
                {dirty && (
                    <div className="ov-apply--OV">
                        <span>Unsaved type changes</span>
                        <button type="button" className="lab-ghost-btn--DS" onClick={reset}>Reset</button>
                        <button type="button" className="form-button" onClick={apply} disabled={saving}>{saving ? 'Re-typing…' : 'Apply'}</button>
                    </div>
                )}
            </div>
            {error && <div className="feedback--DS error">{error}</div>}

            <div className="ov-table-wrapper--OV">
                <table className="ov-table--OV">
                    <thead>
                        <tr>
                            <th>Column</th><th>Type</th><th>Detection</th><th>Missing</th><th>Unique</th><th>Distribution</th><th>Summary</th>
                        </tr>
                    </thead>
                    <tbody>
                        {visible.map(key => {
                            const c = profile.columns[key];
                            const current = overrides[key] || c.type;
                            const s = c.stats || {};
                            return (
                                <tr key={key} className={overrides[key] ? 'overridden' : ''}>
                                    <td className="ov-name--OV">
                                        <code>{key}</code>
                                        {c.label !== key && <span title="original name">{c.label}</span>}
                                    </td>
                                    <td>
                                        <div className="ov-type-cell--OV" title={TYPE_HELP[current]}>
                                            <TypeBadge type={current} compact />
                                            <select value={current} onChange={(e) => setType(key, e.target.value, c.type)}>
                                                {EDITABLE_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
                                                {!EDITABLE_TYPES.includes(c.type) && <option value={c.type}>{c.type}</option>}
                                            </select>
                                            {overrides[key] && <button type="button" title="Back to automatic" onClick={() => setType(key, '__auto__')}>↺</button>}
                                        </div>
                                    </td>
                                    <td className="ov-note--OV">
                                        {[c.subtype, c.note].filter(Boolean).join(' · ') || '—'}
                                        {c.failed > 0 && <span className="warn--OV"> · {formatCount(c.failed)} failed</span>}
                                    </td>
                                    <td>
                                        <div className="ov-missing--OV">
                                            <span className="ov-missing-bar--OV"><i style={{ width: `${(c.missing_pct || 0) * 100}%` }} /></span>
                                            <span>{c.missing ? formatPct(c.missing_pct) : '0'}</span>
                                        </div>
                                    </td>
                                    <td className="ov-num--OV">{formatCount(c.unique)}</td>
                                    <td><ColumnDistribution column={c} /></td>
                                    <td className="ov-summary--OV">
                                        {(c.type === 'numeric' || c.type === 'boolean') && s.mean !== undefined && (
                                            <>
                                                <span>mean <b>{formatNumber(s.mean)}</b></span>
                                                <span>std <b>{formatNumber(s.std)}</b></span>
                                                <span>min <b>{formatNumber(s.min)}</b></span>
                                                <span>max <b>{formatNumber(s.max)}</b></span>
                                            </>
                                        )}
                                        {c.avg_length !== undefined && <span>avg length <b>{c.avg_length.toFixed(1)}</b></span>}
                                        {c.sample && c.type !== 'numeric' && <span className="ov-sample--OV" title={c.sample.join(' | ')}>e.g. {String(c.sample[0]).slice(0, 28)}</span>}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

export default OverviewTab;
