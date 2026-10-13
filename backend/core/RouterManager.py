import io
import os
import csv
import json
import asyncio
import tempfile

import numpy as np
import pandas as pd

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect, File, UploadFile, Form, Query
from fastapi.responses import JSONResponse, StreamingResponse

from .app.DataLoader import LoadError, COLUMN_TYPES, SUPPORTED_EXTENSIONS
from .app.Engine import FormulaError, FUNCTIONS_DOC, ANALYSES, describe, run_analysis, _json
from .app import Modeling
from .app.ModelingManager import ModelingManager







class RouterManager:
    def __init__(self, db_manager, ws_manager, store):
        self.db_manager = db_manager
        self.ws_manager = ws_manager
        self.store = store
        self.router = APIRouter()
        self.modeling = ModelingManager(db_manager, ws_manager, store)

        self.routes()


    ##################################################################################################
    #####                                          Utils                                         #####

    async def _call(self, name, fn):
        """Calcul dans un thread ; erreurs utilisateur (format, formule) -> 400 avec un message lisible."""
        try:
            return JSONResponse(content=await asyncio.to_thread(fn))
        except (FormulaError, LoadError, Modeling.ModelingError) as error:
            raise HTTPException(status_code=400, detail=str(error))
        except HTTPException:
            raise
        except Exception as error:
            print(f"api/{name} ===> ERROR: {type(error).__name__}: {str(error)}", flush=True)
            raise HTTPException(status_code=500, detail=f'{type(error).__name__}: {error}')

    def _dataset_or_404(self, dataset_id):
        record = self.db_manager.get_dataset(dataset_id)
        if record is None:
            raise HTTPException(status_code=404, detail=f'Unknown dataset {dataset_id}')
        return record

    async def _broadcast_list(self):
        await self.ws_manager.datasets_list_update(self.db_manager.get_datasets_list())

    def _view_settings(self, record, view):
        return json.loads(view) if view else (record['view_settings'] or {})

    def _check_column_name(self, dataset_id, name):
        df_columns = set(self.store.typed(dataset_id)[1]['columns'])
        reserved = {f.split('(')[0].strip() for key in FUNCTIONS_DOC for f in key.replace(',', '/').split('/')}
        if not name.isidentifier() or name in df_columns or name in reserved or name in self.db_manager.get_columns(dataset_id):
            raise HTTPException(status_code=400, detail='Name must be a valid identifier (letters, digits, _) not used by a dataset column or a function')

    def _family(self, dataset_id):
        """Le dataset d'origine (racine) et tous les sous-datasets qui en descendent, en arbre aplati."""
        datasets = {d['dataset_id']: d for d in self.db_manager.get_datasets_list()}
        root = dataset_id
        seen = set()
        while datasets.get(root, {}).get('parent_id') in datasets and root not in seen:
            seen.add(root)
            root = datasets[root]['parent_id']
        children = {}
        for d in datasets.values():
            children.setdefault(d.get('parent_id'), []).append(d)
        out = []

        def walk(node_id, depth):
            d = datasets[node_id]
            out.append({'dataset_id': node_id, 'name': d['name'], 'parent_id': d.get('parent_id'), 'depth': depth,
                        'rows': (d.get('summary') or {}).get('rows'), 'origin': d.get('origin')})
            for child in sorted(children.get(node_id, []), key=lambda c: c['created_at']):
                walk(child['dataset_id'], depth + 1)
        walk(root, 0)
        return out

    def _full_record(self, dataset_id):
        record = self.db_manager.get_dataset(dataset_id)
        record['derived_columns'] = self.db_manager.get_columns(dataset_id)
        record['workspaces'] = self.db_manager.get_workspaces(dataset_id)
        record['family'] = self._family(dataset_id)
        return record

    #####                                                                                        #####
    ##################################################################################################


    def routes(self):

        @self.router.websocket("/ws")
        async def websocket_endpoint(websocket: WebSocket):
            print("🔵 WebSocket connection attempt...", flush=True)
            await self.ws_manager.connect(websocket)
            try:
                print("🟢 WebSocket connected successfully!", flush=True)
                while True:
                    await websocket.receive_text()
            except WebSocketDisconnect:
                print("🔴 WebSocket disconnected", flush=True)
                self.ws_manager.disconnect(websocket)



