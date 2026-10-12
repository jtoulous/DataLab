import React from "react"
import { GlobalState } from '../State.jsx';
import { BrandMark } from './Utils.jsx';

import "./TopBar.css"


function TopBar() {
  const { headerCollapsed, setHeaderCollapsed, wsConnected } = GlobalState();

  const handleTopBarClick = (e) => {
    if (e.target.closest('.top-bar-logo') || e.target.closest('.top-bar-status--TB')) return;
    setHeaderCollapsed(!headerCollapsed);
  }

  return (
    <>
      <div className="top-bar" style={{ 
        transform: headerCollapsed ? 'translateY(-100%)' : 'translateY(0)',
        opacity: headerCollapsed ? 0 : 1,
        animation: headerCollapsed ? 'slideUpFast 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) 0.4s forwards' : 'slideDownFast 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) 0s backwards'
      }} onClick={handleTopBarClick}>
        <a href="/" className="top-bar-logo">
          <BrandMark size={44} />
        </a>
        <h1>
          <a href="/" className="top-bar-link">
            <span className="title-anomaly">Data</span>
            <span className="title-separator"></span>
            <span className="title-sentinel">Viz</span>
          </a>
        </h1>

        <div className="top-bar-status--TB" title={wsConnected ? 'Connected to the backend' : 'Backend unreachable (port 8010)'}>
          <span className={`top-bar-status-dot--TB ${wsConnected ? 'live' : 'down'}`} />
          <span className="top-bar-status-label--TB">{wsConnected ? 'Online' : 'Offline'}</span>
        </div>
      </div>

      <div className={`header-toggle-btn ${headerCollapsed ? 'visible' : ''}`} onClick={() => setHeaderCollapsed(!headerCollapsed)}>
        ❯
      </div>
    </>
  )
}

export default TopBar
