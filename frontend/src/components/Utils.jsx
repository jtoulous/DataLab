import React from "react";
import { COLUMN_TYPE_STYLE } from '../services/format.js';
import "./Utils.css";



// Logo : histogramme + points (donnees), duo blanc / orange
const BrandMark = ({ size = 40, className = "" }) => {
    return (
        <svg className={`brand-mark--UT ${className}`} width={size} height={size} viewBox="0 0 32 32" fill="none" aria-label="Data Lab">
            <rect x="4" y="17" width="6" height="11" rx="1.3" fill="rgba(255,255,255,0.85)" />
            <rect x="13" y="10" width="6" height="18" rx="1.3" fill="#ff7f32" />
            <rect x="22" y="5" width="6" height="23" rx="1.3" fill="#ffb74d" />
            <circle cx="7" cy="11" r="2.1" fill="#ff7f32" />
            <circle cx="16" cy="4.5" r="2.1" fill="rgba(255,255,255,0.85)" />
        </svg>
    );
};


const BackArrow = ({ onClick }) => {
    return (
        <button type="button" className="back-arrow-btn" onClick={onClick}>
            <svg className="back-arrow-svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 19l-7-7 7-7"></path>
            </svg>
        </button>
    );
};


function AppLoader({ size = 'md', label }) {
    return (
        <div className={`app-loader--UT app-loader--${size}--UT`} role="status" aria-label={label || 'Loading'}>
            <div className="app-loader-badge--UT">
                <span className="app-loader-ring--UT" />
                <span className="app-loader-mark--UT">
                    <span className="app-loader-letter--UT app-loader-a--UT">D</span>
                    <span className="app-loader-sep--UT" />
                    <span className="app-loader-letter--UT app-loader-s--UT">L</span>
                </span>
            </div>
            {label && <span className="app-loader-label--UT">{label}</span>}
        </div>
    );
}


// Badge de type de colonne (icone + libelle ; la couleur n'est jamais le seul signal)
const TypeBadge = ({ type, compact = false }) => {
    const style = COLUMN_TYPE_STYLE[type] || COLUMN_TYPE_STYLE.empty;
    return (
        <span className={`type-badge--UT ${compact ? 'compact' : ''}`} style={{ color: style.color, borderColor: style.color }}>
            <span className="type-badge-icon--UT">{style.icon}</span>
            {!compact && style.label}
        </span>
    );
};


// Mini histogramme (SVG) pour les apercus de colonnes
const MiniHistogram = ({ counts, width = 120, height = 28, color = '#ff7f32' }) => {
    if (!counts?.length) return null;
    const max = Math.max(...counts) || 1;
    const w = width / counts.length;
    return (
        <svg className="mini-hist--UT" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
            {counts.map((c, i) => {
                const h = Math.max(1, (c / max) * (height - 2));
                return <rect key={i} x={i * w + 0.5} y={height - h} width={Math.max(1, w - 1)} height={h} rx="1" fill={color} opacity="0.75" />;
            })}
        </svg>
    );
};


const GearIcon = ({ size = 15 }) => (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
);

const TrashIcon = ({ size = 13 }) => (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
);

const CloseIcon = ({ size = 18 }) => (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
);


export { BrandMark, BackArrow, AppLoader, TypeBadge, MiniHistogram, GearIcon, TrashIcon, CloseIcon };