##################################################################################################
##################################################################################################
#####                                       GET Methods                                      #####


        @self.router.get("/api/get_meta")
        async def get_meta():
            return JSONResponse(content={
                'functions': FUNCTIONS_DOC,
                'column_types': COLUMN_TYPES,
                'analyses': list(ANALYSES.keys()),
                'extensions': sorted(SUPPORTED_EXTENSIONS),
            })


        @self.router.get("/api/get_datasets")
        async def get_datasets():
            try:
                return JSONResponse(content=self.db_manager.get_datasets_list())
            except Exception as error:
                print(f"api/get_datasets ===> ERROR: {str(error)}", flush=True)
                raise HTTPException(status_code=500, detail=str(error))


        @self.router.get("/api/get_dataset")
        async def get_dataset(
            dataset_id: str = Query(...),
        ):
            self._dataset_or_404(dataset_id)
            return JSONResponse(content=self._full_record(dataset_id))


        @self.router.get("/api/get_workspace")
        async def get_workspace(
            dataset_id: str = Query(...),
            name: str = Query(...),
        ):
            workspace = self.db_manager.get_workspace(dataset_id, name)
            if workspace is None:
                raise HTTPException(status_code=404, detail=f'Unknown workspace {name}')
            return JSONResponse(content=workspace)


        @self.router.get("/api/export_csv")
        async def export_csv(
            dataset_id: str = Query(...),
            columns: str = Query(None),
            view: str = Query(None),
        ):
            """Export du dataset tel qu'analyse (vue + colonnes derivees choisies)."""
            record = self._dataset_or_404(dataset_id)
            try:
                view_obj = await asyncio.to_thread(self.store.view, dataset_id, self._view_settings(record, view))
                wanted = json.loads(columns) if columns else list(view_obj.df.columns)
                frame = {}
                for c in wanted:
                    frame[c] = view_obj.column(c, numeric=False)[0]
                df = pd.DataFrame(frame)
            except (FormulaError, LoadError) as error:
                raise HTTPException(status_code=400, detail=str(error))

            def generate():
                buffer = io.StringIO()
                writer = csv.writer(buffer)
                head = (['time'] if view_obj.time_index else []) + list(df.columns)
                writer.writerow(head)
                for index, row in zip(df.index, df.itertuples(index=False, name=None)):
                    writer.writerow(([index.isoformat()] if view_obj.time_index else []) + [_json(v) for v in row])
                    if buffer.tell() > 1 << 16:
                        yield buffer.getvalue()
                        buffer.seek(0)
                        buffer.truncate(0)
                yield buffer.getvalue()

            filename = f'{record["name"]}_export.csv'.replace(' ', '_')
            return StreamingResponse(generate(), media_type='text/csv', headers={'Content-Disposition': f'attachment; filename="{filename}"'})



