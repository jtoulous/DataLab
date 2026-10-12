import io
import re
import csv
import json
import warnings
import unicodedata
import numpy as np
import pandas as pd



###############################################################################################
###############################################################################################
##########                                 DataLoader                                ##########
#
# Chargement adaptatif d'un fichier tabulaire, sans format impose :
#   - CSV / TSV / TXT : encodage, separateur, presence d'un en-tete detectes automatiquement
#   - Excel (.xlsx / .xls), Parquet, Feather, JSON (tableau d'objets, colonnes, JSON lines)
#
# Puis categorisation de chaque colonne (datetime, numeric, boolean, categorical, text, identifier,
# empty), avec conversion robuste : dates en texte (jour/mois ou mois/jour), timestamps Unix,
# nombres avec virgule decimale / separateurs de milliers / %, booleens oui/non...
#
# Les noms de colonnes sont normalises en identifiants (pour les formules), le nom d'origine est
# conserve comme libelle.


TEXT_EXTENSIONS = {'csv', 'tsv', 'txt', 'dat', 'tab'}
SUPPORTED_EXTENSIONS = TEXT_EXTENSIONS | {'xlsx', 'xls', 'xlsm', 'parquet', 'pq', 'feather', 'json', 'jsonl', 'ndjson'}

COLUMN_TYPES = ['datetime', 'numeric', 'boolean', 'categorical', 'text', 'identifier', 'empty', 'ignore']

NA_VALUES = {'', 'na', 'n/a', 'nan', 'null', 'none', '-', '--', '?', '#n/a', '#value!', '#div/0!', 'missing', 'nil'}
TRUE_VALUES = {'true', 't', 'yes', 'y', 'oui', 'vrai', '1'}
FALSE_VALUES = {'false', 'f', 'no', 'n', 'non', 'faux', '0'}
TIME_NAME_HINT = re.compile(r'(date|time|timestamp|datetime|^ts$|_ts$|^dt$|period|day|jour|heure)', re.I)

PARSE_THRESHOLD = 0.95        # part minimale de valeurs non vides qui doivent se convertir


class LoadError(Exception):
    pass



###############################################################################################
#####                                     Reading                                        #####

def read_any(path, extension):
    """Lit le fichier en DataFrame brut + un rapport de lecture (format, encodage, separateur...)."""
    extension = extension.lower().lstrip('.')
    if extension not in SUPPORTED_EXTENSIONS:
        raise LoadError(f'Unsupported file type .{extension} (supported: {", ".join(sorted(SUPPORTED_EXTENSIONS))})')

    if extension in TEXT_EXTENSIONS:
        return _read_text(path)
    if extension in ('xlsx', 'xls', 'xlsm'):
        sheets = pd.read_excel(path, sheet_name=None)
        name, df = max(sheets.items(), key=lambda kv: kv[1].size)      # la feuille la plus remplie
        return df, {'format': 'excel', 'sheet': name, 'sheets': list(sheets.keys())}
    if extension in ('parquet', 'pq'):
        return pd.read_parquet(path), {'format': 'parquet'}
    if extension == 'feather':
        return pd.read_feather(path), {'format': 'feather'}
    return _read_json(path, extension)


def _detect_encoding(raw):
    for encoding in ('utf-8-sig', 'utf-8', 'cp1252', 'latin-1'):
        try:
            raw.decode(encoding)
            return encoding
        except UnicodeDecodeError:
            continue
    return 'latin-1'


