import math
import numpy as np
import pandas as pd

from .DataLoader import LoadError
from .Engine import FormulaError



###############################################################################################
###############################################################################################
##########                                 Resample                                  ##########
#
# Derive d'un dataset a axe temporel un dataset a une timeframe PLUS GROSSE (5 min -> 1 h ...).
# Chaque bougie regroupe les lignes fines de SA fenetre, et seulement elles :
#   convention 'start' : l'horodatage marque le debut des bougies -> bougie t = lignes dans [t, t + D)
#   convention 'end'   : l'horodatage marque la fin des bougies   -> bougie t = lignes dans (t - D, t]
# Les bougies sont alignees sur l'epoque Unix (1 h -> heures pleines UTC, 1 jour -> minuit UTC).
# Aucune bougie n'est supprimee : une bougie sans ligne fine reste vide (n_rows = 0).
# Un dataset fin fait de plusieurs morceaux (sous-dataset) garde ses raccords : pas de bougies
# fabriquees entre deux morceaux, et le debut de chaque morceau reste un raccord.


AGGREGATIONS = {
    'first': {'label': 'first', 'help': 'first value of the candle', 'numeric': False},
    'last': {'label': 'last', 'help': 'last value of the candle', 'numeric': False},
    'offset': {'label': 'value at row k', 'help': 'value of the k-th fine row of the candle (0 = first)', 'numeric': False},
    'sum': {'label': 'sum', 'help': 'sum of the fine rows', 'numeric': True},
    'mean': {'label': 'mean', 'help': 'average of the fine rows', 'numeric': True},
    'median': {'label': 'median', 'help': 'median of the fine rows', 'numeric': True},
    'min': {'label': 'min', 'help': 'smallest value', 'numeric': True},
    'max': {'label': 'max', 'help': 'largest value', 'numeric': True},
    'std': {'label': 'std', 'help': 'standard deviation of the fine rows', 'numeric': True},
    'count': {'label': 'count', 'help': 'number of non-empty fine rows', 'numeric': False},
    'quantile': {'label': 'quantile', 'help': 'quantile q (0-1) of the fine rows', 'numeric': True},
}
STATE_AGGS = {'first', 'last', 'offset'}          # valeurs "d'etat" : seules reprises par l'option ffill
SUM_NAMES = ('n_rows', 'volume', 'number_of_trades', 'trades', 'taker_buy', 'quote_asset', 'count', 'qty', 'amount')
MAX_PREVIEW_ROWS = 12


class ResampleError(LoadError):
    pass


def default_aggregation(name, kind):
    """Agregation proposee d'apres le nom / type de la colonne (OHLC, volumes ...)."""
    n = name.lower()
    if kind not in ('numeric', 'boolean'):
        return 'last'
    if n == 'open' or n.endswith('_open'):
        return 'first'
    if n == 'high' or n.endswith('_high'):
        return 'max'
    if n == 'low' or n.endswith('_low'):
        return 'min'
    if n == 'close' or n.endswith('_close'):
        return 'last'
    if any(k in n for k in SUM_NAMES):
        return 'sum'
    return 'mean'


def parse_rule(rule, step_seconds):
    """'1h', '4h', '1D', '15min', '7D' -> millisecondes ; verifie que c'est plus gros que le pas et un multiple."""
    try:
        delta = pd.Timedelta(pd.tseries.frequencies.to_offset(str(rule).strip()))
    except (ValueError, TypeError):
        raise ResampleError(f'Unknown timeframe "{rule}" — use e.g. 15min, 1h, 4h, 1D, 7D')
    ms = int(delta / pd.Timedelta(milliseconds=1))
    if ms <= 0:
        raise ResampleError('The timeframe must be positive')
    if step_seconds:
        step_ms = int(round(step_seconds * 1000))
        if ms <= step_ms:
            raise ResampleError(f'{rule} is not coarser than the current step — a resample only goes to a bigger timeframe (this dataset is the finest one)')
        if step_ms and ms % step_ms:
            raise ResampleError(f'{rule} is not a whole multiple of the current step ({_label(step_ms)}): candles would cut fine rows in two')
    return ms


def _label(ms):
    for unit, size in (('D', 86_400_000), ('h', 3_600_000), ('min', 60_000), ('s', 1000)):
        if ms % size == 0:
            return f'{ms // size}{unit}'
    return f'{ms}ms'


