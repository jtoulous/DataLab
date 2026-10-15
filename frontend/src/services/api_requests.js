/*===========================================*/
/*===========================================*/
/*              Backend info             ====*/

export const   PROTOCOL = 'http'
export const   HOST = window.location.hostname || 'localhost'
export const   BACKEND_PORT = 8010

const   BASE_URL = `${PROTOCOL}://${HOST}:${BACKEND_PORT}`

/*                                       ====*/
/*===========================================*/
/*===========================================*/


// Remonte le message d'erreur du backend (HTTPException.detail) plutot qu'un message generique
const handleResponse = async (res, errorMessage) => {
    if (!res.ok) {
        let detail = '';
        try {
            const body = await res.json();
            detail = body?.detail ? body.detail : '';
        } catch {
            detail = '';
        }
        throw new Error(detail || errorMessage);
    }
    return res.json();
};

const buildForm = (fields) => {
    const formData = new FormData();
    Object.entries(fields).forEach(([key, value]) => {
        if (value === undefined || value === null) return;
        formData.append(key, typeof value === 'object' && !(value instanceof File) ? JSON.stringify(value) : value);
    });
    return formData;
};

const post = (path, fields, errorMessage) => fetch(`${BASE_URL}${path}`, { method: 'POST', body: buildForm(fields) })
    .then((res) => handleResponse(res, errorMessage));



