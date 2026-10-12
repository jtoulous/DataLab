import ast
import time
import numpy as np
import pandas as pd

from . import Stats



###############################################################################################
###############################################################################################
##########                                   Engine                                  ##########
#
# Moteur d'analyse generique sur un DataFrame charge :
#   - vue        : plage de temps / lignes, reechantillonnage, filtre de lignes
#   - formules   : mini-langage pour creer des colonnes (AST whitelist, aucune execution Python)
#   - analyses   : ~20 analyses (distribution, relations, groupes, temps, tests, regression, PCA...)
#
# Les fenetres glissantes acceptent un nombre de lignes (50) ou, si le dataset a un axe temporel,
# une duree ('7D', '12h', '30min'). Les seules fonctions qui regardent les lignes SUIVANTES (lead)
# marquent la colonne LOOKAHEAD : variable a predire, jamais une feature.


FUNCTIONS_DOC = {
    'lag(x, n=1)': 'value n rows before',
    'lead(x, n=1)': 'LOOKAHEAD — value n rows after (target to predict)',
    'diff(x, n=1)': 'x - lag(x, n)',
    'pct(x, n=1)': 'x / lag(x, n) - 1',
    'mean(x, w) / median(x, w) / sum(x, w)': 'rolling statistic over window w (rows, or a duration like "7D" with a time axis)',
    'std(x, w) / var(x, w) / min(x, w) / max(x, w) / count(x, w)': 'rolling statistic over window w',
    'quantile(x, w, q)': 'rolling quantile q (0-1)',
    'ema(x, span)': 'exponential moving average',
    'zscore(x, w)': '(x - rolling mean) / rolling std',
    'pctrank(x, w)': 'percentile (0-1) of the current value within the window',
    'slope(x, n)': 'least-squares slope over the last n rows',
    'efficiency(x, n)': '|net change| / total path over n rows (1 = straight line, 0 = noise)',
    'skew(x, w) / kurt(x, w)': 'rolling skewness / excess kurtosis',
    'corr(x, y, w)': 'rolling correlation of two columns',
    'cumsum(x) / cummax(x) / cummin(x)': 'cumulative statistics',
    'abs, sign, log, log10, exp, sqrt': 'element-wise math',
    'round(x, d) / clip(x, lo, hi)': 'rounding / bounding',
    'where(cond, a, b)': 'a where cond is true, else b',
    'between(x, lo, hi)': 'true when lo <= x <= hi',
    'isnull(x) / fillna(x, v) / ffill(x)': 'missing values handling (ffill only uses the past)',
    'crossup(a, b) / crossdown(a, b)': 'true on the row where a crosses above / below b',
    'code(x)': 'integer code of a categorical column',
    'hour() minute() weekday() day() month() year() dayofyear()': 'parts of the time axis (or of a datetime column: hour(col))',
    'elapsed()': 'seconds since the first row (time axis)',
    'rownum()': 'row number',
}

LOOKAHEAD_FUNCTIONS = {'lead'}
MAX_POINTS = 15000


class FormulaError(Exception):
    pass



###############################################################################################
#####                                    Formulas                                        #####

def _rolling_slope(x, n):
    n = int(n)
    values = x.to_numpy(dtype=float)
    out = np.full(len(values), np.nan)
    if len(values) < n or n < 2:
        return pd.Series(out, index=x.index)
    t = np.arange(n, dtype=float)
    weights = (t - t.mean()) / ((t - t.mean()) ** 2).sum()
    windows = np.lib.stride_tricks.sliding_window_view(values, n)
    out[n - 1:] = windows @ weights
    return pd.Series(out, index=x.index)


