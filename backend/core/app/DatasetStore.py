import os
import re
import shutil
import secrets
from collections import OrderedDict

import numpy as np
import pandas as pd

from .DataLoader import read_any, build_dataset, profile_column, LoadError, SUPPORTED_EXTENSIONS
from .Engine import View, FormulaError
from .Modeling import _lead_horizon



class DatasetStore:
    """
    Fichiers des datasets + cache memoire.

      <data>/datasets/<id>/original.<ext>   fichier charge, tel quel
      <data>/datasets/<id>/raw.pkl          DataFrame brut lu (avant typage) -> pas besoin de re-parser le CSV

    Un sous-dataset est un dataset a part entiere (ses colonnes, ses vues, ses modeles) : ses lignes sont
    copiees du parent a la creation (raw.pkl, pas de fichier original) et les colonnes derivees du parent
    y deviennent des colonnes figees, calculees sur tout l'historique du parent.

    Le DataFrame type (categorisation + overrides + axe temporel) est reconstruit depuis raw.pkl et
    garde en cache LRU ; il est invalide quand on change les types ou l'axe temporel.
    """

    def __init__(self, data_path, db_manager, cache_size=6):
        self.root = os.path.join(data_path, 'datasets')
        self.db_manager = db_manager
        self.cache = OrderedDict()
        self.cache_size = cache_size
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
            self.cache[(dataset_id, 'auto', '{}')] = (df, profile)
            return dataset_id
        except Exception:
            shutil.rmtree(folder, ignore_errors=True)
            raise

    def delete(self, dataset_id):
        shutil.rmtree(self._dir(dataset_id), ignore_errors=True)
        self._drop_cache(dataset_id)


    # ── Typage / acces ───────────────────────────────────────────────────────

    def typed(self, dataset_id):
        record = self.db_manager.get_dataset(dataset_id)
        if record is None:
            raise LoadError(f'Unknown dataset {dataset_id}')
        overrides = record['type_overrides'] or {}
        time_column = record['time_column']
        key = (dataset_id, time_column, str(sorted(overrides.items())))
        if key in self.cache:
            self.cache.move_to_end(key)
            return self.cache[key]
        raw = pd.read_pickle(os.path.join(self._dir(dataset_id), 'raw.pkl'))
        df, profile = build_dataset(raw, overrides, None if time_column in (None, '', 'none') else time_column)
        self._attach_frozen(dataset_id, df, profile, record.get('frozen') or {})
        self.cache[key] = (df, profile)
        while len(self.cache) > self.cache_size:
            self.cache.popitem(last=False)
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

    def _drop_cache(self, dataset_id):
        for key in [k for k in self.cache if k[0] == dataset_id]:
            self.cache.pop(key, None)

    def add_frozen(self, dataset_id, name, series, info):
        """Enregistre une colonne de valeurs (alignee sur le df type complet du dataset) + ses metadonnees."""
        record = self.db_manager.get_dataset(dataset_id)
        df, _ = self.typed(dataset_id)
        path = self._frozen_path(dataset_id)
        frozen = pd.read_pickle(path) if os.path.exists(path) else pd.DataFrame(index=df.index)
        if len(frozen) != len(df) or not frozen.index.equals(df.index):
            frozen = pd.DataFrame(index=df.index)
        frozen[name] = series.to_numpy(dtype=float)
        frozen.to_pickle(path)
        meta = {**(record.get('frozen') or {}), name: info}
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
        return View(df, profile, custom, settings, origin.get('inherited'), (origin.get('segments') or {}).get('starts'))


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
    def _pieces(mask):
        """Debut (position dans le parent) de chaque suite continue de lignes gardees."""
        kept = np.flatnonzero(mask)
        if not len(kept):
            return kept, []
        starts = [0, *(np.flatnonzero(np.diff(kept) > 1) + 1).tolist()]
        return kept, starts

    def preview_subset(self, parent_id, spec):
        view, mask = self._subset_selection(parent_id, spec)
        kept, starts = self._pieces(mask)
        out = {'rows': int(len(kept)), 'parent_rows': int(len(mask)), 'pieces': len(starts), 'start': None, 'end': None}
        if len(kept):
            first, last = view.df.index[kept[0]], view.df.index[kept[-1]]
            out['start'] = int(first.value // 10 ** 6) if view.time_index else int(first)
            out['end'] = int(last.value // 10 ** 6) if view.time_index else int(last)
        return out

    def create_subset(self, parent_id, name, spec, description=''):
        parent = self.db_manager.get_dataset(parent_id)
        view, mask = self._subset_selection(parent_id, spec)
        kept, starts = self._pieces(mask)
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
            self.cache[(dataset_id, time_column or 'none', str(sorted(overrides.items())))] = (df, profile)
            return dataset_id
        except Exception:
            shutil.rmtree(folder, ignore_errors=True)
            raise
