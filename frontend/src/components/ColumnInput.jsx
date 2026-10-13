import React, { useContext, useEffect, useMemo, useRef, useState } from "react";

import { GlobalState } from '../State.jsx';
import { COLUMN_TYPE_STYLE } from '../services/format.js';

import "./ColumnInput.css";


import { ColumnsContext } from './columnsContext.js';

const TRAILING_TOKEN = /[A-Za-z_][A-Za-z0-9_]*$/;

// Champ colonne / formule avec selecteur : on peut taper une formule librement, ou ouvrir la liste
// (bouton ▾ ou focus) et cliquer une colonne. Le mot en cours de frappe filtre la liste et est
// remplace par la colonne choisie (single : le champ entier) ; apres un operateur ou une parenthese, la colonne est ajoutee.
export function ColumnInput({ value, onChange, onPick, placeholder, className = 'mono--DS', onKeyDown, onBlur, autoCommit = false, single = false }) {
    const catalog = useContext(ColumnsContext);
    const { meta } = GlobalState();
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(0);
    const [typing, setTyping] = useState(false); // filtre uniquement pendant la frappe, pas a l'ouverture
    const wrapRef = useRef(null);
    const inputRef = useRef(null);
    const text = value || '';
    const token = (text.match(TRAILING_TOKEN) || [''])[0];
    const query = typing ? token : '';

    const functions = useMemo(() => {
        if (!meta?.functions) return [];
        const names = Object.keys(meta.functions).flatMap(f => f.split(' / ')).map(f => f.trim().match(/^[A-Za-z_0-9]+/)?.[0]).filter(Boolean);
        return [...new Set(names)];
    }, [meta]);

    const options = useMemo(() => {
        if (!catalog) return [];
        const q = query.toLowerCase();
        const match = (name) => !q || name.toLowerCase().includes(q);
        const types = Object.fromEntries(catalog.columns.map(c => [c.key, c.type]));
        const columns = catalog.all.filter(match).map(name => ({ name, kind: 'column', type: types[name] || 'derived' }));
        const funcs = q ? functions.filter(f => f.toLowerCase().startsWith(q) && f !== token).map(name => ({ name, kind: 'function' })) : [];
        return [...columns, ...funcs].slice(0, 80);
    }, [catalog, query, token, functions]);

    useEffect(() => { setActive(0); }, [query, open]);

    useEffect(() => {
        if (!open) return;
        const close = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
        document.addEventListener('mousedown', close);
        return () => document.removeEventListener('mousedown', close);
    }, [open]);

    const pick = (option) => {
        const insert = option.kind === 'function' ? `${option.name}(` : option.name;
        if (onPick && option.kind === 'column') {
            onPick(option.name);
            onChange?.('');
        } else {
            onChange(single && option.kind === 'column' ? insert : text.slice(0, text.length - token.length) + insert);
        }
        if (option.kind === 'function' || !onPick) inputRef.current?.focus();
        if (onPick || autoCommit) setOpen(false);
    };

    const handleKeyDown = (e) => {
        if (open && options.length) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(options.length - 1, a + 1)); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(0, a - 1)); return; }
            if (e.key === 'Tab' && query) { e.preventDefault(); pick(options[active]); return; }
            if (e.key === 'Enter' && query && options[active] && options[active].name !== token) { e.preventDefault(); pick(options[active]); return; }
        }
        if (e.key === 'Escape') setOpen(false);
        onKeyDown?.(e);
    };

    return (
        <div className="colinput--CI" ref={wrapRef}>
            <input ref={inputRef} className={className} value={text} placeholder={placeholder} spellCheck={false} autoComplete="off"
                onChange={(e) => { onChange(e.target.value); setTyping(true); setOpen(true); }} onFocus={() => { setTyping(false); setOpen(true); }} onKeyDown={handleKeyDown} onBlur={onBlur} />
            <button type="button" className="colinput-toggle--CI" tabIndex={-1} title="Pick a column" onMouseDown={(e) => e.preventDefault()}
                onClick={() => { setTyping(false); setOpen(o => !o); inputRef.current?.focus(); }}>▾</button>
            {open && (
                <div className="colinput-menu--CI">
                    {options.length === 0 && <div className="colinput-empty--CI">No matching column</div>}
                    {options.map((o, i) => {
                        const style = o.kind === 'column' ? (COLUMN_TYPE_STYLE[o.type] || COLUMN_TYPE_STYLE.empty) : null;
                        return (
                            <button type="button" key={`${o.kind}-${o.name}`} className={`colinput-option--CI ${i === active ? 'active' : ''}`}
                                onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => pick(o)}>
                                <span className="colinput-icon--CI" style={{ color: style ? style.color : '#9085e9' }}>{style ? style.icon : 'ƒ'}</span>
                                <span className="colinput-name--CI">{o.name}</span>
                                <span className="colinput-type--CI">{style ? style.label : 'function'}</span>
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