export const apiRequests = {

/*===============================================================================================*/
/*===============================================================================================*/
/*====                                      GET Methods                                      ====*/

    getMeta: () => {
        return fetch(`${BASE_URL}/api/get_meta`)
            .then((res) => handleResponse(res, "Error getting metadata"));
    },

    getDatasets: () => {
        return fetch(`${BASE_URL}/api/get_datasets`)
            .then((res) => handleResponse(res, "Error getting datasets"));
    },

    getDataset: (dataset_id) => {
        const url = new URL(`${BASE_URL}/api/get_dataset`);
        url.searchParams.append("dataset_id", dataset_id);
        return fetch(url)
            .then((res) => handleResponse(res, "Error getting dataset"));
    },

    getWorkspace: (dataset_id, name) => {
        const url = new URL(`${BASE_URL}/api/get_workspace`);
        url.searchParams.append("dataset_id", dataset_id);
        url.searchParams.append("name", name);
        return fetch(url)
            .then((res) => handleResponse(res, "Error loading workspace"));
    },

    getExportUrl: (dataset_id, columns, view) => {
        const url = new URL(`${BASE_URL}/api/export_csv`);
        url.searchParams.append("dataset_id", dataset_id);
        if (columns) url.searchParams.append("columns", JSON.stringify(columns));
        if (view) url.searchParams.append("view", JSON.stringify(view));
        return url.toString();
    },


/*===============================================================================================*/
/*===============================================================================================*/
/*====                                      POST Methods                                     ====*/

    /*====================    Datasets    ====================*/

    uploadDataset: (file, name = null) => post('/api/upload_dataset', { datafile: file, name }, "Error uploading file"),

    importPath: (path, name = null) => post('/api/import_path', { path, name }, "Error importing file"),

    updateDataset: (dataset_id, { name, description, type_overrides, time_column } = {}) =>
        post('/api/update_dataset', { dataset_id, name, description, type_overrides, time_column }, "Error updating dataset"),

    updateView: (dataset_id, view_settings) => post('/api/update_view', { dataset_id, view_settings }, "Invalid view settings"),

    previewSubset: (dataset_id, spec) => post('/api/preview_subset', { dataset_id, spec }, "Selection error"),
    createSubset: (dataset_id, name, spec, description = '') => post('/api/create_subset', { dataset_id, name, spec, description }, "Error creating subset"),
    getSavedModels: (dataset_id) => fetch(`${BASE_URL}/api/model/saved?dataset_id=${encodeURIComponent(dataset_id)}`).then(res => handleResponse(res, "Error loading models")),
    predictPreview: (dataset_id, run_id, model_key, output, threshold) => post('/api/model/predict_preview', { dataset_id, run_id, model_key, output, threshold }, "Prediction error"),
    predictColumn: (dataset_id, fields) => post('/api/model/predict_column', { dataset_id, ...fields }, "Error creating the column"),
    deleteFrozen: (dataset_id, name) => post('/api/delete_frozen', { dataset_id, name }, "Error deleting column"),
    previewResample: (dataset_id, spec) => post('/api/preview_resample', { dataset_id, spec }, "Resample error"),
    createResample: (dataset_id, name, spec, description = '') => post('/api/create_resample', { dataset_id, name, spec, description }, "Error creating the resampled dataset"),
    previewAggregate: (dataset_id, source_id, convention) => post('/api/preview_aggregate', { dataset_id, source_id, convention }, "Aggregation error"),
    createAggregate: (dataset_id, source_id, items, convention) => post('/api/create_aggregate', { dataset_id, source_id, items, convention }, "Error creating the columns"),
    previewFirstTouch: (dataset_id, spec) => post('/api/preview_first_touch', { dataset_id, spec }, "First touch error"),
    createFirstTouch: (dataset_id, spec) => post('/api/create_first_touch', { dataset_id, spec }, "Error creating the label column"),
    getJobs: (dataset_id) => fetch(`${BASE_URL}/api/jobs?dataset_id=${encodeURIComponent(dataset_id)}`).then(res => handleResponse(res, "Error loading jobs")),
    deleteDataset: (dataset_id) => post('/api/delete_dataset', { dataset_id }, "Error deleting dataset"),


    /*====================    Columns    ====================*/

    previewFormula: (dataset_id, formula, view) => post('/api/preview_formula', { dataset_id, formula, view }, "Formula error"),

    saveColumn: (dataset_id, { name, formula, description }) => post('/api/save_column', { dataset_id, name, formula, description }, "Error saving column"),

    getSavedFormulas: () => fetch(`${BASE_URL}/api/saved_formulas`).then(res => handleResponse(res, "Error loading saved formulas")),
    saveFormula: ({ name, formula, description }) => post('/api/save_formula', { name, formula, description }, "Error saving the formula"),
    deleteFormula: (name) => post('/api/delete_formula', { name }, "Error deleting the formula"),
    deleteColumn: (dataset_id, name) => post('/api/delete_column', { dataset_id, name }, "Error deleting column"),


    /*====================    Analyses    ====================*/

    analyze: (dataset_id, analysis, params, view) => post('/api/analyze', { dataset_id, analysis, params, view }, "Analysis error"),


    /*====================    Modeling    ====================*/

    getModelCatalog: () => {
        return fetch(`${BASE_URL}/api/model/catalog`)
            .then((res) => handleResponse(res, "Error getting model catalog"));
    },

    modelPreview: (dataset_id, config, view) => post('/api/model/preview', { dataset_id, config, view }, "Invalid model setup"),

    runModels: (dataset_id, config, view, name) => post('/api/model/run', { dataset_id, config, view, name }, "Error starting the run"),

    cancelModelRun: (run_id) => post('/api/model/cancel', { run_id }, "Error cancelling the run"),

    renameModelRun: (run_id, name) => post('/api/model/rename_run', { run_id, name }, "Error renaming the run"),
    deleteModelRun: (run_id) => post('/api/model/delete_run', { run_id }, "Error deleting the run"),

    getModelRuns: (dataset_id) => {
        const url = new URL(`${BASE_URL}/api/model/runs`);
        url.searchParams.append("dataset_id", dataset_id);
        return fetch(url)
            .then((res) => handleResponse(res, "Error getting model runs"));
    },

    getModelResult: (run_id, model_key) => {
        const url = new URL(`${BASE_URL}/api/model/result`);
        url.searchParams.append("run_id", run_id);
        url.searchParams.append("model_key", model_key);
        return fetch(url)
            .then((res) => handleResponse(res, "Error getting model result"));
    },


    /*====================    Workspaces    ====================*/

    saveWorkspace: (dataset_id, name, config) => post('/api/save_workspace', { dataset_id, name, config }, "Error saving workspace"),

    deleteWorkspace: (dataset_id, name) => post('/api/delete_workspace', { dataset_id, name }, "Error deleting workspace"),
};
