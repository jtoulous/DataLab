import re
import time
import warnings
import numpy as np
import pandas as pd

from sklearn.pipeline import Pipeline
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import StandardScaler, MinMaxScaler, RobustScaler
from sklearn.model_selection import KFold, StratifiedKFold, TimeSeriesSplit, train_test_split
from sklearn.inspection import permutation_importance
from sklearn import metrics as skm

from sklearn.dummy import DummyRegressor, DummyClassifier
from sklearn.linear_model import LinearRegression, Ridge, Lasso, ElasticNet, LogisticRegression
from sklearn.neighbors import KNeighborsRegressor, KNeighborsClassifier
from sklearn.tree import DecisionTreeRegressor, DecisionTreeClassifier
from sklearn.ensemble import (RandomForestRegressor, RandomForestClassifier, ExtraTreesRegressor, ExtraTreesClassifier,
                              HistGradientBoostingRegressor, HistGradientBoostingClassifier)
from sklearn.svm import SVR, SVC
from sklearn.naive_bayes import GaussianNB
from sklearn.neural_network import MLPRegressor, MLPClassifier

from .Engine import FormulaError



###############################################################################################
###############################################################################################
##########                                  Modeling                                 ##########
#
# Entrainement / evaluation de modeles sur un dataset (meme vue et memes formules que l'onglet
# Explore) :
#   - cible  : formule libre, peut regarder le futur (lead) -> c'est ce qu'on cherche a predire
#   - entrees: formules, INTERDITES de regarder le futur (fuite d'information)
#   - decoupage train / test : hold-out chronologique ou aleatoire, k-fold, walk-forward,
#     k-fold par blocs purges ; un "gap" retire des lignes entre train et test
#   - plusieurs modeles compares en un lancement, toujours face a une baseline naive
#   - metriques train ET test (detection du sur-apprentissage), courbes, importances


###############################################################################################
#####                                     Catalog                                        #####

def _p(kind, default, help_text='', **extra):
    return {'type': kind, 'default': default, 'help': help_text, **extra}


DEPTH_HELP = '0 = no limit'