def _read_text(path):
    with open(path, 'rb') as f:
        head = f.read(256 * 1024)
    if not head.strip():
        raise LoadError('The file is empty')
    encoding = _detect_encoding(head)
    sample = head.decode(encoding, errors='replace')
    # on ignore une eventuelle derniere ligne tronquee de l'echantillon
    sample_lines = [l for l in sample.splitlines()[:200] if l.strip()]
    sample = '\n'.join(sample_lines[:-1] if len(sample_lines) > 2 else sample_lines)

    delimiter = _detect_delimiter(sample)
    try:
        has_header = csv.Sniffer().has_header(sample) if delimiter != 'whitespace' else True
    except csv.Error:
        has_header = True
    # le Sniffer se trompe souvent quand toutes les colonnes sont textuelles : on garde l'en-tete si
    # la 1ere ligne ne contient aucun nombre
    first = sample_lines[0] if sample_lines else ''
    if not has_header and not re.search(r'\d', first):
        has_header = True

    read_kwargs = dict(
        encoding=encoding, dtype=str, keep_default_na=False, na_values=[],
        header=0 if has_header else None, skipinitialspace=True, on_bad_lines='warn',
    )
    if delimiter == 'whitespace':
        read_kwargs['sep'] = r'\s+'
    else:
        read_kwargs['sep'] = delimiter
    with warnings.catch_warnings(record=True) as caught:
        df = pd.read_csv(path, **read_kwargs)
    bad_lines = sum(1 for w in caught if 'Skipping line' in str(w.message) or 'Expected' in str(w.message))

    if not has_header:
        df.columns = [f'col_{i + 1}' for i in range(df.shape[1])]
    return df, {
        'format': 'text', 'encoding': encoding,
        'delimiter': {'\t': 'tab', ' ': 'space', 'whitespace': 'whitespace'}.get(delimiter, delimiter),
        'header': has_header, 'skipped_lines': bad_lines,
    }


def _detect_delimiter(sample):
    """Separateur le plus regulier d'une ligne a l'autre (et present sur la 1ere ligne)."""
    lines = [l for l in sample.splitlines() if l.strip()][:50]
    best, best_score = ',', -1.0
    for candidate in [',', ';', '\t', '|', ':']:
        counts = [_count_outside_quotes(l, candidate) for l in lines]
        if not counts or counts[0] == 0:
            continue
        mode = max(set(counts), key=counts.count)
        consistency = counts.count(mode) / len(counts)
        score = consistency * 10 + min(mode, 50) / 50
        if mode > 0 and score > best_score:
            best, best_score = candidate, score
    if best_score < 0:
        # aucun separateur classique : colonnes separees par des espaces ?
        if all(len(l.split()) == len(lines[0].split()) > 1 for l in lines[:20]):
            return 'whitespace'
    return best


def _count_outside_quotes(line, char):
    count, quoted = 0, False
    for c in line:
        if c == '"':
            quoted = not quoted
        elif c == char and not quoted:
            count += 1
    return count


def _read_json(path, extension):
    with open(path, 'rb') as f:
        raw = f.read()
    text = raw.decode(_detect_encoding(raw[:65536]), errors='replace').strip()
    if extension in ('jsonl', 'ndjson') or (text.startswith('{') and '\n{' in text):
        records = [json.loads(line) for line in text.splitlines() if line.strip()]
        return pd.json_normalize(records), {'format': 'json lines'}
    data = json.loads(text)
    if isinstance(data, list):
        return pd.json_normalize(data), {'format': 'json records'}
    if isinstance(data, dict):
        # {"col": [...], ...}  ou  {"data": [...]}  ou  {"index": {...}}
        list_values = {k: v for k, v in data.items() if isinstance(v, list)}
        if len(list_values) == 1 and isinstance(next(iter(list_values.values()))[0], dict):
            return pd.json_normalize(next(iter(list_values.values()))), {'format': f'json ({next(iter(list_values))})'}
        if list_values and len({len(v) for v in list_values.values()}) == 1:
            return pd.DataFrame(list_values), {'format': 'json columns'}
        return pd.DataFrame.from_dict(data, orient='index'), {'format': 'json index'}
    raise LoadError('Unsupported JSON structure')



###############################################################################################
#####                                   Column names                                     #####

def make_keys(labels):
    """Libelles d'origine -> identifiants uniques utilisables dans les formules (snake_case ASCII)."""
    keys, used = [], set()
    for i, label in enumerate(labels):
        text = unicodedata.normalize('NFKD', str(label)).encode('ascii', 'ignore').decode()
        key = re.sub(r'[^0-9a-zA-Z]+', '_', text).strip('_').lower() or f'col_{i + 1}'
        if key[0].isdigit():
            key = f'c_{key}'
        base, n = key, 2
        while key in used:
            key, n = f'{base}_{n}', n + 1
        used.add(key)
        keys.append(key)
    return keys



