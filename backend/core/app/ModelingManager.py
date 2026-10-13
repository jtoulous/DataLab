import os
import time
import asyncio

import joblib

from .Engine import FormulaError
from .DataLoader import LoadError
from . import Modeling



class ModelingManager:
    """
    Lancements de modelisation en tache de fond (un thread par lancement) avec progression
    diffusee par WebSocket, annulation, et sauvegarde des resultats en base.
    """

    def __init__(self, db_manager, ws_manager, store):
        self.db_manager = db_manager
        self.ws_manager = ws_manager
        self.store = store
        self.running = {}            # run_id -> {'cancel': bool, 'progress': {...}}
        self.models_dir = os.path.join(os.path.dirname(store.root), 'models')
        os.makedirs(self.models_dir, exist_ok=True)
        self.db_manager.mark_interrupted_runs()
        self.prune_saved()

    # ── modeles entraines, reutilisables sur un autre dataset ────────────────

    def _model_path(self, run_id, model_key):
        return os.path.join(self.models_dir, f'{int(run_id)}__{model_key}.joblib')

    def save_models(self, run_id, fitted):
        for key, bundle in fitted.items():
            joblib.dump(bundle, self._model_path(run_id, key), compress=3)

    @staticmethod
    def _pick_best(task, summary, keys):
        """Meilleur modele parmi `keys` sur la metrique principale du test (celle du classement)."""
        main = 'roc_auc' if task == 'classification' else 'r2'
        scored = [(m['test'].get(main), m['key']) for m in summary if m['key'] in keys and m.get('test')]
        scored = [(v, k) for v, k in scored if v is not None]
        if scored:
            return max(scored)[1]
        return next(iter(keys), None)

    def _best_key(self, result):
        fitted = result.get('fitted') or {}
        return self._pick_best(result['info'].get('task'), result['summary'], list(fitted))

    def prune_saved(self):
        """Lancements enregistres avant la regle « seul le meilleur modele est garde » : on ne garde que lui."""
        removed = 0
        for dataset in self.db_manager.get_datasets_list():
            for run in self.db_manager.get_model_runs(dataset['dataset_id']):
                keys = self.saved_keys(run['run_id'])
                if len(keys) <= 1 or run['status'] != 'done':
                    continue
                best = self._pick_best((run['info'] or {}).get('task'), run['summary'] or [], keys)
                for key in keys:
                    if key != best:
                        try:
                            os.remove(self._model_path(run['run_id'], key))
                            removed += 1
                        except OSError:
                            pass
        if removed:
            print(f'models: kept only the best model of each run ({removed} other saved models removed)', flush=True)

    def load_model(self, run_id, model_key):
        path = self._model_path(run_id, model_key)
        if not os.path.exists(path):
            raise LoadError('This model was not saved (runs made before models were kept cannot be applied) — train it again')
        return joblib.load(path)

    def saved_keys(self, run_id):
        prefix = f'{int(run_id)}__'
        return sorted(f[len(prefix):-len('.joblib')] for f in os.listdir(self.models_dir) if f.startswith(prefix) and f.endswith('.joblib'))

    def delete_models(self, run_id):
        for key in self.saved_keys(run_id):
            try:
                os.remove(self._model_path(run_id, key))
            except OSError:
                pass

    async def start(self, dataset_id, config, view, name=None):
        record = self.db_manager.get_dataset(dataset_id)
        if record is None:
            raise LoadError(f'Unknown dataset {dataset_id}')
        settings = view if view is not None else (record['view_settings'] or {})
        # validation immediate (cible, entrees, decoupage) pour renvoyer l'erreur tout de suite
        view_obj = await asyncio.to_thread(self.store.view, dataset_id, settings)
        await asyncio.to_thread(Modeling.preview, view_obj, config)

        label = name or f'{config.get("target", "")[:40]} · {len(config.get("models") or [])} models'
        run_id = self.db_manager.new_model_run(dataset_id, label, config, settings)
        state = {'cancel': False, 'progress': {'done': 0, 'total': 1, 'label': 'starting'}}
        self.running[run_id] = state
        loop = asyncio.get_running_loop()
        asyncio.create_task(self._run(run_id, dataset_id, config, view_obj, state, loop))
        return run_id

    def cancel(self, run_id):
        state = self.running.get(run_id)
        if state:
            state['cancel'] = True
            return True
        return False

    def progress_of(self, run_id):
        state = self.running.get(run_id)
        return state['progress'] if state else None

    async def _run(self, run_id, dataset_id, config, view_obj, state, loop):
        started = time.time()
        last_sent = [0.0]

        def progress(done, total, label):
            state['progress'] = {'done': done, 'total': total, 'label': label}
            now = time.monotonic()
            if now - last_sent[0] > 0.3 or done == total:
                last_sent[0] = now
                asyncio.run_coroutine_threadsafe(self._broadcast(run_id, dataset_id, 'running', progress=state['progress']), loop)

        try:
            result = await asyncio.to_thread(Modeling.run, view_obj, config, progress, lambda: state['cancel'])
            self.db_manager.save_model_results(run_id, result['details'])
            best = self._best_key(result)
            await asyncio.to_thread(self.save_models, run_id, {best: result['fitted'][best]} if best else {})
            self.db_manager.finish_model_run(run_id, 'done', info=result['info'], summary=result['summary'], duration=result['duration'])
            await self._broadcast(run_id, dataset_id, 'done')
        except (Modeling.ModelingError, FormulaError, LoadError) as error:
            status = 'cancelled' if str(error) == 'Cancelled' else 'error'
            self.db_manager.finish_model_run(run_id, status, error=str(error), duration=time.time() - started)
            await self._broadcast(run_id, dataset_id, status, error=str(error))
        except Exception as error:
            print(f'model run {run_id} ===> ERROR: {type(error).__name__}: {error}', flush=True)
            self.db_manager.finish_model_run(run_id, 'error', error=f'{type(error).__name__}: {error}', duration=time.time() - started)
            await self._broadcast(run_id, dataset_id, 'error', error=f'{type(error).__name__}: {error}')
        finally:
            self.running.pop(run_id, None)

    async def _broadcast(self, run_id, dataset_id, status, progress=None, error=None):
        await self.ws_manager.broadcast({
            "type": "model_run_update",
            "payload": {"run_id": run_id, "dataset_id": dataset_id, "status": status, "progress": progress, "error": error}
        })