def _keys(index, delta_ms, convention):
    """Numero de bougie de chaque ligne fine (entier, aligne sur l'epoque)."""
    ms = index.as_unit('ms').asi8
    if convention == 'end':
        return -((-ms) // delta_ms)      # (t - D, t] -> bougie t
    return ms // delta_ms                # [t, t + D) -> bougie t


def _pieces(view):
    return view.slices or [(0, len(view.df))]


def _bins(keys, pieces):
    """
    Numeros de toutes les bougies a produire (y compris vides, pour ne jamais en supprimer) et
    numero de la premiere bougie de chaque morceau apres le premier (raccords du dataset derive).
    """
    spans, starts = [], []
    for a, b in pieces:
        if b <= a:
            continue
        lo, hi = int(keys[a]), int(keys[b - 1])
        spans.append(np.arange(lo, hi + 1, dtype=np.int64))
        starts.append(lo)
    if not spans:
        raise ResampleError('This dataset has no row')
    bins = np.unique(np.concatenate(spans))
    # une bougie a cheval sur un raccord appartient au morceau qui commence (elle regroupe les deux bords)
    seams = sorted({s for s in starts[1:] if s > bins[0]})
    return bins, seams


def describe_spec(view, spec):
    """Verifie la demande et renvoie (delta_ms, convention, items, step_seconds)."""
    if not view.time_index:
        raise ResampleError('A resample needs a time axis — set one in the Overview tab')
    time = view.profile.get('time') or {}
    step = time.get('median_step_seconds')
    delta_ms = parse_rule(spec.get('rule', '1h'), step)
    convention = 'end' if spec.get('convention') == 'end' else 'start'
    requested = spec.get('items') or default_items(view)
    items = [dict(i) for i in requested if i.get('include', True) and (i.get('source') or '').strip()]
    names = set()
    for item in items:
        item['name'] = (item.get('name') or item['source']).strip()
        if not item['name'].isidentifier():
            raise ResampleError(f'"{item["name"]}" is not a valid column name (letters, digits, _)')
        if item['name'] in names:
            raise ResampleError(f'Two columns are named "{item["name"]}"')
        names.add(item['name'])
        if item.get('agg') not in AGGREGATIONS:
            raise ResampleError(f'Unknown aggregation "{item.get("agg")}" for {item["name"]}')
    if not items:
        raise ResampleError('Choose at least one column to keep')
    time_column = time.get('column')
    if time_column in names:
        raise ResampleError(f'"{time_column}" is the time axis of the new dataset (the candle time): give that column another name')
    return delta_ms, convention, items, step


def default_items(view):
    """Une ligne par colonne du dataset fin (sauf l'axe temporel), avec l'agregation proposee."""
    time_column = (view.profile.get('time') or {}).get('column')
    out = []
    for column in view.df.columns:
        if column == time_column:
            continue
        kind = (view.profile['columns'].get(column) or {}).get('type') or ('numeric' if pd.api.types.is_numeric_dtype(view.df[column]) else 'categorical')
        out.append({'name': column, 'source': column, 'agg': default_aggregation(column, kind), 'kind': kind, 'include': True})
    return out


def _aggregate(values, group, agg, item, sizes_ok=None):
    """Agregation d'une serie (alignee sur les lignes fines) par numero de bougie."""
    values = values.copy()
    if sizes_ok is not None:
        values[~sizes_ok] = np.nan
    numeric = pd.api.types.is_numeric_dtype(values)
    if AGGREGATIONS[agg]['numeric'] and not numeric:
        raise ResampleError(f'"{item["source"]}" is not numeric: use first / last / count, or code({item["source"]})')
    grouped = values.groupby(group, sort=True)
    if agg == 'first':
        return grouped.first()
    if agg == 'last':
        return grouped.last()
    if agg == 'sum':
        return grouped.sum(min_count=1)
    if agg == 'mean':
        return grouped.mean()
    if agg == 'median':
        return grouped.median()
    if agg == 'min':
        return grouped.min()
    if agg == 'max':
        return grouped.max()
    if agg == 'std':
        return grouped.std(ddof=0)
    if agg == 'count':
        return grouped.count()
    if agg == 'quantile':
        q = float(item.get('q', 0.5))
        if not 0 <= q <= 1:
            raise ResampleError('A quantile must be between 0 and 1')
        return grouped.quantile(q)
    raise ResampleError(f'Unknown aggregation {agg}')


def _restrict_mask(position, size, item):
    """Lignes gardees par « seulement les N premieres / dernieres lignes de la bougie »."""
    side, n = item.get('restrict'), int(item.get('restrict_n') or 0)
    if side not in ('first', 'last') or n <= 0:
        return None
    return position < n if side == 'first' else position >= size - n


def resample(view, spec, progress=None):
    """
    Construit le tableau du dataset derive. Renvoie (frame, meta) ; frame a l'axe temporel en colonne
    (nom de la colonne temps du dataset fin) et une ligne par bougie, vides comprises.
    """
    delta_ms, convention, items, step = describe_spec(view, spec)
    df = view.df
    time_column = (view.profile.get('time') or {}).get('column') or 'time'
    keys = _keys(df.index, delta_ms, convention)
    pieces = _pieces(view)
    bins, seams = _bins(keys, pieces)
    group = pd.Series(keys, index=df.index)

    # position de chaque ligne dans sa bougie (pour « valeur a la ligne k » et « N dernieres lignes »)
    position = group.groupby(group, sort=False).cumcount().to_numpy()
    size = group.map(group.value_counts()).to_numpy()

    total = len(items) + 2
    columns, meta_items = {}, []
    for i, item in enumerate(items):
        if progress:
            progress(i, total, f'{item["name"]}')
        try:
            values, lookahead = view.column(item['source'], numeric=False)
        except FormulaError as error:
            raise ResampleError(f'{item["name"]}: {error}')
        keep = _restrict_mask(position, size, item)
        agg = item['agg']
        if agg == 'offset':
            k = int(item.get('k') or 0)
            values = values.where(position == k)
            agg = 'first'
        aggregated = _aggregate(values, group, agg, item, keep)
        columns[item['name']] = aggregated.reindex(bins)
        meta_items.append({**{k: item.get(k) for k in ('name', 'source', 'agg', 'q', 'k', 'restrict', 'restrict_n')}, 'lookahead': bool(lookahead)})

    if progress:
        progress(len(items), total, 'assembling candles')
    # resample d'un dataset deja resample : son n_rows (somme) garde le compte des lignes d'origine
    n_rows_name = 'n_rows' if 'n_rows' not in columns else f'n_rows_{_label(delta_ms)}'
    counts = group.value_counts().reindex(bins).fillna(0).astype(int)
    frame = pd.DataFrame(columns, index=bins)
    frame[n_rows_name] = counts.to_numpy()

    # reprise de la derniere valeur connue (option) : seulement les valeurs d'etat, morceau par morceau
    if spec.get('fill') == 'ffill':
        piece_id = np.searchsorted(np.asarray(seams, dtype=np.int64), bins, side='right')
        state = [m['name'] for m in meta_items if m['agg'] in STATE_AGGS]
        if state:
            frame[state] = frame[state].groupby(piece_id).ffill()

    labels = pd.to_datetime(bins * delta_ms, unit='ms', utc=True)
    frame.insert(0, time_column, labels)
    frame = frame.reset_index(drop=True)

    empty = int((counts == 0).sum())
    meta = {
        'rule': spec.get('rule'), 'rule_label': _label(delta_ms), 'delta_ms': delta_ms, 'convention': convention,
        'fill': spec.get('fill') or 'empty', 'items': meta_items, 'n_rows_column': n_rows_name,
        'candles': int(len(bins)), 'empty_candles': empty, 'fine_rows': int(len(df)),
        'rows_per_candle': float(counts[counts > 0].mean()) if len(counts) else 0,
        'expected_rows_per_candle': (delta_ms / 1000 / step) if step else None,
        'pieces': len(seams) + 1, 'segment_starts': [int(s * delta_ms) for s in seams],
        'step_from': (view.profile.get('time') or {}).get('step_label'), 'time_column': time_column,
    }
    if progress:
        progress(total - 1, total, 'building the dataset')
    return frame, meta


def preview(view, spec):
    """Infos avant creation : bougies, vides, morceaux, et les lignes fines de la premiere bougie."""
    delta_ms, convention, items, step = describe_spec(view, {**spec, 'items': spec.get('items') or default_items(view)})
    df = view.df
    keys = _keys(df.index, delta_ms, convention)
    bins, seams = _bins(keys, _pieces(view))
    counts = pd.Series(keys).value_counts()
    filled = counts.reindex(bins).fillna(0)
    expected = (delta_ms / 1000 / step) if step else None

    # premiere bougie COMPLETE (la premiere est souvent tronquee par le debut des donnees)
    first_key = int(bins[0])
    if expected:
        full = filled[filled >= expected]
        if len(full):
            first_key = int(full.index[0])
    rows = np.flatnonzero(keys == first_key)
    shown = rows if len(rows) <= MAX_PREVIEW_ROWS else np.concatenate([rows[:MAX_PREVIEW_ROWS // 2], rows[-MAX_PREVIEW_ROWS // 2:]])
    window_start = first_key * delta_ms - (delta_ms if convention == 'end' else 0)
    return {
        'rule_label': _label(delta_ms), 'delta_ms': delta_ms, 'convention': convention,
        'candles': int(len(bins)), 'empty_candles': int((filled == 0).sum()), 'incomplete_candles': int(((filled > 0) & (filled < expected)).sum()) if expected else None,
        'fine_rows': int(len(df)), 'expected_rows_per_candle': expected, 'pieces': len(seams) + 1,
        'step_from': (view.profile.get('time') or {}).get('step_label'),
        'example': {
            'label': first_key * delta_ms, 'window_start': window_start, 'window_end': window_start + delta_ms,
            'window_closed': 'right' if convention == 'end' else 'left',
            'rows': int(len(rows)), 'skipped': int(max(0, len(rows) - len(shown))),
            'times': [int(t) for t in df.index[shown].as_unit('ms').asi8],
        },
        'defaults': default_items(view),
        'aggregations': AGGREGATIONS,
        'lead_columns': sorted(view.lookahead_columns),
        'horizon_factor': None if not step else step * 1000 / delta_ms,
    }


def horizon_in_candles(fine_horizon_rows, step_seconds, delta_ms):
    """Horizon lead() exprime en lignes fines -> en bougies du dataset derive (arrondi au-dessus)."""
    if not fine_horizon_rows or not step_seconds:
        return 1
    return max(1, math.ceil(fine_horizon_rows * step_seconds * 1000 / delta_ms))



###############################################################################################
#####                       Agregation d'une granularite plus fine                       #####
#
# Ajoute au dataset COURANT des colonnes calculees sur les lignes d'un dataset plus fin de la meme
# famille (l'original ou un subset) : chaque bougie du dataset courant regroupe les lignes fines de
# sa fenetre ([t, t + D) en convention 'start', (t - D, t] en 'end'), D = pas du dataset courant.

def _coarse_step_ms(coarse_view):
    step = (coarse_view.profile.get('time') or {}).get('median_step_seconds')
    if not step:
        raise ResampleError('The current dataset has no regular time step')
    return int(round(step * 1000))


def check_granularity(coarse_view, fine_view):
    if not coarse_view.time_index or not fine_view.time_index:
        raise ResampleError('Both datasets need a time axis')
    coarse_ms = _coarse_step_ms(coarse_view)
    fine_step = (fine_view.profile.get('time') or {}).get('median_step_seconds') or 0
    if not fine_step or fine_step * 1000 >= coarse_ms:
        raise ResampleError('The source must be FINER than the current dataset (smaller time step)')
    return coarse_ms, fine_step


def _assign(coarse_index, fine_index, delta_ms, convention):
    """Pour chaque ligne fine : position de la bougie du dataset courant qui la contient, ou -1."""
    labels = coarse_index.as_unit('ms').asi8
    ts = fine_index.as_unit('ms').asi8
    if not len(labels):
        return np.full(len(ts), -1)
    if convention == 'end':
        pos = np.searchsorted(labels, ts, side='left')                 # premiere bougie dont l'heure >= t
        clipped = np.clip(pos, 0, len(labels) - 1)
        valid = (pos < len(labels)) & (ts > labels[clipped] - delta_ms)
    else:
        pos = np.searchsorted(labels, ts, side='right') - 1            # derniere bougie dont l'heure <= t
        clipped = np.clip(pos, 0, len(labels) - 1)
        valid = (pos >= 0) & (ts < labels[clipped] + delta_ms)
    return np.where(valid, clipped, -1)


def preview_aggregate(coarse_view, fine_view, convention='start'):
    delta_ms, fine_step = check_granularity(coarse_view, fine_view)
    assigned = _assign(coarse_view.df.index, fine_view.df.index, delta_ms, convention)
    counts = np.bincount(assigned[assigned >= 0], minlength=len(coarse_view.df))
    expected = delta_ms / 1000 / fine_step
    covered = counts > 0
    example = None
    full = np.flatnonzero(counts >= expected) if expected else np.flatnonzero(covered)
    if len(full):
        k = int(full[0])
        rows = np.flatnonzero(assigned == k)
        shown = rows if len(rows) <= MAX_PREVIEW_ROWS else np.concatenate([rows[:MAX_PREVIEW_ROWS // 2], rows[-MAX_PREVIEW_ROWS // 2:]])
        label = int(coarse_view.df.index[k].value // 10 ** 6)
        start = label - (delta_ms if convention == 'end' else 0)
        example = {'label': label, 'window_start': start, 'window_end': start + delta_ms, 'window_closed': 'right' if convention == 'end' else 'left',
                   'rows': int(len(rows)), 'skipped': int(max(0, len(rows) - len(shown))),
                   'times': [int(t) for t in fine_view.df.index[shown].as_unit('ms').asi8]}
    return {
        'coarse_step': (coarse_view.profile.get('time') or {}).get('step_label'), 'fine_step': (fine_view.profile.get('time') or {}).get('step_label'),
        'expected_rows_per_candle': expected, 'candles': int(len(counts)), 'covered': int(covered.sum()),
        'incomplete': int(((counts > 0) & (counts < expected)).sum()), 'not_covered': int((~covered).sum()),
        'fine_rows_used': int((assigned >= 0).sum()), 'fine_rows': int(len(assigned)), 'example': example,
        'aggregations': AGGREGATIONS, 'lead_columns': sorted(fine_view.lookahead_columns),
    }


def aggregate_into(coarse_view, fine_view, items, convention='start', progress=None):
    """Colonnes (alignees sur toutes les lignes du dataset courant) + metadonnees de chaque colonne."""
    delta_ms, fine_step = check_granularity(coarse_view, fine_view)
    if not items:
        raise ResampleError('Add at least one column to create')
    for item in items:
        if not (item.get('name') or '').isidentifier():
            raise ResampleError(f'"{item.get("name")}" is not a valid column name (letters, digits, _)')
        source = (item.get('source') or '').strip()
        if not source:
            raise ResampleError(f'{item["name"]}: choose a column of the source dataset')
        if source not in fine_view.df.columns and source not in fine_view.custom:
            raise ResampleError(f'{item["name"]}: "{source}" is not a column of the source dataset — create it there first (New column)')
        if item.get('agg') not in AGGREGATIONS:
            raise ResampleError(f'Unknown aggregation "{item.get("agg")}" for {item["name"]}')
    if len({i['name'] for i in items}) != len(items):
        raise ResampleError('Two new columns have the same name')

    assigned = _assign(coarse_view.df.index, fine_view.df.index, delta_ms, convention)
    used = assigned >= 0
    group = pd.Series(assigned[used], index=fine_view.df.index[used])
    position = group.groupby(group, sort=False).cumcount().to_numpy()
    size = group.map(group.value_counts()).to_numpy()
    candles = pd.RangeIndex(len(coarse_view.df))

    out, metas = {}, []
    for i, item in enumerate(items):
        if progress:
            progress(i, len(items) + 1, item['name'])
        try:
            values, lookahead = fine_view.column(item['source'], numeric=False)
        except FormulaError as error:
            raise ResampleError(f'{item["name"]}: {error}')
        values = values[used]
        agg = item['agg']
        if agg == 'offset':
            values = values.where(position == int(item.get('k') or 0))
            agg = 'first'
        if agg in ('first', 'last') and not pd.api.types.is_numeric_dtype(values):
            raise ResampleError(f'{item["name"]}: "{item["source"]}" is not numeric — use code({item["source"]}) to get a number per category')
        aggregated = _aggregate(values, group, agg, item, _restrict_mask(position, size, item)).reindex(candles)
        out[item['name']] = pd.Series(aggregated.to_numpy(dtype=float), index=coarse_view.df.index)
        metas.append({**{k: item.get(k) for k in ('name', 'source', 'agg', 'q', 'k', 'restrict', 'restrict_n')}, 'lookahead': bool(lookahead)})
    return out, metas, {'delta_ms': delta_ms, 'fine_step': fine_step, 'convention': convention}
