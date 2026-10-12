import os
import re
import shutil
import secrets
from collections import OrderedDict

import pandas as pd

from .DataLoader import read_any, build_dataset, LoadError, SUPPORTED_EXTENSIONS
from .Engine import View



class DatasetStore:
    """
    Fichiers des datasets + cache memoire.

      <data>/datasets/<id>/original.<ext>   fichier charge, tel quel
      <data>/datasets/<id>/raw.pkl          DataFrame brut lu (avant typage) -> pas besoin de re-parser le CSV

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
        for key in [k for k in self.cache if k[0] == dataset_id]:
            self.cache.pop(key, None)


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
        self.cache[key] = (df, profile)
        while len(self.cache) > self.cache_size:
            self.cache.popitem(last=False)
        return df, profile

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
        return View(df, profile, custom, settings)