###############################################################################################
#####                                  Type inference                                    #####

def _is_missing(series):
    if series.dtype == object or pd.api.types.is_string_dtype(series):
        stripped = series.astype(str).str.strip().str.lower()
        return series.isna() | stripped.isin(NA_VALUES)
    return series.isna()


def _parse_bool(values):
    lowered = values.astype(str).str.strip().str.lower()
    ok = lowered.isin(TRUE_VALUES | FALSE_VALUES)
    return lowered.isin(TRUE_VALUES).where(ok), ok.mean()


NUMBER_CLEAN = re.compile(r'[\s  $€£¥%]')


def _parse_numeric(values):
    """Essaie point decimal, puis virgule decimale. Renvoie (serie, taux de succes, note)."""
    text = values.astype(str).str.strip()
    is_percent = text.str.endswith('%').mean() > 0.5
    cleaned = text.str.replace(NUMBER_CLEAN, '', regex=True).str.replace(r'^\((.*)\)$', r'-\1', regex=True)

    attempts = []
    # 1) format anglo-saxon : 1,234.56
    attempts.append((pd.to_numeric(cleaned.str.replace(',', '', regex=False), errors='coerce'), 'dot decimal'))
    # 2) format europeen : 1.234,56 ou 1 234,56
    attempts.append((pd.to_numeric(cleaned.str.replace('.', '', regex=False).str.replace(',', '.', regex=False), errors='coerce'), 'decimal comma'))
    # 3) virgule decimale sans milliers : 12,5
    attempts.append((pd.to_numeric(cleaned.str.replace(',', '.', regex=False), errors='coerce'), 'decimal comma'))

    # entre plusieurs conversions qui marchent, la plus naturelle : si toutes les virgules sont suivies
    # de exactement 3 chiffres, ce sont des milliers ; sinon une virgule seule est un decimal
    has_comma = cleaned.str.contains(',', regex=False)
    thousands_like = cleaned[has_comma].str.match(r'^-?\d{1,3}(,\d{3})+(\.\d+)?$').mean() if has_comma.any() else 1.0
    order = [0, 1, 2] if thousands_like > 0.9 else [2, 1, 0]

    best_values, best_rate, best_note = None, -1.0, None
    for i in order:
        parsed, note = attempts[i]
        rate = parsed.notna().mean()
        if rate > best_rate + 1e-9:
            best_values, best_rate, best_note = parsed, rate, note
    if is_percent and best_values is not None:
        best_values = best_values / 100
        best_note = f'{best_note}, percent'
    return best_values, best_rate, best_note


DATE_SHAPE = re.compile(r'\d{1,4}[-/.\s]\d{1,2}[-/.\s]\d{1,4}|\d{4}-?\d{2}-?\d{2}|[a-zA-Z]{3,9}[\s,.-]+\d{1,2}|\d{1,2}[\s.-]+[a-zA-Z]{3,9}')


def _parse_datetime(values):
    """Dates en texte : ISO, jour/mois ou mois/jour (tranche selon les valeurs), formats mixtes."""
    text = values.astype(str).str.strip()
    if text.str.contains(DATE_SHAPE).mean() < PARSE_THRESHOLD:
        return None, 0.0, None

    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        try:
            iso = pd.to_datetime(text, format='ISO8601', errors='coerce', utc=True)
            if iso.notna().mean() >= PARSE_THRESHOLD:
                return iso, iso.notna().mean(), 'ISO 8601'
        except (ValueError, TypeError):
            pass

        # jour en premier ? decide par les valeurs non ambigues (premier champ > 12)
        first_fields = text.str.extract(r'^(\d{1,2})[-/.]')[0].dropna().astype(int)
        second_fields = text.str.extract(r'^\d{1,2}[-/.](\d{1,2})[-/.]')[0].dropna().astype(int)
        if len(first_fields) and (first_fields > 12).any():
            candidates = [(True, 'day first')]
        elif len(second_fields) and (second_fields > 12).any():
            candidates = [(False, 'month first')]
        else:
            candidates = [(True, 'day first (ambiguous: no day > 12, check it)'), (False, 'month first (ambiguous)')]

        best = (None, 0.0, None)
        for dayfirst, note in candidates:
            try:
                parsed = pd.to_datetime(text, format='mixed', dayfirst=dayfirst, errors='coerce', utc=True)
            except (ValueError, TypeError):
                continue
            rate = parsed.notna().mean()
            if rate > best[1]:
                best = (parsed, rate, note)
        return best