class FormulaEvaluator:
    ALLOWED_NODES = (ast.Expression, ast.BinOp, ast.UnaryOp, ast.Compare, ast.Call, ast.Name, ast.Constant,
                     ast.Load, ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow, ast.Mod, ast.FloorDiv, ast.USub, ast.UAdd,
                     ast.Gt, ast.GtE, ast.Lt, ast.LtE, ast.Eq, ast.NotEq, ast.BitAnd, ast.BitOr, ast.Invert)

    def __init__(self, df, custom, time_index, depth=0, cache=None):
        self.df = df
        self.custom = custom
        self.time_index = time_index
        self.depth = depth
        self.lookahead = False
        self.cache = cache if cache is not None else {}

        S = self._series
        self.functions = {
            'lag': lambda x, n=1: self._lag(S(x), n),
            'lead': self._lead,
            'diff': lambda x, n=1: S(x) - self._lag(S(x), n),
            'pct': lambda x, n=1: S(x) / self._lag(S(x), n).replace(0, np.nan) - 1,
            'mean': lambda x, w: self._roll(x, w).mean(),
            'median': lambda x, w: self._roll(x, w).median(),
            'sum': lambda x, w: self._roll(x, w).sum(),
            'std': lambda x, w: self._roll(x, w).std(ddof=0),
            'var': lambda x, w: self._roll(x, w).var(ddof=0),
            'min': lambda x, w: self._roll(x, w).min(),
            'max': lambda x, w: self._roll(x, w).max(),
            'count': lambda x, w: self._roll(x, w).count(),
            'quantile': lambda x, w, q: self._roll(x, w).quantile(float(q)),
            'skew': lambda x, w: self._roll(x, w).skew(),
            'kurt': lambda x, w: self._roll(x, w).kurt(),
            'ema': lambda x, span: S(x).ewm(span=float(span), min_periods=1).mean(),
            'zscore': lambda x, w: (S(x) - self._roll(x, w).mean()) / self._roll(x, w).std(ddof=0).replace(0, np.nan),
            'pctrank': lambda x, w: self._roll(x, w).apply(lambda v: (v[:-1] < v[-1]).mean() if len(v) > 1 else np.nan, raw=True),
            'slope': lambda x, n: _rolling_slope(S(x), int(n)),
            'efficiency': lambda x, n: (S(x) - self._lag(S(x), n)).abs() / S(x).diff().abs().rolling(int(n)).sum().replace(0, np.nan),
            'corr': lambda x, y, w: self._roll(x, w).corr(S(y)),
            'cumsum': lambda x: S(x).cumsum(),
            'cummax': lambda x: S(x).cummax(),
            'cummin': lambda x: S(x).cummin(),
            'abs': lambda x: S(x).abs(),
            'sign': lambda x: np.sign(S(x)),
            'log': lambda x: np.log(S(x).where(S(x) > 0)),
            'log10': lambda x: np.log10(S(x).where(S(x) > 0)),
            'exp': lambda x: np.exp(S(x)),
            'sqrt': lambda x: np.sqrt(S(x).where(S(x) >= 0)),
            'round': lambda x, d=0: S(x).round(int(d)),
            'clip': lambda x, lo, hi: S(x).clip(lo, hi),
            'where': lambda c, a, b: pd.Series(np.where(self._bool(c), S(a), S(b)), index=df.index),
            'between': lambda x, lo, hi: (S(x) >= lo) & (S(x) <= hi),
            'isnull': lambda x: S(x).isna(),
            'fillna': lambda x, v: S(x).fillna(v),
            'ffill': lambda x: S(x).ffill(),
            'crossup': lambda a, b: (S(a) > S(b)) & (S(a).shift(1) <= S(b).shift(1)),
            'crossdown': lambda a, b: (S(a) < S(b)) & (S(a).shift(1) >= S(b).shift(1)),
            'code': lambda x: pd.Series(pd.factorize(S(x), sort=True)[0], index=df.index).replace(-1, np.nan).astype(float),
            'hour': lambda col=None: self._time_part(col, 'hour'),
            'minute': lambda col=None: self._time_part(col, 'minute'),
            'weekday': lambda col=None: self._time_part(col, 'weekday'),
            'day': lambda col=None: self._time_part(col, 'day'),
            'month': lambda col=None: self._time_part(col, 'month'),
            'year': lambda col=None: self._time_part(col, 'year'),
            'dayofyear': lambda col=None: self._time_part(col, 'dayofyear'),
            'elapsed': self._elapsed,
            'rownum': lambda: pd.Series(np.arange(len(df), dtype=float), index=df.index),
        }

    # ── helpers ──────────────────────────────────────────────────────────────

    def _series(self, value):
        if isinstance(value, pd.Series):
            return value
        return pd.Series(value, index=self.df.index)

    def _bool(self, value):
        s = self._series(value)
        return s.fillna(0).astype(bool) if s.dtype != bool else s

    def _lag(self, x, n):
        if n < 0:
            raise FormulaError('lag() needs n >= 0 — use lead() to look at following rows')
        return x.shift(int(n))

    def _lead(self, x, n=1):
        self.lookahead = True
        return self._series(x).shift(-int(n))

    def _roll(self, x, w):
        x = self._series(x)
        if isinstance(w, str):
            if not self.time_index:
                raise FormulaError(f'Duration windows ("{w}") need a time axis — use a number of rows')
            try:
                return x.rolling(w)
            except ValueError as error:
                raise FormulaError(f'Invalid duration "{w}": {error}')
        w = int(w)
        if w < 1:
            raise FormulaError('Window must be >= 1')
        return x.rolling(w, min_periods=w)

    def _time_part(self, col, part):
        if col is None:
            if not self.time_index:
                raise FormulaError(f'{part}() needs a time axis, or a datetime column: {part}(my_date)')
            values = self.df.index.to_series()
        else:
            values = col if isinstance(col, pd.Series) else self._column(str(col))
            if not pd.api.types.is_datetime64_any_dtype(values):
                raise FormulaError(f'{part}() expects a datetime column')
        accessor = values.dt
        return pd.Series(getattr(accessor, part).to_numpy(dtype=float), index=self.df.index)

    def _elapsed(self):
        if not self.time_index:
            raise FormulaError('elapsed() needs a time axis')
        index = self.df.index
        return pd.Series((index - index[0]).total_seconds().to_numpy(dtype=float), index=index)

    # ── evaluation ───────────────────────────────────────────────────────────

    def evaluate(self, formula):
        formula = (formula or '').strip()
        if not formula:
            raise FormulaError('Empty formula')
        if formula in self.cache:
            value, lookahead = self.cache[formula]
            self.lookahead = self.lookahead or lookahead
            return value
        try:
            tree = ast.parse(formula, mode='eval')
        except SyntaxError as error:
            raise FormulaError(f'Syntax error: {error.msg}')
        for node in ast.walk(tree):
            if not isinstance(node, self.ALLOWED_NODES):
                raise FormulaError(f'Not allowed in formulas: {type(node).__name__}')
        before = self.lookahead
        self.lookahead = False
        result = self._series(self._eval(tree.body))
        if result.dtype == bool:
            result = result.astype(float)
        elif pd.api.types.is_numeric_dtype(result):
            result = result.astype(float).replace([np.inf, -np.inf], np.nan)
        self.cache[formula] = (result, self.lookahead)
        self.lookahead = before or self.lookahead
        return result

    def _eval(self, node):
        if isinstance(node, ast.Constant):
            if isinstance(node.value, (int, float, str)) and not isinstance(node.value, bool):
                return node.value
            raise FormulaError('Only numbers and strings are allowed as constants')
        if isinstance(node, ast.Name):
            return self._column(node.id)
        if isinstance(node, ast.UnaryOp):
            value = self._eval(node.operand)
            if isinstance(node.op, ast.USub):
                return -value
            if isinstance(node.op, ast.Invert):
                return ~self._bool(value)
            return value
        if isinstance(node, ast.BinOp):
            left, right = self._eval(node.left), self._eval(node.right)
            op = node.op
            try:
                if isinstance(op, ast.Add): return left + right
                if isinstance(op, ast.Sub): return left - right
                if isinstance(op, ast.Mult): return left * right
                if isinstance(op, ast.Div):
                    return left / (right.replace(0, np.nan) if isinstance(right, pd.Series) else (right or np.nan))
                if isinstance(op, ast.FloorDiv): return left // right
                if isinstance(op, ast.Pow): return left ** right
                if isinstance(op, ast.Mod): return left % right
                if isinstance(op, ast.BitAnd): return self._bool(left) & self._bool(right)
                if isinstance(op, ast.BitOr): return self._bool(left) | self._bool(right)
            except TypeError:
                raise FormulaError('Arithmetic on a non-numeric column — use code(x) for categories')
        if isinstance(node, ast.Compare):
            if len(node.ops) != 1:
                raise FormulaError('Chained comparisons are not supported, use (a > b) & (b > c)')
            left, right = self._eval(node.left), self._eval(node.comparators[0])
            op = node.ops[0]
            if isinstance(op, ast.Gt): return left > right
            if isinstance(op, ast.GtE): return left >= right
            if isinstance(op, ast.Lt): return left < right
            if isinstance(op, ast.LtE): return left <= right
            if isinstance(op, ast.Eq): return left == right
            if isinstance(op, ast.NotEq): return left != right
        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name) or node.func.id not in self.functions:
                name = node.func.id if isinstance(node.func, ast.Name) else '?'
                raise FormulaError(f'Unknown function {name}()')
            if node.keywords:
                raise FormulaError('Use positional arguments only, e.g. mean(x, 50)')
            args = [self._eval(arg) for arg in node.args]
            try:
                return self.functions[node.func.id](*args)
            except FormulaError:
                raise
            except (TypeError, ValueError) as error:
                raise FormulaError(f'{node.func.id}(): {error}')
        raise FormulaError(f'Unsupported expression: {type(node).__name__}')

    def _column(self, name):
        if name in self.df.columns:
            return self.df[name]
        if name in self.custom:
            if self.depth > 25:
                raise FormulaError(f'Column {name}: too deep (circular reference?)')
            nested = FormulaEvaluator(self.df, self.custom, self.time_index, self.depth + 1, self.cache)
            value = nested.evaluate(self.custom[name])
            self.lookahead = self.lookahead or nested.lookahead
            return value
        raise FormulaError(f'Unknown column "{name}"')



