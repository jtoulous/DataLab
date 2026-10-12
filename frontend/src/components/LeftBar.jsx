import React from "react";

import { useNavigate, useLocation, useSearchParams } from "react-router-dom"; 
import { GlobalState } from '../State.jsx';
import { formatCount } from '../services/format.js';

import "./LeftBar.css";



function LeftBar() {
    const {
        datasetsList,
        leftBarIsOpen, setLeftBarIsOpen,
        headerCollapsed,
    } = GlobalState();

    const navigate = useNavigate();
    const location = useLocation();
    const [searchParams] = useSearchParams();
    const activeId = location.pathname === '/dataset' ? searchParams.get('id') : null;

    return (
        <div className="left-bar-wrapper" style={{ top: headerCollapsed ? '0px' : '80px' }}>
            <div className={`left-bar ${leftBarIsOpen ? "open" : ""}`}>

                <div className="left-bar-nav--LB">
                    <div className={`left-bar-nav-item--LB ${location.pathname === '/' ? 'active' : ''}`} onClick={() => navigate('/')}>
                        <span className="left-bar-nav-icon--LB">⊞</span> Datasets
                    </div>
                </div>

                <div className="left-bar-section-title--LB">Loaded datasets</div>

                {datasetsList.map(dataset => (
                    <div key={dataset.dataset_id} className={`market-link ${activeId === dataset.dataset_id ? 'active' : ''}`}
                        onClick={() => navigate(`/dataset?id=${dataset.dataset_id}`)} style={{ cursor: "pointer" }}>
                        <span className="market-name">{dataset.name}</span>
                        <span className="left-bar-ticker--LB">
                            <span className="left-bar-price--LB">{formatCount(dataset.summary?.rows)}</span>
                            <span className="left-bar-pct--LB">{dataset.summary?.columns} cols</span>
                        </span>
                    </div>
                ))}

                {datasetsList.length === 0 && (
                    <div className="left-bar-empty--LB">No dataset loaded yet</div>
                )}

                {leftBarIsOpen && (
                    <div className="retract-arrow" onClick={() => setLeftBarIsOpen(false)}>❮</div>
                )}
            </div>
            {!leftBarIsOpen && (
                <div className="toggle-arrow" onClick={() => setLeftBarIsOpen(true)}>
                    ❯
                </div>
            )}
        </div>
    );
}

export default LeftBar;