def _epoch_unit(values, name):
    """Entier qui ressemble a un timestamp Unix (et dont le nom l'evoque) -> unite, sinon None."""
    if not TIME_NAME_HINT.search(name):
        return None
    v = values.dropna()
    if v.empty or (v % 1 != 0).any():
        return None
    lo, hi = v.min(), v.max()
    for unit, (a, b) in {'s': (3e8, 5e9), 'ms': (3e11, 5e12), 'us': (3e14, 5e15), 'ns': (3e17, 5e18)}.items():
        if a <= lo and hi <= b:
            return unit
    return None


def infer_column(series, name, n_rows):
    """
    Renvoie (serie convertie, infos de type). Les valeurs qui n'ont pas pu etre converties
    deviennent NaN et sont comptees dans `failed`.
    """
    missing = _is_missing(series)
    present = series[~missing]
    n_present = len(present)
    info = {'type': 'empty', 'subtype': None, 'note': None, 'failed': 0}

    if n_present == 0:
        return pd.Series(np.nan, index=series.index), info

    # ── deja type par le format source (parquet, excel...) ────────────────────
    if pd.api.types.is_bool_dtype(series):
        return series.astype(float), {**info, 'type': 'boolean'}
    if pd.api.types.is_datetime64_any_dtype(series):
        converted = pd.to_datetime(series, utc=True)
        return converted, {**info, 'type': 'datetime', 'subtype': 'native'}
    if pd.api.types.is_numeric_dtype(series):
        numeric = pd.to_numeric(series, errors='coerce').astype(float)
        unit = _epoch_unit(numeric, name)
        if unit:
            return pd.to_datetime(numeric, unit=unit, utc=True), {**info, 'type': 'datetime', 'subtype': f'unix {unit}'}
        return numeric, {**info, 'type': 'numeric', 'subtype': _numeric_subtype(numeric)}

    # ── texte : on essaie booleen, nombre, date, puis categories ──────────────
    parsed_bool, rate = _parse_bool(present)
    unique_lower = set(present.astype(str).str.strip().str.lower().unique())
    if rate >= 0.98 and not unique_lower <= {'0', '1'}:
        out = pd.Series(np.nan, index=series.index)
        out[~missing] = parsed_bool.astype(float)
        return out, {**info, 'type': 'boolean', 'failed': int((~parsed_bool.notna()).sum())}

    numeric, rate, note = _parse_numeric(present)
    if rate >= PARSE_THRESHOLD:
        out = pd.Series(np.nan, index=series.index)
        out[~missing] = numeric.astype(float)
        unit = _epoch_unit(out, name)
        if unit:
            return pd.to_datetime(out, unit=unit, utc=True), {**info, 'type': 'datetime', 'subtype': f'unix {unit}'}
        return out, {**info, 'type': 'numeric', 'subtype': _numeric_subtype(out), 'note': note if note != 'dot decimal' else None,
                     'failed': int(numeric.isna().sum())}

    dates, rate, note = _parse_datetime(present)
    if dates is not None and rate >= PARSE_THRESHOLD:
        out = pd.Series(pd.NaT, index=series.index, dtype='datetime64[ns, UTC]')
        out[~missing] = dates
        return out, {**info, 'type': 'datetime', 'subtype': 'text', 'note': note, 'failed': int(dates.isna().sum())}

    text = series.where(~missing).astype(object).where(~missing, None)
    text = text.map(lambda v: v.strip() if isinstance(v, str) else v)
    n_unique = present.nunique()
    if n_unique == n_present and n_present > 20:
        return text, {**info, 'type': 'identifier'}
    if n_unique <= max(30, 0.05 * n_present) or (n_unique <= 200 and n_unique / n_present < 0.5):
        return text, {**info, 'type': 'categorical'}
    return text, {**info, 'type': 'text'}