###############################################################################################
#####                                      View                                          #####

class View:
    """
    Un dataset tel qu'analyse : df type -> plage -> reechantillonnage -> colonnes derivees -> filtre.
    `settings` : {range: {start, end}, resample: {rule, agg}, filter: formule booleenne}
    """

    def __init__(self, df, profile, custom, settings):
        self.profile = profile
        self.custom = custom or {}
        self.settings = settings or {}
        self.time_index = isinstance(df.index, pd.DatetimeIndex)

        df = df.drop(columns=[c for c, i in profile['columns'].items() if i.get('type') == 'ignore' and c in df.columns])
        df = self._apply_range(df)
        df = self._apply_resample(df)
        self.df = df
        self.cache = {}
        self.mask = None

        filter_formula = (self.settings.get('filter') or '').strip()
        if filter_formula:
            mask = self.evaluator().evaluate(filter_formula)
            self.mask = mask.fillna(0).astype(bool)

    def _apply_range(self, df):
        r = self.settings.get('range') or {}
        start, end = r.get('start'), r.get('end')
        if self.time_index:
            if start:
                df = df[df.index >= pd.Timestamp(start, unit='ms', tz='UTC') if isinstance(start, (int, float)) else pd.Timestamp(start, tz='UTC')]
            if end:
                df = df[df.index <= pd.Timestamp(end, unit='ms', tz='UTC') if isinstance(end, (int, float)) else pd.Timestamp(end, tz='UTC')]
        else:
            if start not in (None, ''):
                df = df.iloc[int(start):]
            if end not in (None, ''):
                df = df.iloc[:int(end)]
        return df

    def _apply_resample(self, df):
        spec = self.settings.get('resample') or {}
        rule = spec.get('rule')
        if not rule:
            return df
        if not self.time_index:
            raise FormulaError('Resampling needs a time axis')
        agg = spec.get('agg', 'mean')
        types = {k: v.get('type') for k, v in self.profile['columns'].items()}
        how = {}
        for column in df.columns:
            kind = types.get(column)
            if kind in ('numeric', 'boolean'):
                how[column] = agg
            elif kind == 'datetime':
                how[column] = 'last'
            else:
                how[column] = 'last'
        try:
            out = df.resample(rule).agg(how)
        except (ValueError, TypeError) as error:
            raise FormulaError(f'Invalid resample rule "{rule}": {error}')
        out['n_rows'] = df.iloc[:, 0].resample(rule).size().astype(float)
        return out.dropna(how='all', subset=[c for c in out.columns if c != 'n_rows'])

    def evaluator(self):
        return FormulaEvaluator(self.df, self.custom, self.time_index, cache=self.cache)

    def column(self, formula, numeric=True):
        """Evalue une formule ; renvoie (serie filtree, lookahead)."""
        ev = self.evaluator()
        values = ev.evaluate(formula)
        if numeric and not pd.api.types.is_numeric_dtype(values):
            raise FormulaError(f'"{formula}" is not numeric — use code({formula}) or pick a numeric column')
        if self.mask is not None:
            values = values[self.mask]
        return values, ev.lookahead

    def frame(self, formulas, numeric=True):
        out, lookahead = {}, []
        for f in formulas:
            values, la = self.column(f, numeric=numeric)
            out[f] = values
            if la:
                lookahead.append(f)
        return pd.DataFrame(out), lookahead

    @property
    def index(self):
        return self.df.index if self.mask is None else self.df.index[self.mask.to_numpy()]

    def numeric_columns(self):
        return [c for c in self.df.columns if pd.api.types.is_numeric_dtype(self.df[c])]

    def shuffled(self, mode='rows', seed=0):
        """
        Version "hasard" du dataset pour les comparaisons :
          rows       : lignes permutees (detruit tout ordre temporel)
          increments : on permute les variations ligne a ligne des colonnes numeriques puis on
                       reconstruit (adapte aux series de niveau : prix, compteurs cumulatifs...)
        """
        rng = np.random.default_rng(seed)
        df = self.df
        order = rng.permutation(len(df))
        if mode == 'increments':
            out = df.copy()
            for c in self.numeric_columns():
                values = df[c].to_numpy(dtype=float)
                inc = np.diff(values, prepend=values[0])
                inc[0] = 0
                rebuilt = values[0] + np.cumsum(np.nan_to_num(inc[order]))
                out[c] = rebuilt
        else:
            out = df.iloc[order].copy()
            out.index = df.index
        view = View.__new__(View)
        view.profile, view.custom, view.settings = self.profile, self.custom, self.settings
        view.time_index, view.df, view.cache, view.mask = self.time_index, out, {}, None
        return view



###############################################################################################
#####                                     Analyses                                       #####

