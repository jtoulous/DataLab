import { useEffect, useRef } from "react";
import { GlobalState } from '../State.jsx';
import { HOST, BACKEND_PORT, apiRequests } from './api_requests.js';
import { appEvents } from './events.js';


function WebsocketManager() {
    const state = GlobalState();
    const stateRef = useRef(state);

    useEffect(() => {
        stateRef.current = state;
    });

    useEffect(() => {
        let reconnectTimer = null;
        let retryDelay = 1000;
        let closedByUnmount = false;
        let currentWs = null;

        const connect = () => {
            const ws = new WebSocket(`ws://${HOST}:${BACKEND_PORT}/ws`);
            currentWs = ws;

            ws.onopen = () => {
                retryDelay = 1000;
                stateRef.current.setWsConnected(true);
                apiRequests.getDatasets().then(stateRef.current.setDatasetsList).catch(() => {});
            };

            ws.onclose = () => {
                if (closedByUnmount) return;
                stateRef.current.setWsConnected(false);
                reconnectTimer = setTimeout(connect, retryDelay);
                retryDelay = Math.min(retryDelay * 2, 15000);
            };

            ws.onmessage = (event) => {
                const data = JSON.parse(event.data)

                switch(data.type){

                    case 'datasets_list_update':
                        stateRef.current.setDatasetsList(data.payload.datasets_list);
                        break;

                    case 'dataset_update':
                        appEvents.emit('dataset', data.payload.dataset);
                        break;

                    case 'columns_update':
                        appEvents.emit('columns', data.payload);
                        break;
                }
            };
        };

        connect();

        return () => {
            closedByUnmount = true;
            clearTimeout(reconnectTimer);
            currentWs?.close();
        };
    }, []);

    return null;
}

export default WebsocketManager;