MODELS = {
    'regression': {
        'baseline': {
            'label': 'Baseline (mean)', 'family': 'baseline', 'always': True,
            'help': 'Always predicts the training mean (or median). Any useful model must beat it.',
            'params': {'strategy': _p('select', 'mean', 'constant prediction', options=['mean', 'median'])},
        },
        'linear': {'label': 'Linear regression', 'family': 'linear', 'help': 'Ordinary least squares.', 'params': {}},
        'ridge': {'label': 'Ridge', 'family': 'linear', 'help': 'Linear + L2 penalty (shrinks coefficients).',
                  'params': {'alpha': _p('float', 1.0, 'penalty strength', min=0)}},
        'lasso': {'label': 'Lasso', 'family': 'linear', 'help': 'Linear + L1 penalty (sets useless coefficients to 0).',
                  'params': {'alpha': _p('float', 0.001, 'penalty strength', min=0)}},
        'elasticnet': {'label': 'Elastic Net', 'family': 'linear', 'help': 'Mix of L1 and L2 penalties.',
                       'params': {'alpha': _p('float', 0.001, 'penalty strength', min=0), 'l1_ratio': _p('float', 0.5, '0 = ridge, 1 = lasso', min=0, max=1)}},
        'knn': {'label': 'K nearest neighbors', 'family': 'neighbors', 'help': 'Average of the K most similar training rows (needs scaling).',
                'params': {'n_neighbors': _p('int', 25, 'K', min=1), 'weights': _p('select', 'distance', '', options=['uniform', 'distance'])}},
        'decision_tree': {'label': 'Decision tree', 'family': 'tree', 'help': 'A single tree of if/else rules — readable, overfits easily.',
                          'params': {'max_depth': _p('int', 6, DEPTH_HELP, min=0), 'min_samples_leaf': _p('int', 20, 'min rows per leaf', min=1)}},
        'random_forest': {'label': 'Random forest', 'family': 'tree', 'help': 'Average of many decorrelated trees.',
                          'params': {'n_estimators': _p('int', 200, 'trees', min=1), 'max_depth': _p('int', 8, DEPTH_HELP, min=0),
                                     'min_samples_leaf': _p('int', 20, 'min rows per leaf', min=1), 'max_features': _p('float', 0.5, 'share of features per split', min=0.05, max=1)}},
        'extra_trees': {'label': 'Extra trees', 'family': 'tree', 'help': 'Like random forest with random split points — less variance.',
                        'params': {'n_estimators': _p('int', 200, 'trees', min=1), 'max_depth': _p('int', 8, DEPTH_HELP, min=0),
                                   'min_samples_leaf': _p('int', 20, 'min rows per leaf', min=1), 'max_features': _p('float', 0.5, 'share of features per split', min=0.05, max=1)}},
        'gradient_boosting': {'label': 'Gradient boosting', 'family': 'boosting', 'help': 'Trees added one after another to fix the previous errors (histogram-based, fast).',
                              'params': {'learning_rate': _p('float', 0.05, '', min=0.001, max=1), 'max_iter': _p('int', 300, 'trees', min=1),
                                         'max_depth': _p('int', 0, DEPTH_HELP, min=0), 'min_samples_leaf': _p('int', 50, 'min rows per leaf', min=1),
                                         'l2_regularization': _p('float', 0.0, '', min=0)}},
        'svr': {'label': 'Support vector (SVR)', 'family': 'kernel', 'help': 'Kernel method — slow on large data (training capped to 8,000 rows).',
                'params': {'C': _p('float', 1.0, 'inverse regularization', min=0.0001), 'epsilon': _p('float', 0.1, 'tolerance tube', min=0),
                           'kernel': _p('select', 'rbf', '', options=['rbf', 'linear', 'poly'])}},
        'mlp': {'label': 'Neural network (MLP)', 'family': 'neural', 'help': 'Fully connected network (needs scaling).',
                'params': {'hidden_layers': _p('text', '64,32', 'neurons per layer, comma separated'), 'alpha': _p('float', 0.0001, 'L2 penalty', min=0),
                           'max_iter': _p('int', 300, 'epochs', min=10), 'early_stopping': _p('bool', True, 'stop when validation stops improving')}},
    },
    'classification': {
        'baseline': {
            'label': 'Baseline (majority)', 'family': 'baseline', 'always': True,
            'help': 'Always predicts the most frequent class (or random draws with the class frequencies). Any useful model must beat it.',
            'params': {'strategy': _p('select', 'prior', '', options=['prior', 'most_frequent', 'stratified'])},
        },
        'logistic': {'label': 'Logistic regression', 'family': 'linear', 'help': 'Linear model of the log-odds.',
                     'params': {'C': _p('float', 1.0, 'inverse regularization', min=0.0001), 'class_weight': _p('select', 'none', 'rebalance rare classes', options=['none', 'balanced'])}},
        'knn': {'label': 'K nearest neighbors', 'family': 'neighbors', 'help': 'Vote of the K most similar training rows (needs scaling).',
                'params': {'n_neighbors': _p('int', 25, 'K', min=1), 'weights': _p('select', 'distance', '', options=['uniform', 'distance'])}},
        'decision_tree': {'label': 'Decision tree', 'family': 'tree', 'help': 'A single tree of if/else rules.',
                          'params': {'max_depth': _p('int', 6, DEPTH_HELP, min=0), 'min_samples_leaf': _p('int', 20, 'min rows per leaf', min=1),
                                     'class_weight': _p('select', 'none', '', options=['none', 'balanced'])}},
        'random_forest': {'label': 'Random forest', 'family': 'tree', 'help': 'Vote of many decorrelated trees.',
                          'params': {'n_estimators': _p('int', 200, 'trees', min=1), 'max_depth': _p('int', 8, DEPTH_HELP, min=0),
                                     'min_samples_leaf': _p('int', 20, 'min rows per leaf', min=1), 'max_features': _p('float', 0.5, 'share of features per split', min=0.05, max=1),
                                     'class_weight': _p('select', 'none', '', options=['none', 'balanced'])}},
        'extra_trees': {'label': 'Extra trees', 'family': 'tree', 'help': 'Random forest with random split points.',
                        'params': {'n_estimators': _p('int', 200, 'trees', min=1), 'max_depth': _p('int', 8, DEPTH_HELP, min=0),
                                   'min_samples_leaf': _p('int', 20, 'min rows per leaf', min=1), 'max_features': _p('float', 0.5, 'share of features per split', min=0.05, max=1),
                                   'class_weight': _p('select', 'none', '', options=['none', 'balanced'])}},
        'gradient_boosting': {'label': 'Gradient boosting', 'family': 'boosting', 'help': 'Sequential trees (histogram-based, fast).',
                              'params': {'learning_rate': _p('float', 0.05, '', min=0.001, max=1), 'max_iter': _p('int', 300, 'trees', min=1),
                                         'max_depth': _p('int', 0, DEPTH_HELP, min=0), 'min_samples_leaf': _p('int', 50, 'min rows per leaf', min=1),
                                         'l2_regularization': _p('float', 0.0, '', min=0), 'class_weight': _p('select', 'none', '', options=['none', 'balanced'])}},
        'svc': {'label': 'Support vector (SVC)', 'family': 'kernel', 'help': 'Kernel method — slow on large data (training capped to 8,000 rows).',
                'params': {'C': _p('float', 1.0, 'inverse regularization', min=0.0001), 'kernel': _p('select', 'rbf', '', options=['rbf', 'linear', 'poly']),
                           'class_weight': _p('select', 'none', '', options=['none', 'balanced'])}},
        'naive_bayes': {'label': 'Naive Bayes (Gaussian)', 'family': 'probabilistic', 'help': 'Assumes independent, normally distributed features — fast baseline.', 'params': {}},
        'mlp': {'label': 'Neural network (MLP)', 'family': 'neural', 'help': 'Fully connected network (needs scaling).',
                'params': {'hidden_layers': _p('text', '64,32', 'neurons per layer, comma separated'), 'alpha': _p('float', 0.0001, 'L2 penalty', min=0),
                           'max_iter': _p('int', 300, 'epochs', min=10), 'early_stopping': _p('bool', True, 'stop when validation stops improving')}},
    },
}

SPLITS = {
    'chrono_holdout': {'label': 'Chronological hold-out', 'help': 'Train on the first part, test on the last part. The honest default for time-ordered data.', 'time_safe': True},
    'random_holdout': {'label': 'Random hold-out', 'help': 'Random rows in test. Fine for independent rows, optimistic on time series (neighbouring rows leak).', 'time_safe': False},
    'walk_forward': {'label': 'Walk-forward', 'help': 'Several successive tests, each trained only on the past (expanding or sliding window). Closest to live use.', 'time_safe': True},
    'blocked_kfold': {'label': 'Blocked k-fold (purged)', 'help': 'Contiguous folds, rows within `gap` of the test block removed from training. Uses all data, limits leakage.', 'time_safe': True},
    'kfold': {'label': 'K-fold (shuffled)', 'help': 'Classic cross-validation on shuffled rows. Only for rows without time dependence.', 'time_safe': False},
}

SCALERS = {'none': None, 'standard': StandardScaler, 'minmax': MinMaxScaler, 'robust': RobustScaler}

