import React, { createContext, useContext, useState, useEffect } from 'react';
import { apiRequests } from './services/api_requests.js';


const StateContext = createContext();

export function State({ children }) {
    const [leftBarIsOpen, setLeftBarIsOpen] = useState(false)
    const [headerCollapsed, setHeaderCollapsed] = useState(false)
    const [wsConnected, setWsConnected] = useState(false)

    const [meta, setMeta] = useState(null)
    const [datasetsList, setDatasetsList] = useState([])

    const [currentDataset, setCurrentDataset] = useState(null)
    const [currentTab, setCurrentTab] = useState("overview")


    useEffect(() => {
        apiRequests.getMeta()
            .then(data => setMeta(data))
            .catch(err => console.error(err));
        apiRequests.getDatasets()
            .then(data => setDatasetsList(data))
            .catch(err => console.error(err));
    }, []);


    // To access the variables from the state threw the navigators console by using _globalState
    useEffect(() => {
        if (typeof window !== 'undefined') {
            window._globalState = {
                leftBarIsOpen, setLeftBarIsOpen,
                headerCollapsed, setHeaderCollapsed,
                wsConnected, setWsConnected,
                meta, setMeta,
                datasetsList, setDatasetsList,
                currentDataset, setCurrentDataset,
                currentTab, setCurrentTab,
            };
        }
    });


    return (
        <StateContext.Provider value={{
            leftBarIsOpen, setLeftBarIsOpen,
            headerCollapsed, setHeaderCollapsed,
            wsConnected, setWsConnected,

            meta, setMeta,
            datasetsList, setDatasetsList,

            currentDataset, setCurrentDataset,
            currentTab, setCurrentTab,
        }}>
            {children}
        </StateContext.Provider>
    );
}

export const GlobalState = () => useContext(StateContext);