##################################################################################################
##################################################################################################
#####                                       POST Methods                                     #####


        #==================    DATASETS    ==================#

        @self.router.post("/api/upload_dataset")
        async def upload_dataset(
            datafile: UploadFile = File(...),
            name: str = Form(None),
        ):
            suffix = os.path.splitext(datafile.filename or 'data.csv')[1]
            tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix, dir=self.store.root)
            try:
                while chunk := await datafile.read(1 << 20):
                    tmp.write(chunk)
                tmp.close()

                def work():
                    dataset_id = self.store.import_file(tmp.name, datafile.filename, name)
                    return self.db_manager.get_dataset(dataset_id)
                response = await self._call('upload_dataset', work)
                await self._broadcast_list()
                return response
            finally:
                if os.path.exists(tmp.name):
                    os.remove(tmp.name)


        @self.router.post("/api/import_path")
        async def import_path(
            path: str = Form(...),
            name: str = Form(None),
        ):
            """Import d'un fichier deja present sur la machine du serveur (gros fichiers)."""
            if not os.path.isfile(path):
                raise HTTPException(status_code=404, detail=f'File not found on the server: {path}')

            def work():
                dataset_id = self.store.import_file(path, os.path.basename(path), name)
                return self.db_manager.get_dataset(dataset_id)
            response = await self._call('import_path', work)
            await self._broadcast_list()
            return response


        @self.router.post("/api/update_dataset")
        async def update_dataset(
            dataset_id: str = Form(...),
            name: str = Form(None),
            description: str = Form(None),
            type_overrides: str = Form(None),
            time_column: str = Form(None),
        ):
            self._dataset_or_404(dataset_id)
            if name is not None or description is not None:
                self.db_manager.update_dataset(dataset_id, **{k: v for k, v in (('name', name), ('description', description)) if v is not None})

            def work():
                if type_overrides is not None or time_column is not None:
                    overrides = json.loads(type_overrides) if type_overrides is not None else None
                    if overrides:
                        bad = {k: v for k, v in overrides.items() if v not in COLUMN_TYPES}
                        if bad:
                            raise LoadError(f'Unknown types: {bad}')
                    self.store.retype(dataset_id, overrides, time_column)
                return self._full_record(dataset_id)
            response = await self._call('update_dataset', work)
            await self._broadcast_list()
            return response


        @self.router.post("/api/update_view")
        async def update_view(
            dataset_id: str = Form(...),
            view_settings: str = Form(...),
        ):
            """Plage / reechantillonnage / filtre enregistres pour le dataset (valides avant)."""
            self._dataset_or_404(dataset_id)
            settings = json.loads(view_settings)

            def work():
                view_obj = self.store.view(dataset_id, settings)
                self.db_manager.update_dataset(dataset_id, view_settings=settings)
                return {'status': 'ok', 'rows': int(len(view_obj.index)), 'view_settings': settings}
            return await self._call('update_view', work)


        @self.router.post("/api/preview_subset")
        async def preview_subset(
            dataset_id: str = Form(...),
            spec: str = Form(...),
        ):
            """Nombre de lignes / morceaux / periode que garderait la selection, avant de creer."""
            self._dataset_or_404(dataset_id)
            return await self._call('preview_subset', lambda: self.store.preview_subset(dataset_id, json.loads(spec)))


        @self.router.post("/api/create_subset")
        async def create_subset(
            dataset_id: str = Form(...),
            name: str = Form(...),
            spec: str = Form(...),
            description: str = Form(''),
        ):
            """Nouveau dataset a part entiere, fait des lignes selectionnees du dataset parent."""
            self._dataset_or_404(dataset_id)

            def work():
                child_id = self.store.create_subset(dataset_id, name.strip(), json.loads(spec), description)
                return self._full_record(child_id)
            response = await self._call('create_subset', work)
            await self._broadcast_list()
            return response


        @self.router.post("/api/delete_dataset")
        async def delete_dataset(
            dataset_id: str = Form(...),
        ):
            self._dataset_or_404(dataset_id)
            for run in self.db_manager.get_model_runs(dataset_id):
                self.modeling.cancel(run['run_id'])
                self.modeling.delete_models(run['run_id'])
            self.db_manager.delete_dataset(dataset_id)
            self.store.delete(dataset_id)
            await self._broadcast_list()
            return JSONResponse(content={'status': 'ok'})


        #==================    COLUMNS    ==================#

        @self.router.post("/api/preview_formula")
        async def preview_formula(
            dataset_id: str = Form(...),
            formula: str = Form(...),
            view: str = Form(None),
        ):
            record = self._dataset_or_404(dataset_id)

            def work():
                view_obj = self.store.view(dataset_id, self._view_settings(record, view))
                values, lookahead = view_obj.column(formula, numeric=False)
                numeric = pd.api.types.is_numeric_dtype(values)
                tail = values.tail(400)
                return {
                    'lookahead': lookahead, 'numeric': bool(numeric),
                    'stats': describe(values) if numeric else {'count': int(values.notna().sum()), 'unique': int(values.nunique())},
                    'tail': {'x': [_json(v) for v in tail.index], 'y': [_json(v) for v in tail.to_numpy()]} if numeric else None,
                    'top': [{'value': str(k), 'count': int(v)} for k, v in values.astype(str).value_counts().head(6).items()] if not numeric else None,
                }
            return await self._call('preview_formula', work)


        @self.router.post("/api/save_column")
        async def save_column(
            dataset_id: str = Form(...),
            name: str = Form(...),
            formula: str = Form(...),
            description: str = Form(None),
        ):
            self._dataset_or_404(dataset_id)
            name = name.strip()
            df_columns = set(self.store.typed(dataset_id)[1]['columns'])
            reserved = {f.split('(')[0].strip() for key in FUNCTIONS_DOC for f in key.replace(',', '/').split('/')}
            if not name.isidentifier() or name in df_columns or name in reserved:
                raise HTTPException(status_code=400, detail='Name must be a valid identifier (letters, digits, _) not used by a dataset column or a function')

            def work():
                # la formule doit s'evaluer (sans reference circulaire) avant d'etre enregistree
                view_obj = self.store.view(dataset_id, {})
                view_obj.custom = {**view_obj.custom, name: formula}
                view_obj.column(name, numeric=False)
                self.db_manager.save_column(dataset_id, name, formula, description)
                return {'status': 'ok', 'derived_columns': self.db_manager.get_columns(dataset_id)}
            response = await self._call('save_column', work)
            await self.ws_manager.columns_update(dataset_id, self.db_manager.get_columns(dataset_id))
            return response


        @self.router.post("/api/delete_column")
        async def delete_column(
            dataset_id: str = Form(...),
            name: str = Form(...),
        ):
            self.db_manager.delete_column(dataset_id, name)
            columns = self.db_manager.get_columns(dataset_id)
            await self.ws_manager.columns_update(dataset_id, columns)
            return JSONResponse(content={'status': 'ok', 'derived_columns': columns})


        #==================    ANALYSES    ==================#

        @self.router.post("/api/analyze")
        async def analyze(
            dataset_id: str = Form(...),
            analysis: str = Form(...),
            params: str = Form('{}'),
            view: str = Form(None),
        ):
            record = self._dataset_or_404(dataset_id)

            def work():
                view_obj = self.store.view(dataset_id, self._view_settings(record, view))
                return run_analysis(view_obj, analysis, json.loads(params))
            return await self._call('analyze', work)


        #==================    MODELING    ==================#

        @self.router.get("/api/model/catalog")
        async def model_catalog():
            return JSONResponse(content=Modeling.catalog())


        @self.router.post("/api/model/preview")
        async def model_preview(
            dataset_id: str = Form(...),
            config: str = Form(...),
            view: str = Form(None),
        ):
            """Tache detectee, classes / stats de la cible, gap suggere, avertissements — avant de lancer."""
            record = self._dataset_or_404(dataset_id)

            def work():
                view_obj = self.store.view(dataset_id, self._view_settings(record, view))
                return Modeling.preview(view_obj, json.loads(config))
            return await self._call('model/preview', work)


        @self.router.post("/api/model/run")
        async def model_run(
            dataset_id: str = Form(...),
            config: str = Form(...),
            view: str = Form(None),
            name: str = Form(None),
        ):
            record = self._dataset_or_404(dataset_id)
            try:
                run_id = await self.modeling.start(dataset_id, json.loads(config), self._view_settings(record, view), name)
            except (FormulaError, LoadError, Modeling.ModelingError) as error:
                raise HTTPException(status_code=400, detail=str(error))
            return JSONResponse(content={'run_id': run_id})


        @self.router.post("/api/model/cancel")
        async def model_cancel(
            run_id: int = Form(...),
        ):
            return JSONResponse(content={'cancelled': self.modeling.cancel(run_id)})


        @self.router.get("/api/model/runs")
        async def model_runs(
            dataset_id: str = Query(...),
        ):
            runs = self.db_manager.get_model_runs(dataset_id)
            for run in runs:
                run['progress'] = self.modeling.progress_of(run['run_id'])
                run['saved'] = self.modeling.saved_keys(run['run_id'])
            return JSONResponse(content=runs)


        @self.router.get("/api/model/result")
        async def model_result(
            run_id: int = Query(...),
            model_key: str = Query(...),
        ):
            result = self.db_manager.get_model_result(run_id, model_key)
            if result is None:
                raise HTTPException(status_code=404, detail='No result for this model')
            return JSONResponse(content=result)


        @self.router.post("/api/model/rename_run")
        async def model_rename_run(
            run_id: int = Form(...),
            name: str = Form(...),
        ):
            """Le nom d'un lancement est aussi celui de son modele conserve (liste « Model prediction »)."""
            if self.db_manager.get_model_run(run_id) is None:
                raise HTTPException(status_code=404, detail='Unknown run')
            name = name.strip()
            if not name:
                raise HTTPException(status_code=400, detail='The name cannot be empty')
            self.db_manager.rename_model_run(run_id, name[:80])
            return JSONResponse(content={'status': 'ok', 'name': name[:80]})


        @self.router.post("/api/model/delete_run")
        async def model_delete_run(
            run_id: int = Form(...),
        ):
            self.modeling.cancel(run_id)
            self.modeling.delete_models(run_id)
            self.db_manager.delete_model_run(run_id)
            return JSONResponse(content={'status': 'ok'})


        @self.router.get("/api/model/saved")
        async def model_saved(
            dataset_id: str = Query(...),
        ):
            """
            Modeles entraines applicables ici, de n'importe quel dataset : d'abord ceux de ce dataset, puis de sa
            famille (parent, freres), puis des autres. `unsaved` : lancements termines dont aucun modele n'a ete garde.
            """
            self._dataset_or_404(dataset_id)
            family = [m['dataset_id'] for m in self._family(dataset_id)]
            names = {d['dataset_id']: d['name'] for d in self.db_manager.get_datasets_list()}
            rank = lambda ds: 0 if ds == dataset_id else (1 if ds in family else 2)
            out, unsaved = [], []
            for ds, ds_name in names.items():
                for run in self.db_manager.get_model_runs(ds):
                    if run['status'] != 'done':
                        continue
                    info = run['info'] or {}
                    main = 'roc_auc' if info.get('task') == 'classification' else 'r2'
                    keys = self.modeling.saved_keys(run['run_id'])
                    if not keys:
                        unsaved.append({'run_id': run['run_id'], 'run_name': run['name'], 'dataset_name': ds_name})
                    for key in keys:
                        entry = next((m for m in (run['summary'] or []) if m['key'] == key), None)
                        if entry is None:
                            continue
                        out.append({
                            'run_id': run['run_id'], 'run_name': run['name'], 'model_key': key, 'label': entry['label'],
                            'dataset_id': ds, 'dataset_name': ds_name, 'task': info.get('task'),
                            'target': run['config'].get('target'), 'positive_class': info.get('positive_class'),
                            'metric': main, 'score': (entry.get('test') or {}).get(main), 'created_at': run['created_at'],
                            'fit_rows': (info.get('splits') or [{}])[-1].get('train'),
                            'outputs': Modeling.OUTPUTS.get(info.get('task'), []),
                        })
            out.sort(key=lambda m: (rank(m['dataset_id']), -m['run_id']))
            return JSONResponse(content={'models': out, 'unsaved': unsaved})


        @self.router.post("/api/model/predict_preview")
        async def model_predict_preview(
            dataset_id: str = Form(...),
            run_id: int = Form(...),
            model_key: str = Form(...),
            output: str = Form(None),
            threshold: float = Form(0.5),
        ):
            """Calcule la colonne sans l'enregistrer : lignes predites / deja vues a l'entrainement / sans entrees, stats."""
            self._dataset_or_404(dataset_id)

            def work():
                bundle = self.modeling.load_model(run_id, model_key)
                view_obj = self.store.view(dataset_id, {})
                series, stats = Modeling.predict_with(view_obj, bundle, output, threshold)
                values = series.dropna()
                tail = values.tail(400)
                return {
                    **stats, 'task': bundle['task'], 'label': bundle['label'], 'target': bundle['target'], 'positive_class': bundle['positive'],
                    'stats': describe(values) if len(values) else None,
                    'tail': {'x': [_json(v) for v in tail.index], 'y': [_json(v) for v in tail.to_numpy()]},
                }
            return await self._call('model/predict_preview', work)


        @self.router.post("/api/model/predict_column")
        async def model_predict_column(
            dataset_id: str = Form(...),
            name: str = Form(...),
            run_id: int = Form(...),
            model_key: str = Form(...),
            output: str = Form(None),
            threshold: float = Form(0.5),
            description: str = Form(''),
        ):
            """Nouvelle colonne = predictions d'un modele entraine, figees dans le dataset."""
            self._dataset_or_404(dataset_id)
            name = name.strip()
            self._check_column_name(dataset_id, name)

            def work():
                bundle = self.modeling.load_model(run_id, model_key)
                view_obj = self.store.view(dataset_id, {})
                series, stats = Modeling.predict_with(view_obj, bundle, output, threshold)
                if stats['predicted'] == 0:
                    raise Modeling.ModelingError('The model predicts no row here: every row was used in its training, or an input is missing')
                run = self.db_manager.get_model_run(run_id)
                source = self.db_manager.get_dataset(run['dataset_id'])
                info = {
                    'kind': 'model', 'run_id': int(run_id), 'model_key': model_key, 'model_label': bundle['label'], 'task': bundle['task'],
                    'output': output or Modeling.OUTPUTS[bundle['task']][0], 'threshold': threshold if output == 'class' else None,
                    'target': bundle['target'], 'trained_on': source['name'] if source else run['dataset_id'], 'trained_on_id': run['dataset_id'],
                    'run_name': run['name'], 'description': description or '', 'predicted': stats['predicted'],
                    'left_empty': stats['seen_in_training'] + stats['missing_inputs'],
                    'lookahead': False, 'created_at': self.db_manager.now_utc(),
                }
                self.store.add_frozen(dataset_id, name, series, info)
                return self._full_record(dataset_id)
            response = await self._call('model/predict_column', work)
            await self._broadcast_list()
            return response


        @self.router.post("/api/delete_frozen")
        async def delete_frozen(
            dataset_id: str = Form(...),
            name: str = Form(...),
        ):
            self._dataset_or_404(dataset_id)
            response = await self._call('delete_frozen', lambda: (self.store.delete_frozen(dataset_id, name), self._full_record(dataset_id))[1])
            await self._broadcast_list()
            return response


        #==================    WORKSPACES    ==================#

        @self.router.post("/api/save_workspace")
        async def save_workspace(
            dataset_id: str = Form(...),
            name: str = Form(...),
            config: str = Form(...),
        ):
            self._dataset_or_404(dataset_id)
            self.db_manager.save_workspace(dataset_id, name.strip(), json.loads(config))
            return JSONResponse(content={'status': 'ok', 'workspaces': self.db_manager.get_workspaces(dataset_id)})


        @self.router.post("/api/delete_workspace")
        async def delete_workspace(
            dataset_id: str = Form(...),
            name: str = Form(...),
        ):
            self.db_manager.delete_workspace(dataset_id, name)
            return JSONResponse(content={'status': 'ok', 'workspaces': self.db_manager.get_workspaces(dataset_id)})