METRICS = {
    'regression': [
        {'key': 'r2', 'label': 'R²', 'better': 'high', 'help': 'Share of the target variance explained (0 = as good as the mean, < 0 = worse).'},
        {'key': 'mae', 'label': 'MAE', 'better': 'low', 'help': 'Mean absolute error, in target units.'},
        {'key': 'rmse', 'label': 'RMSE', 'better': 'low', 'help': 'Root mean squared error — penalizes large errors.'},
        {'key': 'nrmse', 'label': 'NRMSE', 'better': 'low', 'help': 'RMSE divided by the range (max − min) of the real values. Unitless ratio, comparable across targets and datasets: 0 = perfect, 0.1 = the typical error is a tenth of the whole span.'},
        {'key': 'medae', 'label': 'Median AE', 'better': 'low', 'help': 'Median absolute error (robust to outliers).'},
        {'key': 'mape', 'label': 'MAPE', 'better': 'low', 'help': 'Mean absolute % error (undefined when the target is near 0).'},
        {'key': 'pearson', 'label': 'Corr (pred, real)', 'better': 'high', 'help': 'Linear correlation between predictions and real values.'},
        {'key': 'spearman', 'label': 'Rank corr (IC)', 'better': 'high', 'help': 'Rank correlation — does the model order the rows correctly?'},
        {'key': 'sign_accuracy', 'label': 'Sign accuracy', 'better': 'high', 'help': 'Share of rows where prediction and reality have the same sign (useful for returns, changes).'},
    ],
    'classification': [
        {'key': 'accuracy', 'label': 'Accuracy', 'better': 'high', 'help': 'Share of correct predictions (misleading when classes are imbalanced).'},
        {'key': 'balanced_accuracy', 'label': 'Balanced accuracy', 'better': 'high', 'help': 'Average recall over classes — 0.5 = random for 2 balanced classes.'},
        {'key': 'precision', 'label': 'Precision', 'better': 'high', 'help': 'When the model says positive, how often is it right? (1 − false-positive share)'},
        {'key': 'recall', 'label': 'Recall', 'better': 'high', 'help': 'Share of real positives the model catches (1 − false-negative share).'},
        {'key': 'f1', 'label': 'F1', 'better': 'high', 'help': 'Harmonic mean of precision and recall.'},
        {'key': 'roc_auc', 'label': 'ROC AUC', 'better': 'high', 'help': 'Probability that a random positive is scored above a random negative — 0.5 = random, 1 = perfect.'},
        {'key': 'pr_auc', 'label': 'PR AUC', 'better': 'high', 'help': 'Area under precision-recall — compare to the positive rate (its random level).'},
        {'key': 'log_loss', 'label': 'Log loss', 'better': 'low', 'help': 'Quality of the predicted probabilities (lower is better).'},
    ],
}

MAX_PLOT_POINTS = 6000
MAX_KERNEL_ROWS = 8000


class ModelingError(Exception):
    pass


def catalog():
    return {'models': MODELS, 'splits': SPLITS, 'scalers': list(SCALERS), 'metrics': METRICS}



###############################################################################################
#####                                   Data prep                                        #####

def _lead_calls(formula):
    """Arguments de chaque appel lead(...) de la formule, en respectant les parentheses imbriquees."""
    calls = []
    for match in re.finditer(r'\blead\s*\(', formula):
        depth, args, current = 1, [], ''
        for ch in formula[match.end():]:
            if ch == '(':
                depth += 1
            elif ch == ')':
                depth -= 1
                if depth == 0:
                    args.append(current.strip())
                    break
            elif ch == ',' and depth == 1:
                args.append(current.strip())
                current = ''
                continue
            current += ch
        calls.append(args)
    return calls


def _lead_horizon(formula, custom, depth=0):
    """Plus grand n de lead(x, n) dans la formule (y compris via colonnes derivees) — sert a suggerer le gap."""
    horizons = []
    for args in _lead_calls(formula):
        try:
            horizons.append(int(float(args[1])) if len(args) > 1 else 1)
        except ValueError:
            horizons.append(1)
    if depth < 10:
        for name, sub in custom.items():
            if re.search(rf'\b{re.escape(name)}\b', formula):
                horizons.append(_lead_horizon(sub, custom, depth + 1))
    return max(horizons or [0])


def detect_task(y):
    if not pd.api.types.is_numeric_dtype(y):
        return 'classification'
    values = y.dropna()
    if values.empty:
        return 'regression'
    if values.nunique() <= 10 and (values % 1 == 0).all():
        return 'classification'
    return 'regression'


def _labels(y):
    """Etiquettes de classes lisibles et stables (1.0 -> '1', True -> 'True')."""
    def fmt(v):
        if v is None or (isinstance(v, float) and np.isnan(v)):
            return None
        if isinstance(v, (float, np.floating)) and float(v).is_integer():
            return str(int(v))
        return str(v)
    return y.map(fmt)


def prepare(view, config):
    """
    Construit (X, y, index, infos) a partir de la configuration.
    Refuse les entrees qui regardent le futur ; la cible, elle, peut le faire.
    """
    target = (config.get('target') or '').strip()
    features = [f for f in (config.get('features') or []) if f.strip()]
    if not target:
        raise ModelingError('Choose a target to predict')
    if not features:
        raise ModelingError('Choose at least one explanatory column')
    if target in features:
        raise ModelingError('The target cannot also be an input')

    y, target_lookahead = view.column(target, numeric=False)

    columns, encoded, levels = {}, [], {}
    for f in features:
        values, lookahead = view.column(f, numeric=False)
        if lookahead:
            raise ModelingError(f'"{f}" uses following rows (lead): it would leak the future into the model. Inputs must only use the past.')
        if pd.api.types.is_numeric_dtype(values):
            columns[f] = values.astype(float)
        else:
            if not config.get('one_hot', True):
                raise ModelingError(f'"{f}" is categorical — enable one-hot encoding or use code({f})')
            top = values.value_counts().head(30).index
            levels[f] = [c.item() if hasattr(c, 'item') else c for c in top]
            for category in top:
                columns[f'{f}={category}'] = (values == category).astype(float).where(values.notna())
            encoded.append(f)
    X = pd.DataFrame(columns, index=y.index)

    task = config.get('task', 'auto')
    if task == 'auto':
        task = detect_task(y)

    data = X.assign(__y__=y).dropna(subset=['__y__'])
    if config.get('missing', 'drop') == 'drop':
        data = data.dropna()
    if data.empty:
        raise ModelingError('No complete row left (check missing values or the view filter)')

    max_rows = int(config.get('max_rows') or 0)
    if max_rows and len(data) > max_rows:
        data = data.iloc[-max_rows:]

    y = data.pop('__y__')
    if task == 'regression':
        y = pd.to_numeric(y, errors='coerce')
        if y.isna().any():
            raise ModelingError('Regression needs a numeric target')
        y = y.astype(float)
    else:
        y = _labels(y)
        if y.nunique() < 2:
            raise ModelingError('Classification needs at least 2 classes in the target')
        if y.nunique() > 30:
            raise ModelingError(f'The target has {y.nunique()} classes — switch the task to regression, or bin the target')

    # colonnes heritees figees : leur horizon lead() vient du parent
    inherited = {n: f'lead(x, {i.get("horizon") or 1})' for n, i in (getattr(view, 'inherited', None) or {}).items() if i.get('lookahead')}
    custom = {**inherited, **(view.custom or {})}
    info = {
        'task': task, 'rows': int(len(data)), 'features': list(data.columns), 'encoded': encoded, 'encoded_levels': levels,
        'target_lookahead': bool(target_lookahead), 'lead_horizon': _lead_horizon(target, custom),
        'time_index': bool(view.time_index),
    }
    if task == 'classification':
        counts = y.value_counts()
        info['classes'] = sorted(counts.index.tolist(), key=lambda c: (len(c), c))
        info['class_counts'] = {k: int(v) for k, v in counts.items()}
    else:
        info['target_stats'] = {'mean': float(y.mean()), 'std': float(y.std()), 'min': float(y.min()), 'max': float(y.max())}
    return data, y, info



