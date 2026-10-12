import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .DatabaseManager import DatabaseManager
from .WebsocketManager import WebsocketManager
from .RouterManager import RouterManager
from .app.DatasetStore import DatasetStore



class ServerManager:
    def __init__(self, data_path, host='0.0.0.0', port=8010):
        self.data_path = data_path
        self.host = host
        self.port = port

        self.ws_manager = WebsocketManager()
        self.db_manager = DatabaseManager(data_path)
        self.store = DatasetStore(data_path, self.db_manager)
        self.router_manager = RouterManager(self.db_manager, self.ws_manager, self.store)
    
        self.server = self.init_server()


    def init_server(self):
        server = FastAPI()
        server.include_router(self.router_manager.router)

        origins = [
            "http://localhost:8011",
            "http://127.0.0.1:8011",
        ]

        server.add_middleware(
            CORSMiddleware,
            allow_origins=origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )
        return server


    def run(self):
        uvicorn.run(self.server, host=self.host, port=self.port)
