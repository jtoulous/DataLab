// Formatage generique des valeurs affichees

export function formatNumber(value, digits = 4) {
    if (value === null || value === undefined || Number.isNaN(value)) return '—';
    if (typeof value !== 'number') return String(value);
    const abs = Math.abs(value);
    if (abs !== 0 && (abs >= 1e7 || abs < 1e-4)) return value.toExponential(2);
    if (Number.isInteger(value)) return value.toLocaleString('en-US');
    return value.toLocaleString('en-US', { maximumFractionDigits: abs >= 100 ? 2 : digits });
}

export function formatPct(value, digits = 1) {
    if (value === null || value === undefined || Number.isNaN(value)) return '—';
    return `${(value * 100).toFixed(digits)}%`;
}

export function formatCount(value) {
    if (value === null || value === undefined) return '—';
    return value.toLocaleString('en-US');
}

export function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

const pad = (n) => String(n).padStart(2, '0');

export function formatDate(value, withTime = true) {
    if (value === null || value === undefined) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    if (!withTime || (d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0)) return date;
    return `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${d.getUTCSeconds() ? `:${pad(d.getUTCSeconds())}` : ''}`;
}

export function formatCell(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return formatNumber(value, 6);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) return formatDate(value);
    return String(value);
}

// Types de colonnes : libelle, icone, couleur (identite visuelle stable dans toute l'app)
export const COLUMN_TYPE_STYLE = {
    datetime: { label: 'datetime', icon: '◷', color: '#3987e5' },
    numeric: { label: 'numeric', icon: '#', color: '#ff7f32' },
    boolean: { label: 'boolean', icon: '◐', color: '#c98500' },
    categorical: { label: 'categorical', icon: '▤', color: '#9085e9' },
    text: { label: 'text', icon: '¶', color: '#d55181' },
    identifier: { label: 'identifier', icon: '⌗', color: 'rgba(255,255,255,0.45)' },
    empty: { label: 'empty', icon: '∅', color: 'rgba(255,255,255,0.3)' },
    ignore: { label: 'ignored', icon: '⊘', color: 'rgba(255,255,255,0.25)' },
    derived: { label: 'derived', icon: 'ƒ', color: '#69f0ae' },
};
