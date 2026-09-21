import { useEffect, useState, useCallback } from 'react';
import UploadPanel from './components/UploadPanel.jsx';
import Viewer from './components/Viewer.jsx';
import SeriesThumb from './components/SeriesThumb.jsx';
import { listSeries, deleteSeries } from './api.js';

const THEME_KEY = 'dicom-viewer-theme';

export default function App() {
  const [seriesList, setSeriesList] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [error, setError] = useState('');
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || 'dark');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  const refresh = useCallback(() => {
    listSeries()
      .then(setSeriesList)
      .catch((err) => setError(err.message || 'Failed to load series list.'));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleDelete(id, e) {
    e.stopPropagation();
    if (!window.confirm('Delete this series and its files?')) return;
    await deleteSeries(id);
    if (activeId === id) setActiveId(null);
    refresh();
  }

  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="dot" />
          <h1>Series Viewer</h1>
        </div>
        <button
          className="btn theme-toggle"
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? '☀ Light' : '☾ Dark'}
        </button>
      </header>

      <main>
        <aside className="library">
          <UploadPanel
            compact={seriesList.length > 0}
            onUploaded={(idOrIds) => {
              // A loose-file upload reports one series id; a .zip archive
              // can contain several, reported as an array - either way,
              // make the first (or only) one active and refresh the list.
              const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
              if (ids.length) setActiveId(ids[0]);
              refresh();
            }}
          />
          <div className="library-list">
            <h2>SERIES</h2>
            {error && <p className="status error">{error}</p>}
            {seriesList.length === 0 && <p className="hint">No series uploaded yet.</p>}
            {seriesList.map((s) => (
              <div key={s.id} className={`library-item${s.id === activeId ? ' active' : ''}`} onClick={() => setActiveId(s.id)}>
                <SeriesThumb sliceId={s.thumbnail_slice_id} />
                <div className="li-main">
                  <span className="li-title">{s.series_description || s.modality || `Series ${s.id}`}</span>
                  <span className="li-sub">{s.modality ? `${s.modality} · ` : ''}{s.slice_count} img{s.slice_count === 1 ? '' : 's'}</span>
                  <span className="li-sub li-date">{s.study_date || 'no date'}</span>
                </div>
                <button className="li-delete" onClick={(e) => handleDelete(s.id, e)} title="Delete series">
                  ×
                </button>
              </div>
            ))}
          </div>
        </aside>

        <section className="stage">
          <Viewer seriesId={activeId} />
        </section>
      </main>
    </div>
  );
}