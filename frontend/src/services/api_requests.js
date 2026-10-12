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

    deleteDataset: (dataset_id) => post('/api/delete_dataset', { dataset_id }, "Error deleting dataset"),


    /*====================    Columns    ====================*/

    previewFormula: (dataset_id, formula, view) => post('/api/preview_formula', { dataset_id, formula, view }, "Formula error"),

    saveColumn: (dataset_id, { name, formula, description }) => post('/api/save_column', { dataset_id, name, formula, description }, "Error saving column"),

    deleteColumn: (dataset_id, name) => post('/api/delete_column', { dataset_id, name }, "Error deleting column"),


    /*====================    Analyses    ====================*/

    analyze: (dataset_id, analysis, params, view) => post('/api/analyze', { dataset_id, analysis, params, view }, "Analysis error"),


    /*====================    Workspaces    ====================*/

    saveWorkspace: (dataset_id, name, config) => post('/api/save_workspace', { dataset_id, name, config }, "Error saving workspace"),

    deleteWorkspace: (dataset_id, name) => post('/api/delete_workspace', { dataset_id, name }, "Error deleting workspace"),
};
