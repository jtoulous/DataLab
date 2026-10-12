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







class RouterManager:
    def __init__(self, db_manager, ws_manager, store):
        self.db_manager = db_manager
        self.ws_manager = ws_manager
        self.store = store
        self.router = APIRouter()

        self.routes()


    ##################################################################################################
    #####                                          Utils                                         #####

    async def _call(self, name, fn):
        """Calcul dans un thread ; erreurs utilisateur (format, formule) -> 400 avec un message lisible."""
        try:
            return JSONResponse(content=await asyncio.to_thread(fn))
        except (FormulaError, LoadError) as error:
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
            record = self._dataset_or_404(dataset_id)
            record['derived_columns'] = self.db_manager.get_columns(dataset_id)
            record['workspaces'] = self.db_manager.get_workspaces(dataset_id)
            return JSONResponse(content=record)


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
                record = self.db_manager.get_dataset(dataset_id)
                record['derived_columns'] = self.db_manager.get_columns(dataset_id)
                record['workspaces'] = self.db_manager.get_workspaces(dataset_id)
                return record
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


        @self.router.post("/api/delete_dataset")
        async def delete_dataset(
            dataset_id: str = Form(...),
        ):
            self._dataset_or_404(dataset_id)
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