###############################################################################################
#####                                     Splits                                         #####

def make_splits(n, y, task, config, time_index):
    """Renvoie une liste de (indices_train, indices_test) en positions."""
    method = config.get('split', 'chrono_holdout')
    test_size = float(config.get('test_size', 0.2))
    n_splits = int(config.get('n_splits', 5))
    gap = int(config.get('gap', 0))
    seed = int(config.get('seed', 42))
    positions = np.arange(n)

    if method == 'chrono_holdout':
        n_test = max(1, int(round(n * test_size)))
        train_end = n - n_test - gap
        if train_end < 10:
            raise ModelingError('Not enough rows left for training after the test part and the gap')
        return [(positions[:train_end], positions[n - n_test:])]

    if method == 'random_holdout':
        stratify = y if task == 'classification' and config.get('stratify', True) else None
        try:
            tr, te = train_test_split(positions, test_size=test_size, random_state=seed, shuffle=True, stratify=stratify)
        except ValueError:
            tr, te = train_test_split(positions, test_size=test_size, random_state=seed, shuffle=True)
        return [(np.sort(tr), np.sort(te))]

    if method == 'walk_forward':
        window = config.get('window', 'expanding')
        max_train = int(config.get('max_train_size') or 0) if window == 'sliding' else None
        splitter = TimeSeriesSplit(n_splits=n_splits, gap=gap, max_train_size=max_train or None)
        return [(tr, te) for tr, te in splitter.split(positions)]

    if method == 'blocked_kfold':
        folds = []
        for tr, te in KFold(n_splits=n_splits, shuffle=False).split(positions):
            lo, hi = te.min() - gap, te.max() + gap
            tr = tr[(tr < lo) | (tr > hi)]
            folds.append((tr, te))
        return folds

    if method == 'kfold':
        if task == 'classification' and config.get('stratify', True):
            splitter = StratifiedKFold(n_splits=n_splits, shuffle=True, random_state=seed)
            return [(tr, te) for tr, te in splitter.split(positions, y)]
        splitter = KFold(n_splits=n_splits, shuffle=True, random_state=seed)
        return [(tr, te) for tr, te in splitter.split(positions)]

    raise ModelingError(f'Unknown split method {method}')


def split_warnings(config, info):
    warns = []
    method = config.get('split', 'chrono_holdout')
    if info['time_index'] and not SPLITS[method]['time_safe']:
        warns.append('Shuffled split on time-ordered rows: neighbouring rows are nearly identical, so the test set leaks into training and scores are optimistic. Prefer chronological, walk-forward or blocked k-fold.')
    horizon = info.get('lead_horizon', 0)
    if horizon and SPLITS[method]['time_safe'] and int(config.get('gap', 0)) < horizon:
        warns.append(f'The target looks {horizon} rows ahead but the gap is {config.get("gap", 0)}: the last training targets overlap the test period. Set gap ≥ {horizon}.')
    if info['task'] == 'classification':
        counts = info['class_counts']
        minority = min(counts.values()) / sum(counts.values())
        if minority < 0.1:
            warns.append(f'Imbalanced classes (smallest = {minority:.1%}): accuracy is misleading — read balanced accuracy, precision / recall, PR AUC, or set class_weight = balanced.')
    if info['rows'] < 200:
        warns.append(f'Only {info["rows"]} rows: metrics will be very noisy.')
    return warns



###############################################################################################
#####                                     Models                                         #####

def _param(spec, value):
    if value is None or value == '':
        return spec['default']
    if spec['type'] == 'int':
        return int(value)
    if spec['type'] == 'float':
        return float(value)
    if spec['type'] == 'bool':
        return bool(value)
    return value


