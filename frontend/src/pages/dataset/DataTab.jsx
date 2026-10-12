import React, { useState, useEffect, useCallback } from "react";

import { apiRequests } from '../../services/api_requests.js';
import { formatCount, formatCell } from '../../services/format.js';
import { AppLoader, TypeBadge } from '../../components/Utils.jsx';
import ViewBar from './ViewBar.jsx';


const PAGE_SIZES = [50, 100, 250, 1000];


function DataTab({ dataset, catalog, onChanged }) {
    const [columns, setColumns] = useState(() => catalog.all.slice(0, 40));
    const [page, setPage] = useState(0);
    const [pageSize, setPageSize] = useState(100);
    const [sort, setSort] = useState({ by: null, ascending: true });
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [showColumns, setShowColumns] = useState(false);

    const view = dataset.view_settings || {};
    const typeOf = (key) => dataset.profile.columns[key]?.type || (dataset.derived_columns?.[key] ? 'derived' : 'empty');

    const load = useCallback(() => {
        setLoading(true);
        setError(null);
        apiRequests.analyze(dataset.dataset_id, 'table', { columns, page, page_size: pageSize, sort_by: sort.by, ascending: sort.ascending }, view)
            .then(setData)
            .catch(err => setError(err.message))
            .finally(() => setLoading(false));
    }, [dataset.dataset_id, columns, page, pageSize, sort, JSON.stringify(view)]);

    useEffect(() => { load(); }, [load]);

    const toggleSort = (column) => {
        setPage(0);
        setSort(prev => (prev.by === column ? { by: column, ascending: !prev.ascending } : { by: column, ascending: true }));
    };

    const toggleColumn = (key) => setColumns(prev => (prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]));
    const pages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;

    return (
        <div className="tab-container--DS">
            <ViewBar dataset={dataset} onSaved={(settings) => { onChanged({ ...dataset, view_settings: settings }); setPage(0); }} />

            <div className="data-toolbar--DT">
                <button type="button" className="lab-ghost-btn--DS" onClick={() => setShowColumns(!showColumns)}>
                    {showColumns ? '▾' : '▸'} Columns ({columns.length}/{catalog.all.length})
                </button>
                <span className="data-total--DT">{data ? `${formatCount(data.total)} rows` : ''}</span>
                <div className="data-pager--DT">
                    <button type="button" disabled={page === 0} onClick={() => setPage(0)}>«</button>
                    <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>‹</button>
                    <span>page {page + 1} / {formatCount(pages)}</span>
                    <button type="button" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>›</button>
                    <button type="button" disabled={page >= pages - 1} onClick={() => setPage(pages - 1)}>»</button>
                    <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }}>
                        {PAGE_SIZES.map(s => <option key={s} value={s}>{s} / page</option>)}
                    </select>
                </div>
                <a className="list-button data-export--DT" href={apiRequests.getExportUrl(dataset.dataset_id, columns, view)} download>Export CSV</a>
            </div>

            {showColumns && (
                <div className="data-columns--DT">
                    <button type="button" className="lab-ghost-btn--DS" onClick={() => setColumns(catalog.all)}>All</button>
                    <button type="button" className="lab-ghost-btn--DS" onClick={() => setColumns([])}>None</button>
                    {catalog.all.map(key => (
                        <button key={key} type="button" className={`data-col-chip--DT ${columns.includes(key) ? 'active' : ''}`} onClick={() => toggleColumn(key)}>
                            <TypeBadge type={typeOf(key)} compact /> {key}
                        </button>
                    ))}
                </div>
            )}

            {error && <div className="feedback--DS error">{error}</div>}
            {!data && loading && <div className="data-loading--DT"><AppLoader /></div>}

            {data && (
                <div className={`data-grid-wrapper--DT ${loading ? 'loading' : ''}`}>
                    <table className="data-grid--DT">
                        <thead>
                            <tr>
                                <th className="data-rownum--DT">#</th>
                                {data.columns.map(c => (
                                    <th key={c} onClick={() => toggleSort(c)} className={sort.by === c ? 'sorted' : ''}>
                                        <div>
                                            {c === '__time__' ? <TypeBadge type="datetime" compact /> : <TypeBadge type={typeOf(c)} compact />}
                                            <span>{c === '__time__' ? dataset.profile.time?.column : c}</span>
                                            {sort.by === c && <em>{sort.ascending ? '▲' : '▼'}</em>}
                                        </div>
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {data.rows.map((row, i) => (
                                <tr key={i}>
                                    <td className="data-rownum--DT">{formatCount(page * pageSize + i + 1)}</td>
                                    {row.map((v, j) => (
                                        <td key={j} className={typeof v === 'number' ? 'num' : v === null ? 'null' : ''}>{v === null ? 'null' : formatCell(v)}</td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

export default DataTab;