def run_analysis(view, analysis, params):
    handler = ANALYSES.get(analysis)
    if handler is None:
        raise FormulaError(f'Unknown analysis {analysis}')
    started = time.time()
    result = handler(view, params or {})
    index = view.index
    result['meta'] = {
        'rows': int(len(index)),
        'duration': time.time() - started,
        'time_index': view.time_index,
        'start': _ms(index[0]) if view.time_index and len(index) else None,
        'end': _ms(index[-1]) if view.time_index and len(index) else None,
    }
    return result


def _table(view, p):
    columns = p.get('columns') or list(view.df.columns)
    frame = {}
    for c in columns:
        values, _ = view.column(c, numeric=False)
        frame[c] = values
    df = pd.DataFrame(frame)
    # l'axe temporel n'est ajoute que s'il apporte qqch : donnees reechantillonnees (l'index = debut
    # de periode) ou colonne de date non affichee
    time_column = (view.profile.get('time') or {}).get('column')
    resampled = bool((view.settings.get('resample') or {}).get('rule'))
    if view.time_index and (resampled or time_column not in df.columns):
        df.insert(0, '__time__', df.index)
    sort_by = p.get('sort_by')
    if sort_by and sort_by in df.columns:
        df = df.sort_values(sort_by, ascending=bool(p.get('ascending', True)), kind='stable', na_position='last')
    elif p.get('descending_time'):
        df = df.iloc[::-1]
    page, size = int(p.get('page', 0)), int(p.get('page_size', 100))
    chunk = df.iloc[page * size:(page + 1) * size]
    rows = [[_json(v) for v in row] for row in chunk.itertuples(index=False, name=None)]
    return {'columns': list(df.columns), 'rows': rows, 'total': int(len(df)), 'page': page, 'page_size': size}


def _series(view, p):
    frame, lookahead = view.frame(p.get('columns') or view.numeric_columns()[:3])
    x_formula = p.get('x')
    if x_formula:
        x, _ = view.column(x_formula, numeric=False)
        frame = frame.assign(__x__=x).sort_values('__x__')
        x_values = frame.pop('__x__')
    else:
        x_values = frame.index.to_series()
    step = max(1, int(np.ceil(len(frame) / MAX_POINTS)))
    frame, x_values = frame.iloc[::step], x_values.iloc[::step]
    return {
        'x': [_json(v) for v in x_values],
        'x_kind': 'time' if (not x_formula and view.time_index) or pd.api.types.is_datetime64_any_dtype(x_values) else 'number',
        'columns': {c: _clean_list(frame[c]) for c in frame.columns},
        'lookahead': lookahead, 'downsampled': step > 1,
    }


def _stats(view, p):
    frame, lookahead = view.frame(p.get('columns') or view.numeric_columns()[:6])
    return {'stats': {c: describe(frame[c]) for c in frame.columns}, 'lookahead': lookahead}


def _histogram(view, p):
    bins = int(p.get('bins', 50))
    group = p.get('group')
    out = {'series': [], 'lookahead': []}
    formulas = p.get('columns') or view.numeric_columns()[:1]
    for formula in formulas:
        values, la = view.column(formula)
        if la:
            out['lookahead'].append(formula)
        values = values.dropna()
        if values.empty:
            continue
        lo, hi = (values.quantile(0.005), values.quantile(0.995)) if p.get('clip', True) else (values.min(), values.max())
        if not (np.isfinite(lo) and np.isfinite(hi)) or lo == hi:
            lo, hi = values.min() - 0.5, values.max() + 0.5
        edges = np.linspace(lo, hi, bins + 1)
        parts = [(formula, values)]
        if group:
            groups, _ = view.column(group, numeric=False)
            groups = groups.reindex(values.index)
            top = groups.value_counts().head(6).index
            parts = [(f'{formula} | {g}', values[groups == g]) for g in top]
        for label, v in parts:
            counts, _ = np.histogram(v.clip(lo, hi), bins=edges)
            out['series'].append({
                'label': label, 'edges': edges.tolist(),
                'density': (counts / max(1, counts.sum()) / np.diff(edges)).tolist(),
                'stats': describe(v),
            })
    return out


def _box(view, p):
    formulas = p.get('columns') or view.numeric_columns()[:3]
    group = p.get('group')
    boxes = []
    groups = None
    if group:
        groups, _ = view.column(group, numeric=False)
        if pd.api.types.is_numeric_dtype(groups) and groups.nunique() > 12:
            groups = pd.qcut(groups, q=6, duplicates='drop').astype(str)
        top = groups.value_counts().head(int(p.get('max_groups', 12))).index.tolist()
    for formula in formulas:
        values, _ = view.column(formula)
        parts = [(None, values)] if groups is None else [(g, values[groups.reindex(values.index) == g]) for g in sorted(top, key=str)]
        for g, v in parts:
            v = v.dropna()
            if v.empty:
                continue
            q1, med, q3 = v.quantile([0.25, 0.5, 0.75])
            iqr = q3 - q1
            lo_fence = v[v >= q1 - 1.5 * iqr].min()
            hi_fence = v[v <= q3 + 1.5 * iqr].max()
            outliers = v[(v < lo_fence) | (v > hi_fence)]
            boxes.append({
                'column': formula, 'group': None if g is None else str(g), 'n': int(len(v)),
                'q1': float(q1), 'median': float(med), 'q3': float(q3), 'mean': float(v.mean()),
                'lowerfence': float(lo_fence), 'upperfence': float(hi_fence),
                'outliers': int(len(outliers)),
                'outlier_sample': outliers.sample(min(len(outliers), 150), random_state=0).tolist() if len(outliers) else [],
            })
    return {'boxes': boxes}