def build_estimator(task, key, params, config):
    entry = MODELS[task].get(key)
    if entry is None:
        raise ModelingError(f'Unknown model {key}')
    p = {name: _param(spec, (params or {}).get(name)) for name, spec in entry['params'].items()}
    depth = lambda v: None if not v else int(v)
    cw = lambda v: None if v in (None, 'none') else v
    seed = int(config.get('seed', 42))
    layers = lambda text: tuple(int(x) for x in str(text).replace(' ', '').split(',') if x) or (64,)
    reg = task == 'regression'

    if key == 'baseline':
        model = DummyRegressor(strategy=p['strategy']) if reg else DummyClassifier(strategy=p['strategy'], random_state=seed)
    elif key == 'linear':
        model = LinearRegression()
    elif key == 'ridge':
        model = Ridge(alpha=p['alpha'])
    elif key == 'lasso':
        model = Lasso(alpha=p['alpha'], max_iter=5000)
    elif key == 'elasticnet':
        model = ElasticNet(alpha=p['alpha'], l1_ratio=p['l1_ratio'], max_iter=5000)
    elif key == 'logistic':
        model = LogisticRegression(C=p['C'], class_weight=cw(p['class_weight']), max_iter=2000)
    elif key == 'knn':
        model = (KNeighborsRegressor if reg else KNeighborsClassifier)(n_neighbors=p['n_neighbors'], weights=p['weights'])
    elif key == 'decision_tree':
        extra = {} if reg else {'class_weight': cw(p['class_weight'])}
        model = (DecisionTreeRegressor if reg else DecisionTreeClassifier)(max_depth=depth(p['max_depth']), min_samples_leaf=p['min_samples_leaf'], random_state=seed, **extra)
    elif key in ('random_forest', 'extra_trees'):
        cls = {('random_forest', True): RandomForestRegressor, ('random_forest', False): RandomForestClassifier,
               ('extra_trees', True): ExtraTreesRegressor, ('extra_trees', False): ExtraTreesClassifier}[(key, reg)]
        extra = {} if reg else {'class_weight': cw(p['class_weight'])}
        model = cls(n_estimators=p['n_estimators'], max_depth=depth(p['max_depth']), min_samples_leaf=p['min_samples_leaf'],
                    max_features=p['max_features'], n_jobs=-1, random_state=seed, **extra)
    elif key == 'gradient_boosting':
        extra = {} if reg else {'class_weight': cw(p['class_weight'])}
        model = (HistGradientBoostingRegressor if reg else HistGradientBoostingClassifier)(
            learning_rate=p['learning_rate'], max_iter=p['max_iter'], max_depth=depth(p['max_depth']),
            min_samples_leaf=p['min_samples_leaf'], l2_regularization=p['l2_regularization'], random_state=seed, **extra)
    elif key == 'svr':
        model = SVR(C=p['C'], epsilon=p['epsilon'], kernel=p['kernel'])
    elif key == 'svc':
        model = SVC(C=p['C'], kernel=p['kernel'], class_weight=cw(p['class_weight']), probability=True, random_state=seed)
    elif key == 'naive_bayes':
        model = GaussianNB()
    elif key == 'mlp':
        model = (MLPRegressor if reg else MLPClassifier)(hidden_layer_sizes=layers(p['hidden_layers']), alpha=p['alpha'],
                                                         max_iter=p['max_iter'], early_stopping=p['early_stopping'], random_state=seed)
    else:
        raise ModelingError(f'Unknown model {key}')

    steps = []
    if config.get('missing', 'drop') in ('mean', 'median'):
        steps.append(('impute', SimpleImputer(strategy=config['missing'])))
    scaler = SCALERS.get(config.get('scaling', 'standard'))
    if scaler is not None:
        steps.append(('scale', scaler()))
    steps.append(('model', model))
    return Pipeline(steps), p



###############################################################################################
#####                                     Metrics                                        #####

def _clean(v):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    return None if np.isnan(v) or np.isinf(v) else v


def regression_metrics(y_true, y_pred):
    y_true, y_pred = np.asarray(y_true, float), np.asarray(y_pred, float)
    out = {
        'r2': skm.r2_score(y_true, y_pred) if len(y_true) > 1 else None,
        'mae': skm.mean_absolute_error(y_true, y_pred),
        'rmse': float(np.sqrt(skm.mean_squared_error(y_true, y_pred))),
        'medae': skm.median_absolute_error(y_true, y_pred),
        'nrmse': None,
        'mape': None,
        'pearson': None, 'spearman': None, 'sign_accuracy': None,
    }
    span = float(np.max(y_true) - np.min(y_true))
    if span > 0:
        out['nrmse'] = out['rmse'] / span
    abs_true = np.abs(y_true)
    # MAPE seulement si la cible ne s'approche jamais de 0 (sinon elle explose et ne veut rien dire)
    if abs_true.min() > 0 and abs_true.min() / abs_true.mean() > 1e-3:
        out['mape'] = float(np.mean(np.abs((y_true - y_pred) / y_true)))
    if np.std(y_pred) > 0 and np.std(y_true) > 0:
        out['pearson'] = float(np.corrcoef(y_true, y_pred)[0, 1])
        out['spearman'] = float(pd.Series(y_true).rank().corr(pd.Series(y_pred).rank()))
    nonzero = (y_true != 0) & (y_pred != 0)
    if nonzero.any():
        out['sign_accuracy'] = float((np.sign(y_true[nonzero]) == np.sign(y_pred[nonzero])).mean())
    return {k: _clean(v) for k, v in out.items()}


def classification_metrics(y_true, y_pred, proba, classes, positive):
    y_true, y_pred = np.asarray(y_true), np.asarray(y_pred)
    binary = len(classes) == 2
    out = {
        'accuracy': skm.accuracy_score(y_true, y_pred),
        'balanced_accuracy': skm.balanced_accuracy_score(y_true, y_pred),
    }
    if binary:
        out['precision'] = skm.precision_score(y_true, y_pred, pos_label=positive, zero_division=0)
        out['recall'] = skm.recall_score(y_true, y_pred, pos_label=positive, zero_division=0)
        out['f1'] = skm.f1_score(y_true, y_pred, pos_label=positive, zero_division=0)
    else:
        out['precision'] = skm.precision_score(y_true, y_pred, average='macro', zero_division=0)
        out['recall'] = skm.recall_score(y_true, y_pred, average='macro', zero_division=0)
        out['f1'] = skm.f1_score(y_true, y_pred, average='macro', zero_division=0)
    out['roc_auc'] = out['pr_auc'] = out['log_loss'] = None
    present = set(np.unique(y_true))
    if proba is not None and len(present) > 1:
        try:
            if binary:
                p_pos = proba[:, classes.index(positive)]
                truth = (y_true == positive).astype(int)
                out['roc_auc'] = skm.roc_auc_score(truth, p_pos)
                out['pr_auc'] = skm.average_precision_score(truth, p_pos)
            elif present == set(classes):
                out['roc_auc'] = skm.roc_auc_score(y_true, proba, multi_class='ovr', average='weighted', labels=classes)
            out['log_loss'] = skm.log_loss(y_true, np.clip(proba, 1e-15, 1 - 1e-15), labels=classes)
        except ValueError:
            pass
    return {k: _clean(v) for k, v in out.items()}


