import React, { useState, useRef } from "react";
import "./FileDropZone.css";

function FileDropZone({ accept = ".csv", onFileSelect, onFilesSelect, multiple = false, required = false, label }) {
    const [isDragging, setIsDragging] = useState(false);
    const [fileName, setFileName] = useState(null);
    const inputRef = useRef(null);

    const handleFile = (file) => {
        if (!file) return;
        setFileName(file.name);
        onFileSelect(file);
    };

    const handleDrop = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);
        if (multiple && onFilesSelect) {
            const files = Array.from(e.dataTransfer?.files || []);
            if (files.length) onFilesSelect(files);
            return;
        }
        const file = e.dataTransfer?.files?.[0];
        if (file) handleFile(file);
    };

    const handleDragOver = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(true);
    };

    const handleDragLeave = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);
    };

    const handleClick = () => inputRef.current?.click();

    const handleInputChange = (e) => {
        if (multiple && onFilesSelect) {
            const files = Array.from(e.target.files || []);
            if (files.length) onFilesSelect(files);
            e.target.value = '';
            return;
        }
        handleFile(e.target.files?.[0]);
    };

    const handleRemove = (e) => {
        e.stopPropagation();
        setFileName(null);
        onFileSelect(null);
        if (inputRef.current) inputRef.current.value = "";
    };

    return (
        <div
            className={`fdz-zone ${isDragging ? 'fdz-dragging' : ''} ${fileName ? 'fdz-has-file' : ''}`}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onClick={handleClick}
        >
            <input
                ref={inputRef}
                type="file"
                accept={accept}
                multiple={multiple}
                onChange={handleInputChange}
                required={required && !fileName}
                className="fdz-hidden-input"
            />

            {fileName ? (
                <div className="fdz-file-info">
                    <svg className="fdz-file-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                        <line x1="16" y1="13" x2="8" y2="13"/>
                        <line x1="16" y1="17" x2="8" y2="17"/>
                    </svg>
                    <span className="fdz-file-name">{fileName}</span>
                    <button type="button" className="fdz-remove-btn" onClick={handleRemove}>
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                </div>
            ) : (
                <div className="fdz-placeholder">
                    <svg className="fdz-upload-icon" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                        <polyline points="17 8 12 3 7 8"/>
                        <line x1="12" y1="3" x2="12" y2="15"/>
                    </svg>
                    <span className="fdz-text">{label || <>Drop a <strong>{accept}</strong> file or <span className="fdz-browse">browse</span></>}</span>
                </div>
            )}
        </div>
    );
}

export { FileDropZone };