def _numeric_subtype(values):
    v = values.dropna()
    if v.empty:
        return None
    if (v % 1 == 0).all():
        return 'binary' if set(v.unique()) <= {0, 1} else 'integer'
    return 'float'


def force_type(series, target, name):
    """Applique un type choisi par l'utilisateur (override)."""
    missing = _is_missing(series)
    present = series[~missing]
    if target == 'numeric':
        values = pd.to_numeric(series, errors='coerce') if pd.api.types.is_numeric_dtype(series) else None
        if values is None:
            parsed, _, _ = _parse_numeric(present)
            values = pd.Series(np.nan, index=series.index)
            values[~missing] = parsed
        return values.astype(float), {'type': 'numeric', 'subtype': _numeric_subtype(values), 'note': 'forced', 'failed': int(values[~missing].isna().sum())}
    if target == 'datetime':
        if pd.api.types.is_datetime64_any_dtype(series):
            return pd.to_datetime(series, utc=True), {'type': 'datetime', 'subtype': 'native', 'note': 'forced', 'failed': 0}
        if pd.api.types.is_numeric_dtype(series):
            unit = _epoch_unit(series, 'time') or 's'
            return pd.to_datetime(series, unit=unit, utc=True, errors='coerce'), {'type': 'datetime', 'subtype': f'unix {unit}', 'note': 'forced', 'failed': 0}
        dates, _, note = _parse_datetime(present)
        if dates is None:
            dates = pd.to_datetime(present.astype(str), format='mixed', errors='coerce', utc=True)
        out = pd.Series(pd.NaT, index=series.index, dtype='datetime64[ns, UTC]')
        out[~missing] = dates
        return out, {'type': 'datetime', 'subtype': 'text', 'note': f'forced{", " + note if note else ""}', 'failed': int(dates.isna().sum())}
    if target == 'boolean':
        parsed, _ = _parse_bool(present)
        out = pd.Series(np.nan, index=series.index)
        out[~missing] = parsed.astype(float)
        return out, {'type': 'boolean', 'note': 'forced', 'failed': int(parsed.isna().sum())}
    text = series.where(~missing).astype(object)
    text = text.map(lambda v: (str(v).strip() if v is not None and not (isinstance(v, float) and np.isnan(v)) else None))
    return text, {'type': target, 'subtype': None, 'note': 'forced', 'failed': 0}



###############################################################################################
#####                                     Dataset                                        #####