def _downsample_idx(n, max_points):
    if n <= max_points:
        return np.arange(n)
    return np.unique(np.linspace(0, n - 1, max_points).astype(int))


def _curve(x, y, max_points=200):
    idx = _downsample_idx(len(x), max_points)
    return [float(v) for v in np.asarray(x)[idx]], [float(v) for v in np.asarray(y)[idx]]


def classification_details(y_true, y_pred, proba, classes, positive):
    y_true, y_pred = np.asarray(y_true), np.asarray(y_pred)
    cm = skm.confusion_matrix(y_true, y_pred, labels=classes)
    per_class = []
    p, r, f, s = skm.precision_recall_fscore_support(y_true, y_pred, labels=classes, zero_division=0)
    for i, c in enumerate(classes):
        per_class.append({'class': c, 'precision': float(p[i]), 'recall': float(r[i]), 'f1': float(f[i]), 'support': int(s[i])})
    details = {'confusion': cm.tolist(), 'per_class': per_class}

    if proba is not None and len(classes) == 2 and len(set(y_true)) == 2:
        p_pos = proba[:, classes.index(positive)]
        truth = (y_true == positive).astype(int)
        fpr, tpr, _ = skm.roc_curve(truth, p_pos)
        precision, recall, _ = skm.precision_recall_curve(truth, p_pos)
        details['roc'] = dict(zip(('fpr', 'tpr'), _curve(fpr, tpr)))
        details['pr'] = dict(zip(('recall', 'precision'), _curve(recall, precision)))
        details['positive_rate'] = float(truth.mean())

        # calibration : probabilite predite vs frequence observee, par tranches de proba
        bins = np.linspace(0, 1, 11)
        which = np.clip(np.digitize(p_pos, bins) - 1, 0, 9)
        calib = [{'predicted': float(p_pos[which == b].mean()), 'observed': float(truth[which == b].mean()), 'count': int((which == b).sum())}
                 for b in range(10) if (which == b).sum() > 0]
        details['calibration'] = calib

        # seuil de decision : ce que coute / rapporte chaque seuil (faux positifs, faux negatifs...)
        thresholds = []
        for t in np.round(np.arange(0.05, 0.96, 0.05), 2):
            pred = p_pos >= t
            tp = int((pred & (truth == 1)).sum()); fp = int((pred & (truth == 0)).sum())
            fn = int((~pred & (truth == 1)).sum()); tn = int((~pred & (truth == 0)).sum())
            thresholds.append({
                'threshold': float(t), 'tp': tp, 'fp': fp, 'fn': fn, 'tn': tn,
                'precision': tp / (tp + fp) if tp + fp else None, 'recall': tp / (tp + fn) if tp + fn else None,
                'fpr': fp / (fp + tn) if fp + tn else None, 'predicted_positive': float(pred.mean()),
            })
        details['thresholds'] = thresholds

        hist_bins = np.linspace(0, 1, 26)
        details['proba_hist'] = {
            'edges': hist_bins.tolist(),
            'positive': np.histogram(p_pos[truth == 1], bins=hist_bins)[0].tolist(),
            'negative': np.histogram(p_pos[truth == 0], bins=hist_bins)[0].tolist(),
        }
    return details


def _native_importance(pipeline, feature_names):
    model = pipeline.named_steps['model']
    if hasattr(model, 'feature_importances_'):
        values = np.asarray(model.feature_importances_, float)
        kind = 'tree importance'
    elif hasattr(model, 'coef_'):
        coef = np.asarray(model.coef_, float)
        values = np.abs(coef).mean(axis=0) if coef.ndim > 1 else coef
        kind = 'coefficient (on scaled inputs)' if 'scale' in pipeline.named_steps else 'coefficient'
    else:
        return None
    return {'kind': kind, 'values': {name: float(v) for name, v in zip(feature_names, values)}}



###############################################################################################
#####                                       Run                                          #####

