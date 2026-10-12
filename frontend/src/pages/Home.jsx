import React, { useState } from "react"
import { useNavigate } from "react-router-dom"; 
import { GlobalState } from '../State.jsx';
import { apiRequests } from '../services/api_requests.js';
import { formatCount, formatBytes, formatDate, COLUMN_TYPE_STYLE } from '../services/format.js';

import { FileDropZone } from '../components/FileDropZone.jsx';
import { AppLoader, TrashIcon } from '../components/Utils.jsx';

import "./Home.css"


function Home() {
    const navigate = useNavigate();
    const { datasetsList, meta } = GlobalState()

    const [uploads, setUploads] = useState([]);
    const [serverPath, setServerPath] = useState('');
    const [showPathForm, setShowPathForm] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(null);

    const accept = meta ? meta.extensions.map(e => `.${e}`).join(',') : '.csv';


    //////////////////////////////////////////
    ///        apiRequests Functions       ///

    // Les fichiers sont envoyes un par un : chaque ligne d'upload a son propre statut
    const uploadFiles = async (files) => {
        const entries = files.map((file, i) => ({ id: `${Date.now()}-${i}`, name: file.name, size: file.size, status: 'pending', error: null }));
        setUploads(prev => [...entries, ...prev]);
        for (const [i, file] of files.entries()) {
            const id = entries[i].id;
            setUploads(prev => prev.map(u => (u.id === id ? { ...u, status: 'uploading' } : u)));
            try {
                const dataset = await apiRequests.uploadDataset(file);
                setUploads(prev => prev.map(u => (u.id === id ? { ...u, status: 'done', dataset_id: dataset.dataset_id } : u)));
            } catch (error) {
                setUploads(prev => prev.map(u => (u.id === id ? { ...u, status: 'error', error: error.message } : u)));
            }
        }
    };

    const importPath = (e) => {
        e.preventDefault();
        const id = `${Date.now()}`;
        setUploads(prev => [{ id, name: serverPath, size: null, status: 'uploading' }, ...prev]);
        apiRequests.importPath(serverPath)
            .then(dataset => {
                setUploads(prev => prev.map(u => (u.id === id ? { ...u, status: 'done', dataset_id: dataset.dataset_id } : u)));
                setServerPath('');
                setShowPathForm(false);
            })
            .catch(error => setUploads(prev => prev.map(u => (u.id === id ? { ...u, status: 'error', error: error.message } : u))));
    };

    const deleteDataset = (e, dataset_id) => {
        e.stopPropagation();
        if (confirmDelete !== dataset_id) {
            setConfirmDelete(dataset_id);
            return;
        }
        apiRequests.deleteDataset(dataset_id).catch(err => console.error(err));
        setConfirmDelete(null);
    };


    //////////////////////////////////////////
    ///              HTML code             ///

    return (
        <div className="home-page-container--H">

            <div className="title-container">
                <h1>Datasets</h1>
            </div>

            <div className="upload-section--H">
                <FileDropZone accept={accept} multiple onFilesSelect={uploadFiles} onFileSelect={() => {}}
                    label={<>Drop one or several files — <strong>CSV, TSV, TXT, Excel, Parquet, JSON</strong> — or <span className="fdz-browse">browse</span></>} />
                <p className="upload-hint--H">
                    Any layout works: separator, encoding, header, decimal comma, date formats and column types are detected automatically
                    (and can be corrected afterwards).
                    <button type="button" className="link-btn--H" onClick={() => setShowPathForm(!showPathForm)}>Import a large file from a path on the server</button>
                </p>
                {showPathForm && (
                    <form className="path-form--H" onSubmit={importPath}>
                        <input type="text" placeholder="/goinfre/me/big_file.csv" value={serverPath} onChange={(e) => setServerPath(e.target.value)} required />
                        <button type="submit" className="form-button">Import</button>
                    </form>
                )}

                {uploads.length > 0 && (
                    <div className="uploads--H">
                        {uploads.map(u => (
                            <div key={u.id} className={`upload-row--H ${u.status}`}>
                                <span className="upload-name--H">{u.name}</span>
                                {u.size !== null && <span className="upload-size--H">{formatBytes(u.size)}</span>}
                                <span className="upload-status--H">
                                    {u.status === 'pending' && 'queued'}
                                    {u.status === 'uploading' && <><AppLoader size="sm" /> reading & profiling…</>}
                                    {u.status === 'done' && <button type="button" className="list-button" onClick={() => navigate(`/dataset?id=${u.dataset_id}`)}>Open</button>}
                                    {u.status === 'error' && <span className="upload-error--H">{u.error}</span>}
                                </span>
                                {u.status !== 'uploading' && u.status !== 'pending' && (
                                    <button type="button" className="upload-dismiss--H" onClick={() => setUploads(prev => prev.filter(x => x.id !== u.id))}>✕</button>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <div className="datasets-grid--H">
                {datasetsList.length === 0 && (
                    <div className="empty-state datasets-empty--H">
                        <p>No dataset yet — drop a file above to start exploring.</p>
                    </div>
                )}
                {datasetsList.map(d => {
                    const s = d.summary || {};
                    return (
                        <div key={d.dataset_id} className="dataset-card--H" onClick={() => navigate(`/dataset?id=${d.dataset_id}`)}>
                            <div className="dataset-card-head--H">
                                <div>
                                    <span className="dataset-name--H">{d.name}</span>
                                    <span className="dataset-file--H">{d.filename} · {formatBytes(d.file_size)} · {d.read_report?.format}</span>
                                </div>
                                <button type="button" className={`dataset-delete--H ${confirmDelete === d.dataset_id ? 'confirm' : ''}`}
                                    onClick={(e) => deleteDataset(e, d.dataset_id)} onMouseLeave={() => setConfirmDelete(null)}>
                                    {confirmDelete === d.dataset_id ? 'Delete?' : <TrashIcon />}
                                </button>
                            </div>
                            <div className="dataset-figures--H">
                                <div><b>{formatCount(s.rows)}</b><span>rows</span></div>
                                <div><b>{s.columns}</b><span>columns</span></div>
                                <div className="dataset-time--H">
                                    {s.time
                                        ? <><b>{formatDate(s.time.start, false)} → {formatDate(s.time.end, false)}</b><span>time axis “{s.time.column}” · every {s.time.step_label}</span></>
                                        : <><b>—</b><span>no time axis</span></>}
                                </div>
                            </div>
                            <div className="dataset-types--H">
                                {Object.entries(s.types || {}).map(([type, n]) => {
                                    const style = COLUMN_TYPE_STYLE[type] || COLUMN_TYPE_STYLE.empty;
                                    return <span key={type} style={{ color: style.color, borderColor: style.color }}>{style.icon} {n} {style.label}</span>;
                                })}
                            </div>
                            <span className="dataset-date--H">updated {d.updated_at?.slice(0, 16)} UTC</span>
                        </div>
                    );
                })}
            </div>
        </div>
    )
}

export default Home
