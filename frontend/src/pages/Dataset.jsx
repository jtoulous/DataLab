import React, { useState, useEffect, useCallback, useMemo } from "react"
import { useSearchParams, useNavigate } from "react-router-dom";
import { GlobalState } from '../State.jsx';
import { apiRequests } from '../services/api_requests.js';
import { appEvents } from '../services/events.js';
import { formatCount, formatDate } from '../services/format.js';
import { ColumnsContext } from '../components/columnsContext.js';
import { BackArrow, AppLoader, GearIcon, CloseIcon } from '../components/Utils.jsx';

import OverviewTab from './dataset/OverviewTab.jsx';
import DataTab from './dataset/DataTab.jsx';
import ExploreTab from './explore/ExploreTab.jsx';
import ModelingTab from './modeling/ModelingTab.jsx';
import SubsetModal from './dataset/SubsetModal.jsx';

import "../components/SettingsModal.css";
import "./Dataset.css"


// Catalogue des colonnes utilisables dans les formulaires (colonnes du fichier + colonnes derivees)
function buildCatalog(dataset) {
    if (!dataset?.profile) return null;
    const columns = dataset.profile.order
        .map(key => ({ key, ...dataset.profile.columns[key] }))
        .filter(c => c.type !== 'ignore');
    const derived = Object.entries(dataset.derived_columns || {}).map(([key, c]) => ({ key, label: key, type: 'derived', formula: c.formula, description: c.description }));
    const byType = (types) => columns.filter(c => types.includes(c.type)).map(c => c.key);
    return {
        columns, derived,
        numeric: [...byType(['numeric', 'boolean']), ...derived.map(d => d.key)],
        categorical: byType(['categorical', 'boolean', 'text']),
        datetime: byType(['datetime']),
        all: [...columns.map(c => c.key), ...derived.map(d => d.key)],
        time: !!dataset.profile.time,
    };
}


function DatasetSettingsModal({ dataset, onClose, onChanged }) {
    const navigate = useNavigate();
    const [visible, setVisible] = useState(false);
    const [name, setName] = useState(dataset.name);
    const [description, setDescription] = useState(dataset.description || '');
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => { requestAnimationFrame(() => setVisible(true)); }, []);

    const close = () => { setVisible(false); setTimeout(onClose, 300); };

    const save = () => {
        apiRequests.updateDataset(dataset.dataset_id, { name, description })
            .then(record => { onChanged(record); close(); })
            .catch(err => setError(err.message));
    };

    const remove = () => {
        if (!confirmDelete) { setConfirmDelete(true); return; }
        apiRequests.deleteDataset(dataset.dataset_id).then(() => navigate('/')).catch(err => setError(err.message));
    };

    return (
        <div className={`settings-backdrop ${visible ? 'visible' : ''}`} onClick={(e) => e.target === e.currentTarget && close()}>
            <div className={`settings-modal ${visible ? 'visible' : ''}`}>
                <div className="settings-header">
                    <h2>Dataset Settings</h2>
                    <button className="settings-close-btn" onClick={close}><CloseIcon /></button>
                </div>
                <div className="settings-body">
                    <div className="settings-section settings-section--main">
                        <div className="settings-section-header"><h3 className="settings-section-title">General</h3></div>
                        <div className="settings-section-content">
                            <div className="setting-row">
                                <div className="setting-info"><span className="setting-label">Name</span></div>
                                <input className="setting-input--DS" value={name} onChange={(e) => setName(e.target.value)} />
                            </div>
                            <div className="setting-row setting-row--column--DS">
                                <div className="setting-info"><span className="setting-label">Description / notes</span></div>
                                <textarea className="setting-textarea--DS" rows={4} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this data, where does it come from, what do the columns mean…" />
                            </div>
                            <div className="setting-actions--DS"><button type="button" className="form-button" onClick={save}>Save</button></div>
                        </div>
                    </div>
                    <div className="settings-section settings-section--main settings-danger--DS">
                        <div className="settings-section-header"><h3 className="settings-section-title">Danger Zone</h3></div>
                        <div className="settings-section-content">
                            <div className="setting-row">
                                <div className="setting-info">
                                    <span className="setting-label">Delete dataset</span>
                                    <span className="setting-description">Removes the file, its derived columns, workspaces and model runs. Its subsets are kept (independent copies).</span>
                                </div>
                                <button type="button" className={`danger-button--DS ${confirmDelete ? 'confirm' : ''}`} onClick={remove} onMouseLeave={() => setConfirmDelete(false)}>
                                    {confirmDelete ? 'Click to confirm' : 'Delete'}
                                </button>
                            </div>
                        </div>
                    </div>
                    {error && <div className="feedback--DS error">{error}</div>}
                </div>
            </div>
        </div>
    );
}


