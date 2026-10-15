import React, { useState, useEffect } from "react";

import { apiRequests } from '../../services/api_requests.js';


// Bibliotheque de formules, commune a tous les datasets : on les sauvegarde une fois, on les reutilise partout.
// `draft` = formulaire en cours (nom + formule) ; `onLoad` le remplit avec une formule sauvegardee.
function SavedFormulas({ dataset, catalog, draft, onLoad, onApplied, onMessage }) {
    const [open, setOpen] = useState(false);
    const [formulas, setFormulas] = useState([]);
    const [filter, setFilter] = useState('');

    useEffect(() => {
        apiRequests.getSavedFormulas().then(setFormulas).catch(() => {});
    }, []);

    const canSave = !!draft?.name && !!draft?.formula?.trim();
    const exists = formulas.some(f => f.name === draft?.name);

    const save = () => {
        apiRequests.saveFormula(draft)
            .then(data => { setFormulas(data.formulas); onMessage(`Formula “${draft.name}” ${exists ? 'updated' : 'saved'}`); })
            .catch(err => onMessage(err.message));
    };
    const remove = (name) => {
        apiRequests.deleteFormula(name).then(data => setFormulas(data.formulas)).catch(err => onMessage(err.message));
    };
    // creation directe de la colonne dans le dataset courant, sous le nom de la formule
    const apply = (f) => {
        if (catalog.all.includes(f.name)) { onMessage(`${dataset.name} already has a column “${f.name}”`); return; }
        apiRequests.saveColumn(dataset.dataset_id, f)
            .then(data => { onApplied(data.derived_columns); onMessage(`Column “${f.name}” created`); })
            .catch(err => onMessage(`${f.name}: ${err.message}`));
    };

    const q = filter.toLowerCase();
    const shown = formulas.filter(f => !q || f.name.toLowerCase().includes(q) || f.formula.toLowerCase().includes(q));

    return (
        <>
            <button type="button" className="ex-link--EX" onClick={() => setOpen(!open)}>
                {open ? '▾' : '▸'} Saved formulas{formulas.length ? ` (${formulas.length})` : ''}
            </button>
            {open && (
                <div className="ft-saved--FT">
                    <button type="button" className="ft-saved-save--FT" disabled={!canSave} onClick={save}
                        title={canSave ? '' : 'Fill the column name and the formula above first'}>
                        ★ {exists ? `Update “${draft.name}”` : canSave ? `Save as “${draft.name}”` : 'Save the formula above'}
                    </button>
                    {formulas.length > 5 && <input className="ex-search--EX" placeholder="filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />}
                    {formulas.length === 0 && <div className="ex-columns-empty--EX">No saved formula yet — name a column, write its formula, then save it here.</div>}
                    {shown.map(f => (
                        <div key={f.name} className="ft-saved-item--FT" title={f.description || f.formula}>
                            <button type="button" className="ft-saved-main--FT" onClick={() => onLoad(f)}>
                                <b>{f.name}</b>
                                <code>{f.formula}</code>
                            </button>
                            <button type="button" title={`Create the column “${f.name}” in ${dataset.name} now`} onClick={() => apply(f)}>＋</button>
                            <button type="button" title="Delete from the library" onClick={() => remove(f.name)}>✕</button>
                        </div>
                    ))}
                </div>
            )}
        </>
    );
}

export default SavedFormulas;
