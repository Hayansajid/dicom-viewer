import { useEffect, useRef, useState, useCallback } from "react";
import {
  getSeriesDetail,
  fetchSlicePixels,
  fetchStrokeOverlay,
} from "../api.js";
import { toImageData, computeFallbackWindow } from "../dicomRender.js";

const WINDOW_PRESETS = [
  { label: "Brain", wc: 40, ww: 80 },
  { label: "Soft tissue", wc: 40, ww: 400 },
  { label: "Lung", wc: -600, ww: 1500 },
  { label: "Bone", wc: 480, ww: 2500 },
  { label: "Liver", wc: 60, ww: 160 },
  { label: "Mediastinum", wc: 50, ww: 350 },
];

export default function Viewer({ seriesId, compact }) {
  const [detail, setDetail] = useState(null);
  const [slices, setSlices] = useState([]);
  const [index, setIndex] = useState(0);
  const [manualWindow, setManualWindow] = useState(false);
  const [wc, setWc] = useState(0);
  const [ww, setWw] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showCompactControls, setShowCompactControls] = useState(false);
  const [showOverlay, setShowOverlay] = useState(false);
  const [overlayData, setOverlayData] = useState(null);
  const [overlayLoading, setOverlayLoading] = useState(false);

  const canvasRef = useRef(null);
  const stageRef = useRef(null);
  const thumbRefs = useRef([]);
  const overlayCacheRef = useRef(new Map());

  const isDragging = useRef(false);
  const dragOrigin = useRef({ x: 0, y: 0 });
  const dragStart = useRef({ wc: 0, ww: 0 });

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function handleMouseDown(e) {
    if (e.button !== 0) return;
    const slice = slices[index];
    if (!slice || slice.error) return;
    isDragging.current = true;
    dragOrigin.current = { x: e.clientX, y: e.clientY };
    dragStart.current = {
      wc: manualWindow ? wc : slice.wc,
      ww: manualWindow ? ww : slice.ww,
    };
  }

  function handleMouseMove(e) {
    if (!isDragging.current) return;
    const slice = slices[index];
    if (!slice || slice.error) return;

    const dx = e.clientX - dragOrigin.current.x;
    const dy = e.clientY - dragOrigin.current.y;

    const pMin = slice.pixelMin ?? 0;
    const pMax = slice.pixelMax ?? 255;
    const fullSpan = Math.max(1, pMax - pMin);
    const sensitivity = fullSpan / 300;

    const nextWw = clamp(
      dragStart.current.ww + dx * sensitivity,
      1,
      fullSpan * 4,
    );
    const nextWc = clamp(
      dragStart.current.wc - dy * sensitivity,
      pMin - fullSpan,
      pMax + fullSpan,
    );

    setManualWindow(true);
    setWw(nextWw);
    setWc(nextWc);
  }

  function handleMouseUp() {
    isDragging.current = false;
  }

  const processFrame = (frame, meta) => {
    const fallback = computeFallbackWindow(frame);
    const hasStoredWindow =
      meta.window_center != null && meta.window_width != null;

    return {
      ...frame,
      wc: hasStoredWindow ? meta.window_center : fallback.wc,
      ww: hasStoredWindow ? meta.window_width : fallback.ww,
      pixelMin: fallback.min,
      pixelMax: fallback.max,
    };
  };

  const loadSeriesData = useCallback(async () => {
    if (!seriesId) return;
    setLoading(true);
    setError("");
    try {
      const d = await getSeriesDetail(seriesId);
      setDetail(d);

      const loadedSlices = new Array(d.slices.length).fill(null);

      if (d.slices.length > 0) {
        try {
          const firstFrame = await fetchSlicePixels(d.slices[0].id);
          loadedSlices[0] = processFrame(firstFrame, d.slices[0]);
          setSlices([...loadedSlices]);
        } catch (err) {
          loadedSlices[0] = { error: true, message: err.message };
          setSlices([...loadedSlices]);
        }
      }

      const concurrency = 5;
      const remainingIndices = Array.from(
        { length: d.slices.length - 1 },
        (_, i) => i + 1,
      );

      const runWorker = async () => {
        while (remainingIndices.length > 0) {
          const i = remainingIndices.shift();
          try {
            const frame = await fetchSlicePixels(d.slices[i].id);
            loadedSlices[i] = processFrame(frame, d.slices[i]);
          } catch (err) {
            loadedSlices[i] = { error: true, message: err.message };
          }
          setSlices([...loadedSlices]);
        }
      };

      const workers = Array.from(
        { length: Math.min(concurrency, remainingIndices.length) },
        () => runWorker(),
      );
      await Promise.all(workers);
    } catch (err) {
      setError(err.message || "Failed to load series.");
    } finally {
      setLoading(false);
    }
  }, [seriesId]);

  useEffect(() => {
    setDetail(null);
    setSlices([]);
    setIndex(0);
    setShowOverlay(false);
    setOverlayData(null);
    overlayCacheRef.current.clear();
    loadSeriesData();
  }, [seriesId, loadSeriesData]);

  const applyDisplaySize = useCallback((canvas, slice) => {
    const container = stageRef.current;
    if (!container || !canvas || !slice) return;
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    if (!cw || !ch) return;
    const imgAspect = slice.cols / slice.rows;
    const boxAspect = cw / ch;
    let w, h;
    if (imgAspect > boxAspect) {
      w = cw;
      h = cw / imgAspect;
    } else {
      h = ch;
      w = ch * imgAspect;
    }
    canvas.style.width = `${Math.floor(w)}px`;
    canvas.style.height = `${Math.floor(h)}px`;
  }, []);

  const draw = useCallback(
    (slice, wcOverride, wwOverride) => {
      const canvas = canvasRef.current;
      if (!slice || slice.error || !canvas) return;
      const ctx = canvas.getContext("2d");
      canvas.width = slice.cols;
      canvas.height = slice.rows;
      const useWc = wcOverride ?? slice.wc;
      const useWw = wwOverride ?? slice.ww;
      const imgData = toImageData(ctx, slice, useWc, useWw);
      ctx.putImageData(imgData, 0, 0);

      if (showOverlay && overlayData) {
        const drawPolygons = (polygons, fill, stroke) => {
          if (!polygons || !polygons.length) return;
          for (const pts of polygons) {
            if (!pts || pts.length < 3) continue;
            ctx.beginPath();
            ctx.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length; i++)
              ctx.lineTo(pts[i][0], pts[i][1]);
            ctx.closePath();
            ctx.fillStyle = fill;
            ctx.strokeStyle = stroke;
            ctx.lineWidth = 1.5;
            ctx.fill();
            ctx.stroke();
          }
        };
        drawPolygons(
          overlayData.penumbra,
          "rgba(255, 255, 0, 0.35)",
          "rgba(255, 220, 0, 0.95)",
        );
        drawPolygons(
          overlayData.core,
          "rgba(255, 0, 0, 0.35)",
          "rgba(255, 60, 60, 0.95)",
        );
      }

      applyDisplaySize(canvas, slice);

      canvas.style.display = "none";
      void canvas.offsetHeight;
      canvas.style.display = "";
    },
    [applyDisplaySize, showOverlay, overlayData],
  );

  const currentSlice = slices[index];

  // Fetch overlay for the current slice — cache-first, then network.
  useEffect(() => {
    const sliceId = detail?.slices?.[index]?.id;
    if (!showOverlay || !sliceId) {
      setOverlayData(null);
      setOverlayLoading(false);
      return;
    }
    if (overlayCacheRef.current.has(sliceId)) {
      setOverlayData(overlayCacheRef.current.get(sliceId));
      setOverlayLoading(false);
      return;
    }
    let cancelled = false;
    setOverlayLoading(true);
    setOverlayData(null);
    fetchStrokeOverlay(sliceId)
      .then((data) => {
        if (cancelled) return;
        overlayCacheRef.current.set(sliceId, data);
        setOverlayData(data);
      })
      .catch(() => {
        if (!cancelled) setOverlayData(null);
      })
      .finally(() => {
        if (!cancelled) setOverlayLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showOverlay, detail, index]);

  useEffect(() => {
    function reapply() {
      requestAnimationFrame(() => {
        const canvas = canvasRef.current;
        if (canvas && currentSlice && !currentSlice.error) {
          applyDisplaySize(canvas, currentSlice);
        }
      });
    }
    window.addEventListener("resize", reapply);
    document.addEventListener("fullscreenchange", reapply);
    return () => {
      window.removeEventListener("resize", reapply);
      document.removeEventListener("fullscreenchange", reapply);
    };
  }, [currentSlice, applyDisplaySize]);

  useEffect(() => {
    const container = stageRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      const canvas = canvasRef.current;
      if (canvas && currentSlice && !currentSlice.error) {
        applyDisplaySize(canvas, currentSlice);
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [currentSlice, applyDisplaySize]);

  useEffect(() => {
    if (!currentSlice || currentSlice.error) return;
    if (!manualWindow) {
      setWc(currentSlice.wc);
      setWw(currentSlice.ww);
    }
    draw(
      currentSlice,
      manualWindow ? wc : currentSlice.wc,
      manualWindow ? ww : currentSlice.ww,
    );
    thumbRefs.current[index]?.scrollIntoView({
      inline: "center",
      block: "nearest",
      behavior: "smooth",
    });
  }, [index, currentSlice, draw]);

  useEffect(() => {
    if (currentSlice && !currentSlice.error) draw(currentSlice, wc, ww);
  }, [wc, ww, draw, currentSlice]);

  function goTo(i) {
    if (!detail) return;
    const clamped = Math.max(0, Math.min(detail.slices.length - 1, i));
    setIndex(clamped);

    if (!slices[clamped] && detail.slices[clamped]) {
      fetchSlicePixels(detail.slices[clamped].id).then((frame) => {
        setSlices((prev) => {
          const updated = [...prev];
          updated[clamped] = processFrame(frame, detail.slices[clamped]);
          return updated;
        });
      });
    }
  }

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    function onWheel(e) {
      if (!detail || !detail.slices.length) return;
      e.preventDefault();
      goTo(index + (e.deltaY > 0 ? 1 : -1));
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [index, detail]);

  useEffect(() => {
    function onKey(e) {
      if (!detail || !detail.slices.length) return;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") goTo(index + 1);
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") goTo(index - 1);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [index, detail]);

  if (!seriesId) {
    return (
      <div className="empty-viewer">
        <p>
          Select a series from the list, or load a new one, to start viewing.
        </p>
      </div>
    );
  }

  if (error) return <div className="empty-viewer error">{error}</div>;
  if (!detail) return <div className="empty-viewer">Loading series…</div>;

  const s = detail.series;
  const currentMeta = detail.slices[index];

  const windowControlsBlock = (
    <>
      <h2>WINDOW</h2>
      {s.modality === "CT" ? (
        <div
          className="preset-row"
          title="Standard CT presets (Hounsfield units)."
        >
          {WINDOW_PRESETS.map((p) => (
            <button
              key={p.label}
              className="btn preset-btn"
              onClick={() => {
                setManualWindow(true);
                setWc(p.wc);
                setWw(p.ww);
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      ) : (
        <p className="status preset-unavailable">
          No standard window presets for {s.modality || "this modality"}.
        </p>
      )}
      {(() => {
        const pMin = currentSlice?.pixelMin ?? 0;
        const pMax = currentSlice?.pixelMax ?? 4096;
        const fullSpan = Math.max(1, pMax - pMin);

        return (
          <>
            <WindowSlider
              label="Center"
              value={wc}
              min={Math.floor(pMin)}
              max={Math.ceil(pMax)}
              onChange={(v) => {
                setManualWindow(true);
                setWc(v);
              }}
            />
            <WindowSlider
              label="Width"
              value={ww}
              min={1}
              max={Math.ceil(fullSpan * 1.5)}
              onChange={(v) => {
                setManualWindow(true);
                setWw(v);
              }}
            />
          </>
        );
      })()}
      <button
        className="btn"
        onClick={() => {
          setManualWindow(false);
          const slice = slices[index];
          if (slice && !slice.error) {
            setWc(slice.wc);
            setWw(slice.ww);
          }
        }}
      >
        Reset window
      </button>
    </>
  );

  return (
    <div className={`viewer${compact ? " viewer-compact" : ""}`}>
      <div className="viewer-main" ref={stageRef}>
        {currentSlice?.error ? (
          <div className="empty-viewer error">
            {currentSlice.message || "Could not decode this frame."}
          </div>
        ) : !currentSlice ? (
          <div className="empty-viewer">Buffering slice {index + 1}…</div>
        ) : (
          <canvas
            ref={canvasRef}
            className="dicom-canvas"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          />
        )}

        {/* Slice count HUD */}
        <div className="hud">
          {index + 1} <span className="dim">/ {detail.slices.length}</span>
        </div>

        {/* AI overlay toggle — inside viewer-main so absolute positioning is relative to the canvas */}
        {s.modality === "CT" && (
          <button
            className={`btn ai-overlay-toggle${showOverlay ? " active" : ""}`}
            onClick={() => setShowOverlay((v) => !v)}
            style={{
              position: "absolute",
              top: 8,
              right: 8,
              zIndex: 10,
              padding: "6px 12px",
              fontSize: 13,
            }}
            title={
              showOverlay
                ? "Hide AI stroke segmentation overlay"
                : "Show AI stroke segmentation overlay"
            }
          >
            {showOverlay ? "◉ Hide AI Overlay" : "◎ Show AI Overlay"}
          </button>
        )}

        {/* Loading indicator while overlay fetches */}
        {showOverlay && overlayLoading && (
          <div
            className="overlay-loading"
            style={{
              position: "absolute",
              top: 46,
              right: 8,
              padding: "4px 10px",
              background: "rgba(0,0,0,0.7)",
              color: "#fff",
              fontSize: 11,
              borderRadius: 4,
              zIndex: 10,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "#ffd24a",
                animation: "pulse 1s ease-in-out infinite",
              }}
            />
            Analyzing slice…
          </div>
        )}

        {/* Legend */}
        {showOverlay && (
          <div
            className="overlay-legend"
            style={{
              position: "absolute",
              bottom: 8,
              right: 8,
              padding: "6px 10px",
              background: "rgba(0,0,0,0.7)",
              color: "#fff",
              fontSize: 11,
              borderRadius: 4,
              zIndex: 10,
              display: "flex",
              flexDirection: "column",
              gap: 4,
              pointerEvents: "none",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span
                style={{
                  width: 12,
                  height: 12,
                  background: "rgba(255, 0, 0, 0.35)",
                  border: "1.5px solid rgba(255, 60, 60, 0.95)",
                  borderRadius: 2,
                }}
              />
              Core
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span
                style={{
                  width: 12,
                  height: 12,
                  background: "rgba(255, 255, 0, 0.35)",
                  border: "1.5px solid rgba(255, 220, 0, 0.95)",
                  borderRadius: 2,
                }}
              />
              Penumbra
            </div>
          </div>
        )}

        {/* Persistent research-preview label */}
        {showOverlay && (
          <div
            className="research-preview-label"
            style={{
              position: "absolute",
              bottom: 8,
              left: 8,
              padding: "4px 8px",
              background: "rgba(0,0,0,0.65)",
              color: "#ffd24a",
              fontSize: 11,
              fontWeight: 600,
              borderRadius: 4,
              pointerEvents: "none",
              zIndex: 10,
            }}
          >
            Research preview — not for diagnostic use
          </div>
        )}
      </div>

      <div className="filmbar">
        <div className="row1">
          <span className="lbl">
            slice {index + 1} / {detail.slices.length}
          </span>
          <input
            type="range"
            min={0}
            max={Math.max(0, detail.slices.length - 1)}
            value={index}
            onChange={(e) => goTo(parseInt(e.target.value, 10))}
          />
        </div>

        {compact ? (
          <div className="compact-window-wrap">
            <button
              type="button"
              className="compact-controls-toggle"
              onClick={() => setShowCompactControls((v) => !v)}
            >
              <span className={`chevron${showCompactControls ? " open" : ""}`}>
                ▸
              </span>
              Window / Level
            </button>
            {showCompactControls && (
              <div className="compact-window-controls">
                {windowControlsBlock}
              </div>
            )}
          </div>
        ) : (
          <div className="filmstrip">
            {detail.slices.map((sl, i) => (
              <div
                key={sl.id}
                ref={(el) => (thumbRefs.current[i] = el)}
                className={`thumb${i === index ? " active" : ""}`}
                onClick={() => goTo(i)}
              >
                <ThumbCanvas slice={slices[i]} />
                <span className="n">{i + 1}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {!compact && (
        <aside className="side">
          <h2>IMAGE</h2>
          <Field
            k="Slice"
            v={
              currentMeta?.instance_number != null
                ? `#${currentMeta.instance_number}`
                : `${index + 1} of ${detail.slices.length}`
            }
          />
          <Field k="Frame" v={`${(currentMeta?.frame_index ?? 0) + 1}`} />
          <Field
            k="Dimensions"
            v={
              currentMeta?.cols_px && currentMeta?.rows_px
                ? `${currentMeta.cols_px} x ${currentMeta.rows_px} px`
                : "—"
            }
          />
          <hr />
          <h2>STUDY</h2>
          <Field k="Modality" v={s.modality || "—"} />
          <Field k="Series description" v={s.series_description || "—"} />
          <Field k="Study date" v={s.study_date || "—"} />
          <Field k="Pixel spacing" v={s.pixel_spacing || "—"} />
          <Field k="Compression" v={s.transfer_syntax_uid || "—"} />
          <hr />
          {windowControlsBlock}
          {loading && <p className="status">Loading slices…</p>}
        </aside>
      )}
    </div>
  );
}

function Field({ k, v }) {
  return (
    <div className="field">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
    </div>
  );
}

function WindowSlider({ label, value, min, max, onChange }) {
  const [text, setText] = useState(String(Math.round(value)));
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setText(String(Math.round(value)));
  }, [value]);

  function commit(raw) {
    const n = parseFloat(raw);
    if (!Number.isNaN(n)) onChange(n);
  }

  return (
    <div className="field">
      <div className="k row">
        <span>{label}</span>
        <input
          className="window-value-input"
          type="number"
          value={text}
          onFocus={() => {
            focused.current = true;
          }}
          onChange={(e) => {
            setText(e.target.value);
            commit(e.target.value);
          }}
          onBlur={() => {
            focused.current = false;
            setText(String(Math.round(value)));
          }}
        />
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </div>
  );
}

let sharedFullResCanvas = null;
function getSharedFullResCanvas(width, height) {
  if (!sharedFullResCanvas) {
    sharedFullResCanvas = document.createElement("canvas");
  }
  if (
    sharedFullResCanvas.width !== width ||
    sharedFullResCanvas.height !== height
  ) {
    sharedFullResCanvas.width = width;
    sharedFullResCanvas.height = height;
  }
  return sharedFullResCanvas;
}

function ThumbCanvas({ slice }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !slice || slice.error) return;
    const full = getSharedFullResCanvas(slice.cols, slice.rows);
    const fctx = full.getContext("2d");
    fctx.clearRect(0, 0, full.width, full.height);
    const imgData = toImageData(fctx, slice, slice.wc, slice.ww);
    fctx.putImageData(imgData, 0, 0);
    const tctx = canvas.getContext("2d");
    tctx.clearRect(0, 0, 40, 40);
    tctx.drawImage(full, 0, 0, 40, 40);
  }, [slice]);
  return <canvas ref={ref} width={40} height={40} />;
}