def run(view, config, progress=None, cancelled=lambda: False):
    """
    Entraine et evalue tous les modeles demandes. `progress(done, total, label)` est appele
    entre deux etapes ; `cancelled()` permet d'interrompre proprement.
    """
    started = time.time()
    X, y, info = prepare(view, config)
    task = info['task']
    classes = info.get('classes')
    positive = None
    if task == 'classification' and len(classes) == 2:
        positive = config.get('positive_class') if config.get('positive_class') in classes else classes[-1]

    splits = make_splits(len(X), y, task, config, info['time_index'])
    if not splits or any(len(te) == 0 or len(tr) < 5 for tr, te in splits):
        raise ModelingError('The split leaves an empty train or test set — reduce the gap / test size / number of folds')

    requested = [m for m in (config.get('models') or []) if m in MODELS[task]]
    keys = ['baseline'] + [m for m in requested if m != 'baseline']
    model_params = config.get('model_params') or {}
    feature_names = list(X.columns)
    X_values, y_values = X.to_numpy(float), y.to_numpy()
    index = X.index

    total = len(keys) * len(splits)
    done = 0
    summary, details, fitted = [], {}, {}

    for key in keys:
        if cancelled():
            raise ModelingError('Cancelled')
        entry = MODELS[task][key]
        model_started = time.time()
        oof_pred = np.empty(len(X), dtype=object if task == 'classification' else float)
        oof_proba = np.full((len(X), len(classes)), np.nan) if task == 'classification' else None
        oof_fold = np.full(len(X), -1)
        fold_metrics, train_metrics = [], []
        last_pipeline, notes = None, []
        done_before = done

        try:
            for fold, (tr, te) in enumerate(splits):
                if cancelled():
                    raise ModelingError('Cancelled')
                if progress:
                    progress(done, total, f'{entry["label"]}' + (f' · fold {fold + 1}/{len(splits)}' if len(splits) > 1 else ''))
                pipeline, used_params = build_estimator(task, key, model_params.get(key), config)
                tr_fit = tr
                if key in ('svr', 'svc') and len(tr) > MAX_KERNEL_ROWS:
                    tr_fit = tr[-MAX_KERNEL_ROWS:]
                    if fold == 0:
                        notes.append(f'trained on the last {MAX_KERNEL_ROWS:,} rows of each training set (kernel methods scale badly)')
                with warnings.catch_warnings():
                    warnings.simplefilter('ignore')
                    pipeline.fit(X_values[tr_fit], y_values[tr_fit])
                    pred_te = pipeline.predict(X_values[te])
                    pred_tr = pipeline.predict(X_values[tr])
                    proba_te = proba_tr = None
                    if task == 'classification' and hasattr(pipeline, 'predict_proba'):
                        model_classes = [str(c) for c in pipeline.classes_]
                        raw_te, raw_tr = pipeline.predict_proba(X_values[te]), pipeline.predict_proba(X_values[tr])
                        proba_te = np.zeros((len(te), len(classes)))
                        proba_tr = np.zeros((len(tr), len(classes)))
                        for j, c in enumerate(model_classes):
                            proba_te[:, classes.index(c)] = raw_te[:, j]
                            proba_tr[:, classes.index(c)] = raw_tr[:, j]

                oof_pred[te] = pred_te
                oof_fold[te] = fold
                if proba_te is not None:
                    oof_proba[te] = proba_te
                if task == 'regression':
                    fold_metrics.append(regression_metrics(y_values[te], pred_te))
                    train_metrics.append(regression_metrics(y_values[tr], pred_tr))
                else:
                    fold_metrics.append(classification_metrics(y_values[te], pred_te, proba_te, classes, positive))
                    train_metrics.append(classification_metrics(y_values[tr], pred_tr, proba_tr, classes, positive))
                last_pipeline = pipeline
                done += 1
        except ModelingError:
            raise
        except Exception as error:
            summary.append({'key': key, 'label': entry['label'], 'family': entry['family'], 'error': f'{type(error).__name__}: {error}'})
            done = done_before + len(splits)
            continue

        # modele reutilisable sur un autre dataset : pipeline du dernier decoupage + lignes qu'il a vues
        if key != 'baseline' and last_pipeline is not None:
            tr_last = splits[-1][0]
            if key in ('svr', 'svc') and len(tr_last) > MAX_KERNEL_ROWS:
                tr_last = tr_last[-MAX_KERNEL_ROWS:]
            fitted[key] = {
                'estimator': last_pipeline, 'key': key, 'label': entry['label'], 'task': task, 'classes': classes, 'positive': positive,
                'features': list(config.get('features') or []), 'columns': feature_names, 'encoded_levels': info.get('encoded_levels') or {},
                'missing': config.get('missing', 'drop'), 'target': config.get('target'),
                'fit_index': _index_keys(index[tr_last]), 'fit_rows': int(len(tr_last)), 'index_kind': 'time' if info['time_index'] else 'row',
            }

        tested = oof_fold >= 0
        y_test = y_values[tested]
        pred_test = oof_pred[tested]
        proba_test = oof_proba[tested] if oof_proba is not None else None
        if proba_test is not None and np.isnan(proba_test).any():
            proba_test = None

        if task == 'regression':
            test_metrics = regression_metrics(y_test, pred_test.astype(float))
        else:
            test_metrics = classification_metrics(y_test, pred_test, proba_test, classes, positive)

        mean_train = {k: _mean([m.get(k) for m in train_metrics]) for k in train_metrics[0]}
        fold_std = {k: _std([m.get(k) for m in fold_metrics]) for k in fold_metrics[0]} if len(fold_metrics) > 1 else None

        # importance par permutation sur le test : chute du score quand on melange une colonne
        permutation = None
        if config.get('permutation', True) and last_pipeline is not None and key != 'baseline':
            tr, te = splits[-1]
            sample = te if len(te) <= 3000 else np.random.default_rng(0).choice(te, 3000, replace=False)
            scoring = 'r2' if task == 'regression' else 'balanced_accuracy'
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter('ignore')
                    imp = permutation_importance(last_pipeline, X_values[sample], y_values[sample], n_repeats=5,
                                                 random_state=0, scoring=scoring, n_jobs=1)
                permutation = {'scoring': scoring, 'mean': {n: float(v) for n, v in zip(feature_names, imp.importances_mean)},
                               'std': {n: float(v) for n, v in zip(feature_names, imp.importances_std)}}
            except Exception:
                permutation = None

        test_positions = np.flatnonzero(tested)
        keep = _downsample_idx(len(test_positions), MAX_PLOT_POINTS)
        pos = test_positions[keep]
        x_axis = [t.isoformat() if isinstance(t, pd.Timestamp) else int(t) for t in index[pos]]
        detail = {
            'key': key, 'label': entry['label'], 'family': entry['family'], 'params': used_params, 'notes': notes,
            'test': test_metrics, 'train': mean_train, 'fold_std': fold_std, 'folds': fold_metrics,
            'native_importance': _native_importance(last_pipeline, feature_names) if last_pipeline is not None else None,
            'permutation_importance': permutation,
            'predictions': {
                'x': x_axis, 'x_kind': 'time' if info['time_index'] else 'row', 'fold': oof_fold[pos].tolist(),
                'actual': [v if task == 'classification' else _clean(v) for v in y_values[pos]],
                'predicted': [v if task == 'classification' else _clean(v) for v in oof_pred[pos]],
            },
            'duration': time.time() - model_started,
        }
        if task == 'regression':
            residuals = y_test.astype(float) - pred_test.astype(float)
            counts, edges = np.histogram(residuals, bins=40)
            detail['residual_hist'] = {'counts': counts.tolist(), 'edges': edges.tolist()}
        else:
            if proba_test is not None:
                score = proba_test[:, classes.index(positive)] if positive else proba_test.max(axis=1)
                detail['predictions']['score'] = [_clean(v) for v in score[keep]]
            detail['classification'] = classification_details(y_test, pred_test, proba_test, classes, positive)
        details[key] = detail
        summary.append({'key': key, 'label': entry['label'], 'family': entry['family'], 'test': test_metrics,
                        'train': mean_train, 'fold_std': fold_std, 'duration': detail['duration'], 'notes': notes})

    if progress:
        progress(total, total, 'done')

    split_info = [{'fold': i, 'train': int(len(tr)), 'test': int(len(te)),
                   'train_start': _bound(index, tr, 0), 'train_end': _bound(index, tr, -1),
                   'test_start': _bound(index, te, 0), 'test_end': _bound(index, te, -1)} for i, (tr, te) in enumerate(splits)]
    return {
        'info': {**info, 'positive_class': positive, 'warnings': split_warnings(config, info), 'splits': split_info},
        'summary': summary, 'details': details, 'fitted': fitted, 'duration': time.time() - started,
    }


