import { useRef, useState } from 'react';
import { uploadSeries, uploadZip } from '../api.js';

export default function UploadPanel({ onUploaded, compact }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [dragOver, setDragOver] = useState(false);

  async function handleFiles(fileList) {
    if (!fileList || !fileList.length) return;
    const files = Array.from(fileList);

    // A single .zip is treated as a whole study (possibly several series,
    // nested folders, extensionless files) and routed to the archive
    // endpoint; anything else goes through the plain multi-file upload,
    // same as before.
    const isSingleZip = files.length === 1 && files[0].name.toLowerCase().endsWith('.zip');

    setBusy(true);
    setMessage(isSingleZip ? 'Uploading archive…' : `Uploading ${files.length} file${files.length > 1 ? 's' : ''}…`);

    try {
      if (isSingleZip) {
        const result = await uploadZip(files[0]);
        setMessage(
          result.skipped
            ? `Found ${result.series.length} series; ${result.skipped} file(s) in the archive weren't DICOM.`
            : `Found ${result.series.length} series.`
        );
        onUploaded(result.series.map((s) => s.seriesId));
      } else {
        const result = await uploadSeries(files);
        setMessage(
          result.skipped
            ? `Stored ${result.sliceCount} slice(s); ${result.skipped} file(s) could not be read as DICOM.`
            : `Stored ${result.sliceCount} slice(s).`
        );
        onUploaded(result.seriesId);
      }
    } catch (err) {
      setMessage(err.message || 'Upload failed.');
    } finally {
      setBusy(false);
    }
  }

  const dragHandlers = {
    onDragOver: (e) => {
      e.preventDefault();
      setDragOver(true);
    },
    onDragLeave: () => setDragOver(false),
    onDrop: (e) => {
      e.preventDefault();
      setDragOver(false);
      handleFiles(e.dataTransfer.files);
    },
  };

  const fileInput = (
    <input
      ref={inputRef}
      type="file"
      multiple
      accept=".dcm,.dicom,.zip,application/dicom,application/zip"
      style={{ display: 'none' }}
      onChange={(e) => {
        handleFiles(e.target.files);
        e.target.value = '';
      }}
    />
  );

  // Once there's already a series list, the full-height onboarding
  // dropzone just pushes most of it below the fold every time - a slim
  // one-line bar keeps drag-and-drop and the file picker available
  // without costing the sidebar all that vertical space. The full
  // friendly version still shows for a first-time/empty library, where
  // it earns its size by explaining what to do.
  if (compact) {
    return (
      <div className={`upload-panel upload-panel-compact${dragOver ? ' drag' : ''}`} {...dragHandlers}>
        <button className="btn" disabled={busy} onClick={() => inputRef.current.click()}>
          {busy ? 'Uploading…' : '+ Add files or .zip'}
        </button>
        {message && <p className="status">{message}</p>}
        {fileInput}
      </div>
    );
  }

  return (
    <div className={`upload-panel${dragOver ? ' drag' : ''}`} {...dragHandlers}>
      <div className="icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M4 4h16v16H4z" />
          <path d="M4 15l4-4 3 3 5-6 4 5" />
        </svg>
      </div>
      <p className="title">Load a series</p>
      <p className="hint">Drag .dcm files or a .zip archive of a whole study here, or select from disk.</p>
      <button className="btn" disabled={busy} onClick={() => inputRef.current.click()}>
        {busy ? 'Uploading…' : 'Choose files'}
      </button>
      {fileInput}
      {message && <p className="status">{message}</p>}
    </div>
  );
}