def build_dataset(raw, overrides=None, time_column='auto'):
    """
    raw        : DataFrame brut (colonnes = libelles d'origine)
    overrides  : {cle: type force}  ('ignore' = colonne exclue)
    time_column: 'auto' | cle de colonne | None (pas d'axe temporel)

    Renvoie (df type et indexe, profil). L'index est l'axe temporel trie si il y en a un,
    sinon le numero de ligne.
    """
    overrides = overrides or {}
    labels = [str(c) for c in raw.columns]
    keys = make_keys(labels)
    raw = raw.copy()
    raw.columns = keys
    n = len(raw)

    columns, infos = {}, {}
    for key, label in zip(keys, labels):
        forced = overrides.get(key)
        if forced == 'ignore':
            infos[key] = {'label': label, 'type': 'ignore', 'subtype': None, 'note': 'ignored', 'failed': 0}
            continue
        if forced:
            values, info = force_type(raw[key], forced, key)
        else:
            values, info = infer_column(raw[key], key, n)
        columns[key] = values
        infos[key] = {'label': label, **info}

    df = pd.DataFrame(columns, index=raw.index)

    # ── axe temporel ──────────────────────────────────────────────────────────
    datetime_cols = [k for k, i in infos.items() if i['type'] == 'datetime']
    if time_column == 'auto':
        named = [k for k in datetime_cols if TIME_NAME_HINT.search(k)]
        time_column = (named or datetime_cols or [None])[0]
    elif time_column and time_column not in datetime_cols:
        time_column = None

    time_info = None
    if time_column:
        t = df[time_column]
        valid = t.notna()
        was_sorted = bool(t[valid].is_monotonic_increasing)
        df = df[valid].sort_values(time_column, kind='stable')
        index = pd.DatetimeIndex(df[time_column])
        df.index = index
        diffs = index.to_series().diff().dropna()
        median_step = diffs.median() if len(diffs) else None
        gaps = int((diffs > median_step * 1.5).sum()) if median_step is not None and median_step > pd.Timedelta(0) else 0
        time_info = {
            'column': time_column,
            'start': _ms(index[0]) if len(index) else None,
            'end': _ms(index[-1]) if len(index) else None,
            'was_sorted': was_sorted,
            'dropped_missing': int((~valid).sum()),
            'duplicates': int(index.duplicated().sum()),
            'median_step_seconds': median_step.total_seconds() if median_step is not None else None,
            'step_label': _step_label(median_step),
            'regular': bool(len(diffs) and (diffs == median_step).mean() > 0.95),
            'gaps': gaps,
        }
    else:
        df.index = pd.RangeIndex(len(df))

    profile = {
        'rows': int(len(df)),
        'columns': {key: {**infos[key], **profile_column(df[key], infos[key]['type'])} if key in df.columns else infos[key] for key in keys},
        'order': keys,
        'time': time_info,
    }
    return df, profile


def profile_column(values, kind):
    n = len(values)
    missing = int(values.isna().sum())
    out = {'missing': missing, 'missing_pct': missing / n if n else 0.0, 'unique': int(values.nunique(dropna=True))}
    present = values.dropna()
    if present.empty:
        return out
    if kind in ('numeric', 'boolean'):
        q = present.quantile([0.01, 0.25, 0.5, 0.75, 0.99])
        out['stats'] = {
            'mean': _clean(present.mean()), 'std': _clean(present.std(ddof=0)), 'min': _clean(present.min()),
            'p1': _clean(q[0.01]), 'p25': _clean(q[0.25]), 'median': _clean(q[0.5]), 'p75': _clean(q[0.75]),
            'p99': _clean(q[0.99]), 'max': _clean(present.max()), 'zeros': int((present == 0).sum()),
            'skew': _clean(present.skew()) if len(present) > 2 else None,
        }
        counts, edges = np.histogram(present.clip(q[0.01], q[0.99]) if q[0.99] > q[0.01] else present, bins=24)
        out['histogram'] = {'counts': counts.tolist(), 'edges': [float(e) for e in edges]}
    elif kind == 'datetime':
        out['stats'] = {'min': _ms(present.min()), 'max': _ms(present.max())}
    else:
        top = present.astype(str).value_counts().head(8)
        out['top'] = [{'value': str(k), 'count': int(v)} for k, v in top.items()]
        out['avg_length'] = float(present.astype(str).str.len().mean())
    out['sample'] = [_json_value(v) for v in present.head(5).tolist()]
    return out


def _step_label(step):
    if step is None or pd.isna(step):
        return None
    s = step.total_seconds()
    for size, label in ((86400 * 365, 'year'), (86400 * 28, 'month'), (86400 * 7, 'week'), (86400, 'day'), (3600, 'hour'), (60, 'minute'), (1, 'second')):
        if s >= size * 0.98:
            value = s / size
            return f'{value:.0f} {label}{"s" if round(value) > 1 else ""}' if abs(value - round(value)) < 0.05 else f'{value:.2f} {label}s'
    return f'{s * 1000:.0f} ms'


def _ms(t):
    return int(pd.Timestamp(t).timestamp() * 1000)


def _clean(v):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    return None if np.isnan(v) or np.isinf(v) else v


def _json_value(v):
    if isinstance(v, pd.Timestamp):
        return v.isoformat()
    if isinstance(v, (np.floating, float)):
        return _clean(v)
    if isinstance(v, (np.integer,)):
        return int(v)
    return v if isinstance(v, (str, int, bool)) or v is None else str(v)