def _index_keys(index):
    """Cles comparables entre datasets : millisecondes UTC pour un axe temporel, numero de ligne sinon."""
    if isinstance(index, pd.DatetimeIndex):
        return index.as_unit('ms').asi8.astype(np.int64)
    return np.asarray(index, dtype=np.int64)


def build_inputs(view, bundle):
    """Entrees du modele recalculees sur un autre dataset (memes formules, memes colonnes encodees)."""
    columns = {}
    for f in bundle['features']:
        values, lookahead = view.column(f, numeric=False)
        if lookahead:
            raise ModelingError(f'"{f}" uses following rows (lead): it cannot be an input')
        levels = bundle['encoded_levels'].get(f)
        if levels is None:
            if not pd.api.types.is_numeric_dtype(values):
                raise ModelingError(f'"{f}" was numeric when the model was trained but is not numeric here')
            columns[f] = values.astype(float)
        else:
            for category in levels:
                columns[f'{f}={category}'] = (values == category).astype(float).where(values.notna())
    X = pd.DataFrame(columns, index=view.df.index)
    absent = [c for c in bundle['columns'] if c not in X.columns]
    if absent:
        raise ModelingError(f'This dataset lacks inputs the model was trained on: {", ".join(absent[:6])}')
    return X[bundle['columns']]


OUTPUTS = {'regression': ['value'], 'classification': ['proba', 'class']}


def predict_with(view, bundle, output=None, threshold=0.5):
    """
    Colonne de predictions du modele sur `view` (dataset complet, sans filtre) :
    renvoie (serie alignee sur view.df.index, stats). Les lignes que le modele a vues a l'entrainement
    restent VIDES (une prediction dessus serait trop belle), de meme que celles dont une entree manque.
    """
    task = bundle['task']
    output = output or OUTPUTS[task][0]
    if output not in OUTPUTS[task]:
        raise ModelingError(f'Output "{output}" does not exist for a {task} model')
    X = build_inputs(view, bundle)
    index = view.df.index
    keys = _index_keys(index)

    seen = np.zeros(len(X), dtype=bool)
    comparable = (bundle['index_kind'] == 'time') == isinstance(index, pd.DatetimeIndex)
    if comparable:
        seen = np.isin(keys, bundle['fit_index'])
    complete = X.notna().all(axis=1).to_numpy() if bundle['missing'] == 'drop' else np.ones(len(X), dtype=bool)
    usable = ~seen & complete

    out = np.full(len(X), np.nan)
    if usable.any():
        estimator = bundle['estimator']
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')
            values = X.to_numpy(float)[usable]
            if task == 'regression':
                out[usable] = estimator.predict(values)
            else:
                classes = bundle['classes']
                if output == 'proba':
                    if len(classes) != 2 or not hasattr(estimator, 'predict_proba'):
                        raise ModelingError('Probabilities need a binary model that can output them — use the predicted class instead')
                    model_classes = [str(c) for c in estimator.classes_]
                    out[usable] = estimator.predict_proba(values)[:, model_classes.index(bundle['positive'])]
                else:
                    if len(classes) == 2 and hasattr(estimator, 'predict_proba'):
                        model_classes = [str(c) for c in estimator.classes_]
                        proba = estimator.predict_proba(values)[:, model_classes.index(bundle['positive'])]
                        negative = [c for c in classes if c != bundle['positive']][0]
                        labels = np.where(proba >= float(threshold), bundle['positive'], negative)
                    else:
                        labels = estimator.predict(values)
                    try:
                        out[usable] = np.array([float(v) for v in labels])
                    except ValueError:
                        out[usable] = np.array([classes.index(str(v)) for v in labels], dtype=float)
    stats = {
        'rows': int(len(X)), 'predicted': int(usable.sum()), 'seen_in_training': int(seen.sum()),
        'missing_inputs': int((~complete & ~seen).sum()), 'overlap_checked': bool(comparable),
    }
    return pd.Series(out, index=index), stats


def _bound(index, positions, which):
    t = index[positions[which]]
    return t.isoformat() if isinstance(t, pd.Timestamp) else int(t)


def _mean(values):
    values = [v for v in values if v is not None]
    return float(np.mean(values)) if values else None


def _std(values):
    values = [v for v in values if v is not None]
    return float(np.std(values)) if len(values) > 1 else None


def preview(view, config):
    """Infos rapides avant lancement : tache detectee, classes / stats de la cible, gap suggere, avertissements."""
    X, y, info = prepare(view, config)
    info['warnings'] = split_warnings(config, info)
    info['suggested_gap'] = info['lead_horizon']
    return info
