import os
import re
import shutil
import hashlib
import secrets
import threading
from collections import OrderedDict

import numpy as np
import pandas as pd

from .DataLoader import read_any, build_dataset, profile_column, LoadError, SUPPORTED_EXTENSIONS
from .Engine import View, FormulaError
from .Modeling import _lead_horizon
from . import Resample
from . import FirstTouch



class DatasetStore:
    """
    Fichiers des datasets + cache memoire.

      <data>/datasets/<id>/original.<ext>   fichier charge, tel quel
      <data>/datasets/<id>/raw.pkl          DataFrame brut lu (avant typage) -> pas besoin de re-parser le CSV

    Un sous-dataset est un dataset a part entiere (ses colonnes, ses vues, ses modeles) : ses lignes sont
    copiees du parent a la creation (raw.pkl, pas de fichier original) et les colonnes derivees du parent
    y deviennent des colonnes figees, calculees sur tout l'historique du parent.

    Le DataFrame type (categorisation + overrides + axe temporel) est calcule depuis raw.pkl (long sur de gros
    fichiers : ~45 s pour 1 M de lignes), sauvegarde dans typed_<hash>.pkl pour ne pas le refaire a chaque
    demarrage, et garde en cache LRU. Il est invalide quand on change les types ou l'axe temporel.
    Un seul calcul a la fois par dataset : les requetes simultanees attendent le meme resultat.
    """

    def __init__(self, data_path, db_manager, cache_size=6):
        self.root = os.path.join(data_path, 'datasets')
        self.db_manager = db_manager
        self.cache = OrderedDict()
        self.cache_size = cache_size
        self._lock = threading.Lock()          # protege le cache LRU et le registre de verrous
        self._build_locks = {}                 # dataset_id -> verrou de construction
        os.makedirs(self.root, exist_ok=True)

    def _dir(self, dataset_id):
        return os.path.join(self.root, dataset_id)

    def _new_id(self, filename):
        stem = re.sub(r'[^a-zA-Z0-9]+', '-', os.path.splitext(filename)[0]).strip('-').lower()[:40] or 'dataset'
        return f'{stem}-{secrets.token_hex(3)}'


    # ── Import ───────────────────────────────────────────────────────────────

    def import_file(self, source_path, filename, name=None):
        extension = os.path.splitext(filename)[1].lower().lstrip('.')
        if extension not in SUPPORTED_EXTENSIONS:
            raise LoadError(f'Unsupported file type .{extension} — supported: {", ".join(sorted(SUPPORTED_EXTENSIONS))}')
        dataset_id = self._new_id(filename)
        folder = self._dir(dataset_id)
        os.makedirs(folder, exist_ok=True)
        try:
            original = os.path.join(folder, f'original.{extension}')
            shutil.copyfile(source_path, original)
            raw, report = read_any(original, extension)
            if raw.empty or raw.shape[1] == 0:
                raise LoadError('No rows or no columns could be read from this file')
            raw.to_pickle(os.path.join(folder, 'raw.pkl'))
            df, profile = build_dataset(raw)
            self.db_manager.new_dataset(dataset_id, name or os.path.splitext(filename)[0], filename,
                                        os.path.getsize(original), report, profile)
            key = self._key(dataset_id, 'auto', {})
            self._save_typed(dataset_id, key, df, profile)
            self._cache_put(key, (df, profile))
            return dataset_id
        except Exception:
            shutil.rmtree(folder, ignore_errors=True)
            raise

    def delete(self, dataset_id):
        shutil.rmtree(self._dir(dataset_id), ignore_errors=True)
        self._drop_cache(dataset_id)


    # ── Typage / acces ───────────────────────────────────────────────────────

    @staticmethod
    def _key(dataset_id, time_column, overrides):
        return (dataset_id, time_column, str(sorted((overrides or {}).items())))

    def _typed_path(self, dataset_id, key):
        digest = hashlib.md5(f'{key[1]}|{key[2]}'.encode()).hexdigest()[:10]
        return os.path.join(self._dir(dataset_id), f'typed_{digest}.pkl')

    def _save_typed(self, dataset_id, key, df, profile):
        path = self._typed_path(dataset_id, key)
        try:
            tmp = f'{path}.tmp'
            pd.to_pickle((df, profile), tmp)
            os.replace(tmp, path)
        except OSError:
            pass  # disque plein : tant pis, on recalculera au prochain demarrage

    def _cache_put(self, key, value):
        with self._lock:
            self.cache[key] = value
            self.cache.move_to_end(key)
            while len(self.cache) > self.cache_size:
                self.cache.popitem(last=False)

    def _cache_get(self, key):
        with self._lock:
            if key in self.cache:
                self.cache.move_to_end(key)
                return self.cache[key]
        return None

    def typed(self, dataset_id):
        record = self.db_manager.get_dataset(dataset_id)
        if record is None:
            raise LoadError(f'Unknown dataset {dataset_id}')
        overrides = record['type_overrides'] or {}
        time_column = record['time_column']
        key = self._key(dataset_id, time_column, overrides)
        hit = self._cache_get(key)
        if hit is not None:
            return hit
        with self._lock:
            build_lock = self._build_locks.setdefault(dataset_id, threading.Lock())
        with build_lock:
            hit = self._cache_get(key)   # un autre thread l'a peut-etre construit pendant qu'on attendait
            if hit is not None:
                return hit
            path = self._typed_path(dataset_id, key)
            loaded = None
            if os.path.exists(path):
                try:
                    loaded = pd.read_pickle(path)
                except Exception:
                    loaded = None  # fichier abime : on le reconstruit
            if loaded is None:
                raw = pd.read_pickle(os.path.join(self._dir(dataset_id), 'raw.pkl'))
                loaded = build_dataset(raw, overrides, None if time_column in (None, '', 'none') else time_column)
                self._save_typed(dataset_id, key, *loaded)
            df, profile = loaded
            self._attach_frozen(dataset_id, df, profile, record.get('frozen') or {})
            self._cache_put(key, (df, profile))
            return df, profile

    # ── Colonnes figees (predictions de modeles) ─────────────────────────────

    def _frozen_path(self, dataset_id):
        return os.path.join(self._dir(dataset_id), 'frozen.pkl')

    def _attach_frozen(self, dataset_id, df, profile, frozen_info):
        """Ajoute au df type les colonnes figees, par position (verifie que l'index est identique)."""
        path = self._frozen_path(dataset_id)
        if not frozen_info or not os.path.exists(path):
            return
        frozen = pd.read_pickle(path)
        if len(frozen) != len(df) or not frozen.index.equals(df.index):
            return  # types / axe temporel changes depuis : les lignes ne correspondent plus
        for column in frozen.columns:
            if column in df.columns or column not in frozen_info:
                continue
            df[column] = frozen[column].to_numpy()
            profile['columns'][column] = {'label': column, 'type': 'numeric', 'subtype': 'float', 'note': 'model prediction', 'failed': 0,
                                          **profile_column(df[column], 'numeric')}
            profile['order'].append(column)

    def _drop_cache(self, dataset_id, files=False):
        with self._lock:
            for key in [k for k in self.cache if k[0] == dataset_id]:
                self.cache.pop(key, None)
        if files:
            # types / axe temporel changes : les tableaux types enregistres ne valent plus rien
            folder = self._dir(dataset_id)
            for name in os.listdir(folder) if os.path.isdir(folder) else []:
                if name.startswith('typed_') and name.endswith('.pkl'):
                    try:
                        os.remove(os.path.join(folder, name))
                    except OSError:
                        pass

    def add_frozen(self, dataset_id, name, series, info):
        """Enregistre une colonne de valeurs (alignee sur le df type complet du dataset) + ses metadonnees."""
        self.add_frozen_many(dataset_id, {name: (series, info)})

    def add_frozen_many(self, dataset_id, columns):
        """columns : {nom: (serie alignee sur le df type complet, metadonnees)}."""
        record = self.db_manager.get_dataset(dataset_id)
        df, _ = self.typed(dataset_id)
        path = self._frozen_path(dataset_id)
        frozen = pd.read_pickle(path) if os.path.exists(path) else pd.DataFrame(index=df.index)
        if len(frozen) != len(df) or not frozen.index.equals(df.index):
            frozen = pd.DataFrame(index=df.index)
        for name, (series, _) in columns.items():
            frozen[name] = series.to_numpy(dtype=float)
        frozen.to_pickle(path)
        meta = {**(record.get('frozen') or {}), **{name: info for name, (_, info) in columns.items()}}
        self.db_manager.update_dataset(dataset_id, frozen=meta)
        self._drop_cache(dataset_id)
        _, profile = self.typed(dataset_id)
        self.db_manager.update_dataset(dataset_id, profile=profile)

    def delete_frozen(self, dataset_id, name):
        record = self.db_manager.get_dataset(dataset_id)
        meta = {k: v for k, v in (record.get('frozen') or {}).items() if k != name}
        path = self._frozen_path(dataset_id)
        if os.path.exists(path):
            frozen = pd.read_pickle(path)
            if name in frozen.columns:
                frozen = frozen.drop(columns=[name])
                frozen.to_pickle(path)
        self.db_manager.update_dataset(dataset_id, frozen=meta)
        self._drop_cache(dataset_id)
        _, profile = self.typed(dataset_id)
        self.db_manager.update_dataset(dataset_id, profile=profile)

    def retype(self, dataset_id, type_overrides=None, time_column=None):
        """Applique de nouveaux types / axe temporel, recalcule et enregistre le profil."""
        fields = {}
        if type_overrides is not None:
            fields['type_overrides'] = type_overrides
        if time_column is not None:
            fields['time_column'] = time_column
        self.db_manager.update_dataset(dataset_id, **fields)
        self._drop_cache(dataset_id, files=True)
        df, profile = self.typed(dataset_id)
        self.db_manager.update_dataset(dataset_id, profile=profile)
        return profile

    def view(self, dataset_id, view_settings=None):
        record = self.db_manager.get_dataset(dataset_id)
        if record is None:
            raise LoadError(f'Unknown dataset {dataset_id}')
        df, profile = self.typed(dataset_id)
        custom = {name: c['formula'] for name, c in self.db_manager.get_columns(dataset_id).items()}
        settings = view_settings if view_settings is not None else (record['view_settings'] or {})
        origin = record.get('origin') or {}
        # colonnes figees (predictions, agregations d'une granularite fine) qui regardent le futur : des cibles
        targets = {k: v for k, v in (record.get('frozen') or {}).items() if v.get('lookahead')}
        return View(df, profile, custom, settings, {**(origin.get('inherited') or {}), **targets}, (origin.get('segments') or {}).get('starts'))


    # ── Sous-datasets ────────────────────────────────────────────────────────

    @staticmethod
    def _bound(value, time_index):
        if value in (None, ''):
            return None
        if not time_index:
            return int(float(value))
        return pd.Timestamp(value, unit='ms', tz='UTC') if isinstance(value, (int, float)) else pd.Timestamp(value, tz='UTC')

    def _subset_selection(self, parent_id, spec):
        """
        spec : {ranges: [{start, end}], mode: 'include' | 'exclude', condition: formule}
        Renvoie (vue complete du parent, masque des lignes gardees).
        """
        view = self.view(parent_id, {})
        n = len(view.df)
        index = view.df.index
        ranges = [r for r in (spec.get('ranges') or []) if r.get('start') not in (None, '') or r.get('end') not in (None, '')]
        mask = np.ones(n, dtype=bool)
        if ranges:
            inside = np.zeros(n, dtype=bool)
            positions = np.arange(n)
            for r in ranges:
                start, end = self._bound(r.get('start'), view.time_index), self._bound(r.get('end'), view.time_index)
                keys = index if view.time_index else positions
                part = np.ones(n, dtype=bool)
                if start is not None:
                    part &= np.asarray(keys >= start)
                if end is not None:
                    part &= np.asarray(keys <= end)
                inside |= part
            mask = ~inside if spec.get('mode') == 'exclude' else inside
        condition = (spec.get('condition') or '').strip()
        if condition:
            values, lookahead = view.column(condition, numeric=False)
            if lookahead:
                raise FormulaError(f'"{condition}" uses following rows (lead): a subset chosen with the future would leak it into everything trained on it')
            mask &= values.fillna(0).astype(bool).to_numpy()
        return view, mask

    @staticmethod
    def _pieces(mask, view=None):
        """
        Debut (indice dans les lignes gardees) de chaque morceau continu. Un nouveau morceau commence quand des
        lignes ont ete sautees, mais aussi sur un raccord du PARENT (un parent a plusieurs morceaux transmet
        ses raccords : deux lignes voisines de part et d'autre ne sont pas consecutives dans la realite).
        """
        kept = np.flatnonzero(mask)
        if not len(kept):
            return kept, []
        broken = np.diff(kept) > 1
        parent_breaks = [a for a, _ in (getattr(view, 'slices', None) or [])[1:]]
        if parent_breaks:
            broken |= np.isin(kept[1:], parent_breaks)
        return kept, [0, *(np.flatnonzero(broken) + 1).tolist()]

    def preview_subset(self, parent_id, spec):
        view, mask = self._subset_selection(parent_id, spec)
        kept, starts = self._pieces(mask, view)
        out = {'rows': int(len(kept)), 'parent_rows': int(len(mask)), 'pieces': len(starts), 'start': None, 'end': None}
        if len(kept):
            first, last = view.df.index[kept[0]], view.df.index[kept[-1]]
            out['start'] = int(first.value // 10 ** 6) if view.time_index else int(first)
            out['end'] = int(last.value // 10 ** 6) if view.time_index else int(last)
        return out

    def create_subset(self, parent_id, name, spec, description=''):
        parent = self.db_manager.get_dataset(parent_id)
        view, mask = self._subset_selection(parent_id, spec)
        kept, starts = self._pieces(mask, view)
        if not len(kept):
            raise LoadError('The selection keeps no row')
        if len(kept) < 2:
            raise LoadError('The selection keeps a single row — select a wider period')

        frame = view.df.iloc[kept].copy()

        # colonnes derivees du parent -> valeurs figees calculees sur TOUT le parent (pas d'effet de bord
        # au debut des morceaux) ; on garde la formule, et le caractere "regarde le futur" + son horizon
        parent_origin = parent.get('origin') or {}
        inherited = dict(parent_origin.get('inherited') or {})
        horizons_from = {**{n: f'lead(x, {i.get("horizon") or 1})' for n, i in inherited.items() if i.get('lookahead')}, **view.custom}
        derived = self.db_manager.get_columns(parent_id)
        for column, info in derived.items():
            try:
                values, lookahead = view.column(column, numeric=False)
            except FormulaError:
                continue
            frame[column] = values.iloc[kept].to_numpy()
            inherited[column] = {
                'formula': info['formula'], 'description': info.get('description') or '', 'from': parent['name'],
                'lookahead': bool(lookahead), 'horizon': _lead_horizon(info['formula'], horizons_from) if lookahead else 0,
            }

        segment_keys = []
        for position in starts[1:]:
            label = frame.index[position]
            segment_keys.append(int(label.value // 10 ** 6) if view.time_index else int(position))

        time_column = (parent['profile'].get('time') or {}).get('column')
        raw = frame.reset_index(drop=True)
        overrides = {k: v for k, v in (parent['type_overrides'] or {}).items() if k in raw.columns and v != 'ignore'}
        df, profile = build_dataset(raw, overrides, time_column or None)

        dataset_id = self._new_id(name or parent['name'])
        folder = self._dir(dataset_id)
        os.makedirs(folder, exist_ok=True)
        try:
            path = os.path.join(folder, 'raw.pkl')
            raw.to_pickle(path)
            first, last = frame.index[0], frame.index[-1]
            origin = {
                'parent_id': parent_id, 'parent_name': parent['name'], 'root_id': parent_origin.get('root_id') or parent_id,
                'spec': spec, 'rows': int(len(kept)), 'parent_rows': int(len(mask)), 'pieces': len(starts),
                'start': int(first.value // 10 ** 6) if view.time_index else int(kept[0]),
                'end': int(last.value // 10 ** 6) if view.time_index else int(kept[-1]),
                'segments': {'kind': 'time' if view.time_index else 'row', 'starts': segment_keys},
                'inherited': inherited,
            }
            self.db_manager.new_dataset(
                dataset_id, name or f'{parent["name"]} (subset)', parent['filename'], os.path.getsize(path),
                {'format': 'subset', 'source': parent['name']}, profile,
                type_overrides=overrides, time_column=time_column or 'none', parent_id=parent_id, origin=origin, description=description,
            )
            key = self._key(dataset_id, time_column or 'none', overrides)
            self._save_typed(dataset_id, key, df, profile)
            self._cache_put(key, (df, profile))
            return dataset_id
        except Exception:
            shutil.rmtree(folder, ignore_errors=True)
            raise


    # ── Resample (timeframe plus grosse) ─────────────────────────────────────

    def preview_resample(self, parent_id, spec):
        return Resample.preview(self.view(parent_id, {}), spec)

    def create_resample(self, parent_id, name, spec, description='', progress=None):
        """
        Nouveau dataset derive du dataset courant a une timeframe plus grosse (lien d'origine comme un
        sous-dataset). Chaque colonne garde sa recette (source + agregation) dans origin.inherited ; celles
        qui regardent le futur (lead) restent des cibles.
        """
        parent = self.db_manager.get_dataset(parent_id)
        if progress:
            progress(0, 1, 'loading the fine data')
        view = self.view(parent_id, {})
        frame, meta = Resample.resample(view, spec, progress)
        time_column = meta['time_column']
        step = (view.profile.get('time') or {}).get('median_step_seconds')

        parent_origin = parent.get('origin') or {}
        parent_inherited = parent_origin.get('inherited') or {}
        horizons_from = {**{n: f'lead(x, {i.get("horizon") or 1})' for n, i in parent_inherited.items() if i.get('lookahead')}, **view.custom}
        inherited = {}
        for item in meta['items']:
            recipe = f'{item["agg"]}({item["source"]})'
            if item['agg'] == 'quantile':
                recipe = f'quantile({item["source"]}, {item.get("q", 0.5)})'
            if item['agg'] == 'offset':
                recipe = f'row {int(item.get("k") or 0)} of ({item["source"]})'
            if item.get('restrict') in ('first', 'last') and int(item.get('restrict_n') or 0) > 0:
                recipe += f' on the {item["restrict"]} {int(item["restrict_n"])} rows'
            fine_horizon = _lead_horizon(item['source'], horizons_from) if item['lookahead'] else 0
            inherited[item['name']] = {
                'formula': f'{recipe} per {meta["rule_label"]}', 'description': '', 'from': parent['name'],
                'lookahead': item['lookahead'], 'aggregation': item,
                'horizon': Resample.horizon_in_candles(fine_horizon, step, meta['delta_ms']) if item['lookahead'] else 0,
            }
        inherited[meta['n_rows_column']] = {'formula': f'number of fine rows per {meta["rule_label"]}', 'description': '', 'from': parent['name'], 'lookahead': False, 'horizon': 0}

        df, profile = build_dataset(frame, {}, time_column)
        dataset_id = self._new_id(name or f'{parent["name"]}_{meta["rule_label"]}')
        folder = self._dir(dataset_id)
        os.makedirs(folder, exist_ok=True)
        try:
            path = os.path.join(folder, 'raw.pkl')
            frame.to_pickle(path)
            labels = frame[time_column]
            origin = {
                'kind': 'resample', 'parent_id': parent_id, 'parent_name': parent['name'],
                'root_id': parent_origin.get('root_id') or parent_id,
                'spec': {k: spec.get(k) for k in ('rule', 'convention', 'fill')}, 'resample': {k: v for k, v in meta.items() if k not in ('items', 'segment_starts')},
                'rows': int(len(frame)), 'parent_rows': int(len(view.df)), 'pieces': meta['pieces'],
                'start': int(labels.iloc[0].value // 10 ** 6), 'end': int(labels.iloc[-1].value // 10 ** 6),
                'segments': {'kind': 'time', 'starts': meta['segment_starts']},
                'inherited': inherited,
            }
            self.db_manager.new_dataset(
                dataset_id, name or f'{parent["name"]} {meta["rule_label"]}', parent['filename'], os.path.getsize(path),
                {'format': 'resample', 'source': parent['name']}, profile,
                type_overrides={}, time_column=time_column, parent_id=parent_id, origin=origin, description=description,
            )
            key = self._key(dataset_id, time_column, {})
            self._save_typed(dataset_id, key, df, profile)
            self._cache_put(key, (df, profile))
            return dataset_id
        except Exception:
            shutil.rmtree(folder, ignore_errors=True)
            raise


    # ── Agregation d'une granularite plus fine ───────────────────────────────

    def _fine_source(self, dataset_id, source_id):
        if source_id == dataset_id:
            raise LoadError('Choose another dataset than the current one as the finer source')
        if self.db_manager.get_dataset(source_id) is None:
            raise LoadError(f'Unknown dataset {source_id}')
        return self.view(dataset_id, {}), self.view(source_id, {})

    def preview_aggregate(self, dataset_id, source_id, convention='start'):
        coarse, fine = self._fine_source(dataset_id, source_id)
        return Resample.preview_aggregate(coarse, fine, convention)

    def create_aggregate(self, dataset_id, source_id, items, convention='start', progress=None):
        coarse, fine = self._fine_source(dataset_id, source_id)
        source = self.db_manager.get_dataset(source_id)
        columns, metas, info = Resample.aggregate_into(coarse, fine, items, convention, progress)
        if progress:
            progress(len(items), len(items) + 1, 'saving the columns')
        source_origin = source.get('origin') or {}
        horizons_from = {**{n: f'lead(x, {i.get("horizon") or 1})' for n, i in (source_origin.get('inherited') or {}).items() if i.get('lookahead')}, **fine.custom}
        step = (coarse.profile.get('time') or {}).get('step_label')
        batch = {}
        for meta in metas:
            recipe = f'{meta["agg"]}({meta["source"]})'
            if meta['agg'] == 'quantile':
                recipe = f'quantile({meta["source"]}, {meta.get("q", 0.5)})'
            if meta['agg'] == 'offset':
                recipe = f'row {int(meta.get("k") or 0)} of ({meta["source"]})'
            if meta.get('restrict') in ('first', 'last') and int(meta.get('restrict_n') or 0) > 0:
                recipe += f' on the {meta["restrict"]} {int(meta["restrict_n"])} rows'
            fine_horizon = _lead_horizon(meta['source'], horizons_from) if meta['lookahead'] else 0
            batch[meta['name']] = (columns[meta['name']], {
                'kind': 'aggregate', 'source_id': source_id, 'source_name': source['name'], 'recipe': f'{recipe} per {step} candle',
                'aggregation': meta, 'convention': info['convention'], 'lookahead': meta['lookahead'],
                'horizon': Resample.horizon_in_candles(fine_horizon, info['fine_step'], info['delta_ms']) if meta['lookahead'] else 0,
                'filled': int(columns[meta['name']].notna().sum()), 'created_at': self.db_manager.now_utc(),
            })
        self.add_frozen_many(dataset_id, batch)
        return dataset_id


    # ── Premier niveau touche (labels) ───────────────────────────────────────

    def _first_touch_inputs(self, dataset_id, spec, last_rows=None):
        view = self.view(dataset_id, {})
        values = {}
        for key in ('upper', 'lower', 'high', 'low'):
            formula = (spec.get(key) or '').strip()
            if not formula:
                raise FormulaError(f'Fill the "{key}" field')
            series, lookahead = view.column(formula)
            if lookahead:
                raise FormulaError(f'"{formula}" uses following rows (lead): the levels and the compared columns must be known at the start row')
            values[key] = series.to_numpy(dtype=float)
        n = len(view.df)
        pieces = list(view.slices or [(0, n)])
        if last_rows and n > last_rows:
            # apercu : les dernieres lignes seulement, morceaux coupes au debut de la fenetre
            first = n - last_rows
            pieces = [(max(a, first), b) for a, b in pieces if b > first]
        return values, pieces

    def preview_first_touch(self, dataset_id, spec, last_rows=200_000):
        values, pieces = self._first_touch_inputs(dataset_id, spec, last_rows)
        label, rows = FirstTouch.first_touch(values['high'], values['low'], values['upper'], values['lower'], spec.get('horizon', 24), pieces)
        first = pieces[0][0] if pieces else 0
        out = FirstTouch.summarize(label[first:], rows[first:], values['upper'][first:], values['lower'][first:])
        out['sample'] = last_rows if len(label) > last_rows else None
        return out

    def create_first_touch(self, dataset_id, spec, progress=None):
        values, pieces = self._first_touch_inputs(dataset_id, spec)
        horizon = int(spec.get('horizon', 24))
        label, rows = FirstTouch.first_touch(values['high'], values['low'], values['upper'], values['lower'], horizon, pieces,
                                             progress=(lambda share: progress(share, 1, 'searching the first touch')) if progress else None)
        df, _ = self.typed(dataset_id)
        stats = FirstTouch.summarize(label, rows, values['upper'], values['lower'])
        recipe = f'first touched within {horizon} rows: {spec["upper"]} (via {spec["high"]}) vs {spec["lower"]} (via {spec["low"]})'
        info = {'kind': 'first_touch', 'recipe': recipe, 'spec': {k: spec.get(k) for k in ('upper', 'lower', 'high', 'low', 'horizon')},
                'lookahead': True, 'horizon': horizon, 'stats': stats, 'created_at': self.db_manager.now_utc()}
        batch = {spec['name']: (pd.Series(label, index=df.index), {**info, 'output': 'label'})}
        if spec.get('rows_name'):
            batch[spec['rows_name']] = (pd.Series(rows, index=df.index), {**info, 'output': 'rows', 'recipe': f'rows until the first touch — {recipe}'})
        self.add_frozen_many(dataset_id, batch)
        return dataset_id
