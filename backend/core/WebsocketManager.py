from fastapi import WebSocket
from typing import List
import json


class WebsocketManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []
    

    async def connect(self, websocket: WebSocket):
        """Connecte un websocket"""
        await websocket.accept()
        self.active_connections.append(websocket)
        print(f"WebSocket connected. Total: {len(self.active_connections)}")


    def disconnect(self, websocket: WebSocket):
        """Déconnecte un websocket"""
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
            print(f"WebSocket disconnected. Remaining: {len(self.active_connections)}")


    async def broadcast(self, message: dict):
        """Balance le message à tous les clients connectés"""
        message_str = json.dumps(message)
        disconnected = []
        
        for websocket in list(self.active_connections):
            try:
                await websocket.send_text(message_str)
            except Exception:
                disconnected.append(websocket)
        
        for websocket in disconnected:
            self.disconnect(websocket)


    async def datasets_list_update(self, datasets_list):
        await self.broadcast({
            "type": "datasets_list_update",
            "payload": {
                "datasets_list": datasets_list
            }
        })

    async def dataset_update(self, dataset):
        await self.broadcast({
            "type": "dataset_update",
            "payload": {
                "dataset": dataset
            }
        })

    async def columns_update(self, dataset_id, columns):
        await self.broadcast({
            "type": "columns_update",
            "payload": {
                "dataset_id": dataset_id,
                "columns": columns
            }
        })