// Titre = selecteur de dataset : l'original et tous ses sous-datasets (on garde l'onglet courant)
function DatasetSwitcher({ dataset }) {
    const navigate = useNavigate();
    const [open, setOpen] = useState(false);
    const family = dataset.family || [];
    const origin = dataset.origin;

    useEffect(() => {
        if (!open) return;
        const close = (e) => { if (!e.target.closest('.dataset-switcher--DS')) setOpen(false); };
        document.addEventListener('mousedown', close);
        return () => document.removeEventListener('mousedown', close);
    }, [open]);

    return (
        <div className="dataset-switcher--DS">
            <button type="button" className={`dataset-title--DS ${family.length > 1 ? 'switchable' : ''}`} onClick={() => family.length > 1 && setOpen(o => !o)}>
                <span>{dataset.name}{family.length > 1 && <i>▾</i>}</span>
                {origin
                    ? <em className="origin">⤷ subset of {origin.parent_name} · {formatCount(origin.rows)} / {formatCount(origin.parent_rows)} rows{origin.pieces > 1 ? ` · ${origin.pieces} pieces` : ''}</em>
                    : <em>{dataset.filename}{family.length > 1 ? ` · ${family.length - 1} subset${family.length > 2 ? 's' : ''}` : ''}</em>}
            </button>
            {open && (
                <div className="dataset-switcher-menu--DS">
                    {family.map(f => (
                        <button type="button" key={f.dataset_id} className={f.dataset_id === dataset.dataset_id ? 'current' : ''} style={{ paddingLeft: 12 + f.depth * 18 }}
                            onClick={() => { setOpen(false); if (f.dataset_id !== dataset.dataset_id) navigate(`/dataset?id=${f.dataset_id}`); }}>
                            <span className="name">{f.depth > 0 && <b>⤷</b>}{f.name}</span>
                            <span className="meta">{formatCount(f.rows)} rows{f.origin?.pieces > 1 ? ` · ${f.origin.pieces} pieces` : ''}</span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}


function Dataset() {
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const { currentTab, setCurrentTab, setCurrentDataset, headerCollapsed } = GlobalState();

    const datasetId = searchParams.get('id');
    const [dataset, setDataset] = useState(null);
    const [error, setError] = useState(null);
    const [showSettings, setShowSettings] = useState(false);
    const [showSubset, setShowSubset] = useState(false);

    const load = useCallback(() => {
        apiRequests.getDataset(datasetId)
            .then(record => { setDataset(record); setCurrentDataset(record); setError(null); })
            .catch(err => setError(err.message));
    }, [datasetId, setCurrentDataset]);

    useEffect(() => {
        setDataset(null);
        load();
    }, [load]);

    // colonnes derivees modifiees (depuis un autre onglet / client)
    useEffect(() => appEvents.on('columns', payload => {
        if (payload.dataset_id === datasetId) setDataset(d => (d ? { ...d, derived_columns: payload.columns } : d));
    }), [datasetId]);

    // un sous-dataset cree / supprime ailleurs : on rafraichit la famille du selecteur
    useEffect(() => appEvents.on('datasets', () => {
        apiRequests.getDataset(datasetId).then(record => setDataset(d => (d ? { ...d, family: record.family } : d))).catch(() => {});
    }), [datasetId]);

    const catalog = useMemo(() => buildCatalog(dataset), [dataset]);

    if (error) {
        return <div className="dataset-page-loading--DS"><div className="empty-state" style={{ width: 460 }}><p>{error}</p></div></div>;
    }
    if (!dataset) {
        return <div className="dataset-page-loading--DS"><AppLoader label="Loading dataset" /></div>;
    }

    const p = dataset.profile;
    const tabs = [
        { key: 'overview', label: 'Overview' },
        { key: 'data', label: 'Data' },
        { key: 'explore', label: 'Explore' },
        { key: 'modeling', label: 'Modelling' },
    ];

    return (
        <ColumnsContext.Provider value={catalog}>
        <div className="dataset-page-container--DS">
            <BackArrow onClick={() => navigate('/')} />
            <div className="dataset-top-container--DS" style={{
                visibility: headerCollapsed ? 'hidden' : 'visible',
                opacity: headerCollapsed ? 0 : 1,
                animation: headerCollapsed ? 'slideUp 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) 0.1s forwards' : 'slideDown 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) 0.1s backwards'
            }}>
                <DatasetSwitcher dataset={dataset} />
                <div className="dataset-head-stats--DS">
                    <div><span>Rows</span>{formatCount(p.rows)}</div>
                    <div><span>Columns</span>{p.order.length}</div>
                    <div><span>Derived</span>{Object.keys(dataset.derived_columns || {}).length}</div>
                    <div><span>Time axis</span>{p.time ? `${p.time.column} · ${p.time.step_label || '?'}` : 'none'}</div>
                    {p.time && <div><span>Range</span>{formatDate(p.time.start, false)} → {formatDate(p.time.end, false)}</div>}
                </div>
                <button type="button" className="subset-btn--DS" onClick={() => setShowSubset(true)} title="Create a new dataset from periods of this one">+ Subset</button>
                <button className="settings-btn" onClick={() => setShowSettings(true)}><GearIcon size={22} /></button>
            </div>

            <div className="tab-selection-container--DS" style={{
                visibility: headerCollapsed ? 'hidden' : 'visible',
                opacity: headerCollapsed ? 0 : 1,
            }}>
                {tabs.map(tab => (
                    <div key={tab.key} className={`tab-select--DS ${currentTab === tab.key ? 'active' : ''}`} onClick={() => setCurrentTab(tab.key)}>
                        {tab.label}
                    </div>
                ))}
            </div>

            <div className="tab-content--DS" style={{ top: headerCollapsed ? '0px' : '115px' }}>
                {currentTab === 'overview' && <OverviewTab dataset={dataset} onChanged={setDataset} />}
                {currentTab === 'data' && <DataTab dataset={dataset} catalog={catalog} onChanged={setDataset} />}
                {currentTab === 'explore' && <ExploreTab dataset={dataset} catalog={catalog} onChanged={setDataset} />}
                {currentTab === 'modeling' && <ModelingTab dataset={dataset} catalog={catalog} onChanged={setDataset} />}
            </div>

            {showSubset && <SubsetModal dataset={dataset} catalog={catalog} onClose={() => setShowSubset(false)} />}
            {showSettings && <DatasetSettingsModal dataset={dataset} onClose={() => setShowSettings(false)} onChanged={(record) => { setDataset(record); load(); }} />}
        </div>
        </ColumnsContext.Provider>
    );
}

export default Dataset;
