import { useEffect, useState, useCallback, useMemo } from 'react';
import UploadPanel from './components/UploadPanel.jsx';
import Viewer from './components/Viewer.jsx';
import SeriesThumb from './components/SeriesThumb.jsx';
import { listSeries, deleteSeries } from './api.js';

const THEME_KEY = 'dicom-viewer-theme';
const FOLDER_NAMES_KEY = 'dicom-viewer-folder-names';

function loadFolderNames() {
  try {
    return JSON.parse(localStorage.getItem(FOLDER_NAMES_KEY)) || {};
  } catch {
    return {};
  }
}

export default function App() {
  const [seriesList, setSeriesList] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [error, setError] = useState('');
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || 'dark');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // Custom folder display names, keyed by patient key (patient_id, or
  // patient_name, or "__unknown__" - same key used for grouping below).
  // Kept client-side in localStorage rather than as a backend/DB field:
  // it's a per-user display preference, not clinical data, and this
  // avoids a schema change for something this simple.
  const [folderNames, setFolderNames] = useState(loadFolderNames);
  const [renamingKey, setRenamingKey] = useState(null);
  // Compare-mode selection is scoped to a single folder at a time -
  // picking a checkbox in a different folder resets the selection, so
  // there's never an ambiguous "comparing series from two different
  // patients" state.
  const [compareSelection, setCompareSelection] = useState({ folderKey: null, ids: [] });
  const [compareActive, setCompareActive] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(FOLDER_NAMES_KEY, JSON.stringify(folderNames));
  }, [folderNames]);

  const refresh = useCallback(() => {
    listSeries()
      .then(setSeriesList)
      .catch((err) => setError(err.message || 'Failed to load series list.'));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleDeleteSeries(id, e) {
    e.stopPropagation();
    if (!window.confirm('Delete this series and its files?')) return;
    await deleteSeries(id);
    if (activeId === id) setActiveId(null);
    setCompareSelection((prev) => ({ ...prev, ids: prev.ids.filter((x) => x !== id) }));
    refresh();
  }

  async function handleDeleteFolder(folder, e) {
    e.stopPropagation();
    const count = folder.series.length;
    if (!window.confirm(`Delete this whole folder - ${count} series and all of their slices? This can't be undone.`)) return;
    await Promise.all(folder.series.map((s) => deleteSeries(s.id)));
    if (folder.series.some((s) => s.id === activeId)) setActiveId(null);
    if (compareSelection.folderKey === folder.key) setCompareSelection({ folderKey: null, ids: [] });
    refresh();
  }

  function toggleCompare(folderKey, seriesId, e) {
    e.stopPropagation();
    setCompareSelection((prev) => {
      if (prev.folderKey !== folderKey) return { folderKey, ids: [seriesId] };
      const exists = prev.ids.includes(seriesId);
      if (exists) return { folderKey, ids: prev.ids.filter((id) => id !== seriesId) };
      if (prev.ids.length >= 6) return prev; // cap at 6 panels on screen at once
      return { folderKey, ids: [...prev.ids, seriesId] };
    });
  }

  // Group series into one folder per patient (by patient_id, falling
  // back to patient_name, falling back to upload_id (one id per import -
  // a single zip, or a single loose-file upload) when BOTH patient tags
  // are blank, which de-identified research exports commonly are -
  // without this fallback, two entirely different imports with equally
  // blank patient tags used to collapse into the same "Unknown patient"
  // folder. Preserves the list's existing order (newest upload first)
  // both across and within folders.
  const patientFolders = useMemo(() => {
    const folders = [];
    const byKey = new Map();
    for (const s of seriesList) {
      const key = s.patient_id || s.patient_name || s.upload_id || '__unknown__';
      let folder = byKey.get(key);
      if (!folder) {
        folder = {
          key,
          patientId: s.patient_id,
          patientName: s.patient_name,
          uploadName: s.upload_name,
          series: [],
        };
        byKey.set(key, folder);
        folders.push(folder);
      }
      folder.series.push(s);
    }
    return folders;
  }, [seriesList]);

  // 2 columns up to 4 panels, 3 columns for 5-6 - see the inline comment
  // on the grid itself below for why.
  const compareCount = Math.min(compareSelection.ids.length, 6);
  const compareCols = compareCount <= 4 ? 2 : 3;
  const compareRows = Math.max(1, Math.ceil(compareCount / compareCols));

  return (
    <div className="app">
      <header>
        <div className="header-left">
          <div className="brand">
            <span className="dot" />
            <h1>Series Viewer</h1>
          </div>
          <button
            className="btn sidebar-toggle"
            onClick={() => setSidebarCollapsed((v) => !v)}
            title={sidebarCollapsed ? 'Show series list' : 'Hide series list'}
          >
            {sidebarCollapsed ? '☰ Show list' : '◂ Hide list'}
          </button>
        </div>
        <button
          className="btn theme-toggle"
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? '☀ Light' : '☾ Dark'}
        </button>
      </header>

      <main style={sidebarCollapsed ? { gridTemplateColumns: '1fr' } : undefined}>
        {!sidebarCollapsed && (
        <aside className="library">
          <UploadPanel
            compact={seriesList.length > 0}
            onUploaded={({ ids }) => {
              // upload_name is now persisted server-side per series (see
              // backend/app/main.py's _ingest_series) and used directly as
              // the folder's default display name in the grouping above -
              // no need to separately look it up and cache it here the
              // way this used to work.
              if (ids.length) setActiveId(ids[0]);
              refresh();
            }}
          />
          <div className="library-list">
            <h2>SERIES</h2>
            {error && <p className="status error">{error}</p>}
            {seriesList.length === 0 && <p className="hint">No series uploaded yet.</p>}
            {patientFolders.map((folder) => {
              const displayName = folderNames[folder.key] || folder.patientName || folder.uploadName || 'Unknown patient';
              const isRenaming = renamingKey === folder.key;
              const selection = compareSelection.folderKey === folder.key ? compareSelection.ids : [];

              return (
                <details key={folder.key} className="patient-folder" open>
                  <summary className="patient-folder-summary">
                    <svg className="folder-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
                    </svg>
                    {isRenaming ? (
                      <input
                        className="folder-rename-input"
                        autoFocus
                        defaultValue={displayName}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') e.currentTarget.blur();
                          if (e.key === 'Escape') setRenamingKey(null);
                        }}
                        onBlur={(e) => {
                          const next = e.target.value.trim();
                          setFolderNames((prev) => ({ ...prev, [folder.key]: next || displayName }));
                          setRenamingKey(null);
                        }}
                      />
                    ) : (
                      <span className="patient-name">{displayName}</span>
                    )}
                    {folder.patientId && <span className="patient-id">{folder.patientId}</span>}
                    <span className="patient-count">{folder.series.length}</span>
                    <button
                      className="folder-action"
                      title="Rename folder"
                      onClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        setRenamingKey(folder.key);
                      }}
                    >
                      ✎
                    </button>
                    <button
                      className="folder-action folder-action-danger"
                      title="Delete folder (all series inside)"
                      onClick={(e) => handleDeleteFolder(folder, e)}
                    >
                      🗑
                    </button>
                  </summary>

                  {selection.length >= 2 && (
                    <button
                      className="btn compare-trigger"
                      onClick={() => setCompareActive(true)}
                    >
                      Compare {selection.length} series side-by-side
                    </button>
                  )}

                  <div className="patient-folder-series">
                    {folder.series.map((s) => (
                      <div
                        key={s.id}
                        className={`library-item${s.id === activeId ? ' active' : ''}`}
                        onClick={() => {
                          setActiveId(s.id);
                          setCompareActive(false);
                        }}
                      >
                        <input
                          type="checkbox"
                          className="compare-checkbox"
                          checked={selection.includes(s.id)}
                          disabled={selection.length >= 6 && !selection.includes(s.id)}
                          onClick={(e) => toggleCompare(folder.key, s.id, e)}
                          onChange={() => {}}
                          title={
                            selection.length >= 6 && !selection.includes(s.id)
                              ? 'Up to 6 series can be compared at once'
                              : 'Select for side-by-side comparison'
                          }
                        />
                        <SeriesThumb sliceId={s.thumbnail_slice_id} />
                        <div className="li-main">
                          <span className="li-title">
                            {s.series_description || s.modality || `Series ${s.id}`}
                            {s.is_secondary_capture && (
                              <span
                                className="report-badge"
                                title="A pre-rendered report/summary image, not an original scan slice"
                              >
                                REPORT
                              </span>
                            )}
                          </span>
                          <span className="li-sub">{s.modality ? `${s.modality} · ` : ''}{s.slice_count} img{s.slice_count === 1 ? '' : 's'}</span>
                          <span className="li-sub li-date">{s.study_date || 'no date'}</span>
                        </div>
                        <button className="li-delete" onClick={(e) => handleDeleteSeries(s.id, e)} title="Delete series">
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                </details>
              );
            })}
          </div>
        </aside>
        )}

        <section className="stage">
          {compareActive && compareSelection.ids.length >= 2 ? (
            <div className="compare-grid">
              <div className="compare-toolbar">
                <span>Comparing {compareSelection.ids.length} series</span>
                <button className="btn" onClick={() => setCompareActive(false)}>
                  Close comparison
                </button>
              </div>
              <div
                className="compare-panels"
                style={{
                  // 2 columns for 2-4 panels, 3 columns for 5-6 - keeps
                  // every panel a reasonable size and fits the whole grid
                  // on screen without scrolling, rather than a fixed
                  // column count that leaves 5-6 panels too cramped or
                  // running off the bottom of the screen.
                  gridTemplateColumns: `repeat(${compareCols}, 1fr)`,
                  gridTemplateRows: `repeat(${compareRows}, 1fr)`,
                }}
              >
                {compareSelection.ids.map((id) => {
                  const s = seriesList.find((x) => x.id === id);
                  return (
                    <div className="compare-panel" key={id}>
                      <div className="compare-panel-label">{s?.series_description || s?.modality || `Series ${id}`}</div>
                      <div className="compare-panel-body">
                        <Viewer seriesId={id} compact />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <Viewer seriesId={activeId} />
          )}
        </section>
      </main>
    </div>
  );
}
