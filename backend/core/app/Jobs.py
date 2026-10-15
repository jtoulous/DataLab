import time
import asyncio
import secrets
import traceback

from .Engine import FormulaError
from .DataLoader import LoadError



class JobManager:
    """
    Taches longues (creation d'un dataset derive sur ~1 M de lignes...) executees dans un thread,
    progression diffusee par WebSocket : {"type": "job_update", "payload": {job_id, kind, dataset_id, status,
    progress, error, result}}. Les taches en cours sont listees pour qu'une page rechargee les retrouve.
    """

    def __init__(self, ws_manager):
        self.ws_manager = ws_manager
        self.jobs = {}

    def list(self, dataset_id=None):
        return [self._public(j) for j in self.jobs.values() if dataset_id is None or j['dataset_id'] == dataset_id]

    @staticmethod
    def _public(job):
        return {k: job[k] for k in ('job_id', 'kind', 'dataset_id', 'label', 'status', 'progress', 'error', 'result', 'started')}

    async def start(self, kind, dataset_id, label, fn, on_done=None):
        """fn(progress) s'execute dans un thread et renvoie le resultat (ex : id du dataset cree)."""
        job_id = secrets.token_hex(4)
        job = {'job_id': job_id, 'kind': kind, 'dataset_id': dataset_id, 'label': label, 'status': 'running',
               'progress': {'done': 0, 'total': 1, 'label': 'starting'}, 'error': None, 'result': None, 'started': time.time()}
        self.jobs[job_id] = job
        loop = asyncio.get_running_loop()
        asyncio.create_task(self._run(job, fn, on_done, loop))
        await self._broadcast(job)
        return job_id

    async def _run(self, job, fn, on_done, loop):
        last_sent = [0.0]

        def progress(done, total, label):
            job['progress'] = {'done': done, 'total': max(1, total), 'label': label}
            now = time.monotonic()
            if now - last_sent[0] > 0.3:
                last_sent[0] = now
                asyncio.run_coroutine_threadsafe(self._broadcast(job), loop)

        try:
            job['result'] = await asyncio.to_thread(fn, progress)
            job['status'] = 'done'
            if on_done:
                await on_done(job['result'])
        except (FormulaError, LoadError) as error:
            job['status'], job['error'] = 'error', str(error)
        except Exception as error:
            print(f'job {job["kind"]} {job["job_id"]} ===> ERROR: {type(error).__name__}: {error}\n{traceback.format_exc()}', flush=True)
            job['status'], job['error'] = 'error', f'{type(error).__name__}: {error}'
        await self._broadcast(job)
        # une tache finie reste visible un moment (page rechargee pendant la fin), puis disparait
        await asyncio.sleep(120)
        self.jobs.pop(job['job_id'], None)

    async def _broadcast(self, job):
        await self.ws_manager.broadcast({'type': 'job_update', 'payload': self._public(job)})
