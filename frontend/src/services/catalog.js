// Catalogue des colonnes utilisables dans les formulaires (colonnes du fichier + colonnes derivees)
export function buildCatalog(dataset) {
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