def _scatter(view, p):
    x, la_x = view.column(p['x'])
    y, la_y = view.column(p['y'])
    data = {'x': x, 'y': y}
    color_kind = None
    if p.get('color'):
        c, _ = view.column(p['color'], numeric=False)
        data['c'] = c
        color_kind = 'numeric' if pd.api.types.is_numeric_dtype(c) else 'category'
    if p.get('size'):
        data['s'], _ = view.column(p['size'])
    frame = pd.DataFrame(data).dropna(subset=['x', 'y'])
    sample = frame.sample(min(len(frame), int(p.get('max_points', 8000))), random_state=0) if len(frame) else frame
    result = {
        'x': sample['x'].tolist(), 'y': sample['y'].tolist(), 'n': int(len(frame)),
        'color': [_json(v) for v in sample['c']] if 'c' in sample else None, 'color_kind': color_kind,
        'size': _clean_list(sample['s']) if 's' in sample else None,
        'lookahead': [f for f, la in ((p['x'], la_x), (p['y'], la_y)) if la],
    }
    if len(frame) > 3 and frame['x'].nunique() > 1:
        slope, intercept = np.polyfit(frame['x'], frame['y'], 1)
        result['fit'] = {'slope': float(slope), 'intercept': float(intercept)}
        result['pearson'] = _clean(frame['x'].corr(frame['y']))
        result['spearman'] = _spearman(frame['x'], frame['y'])
        bins = pd.qcut(frame['x'], q=min(25, max(2, len(frame) // 40)), duplicates='drop')
        g = frame.groupby(bins, observed=True)
        result['binned'] = {'x': g['x'].mean().tolist(), 'y': g['y'].mean().tolist(),
                            'q25': g['y'].quantile(0.25).tolist(), 'q75': g['y'].quantile(0.75).tolist()}
    return result


def _splom(view, p):
    formulas = (p.get('columns') or view.numeric_columns()[:4])[:7]
    frame, _ = view.frame(formulas)
    if p.get('color'):
        c, _ = view.column(p['color'], numeric=False)
        frame['__c__'] = c
    frame = frame.dropna(subset=formulas)
    sample = frame.sample(min(len(frame), int(p.get('max_points', 2500))), random_state=0)
    return {
        'columns': {f: _clean_list(sample[f]) for f in formulas},
        'color': [_json(v) for v in sample['__c__']] if '__c__' in sample else None,
        'n': int(len(frame)),
    }


def _correlation(view, p):
    formulas = p.get('columns') or view.numeric_columns()[:15]
    frame, _ = view.frame(formulas)
    method = p.get('method', 'pearson')
    ranked = frame.rank() if method == 'spearman' else frame
    matrix = ranked.corr()
    order = list(matrix.columns)
    if p.get('cluster', True) and len(order) > 2:
        # ordre par la premiere composante principale de la matrice : regroupe les variables liees
        values = np.nan_to_num(matrix.to_numpy())
        w, v = np.linalg.eigh(values)
        order = [order[i] for i in np.argsort(v[:, -1])]
        matrix = matrix.loc[order, order]
    return {'columns': order, 'matrix': [[_clean(v) for v in row] for row in matrix.to_numpy()], 'method': method,
            'n': int(frame.dropna().shape[0])}


def _group_keys(view, by, rule=None, bins=8):
    if by == '__time__':
        if not view.time_index:
            raise FormulaError('Grouping by time needs a time axis')
        index = view.index
        rule = rule or 'D'
        try:
            if rule.rstrip('E')[-1:] in ('W', 'M', 'Q', 'Y'):
                # periodes calendaires (semaine, mois, trimestre, annee)
                keys = index.tz_localize(None).to_period(rule.rstrip('E')).to_timestamp().tz_localize('UTC')
            else:
                keys = index.floor(rule)
        except (ValueError, TypeError) as error:
            raise FormulaError(f'Invalid time rule "{rule}": {error}')
        return pd.Series(keys, index=index), 'time'
    keys, _ = view.column(by, numeric=False)
    if pd.api.types.is_numeric_dtype(keys) and keys.nunique() > 30:
        return pd.qcut(keys, q=bins, duplicates='drop').astype(str), 'binned'
    return keys, 'category'


def _groupby(view, p):
    keys, kind = _group_keys(view, p.get('by'), p.get('rule'), int(p.get('bins', 8)))
    formulas = p.get('values') or view.numeric_columns()[:1]
    agg = p.get('agg', 'mean')
    frame, _ = view.frame(formulas)
    frame['__key__'] = keys.reindex(frame.index)
    grouped = frame.groupby('__key__', observed=True, dropna=True)
    result = grouped[formulas].agg(agg) if agg != 'count' else grouped[formulas].count()
    counts = grouped.size()
    if kind == 'category':
        order = counts.sort_values(ascending=False).head(int(p.get('max_groups', 40))).index
        if p.get('sort') == 'value':
            order = result.loc[order, formulas[0]].sort_values(ascending=False).index
        elif p.get('sort') == 'name':
            order = sorted(order, key=str)
        result, counts = result.loc[order], counts.loc[order]
    return {
        'keys': [_json(k) for k in result.index], 'kind': kind, 'agg': agg,
        'values': {f: _clean_list(result[f]) for f in formulas}, 'counts': [int(c) for c in counts],
    }


def _pivot(view, p):
    rows, _ = _group_keys(view, p['rows'], bins=int(p.get('bins', 8)))
    cols, _ = _group_keys(view, p['cols'], bins=int(p.get('bins', 8)))
    agg = p.get('agg', 'mean')
    if p.get('value'):
        values, _ = view.column(p['value'])
    else:
        values, agg = pd.Series(1.0, index=view.index), 'count'
    frame = pd.DataFrame({'v': values, 'r': rows.reindex(values.index), 'c': cols.reindex(values.index)}).dropna(subset=['r', 'c'])
    table = frame.pivot_table(index='r', columns='c', values='v', aggfunc=agg, observed=True)
    counts = frame.pivot_table(index='r', columns='c', values='v', aggfunc='count', observed=True).reindex_like(table)
    return {
        'rows': [_json(k) for k in table.index], 'cols': [_json(k) for k in table.columns],
        'matrix': [[_clean(v) for v in row] for row in table.to_numpy()],
        'counts': [[int(v) if not np.isnan(v) else 0 for v in row] for row in counts.to_numpy(dtype=float)], 'agg': agg,
    }


TIME_PARTS = {'hour': 24, 'weekday': 7, 'month': 12, 'day': 31, 'year': None, 'minute': 60, 'quarter': 4}


def _time_heatmap(view, p):
    if not view.time_index:
        raise FormulaError('This analysis needs a time axis')
    values, _ = view.column(p['column'])
    rows_part, cols_part = p.get('rows', 'weekday'), p.get('cols', 'hour')
    index = values.index
    frame = pd.DataFrame({'v': values.to_numpy(), 'r': getattr(index, rows_part), 'c': getattr(index, cols_part)})
    agg = p.get('agg', 'mean')
    table = frame.pivot_table(index='r', columns='c', values='v', aggfunc=agg)
    counts = frame.pivot_table(index='r', columns='c', values='v', aggfunc='count').reindex_like(table)
    return {
        'rows': [int(r) for r in table.index], 'cols': [int(c) for c in table.columns],
        'rows_part': rows_part, 'cols_part': cols_part, 'agg': agg,
        'matrix': [[_clean(v) for v in row] for row in table.to_numpy()],
        'counts': [[int(v) if not np.isnan(v) else 0 for v in row] for row in counts.to_numpy(dtype=float)],
    }


def _binned(view, p):
    """Moyenne conditionnelle : X decoupe en quantiles, Y moyen par tranche + test vs permutation."""
    x, _ = view.column(p['x'])
    y, la = view.column(p['y'])
    buckets = int(p.get('buckets', 10))
    frame = pd.DataFrame({'x': x, 'y': y}).dropna()
    if len(frame) < buckets * 5:
        raise FormulaError('Not enough rows for this number of buckets')
    table = _bucket_table(frame, buckets)
    result = {**table, 'ic': _spearman(frame['x'], frame['y']), 'lookahead_y': la}

    # stabilite : correlation de rang par periode (annee si axe temporel, sinon 5 tranches)
    if view.time_index:
        groups = frame.groupby(frame.index.year)
        result['stability'] = {str(k): _spearman(g['x'], g['y']) for k, g in groups if len(g) > 30}
    else:
        chunks = np.array_split(np.arange(len(frame)), 5)
        result['stability'] = {f'rows {c[0]}-{c[-1]}': _spearman(frame['x'].iloc[c], frame['y'].iloc[c]) for c in chunks if len(c) > 30}

    # permutation par blocs : garde l'autocorrelation de x, casse le lien x -> y
    block = max(1, int(p.get('block', 1)))
    rng = np.random.default_rng(0)
    xs = frame['x'].to_numpy()
    n_blocks = int(np.ceil(len(xs) / block))
    spreads = []
    for _ in range(int(p.get('permutations', 200))):
        order = rng.permutation(n_blocks)
        permuted = np.concatenate([xs[i * block:(i + 1) * block] for i in order])[:len(xs)]
        spreads.append(_bucket_table(frame.assign(x=permuted), buckets)['spread'])
    spreads = np.array(spreads)
    result['null_spread'] = {'p5': float(np.percentile(spreads, 5)), 'p95': float(np.percentile(spreads, 95))}
    result['p_value'] = float((np.abs(spreads) >= abs(table['spread'])).mean())
    return result


def _bucket_table(frame, buckets):
    groups = pd.qcut(frame['x'].rank(method='first'), q=buckets, labels=False)
    rows = []
    for b, g in frame.groupby(groups):
        y = g['y']
        std = y.std(ddof=1)
        rows.append({
            'bucket': int(b) + 1, 'count': int(len(g)), 'x_min': float(g['x'].min()), 'x_max': float(g['x'].max()),
            'x_mean': float(g['x'].mean()), 'mean': float(y.mean()), 'median': float(y.median()), 'std': _clean(std),
            'positive': float((y > 0).mean()), 't_stat': _clean(y.mean() / (std / np.sqrt(len(y)))) if std and std > 0 else None,
        })
    return {'buckets': rows, 'spread': rows[-1]['mean'] - rows[0]['mean'], 'baseline': float(frame['y'].mean())}


def _event_study(view, p):
    condition, _ = view.column(p['condition'])
    condition = condition.fillna(0).astype(bool).to_numpy()
    values, _ = view.column(p['value'])
    values = values.to_numpy(dtype=float)
    horizon, lookback = int(p.get('horizon', 20)), int(p.get('lookback', 10))
    gap = int(p.get('gap', horizon))
    mode = p.get('mode', 'diff')
    n = len(values)

    events, last = [], -10 ** 9
    for i in np.flatnonzero(condition):
        if i - last >= gap and i - lookback >= 0 and i + horizon < n and np.isfinite(values[i]):
            events.append(i)
            last = i
    if not events:
        raise FormulaError('The condition never occurs (or only too close to the edges)')

    offsets = np.arange(-lookback, horizon + 1)

    def paths_at(idx):
        base = values[idx][:, None]
        window = values[np.asarray(idx)[:, None] + offsets]
        return window / base - 1 if mode == 'ratio' else window - base

    paths = paths_at(np.array(events))
    rng = np.random.default_rng(0)
    valid = np.arange(lookback, n - horizon)
    valid = valid[np.isfinite(values[valid])]
    null_means = np.array([np.nanmean(paths_at(rng.choice(valid, size=len(events), replace=len(valid) < len(events))), axis=0)
                           for _ in range(int(p.get('permutations', 200)))])
    final = paths[:, -1]
    final_mean = float(np.nanmean(final))
    p_value = float((null_means[:, -1] >= final_mean).mean()) if final_mean >= np.mean(null_means[:, -1]) else float((null_means[:, -1] <= final_mean).mean())
    index = view.index
    return {
        'offsets': offsets.tolist(), 'count': int(len(events)), 'mode': mode,
        'mean': _clean_list(pd.Series(np.nanmean(paths, axis=0))), 'median': _clean_list(pd.Series(np.nanmedian(paths, axis=0))),
        'q10': _clean_list(pd.Series(np.nanpercentile(paths, 10, axis=0))), 'q25': _clean_list(pd.Series(np.nanpercentile(paths, 25, axis=0))),
        'q75': _clean_list(pd.Series(np.nanpercentile(paths, 75, axis=0))), 'q90': _clean_list(pd.Series(np.nanpercentile(paths, 90, axis=0))),
        'positive': _clean_list(pd.Series((paths > 0).mean(axis=0))),
        'null_mean': _clean_list(pd.Series(null_means.mean(axis=0))),
        'null_p5': _clean_list(pd.Series(np.percentile(null_means, 5, axis=0))), 'null_p95': _clean_list(pd.Series(np.percentile(null_means, 95, axis=0))),
        'final': {'mean': final_mean, 'median': float(np.nanmedian(final)), 'positive': float((final > 0).mean()), 'p_value': p_value},
        'events': [{'at': _json(index[i]), 'value': float(paths[k, -1])} for k, i in list(enumerate(events))[-100:]],
    }


def _acf(view, p):
    values, _ = view.column(p['column'])
    values = values.dropna()
    max_lag = int(p.get('max_lag', 40))
    acf = [_clean(values.autocorr(lag)) for lag in range(1, max_lag + 1)]
    # autocorrelation partielle (Durbin-Levinson) : effet direct de chaque retard
    pacf = _pacf([a or 0.0 for a in acf])
    return {'lags': list(range(1, max_lag + 1)), 'acf': acf, 'pacf': pacf, 'band': float(1.96 / np.sqrt(max(1, len(values)))), 'n': int(len(values))}


def _pacf(acf):
    pacf, phi = [], []
    for k in range(1, len(acf) + 1):
        if k == 1:
            phi = [acf[0]]
        else:
            num = acf[k - 1] - sum(phi[j] * acf[k - 2 - j] for j in range(k - 1))
            den = 1 - sum(phi[j] * acf[j] for j in range(k - 1))
            phi_kk = num / den if den else 0.0
            phi = [phi[j] - phi_kk * phi[k - 2 - j] for j in range(k - 1)] + [phi_kk]
        pacf.append(float(phi[-1]))
    return pacf


def _xcorr(view, p):
    x, _ = view.column(p['x'])
    y, _ = view.column(p['y'])
    max_lag = int(p.get('max_lag', 30))
    lags = list(range(-max_lag, max_lag + 1))
    # lag k > 0 : x d'il y a k lignes vs y maintenant -> "x en avance sur y"
    values = [_clean(x.shift(k).corr(y)) for k in lags]
    n = int(pd.concat([x, y], axis=1).dropna().shape[0])
    best = max(((k, v) for k, v in zip(lags, values) if v is not None), key=lambda kv: abs(kv[1]), default=(0, None))
    return {'lags': lags, 'corr': values, 'band': float(1.96 / np.sqrt(max(1, n))), 'best_lag': best[0], 'best_corr': best[1], 'n': n}


def _runs(view, p):
    """Segments de signe constant d'un score (avec zone neutre) et analyse de survie de leurs durees."""
    threshold = float(p.get('threshold', 0))
    score, _ = view.column(p['column'])
    amplitude_formula = p.get('amplitude')
    amplitude = view.column(amplitude_formula)[0] if amplitude_formula else None
    real = _segments(score, amplitude, threshold)
    null_view = view.shuffled(p.get('null_mode', 'rows'))
    null_score, _ = null_view.column(p['column'])
    null_amp = null_view.column(amplitude_formula)[0] if amplitude_formula else None
    null = _segments(null_score, null_amp, threshold)
    durations = [s['duration'] for s in real['segments']] or [1]
    max_t = int(p.get('max_duration') or max(2, np.percentile(durations, 99)))
    out = {'max_t': max_t, 'real': {}, 'null': {}, 'current': real['current'], 'null_mode': p.get('null_mode', 'rows')}
    for label, segs in (('real', real), ('null', null)):
        for direction in ('up', 'down'):
            d = np.array([s['duration'] for s in segs['segments'] if s['direction'] == direction])
            a = np.array([s['amplitude'] for s in segs['segments'] if s['direction'] == direction and s['amplitude'] is not None])
            out[label][direction] = _survival(d, a, max_t)
    return out


def _segments(score, amplitude, threshold):
    values = score.to_numpy(dtype=float)
    amp = amplitude.reindex(score.index).to_numpy(dtype=float) if amplitude is not None else None
    state = np.zeros(len(values))
    current = 0
    for i, v in enumerate(values):
        if np.isnan(v):
            current = 0
        elif v > threshold:
            current = 1
        elif v < -threshold:
            current = -1
        state[i] = current
    segments, start = [], 0
    for i in range(1, len(state) + 1):
        if i == len(state) or state[i] != state[i - 1]:
            if state[i - 1] != 0:
                segments.append({
                    'direction': 'up' if state[i - 1] > 0 else 'down', 'duration': int(i - start),
                    'start': _json(score.index[start]), 'end': _json(score.index[i - 1]),
                    'amplitude': float(amp[i - 1] - amp[start]) if amp is not None and np.isfinite(amp[i - 1]) and np.isfinite(amp[start]) else None,
                    'complete': i != len(state),
                })
            start = i
    current = segments[-1] if segments and not segments[-1]['complete'] else None
    return {'segments': [s for s in segments[1:] if s['complete']], 'current': current}


def _survival(durations, amplitudes, max_t):
    if len(durations) == 0:
        return {'count': 0}
    t = np.arange(1, max_t + 1)
    alive = np.array([(durations >= k).sum() for k in t])
    ending = np.array([(durations == k).sum() for k in t])
    with np.errstate(divide='ignore', invalid='ignore'):
        hazard = np.where(alive >= 10, ending / alive, np.nan)
    remaining = [float(durations[durations >= k].mean() - k) if (durations >= k).sum() >= 10 else None for k in t]
    return {
        'count': int(len(durations)), 'mean': float(durations.mean()), 'median': float(np.median(durations)),
        'std': float(durations.std()), 'p75': float(np.percentile(durations, 75)), 'p90': float(np.percentile(durations, 90)),
        'max': int(durations.max()), 'mean_amplitude': float(amplitudes.mean()) if len(amplitudes) else None,
        'hist': np.bincount(np.minimum(durations, max_t), minlength=max_t + 1)[1:].tolist(),
        't': t.tolist(), 'survival': (alive / len(durations)).tolist(), 'hazard': [_clean(h) for h in hazard], 'remaining': remaining,
    }


def _regression(view, p):
    y_formula, x_formulas = p['y'], p.get('x') or []
    if not x_formulas:
        raise FormulaError('Add at least one explanatory column')
    frame, _ = view.frame([y_formula] + list(x_formulas))
    frame = frame.dropna()
    if len(frame) < len(x_formulas) + 5:
        raise FormulaError('Not enough complete rows')
    res = Stats.ols(frame[y_formula].to_numpy(float), frame[x_formulas].to_numpy(float), x_formulas)
    rng = np.random.default_rng(0)
    idx = rng.choice(len(frame), size=min(len(frame), 4000), replace=False)
    fitted, resid = res.pop('fitted'), res.pop('residuals')
    res['sample'] = {'fitted': fitted[idx].tolist(), 'actual': frame[y_formula].to_numpy()[idx].tolist(), 'residual': resid[idx].tolist()}
    hist, edges = np.histogram(resid, bins=50)
    res['residual_hist'] = {'counts': hist.tolist(), 'edges': edges.tolist()}
    res['residual_acf1'] = _clean(pd.Series(resid).autocorr(1)) if view.time_index else None
    return res


def _pca(view, p):
    formulas = p.get('columns') or view.numeric_columns()[:8]
    frame, _ = view.frame(formulas)
    frame = frame.dropna()
    if len(frame) < 10 or len(formulas) < 2:
        raise FormulaError('PCA needs at least 2 columns and 10 complete rows')
    X = frame.to_numpy(float)
    std = X.std(axis=0)
    std[std == 0] = 1
    Z = (X - X.mean(axis=0)) / std
    U, S, Vt = np.linalg.svd(Z, full_matrices=False)
    explained = (S ** 2) / (S ** 2).sum()
    scores = U[:, :3] * S[:3]
    rng = np.random.default_rng(0)
    idx = rng.choice(len(frame), size=min(len(frame), 4000), replace=False)
    color = None
    if p.get('color'):
        c, _ = view.column(p['color'], numeric=False)
        color = [_json(v) for v in c.reindex(frame.index).to_numpy()[idx]]
    return {
        'columns': formulas, 'explained': explained.tolist(),
        'loadings': [[float(v) for v in Vt[k]] for k in range(min(3, len(Vt)))],
        'pc1': scores[idx, 0].tolist(), 'pc2': scores[idx, 1].tolist() if scores.shape[1] > 1 else [],
        'color': color, 'n': int(len(frame)),
    }


def _compare(view, p):
    values, _ = view.column(p['column'])
    if p.get('condition'):
        cond, _ = view.column(p['condition'])
        cond = cond.reindex(values.index).fillna(0).astype(bool)
        a, b = values[cond].dropna(), values[~cond].dropna()
        labels = [f'{p["condition"]}', f'not ({p["condition"]})']
    else:
        groups, _ = view.column(p['group'], numeric=False)
        groups = groups.reindex(values.index)
        names = [p.get('a'), p.get('b')]
        if not all(names):
            top = groups.value_counts().head(2).index.tolist()
            names = [names[0] or top[0], names[1] or (top[1] if len(top) > 1 else top[0])]
        a, b = values[groups.astype(str) == str(names[0])].dropna(), values[groups.astype(str) == str(names[1])].dropna()
        labels = [str(names[0]), str(names[1])]
    if len(a) < 2 or len(b) < 2:
        raise FormulaError('Each side needs at least 2 values')
    both = pd.concat([a, b])
    lo, hi = both.quantile(0.005), both.quantile(0.995)
    edges = np.linspace(lo, hi, int(p.get('bins', 40)) + 1) if hi > lo else np.linspace(lo - 0.5, hi + 0.5, 11)
    hist = lambda v: (np.histogram(v.clip(edges[0], edges[-1]), bins=edges)[0] / max(1, len(v)) / np.diff(edges)).tolist()
    return {
        'labels': labels, 'edges': edges.tolist(), 'density': [hist(a), hist(b)],
        'stats': [describe(a), describe(b)], 'welch': Stats.welch_t_test(a, b), 'ks': Stats.ks_two_sample(a, b),
    }


def _missing(view, p):
    df = view.df if view.mask is None else view.df[view.mask]
    bins = int(p.get('bins', 60))
    chunks = np.array_split(np.arange(len(df)), min(bins, max(1, len(df))))
    columns = list(df.columns)
    matrix = [[float(df[c].iloc[chunk].isna().mean()) if len(chunk) else 0.0 for chunk in chunks] for c in columns]
    labels = [_json(df.index[chunk[0]]) if len(chunk) else None for chunk in chunks]
    return {
        'columns': columns, 'labels': labels, 'matrix': matrix,
        'totals': {c: float(df[c].isna().mean()) for c in columns},
    }


ANALYSES = {
    'table': _table, 'series': _series, 'stats': _stats, 'histogram': _histogram, 'box': _box,
    'scatter': _scatter, 'splom': _splom, 'correlation': _correlation, 'groupby': _groupby, 'pivot': _pivot,
    'time_heatmap': _time_heatmap, 'binned': _binned, 'event_study': _event_study, 'acf': _acf, 'xcorr': _xcorr,
    'runs': _runs, 'regression': _regression, 'pca': _pca, 'compare': _compare, 'missing': _missing,
}



###############################################################################################
#####                                      Helpers                                       #####

def describe(values):
    v = pd.to_numeric(values, errors='coerce').replace([np.inf, -np.inf], np.nan)
    clean = v.dropna()
    if clean.empty:
        return {'count': 0, 'missing': int(v.isna().sum())}
    q = clean.quantile([0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99])
    return {
        'count': int(len(clean)), 'missing': int(v.isna().sum()), 'mean': _clean(clean.mean()), 'std': _clean(clean.std(ddof=1)),
        'min': _clean(clean.min()), 'p1': _clean(q[0.01]), 'p5': _clean(q[0.05]), 'p25': _clean(q[0.25]), 'median': _clean(q[0.5]),
        'p75': _clean(q[0.75]), 'p95': _clean(q[0.95]), 'p99': _clean(q[0.99]), 'max': _clean(clean.max()),
        'skew': _clean(clean.skew()), 'kurtosis': _clean(clean.kurt()), 'positive': float((clean > 0).mean()),
        'unique': int(clean.nunique()),
    }


def _spearman(a, b):
    return _clean(a.rank().corr(b.rank()))


def _ms(t):
    return int(pd.Timestamp(t).timestamp() * 1000)


def _clean(v):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    return None if np.isnan(v) or np.isinf(v) else v


def _clean_list(series):
    return [_clean(v) for v in np.asarray(series, dtype=float)]


def _json(v):
    if v is None:
        return None
    if isinstance(v, pd.Timestamp):
        return None if pd.isna(v) else v.isoformat()
    if isinstance(v, (np.floating, float)):
        return _clean(v)
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.bool_, bool)):
        return bool(v)
    if isinstance(v, pd.Interval):
        return str(v)
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    return v if isinstance(v, (str, int)) else str(v)
