import { useEffect, useRef, useState, useCallback } from 'react';
import { getSeriesDetail, fetchSlicePixels } from '../api.js';
import { toImageData, computeFallbackWindow } from '../dicomRender.js';

export default function Viewer({ seriesId }) {
  const [detail, setDetail] = useState(null);
  const [slices, setSlices] = useState([]);
  const [index, setIndex] = useState(0);
  const [manualWindow, setManualWindow] = useState(false);
  const [wc, setWc] = useState(0);
  const [ww, setWw] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const canvasRef = useRef(null);
  const stageRef = useRef(null);
  const thumbRefs = useRef([]);

  const isDragging = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });
  const dragStart = useRef({ wc: 0, ww: 0 });

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function handleMouseDown(e) {
    if (e.button !== 0) return; // Left mouse click
    const slice = slices[index];
    if (!slice || slice.error) return;
    isDragging.current = true;
    lastPos.current = { x: e.clientX, y: e.clientY };
    // Always start from whatever window is actually on screen right now -
    // the file's default, or a previous manual adjustment - never from
    // possibly-stale/uninitialized React state. This is what was missing
    // before: dragging used to nudge `wc`/`ww` from whatever they
    // happened to be, which could still be their initial useState(0)/(1)
    // defaults if this was the very first interaction.
    dragStart.current = {
      wc: manualWindow ? wc : slice.wc,
      ww: manualWindow ? ww : slice.ww,
    };
  }

  function handleMouseMove(e) {
    if (!isDragging.current) return;
    const slice = slices[index];
    if (!slice || slice.error) return;
    const dx = e.clientX - lastPos.current.x;
    const dy = e.clientY - lastPos.current.y;

    // Scale drag sensitivity to this image's own pixel value range, so a
    // given mouse movement feels the same whether values span 0-255 or
    // 0-4095+ (typical for mammography/CT) - a fixed multiplier (the old
    // `dx * 2`) is wildly too strong for high-range images and can push
    // the window fully outside the data in a couple of pixels of movement.
    const pMin = slice.pixelMin ?? 0;
    const pMax = slice.pixelMax ?? 255;
    const fullSpan = Math.max(1, pMax - pMin);
    const sensitivity = fullSpan / 300; // ~300px of drag traverses the full range

    // Hard-clamp so a runaway drag can never fully leave the data's range -
    // that's what was producing a solid black (or white) canvas: wc/ww
    // ending up nowhere near any actual pixel value.
    const nextWw = clamp(dragStart.current.ww + dx * sensitivity, 1, fullSpan * 4);
    const nextWc = clamp(dragStart.current.wc - dy * sensitivity, pMin - fullSpan, pMax + fullSpan);

    lastPos.current = { x: e.clientX, y: e.clientY };
    setManualWindow(true);
    setWw(nextWw);
    setWc(nextWc);
  }

  function handleMouseUp() {
    isDragging.current = false;
  }

  const processFrame = (frame, meta) => {
    const fallback = computeFallbackWindow(frame);
    const hasStoredWindow = meta.window_center != null && meta.window_width != null;
    
    return {
      ...frame,
      wc: hasStoredWindow ? meta.window_center : fallback.wc,
      ww: hasStoredWindow ? meta.window_width : fallback.ww,
      pixelMin: fallback.min,
      pixelMax: fallback.max,
    };
  };

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setSlices([]);
    setIndex(0);
    setManualWindow(false);
    setError('');
    if (!seriesId) return;

    setLoading(true);

    getSeriesDetail(seriesId)
      .then(async (d) => {
        if (cancelled) return;
        setDetail(d);

        const loadedSlices = new Array(d.slices.length).fill(null);

        // Step 1: Prioritize Frame 0 so the canvas renders immediately
        if (d.slices.length > 0) {
          try {
            const firstFrame = await fetchSlicePixels(d.slices[0].id);
            if (cancelled) return;
            loadedSlices[0] = processFrame(firstFrame, d.slices[0]);
            setSlices([...loadedSlices]);
          } catch (err) {
            loadedSlices[0] = { error: true, message: err.message };
            setSlices([...loadedSlices]);
          }
        }

        // Step 2: Stream remaining slices concurrently in chunks of 5
        const concurrency = 5;
        const remainingIndices = Array.from({ length: d.slices.length - 1 }, (_, i) => i + 1);

        const runWorker = async () => {
          while (remainingIndices.length > 0 && !cancelled) {
            const i = remainingIndices.shift();
            try {
              const frame = await fetchSlicePixels(d.slices[i].id);
              if (cancelled) return;
              loadedSlices[i] = processFrame(frame, d.slices[i]);
            } catch (err) {
              loadedSlices[i] = { error: true, message: err.message };
            }
            // Update state periodically to refresh thumbnails as they arrive
            setSlices([...loadedSlices]);
          }
        };

        const workers = Array.from({ length: Math.min(concurrency, remainingIndices.length) }, () =>
          runWorker()
        );

        await Promise.all(workers);
      })
      .catch((err) => !cancelled && setError(err.message || 'Failed to load series.'))
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
  }, [seriesId]);

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

  const draw = useCallback((slice, wcOverride, wwOverride) => {
    const canvas = canvasRef.current;
    if (!slice || slice.error || !canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = slice.cols;
    canvas.height = slice.rows;
    const useWc = wcOverride ?? slice.wc;
    const useWw = wwOverride ?? slice.ww;
    const imgData = toImageData(ctx, slice, useWc, useWw);
    ctx.putImageData(imgData, 0, 0);

    // Compute and apply the on-screen CSS size right now, synchronously,
    // by directly measuring the real container box - not via CSS
    // percentages (unreliable in this nested flex layout) and not via a
    // React state round-trip (which lagged behind the browser's actual
    // layout during a fullscreen transition, causing the canvas to fall
    // back to its native pixel size with only a corner visible).
    applyDisplaySize(canvas, slice);

    // Confirmed empirically: manually resizing the browser window makes a
    // stuck-blank canvas display correctly. Setting canvas.width/height via
    // JS (as above) changes the canvas's intrinsic size, but inside this
    // deeply nested flex/percentage-sized layout, some Chromium builds
    // don't reliably re-run layout AND repaint for its ancestors afterward -
    // the canvas paints into a backing store that's correct (confirmed via
    // getImageData) but never gets composited into a properly-sized box on
    // screen until something forces both a reflow and a fresh paint.
    // Briefly removing the element from layout and reinserting it forces
    // both steps, unlike just reading a layout property (which can force
    // layout without necessarily forcing a subsequent repaint).
    canvas.style.display = 'none';
    void canvas.offsetHeight; // force the browser to flush layout right now
    canvas.style.display = '';
  }, [applyDisplaySize]); // no dependency on `slices` - draw is handed the exact frame to paint

  // Depending on `slices[index]` here (a single element) rather than the
  // whole `slices` array is what actually matters: React gives `slices` a
  // new array reference on every background frame that finishes loading -
  // up to N times per series - which used to re-fire this effect (and
  // therefore re-clear + redraw the canvas) N times per load even though
  // only one of those frames was ever the one on screen. `slices[index]`
  // only changes reference when *this specific* frame's data changes.
  const currentSlice = slices[index];

  // Measure the actual container box in real pixels and re-apply the
  // canvas's display size whenever it changes - window resize, and
  // specifically the Fullscreen API transition, which can otherwise be
  // measured too early (mid-transition, before the browser has settled
  // into its new layout), leaving the canvas rendered at native pixel
  // size with only a corner visible. requestAnimationFrame here ensures
  // we measure *after* the browser has actually finished laying out the
  // new size, not synchronously during the event itself.
  useEffect(() => {
    function reapply() {
      requestAnimationFrame(() => {
        const canvas = canvasRef.current;
        if (canvas && currentSlice && !currentSlice.error) {
          applyDisplaySize(canvas, currentSlice);
        }
      });
    }
    window.addEventListener('resize', reapply);
    document.addEventListener('fullscreenchange', reapply);
    return () => {
      window.removeEventListener('resize', reapply);
      document.removeEventListener('fullscreenchange', reapply);
    };
  }, [currentSlice, applyDisplaySize]);

  useEffect(() => {
    if (!currentSlice || currentSlice.error) return;
    if (!manualWindow) {
      setWc(currentSlice.wc);
      setWw(currentSlice.ww);
    }
    draw(currentSlice, manualWindow ? wc : currentSlice.wc, manualWindow ? ww : currentSlice.ww);
    thumbRefs.current[index]?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [index, currentSlice, draw]);

  useEffect(() => {
    // No `manualWindow` guard here on purpose: this effect's job is
    // "whenever wc/ww change for the slice currently on screen, redraw
    // with them" - regardless of whether that change came from dragging
    // (manualWindow true) or from clicking Reset (which sets manualWindow
    // to false while also changing wc/ww). The old `manualWindow &&`
    // guard skipped exactly the Reset case, since Reset needs this
    // effect to fire while manualWindow is false - leaving the slider
    // numbers updated but the canvas still showing the old image.
    if (currentSlice && !currentSlice.error) draw(currentSlice, wc, ww);
  }, [wc, ww, draw, currentSlice]);

  function goTo(i) {
    if (!detail) return;
    const clamped = Math.max(0, Math.min(detail.slices.length - 1, i));
    setManualWindow(false);
    setIndex(clamped);

    // If target frame hasn't loaded yet from the pool, trigger on-demand fetch
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
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [index, detail]);

  useEffect(() => {
    function onKey(e) {
      if (!detail || !detail.slices.length) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') goTo(index + 1);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') goTo(index - 1);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [index, detail]);

  if (!seriesId) {
    return (
      <div className="empty-viewer">
        <p>Select a series from the list, or load a new one, to start viewing.</p>
      </div>
    );
  }

  if (error) return <div className="empty-viewer error">{error}</div>;
  if (!detail) return <div className="empty-viewer">Loading series…</div>;

  const s = detail.series;
  const currentMeta = detail.slices[index];

  return (
    
    <div className="viewer">
      <div className="viewer-main" ref={stageRef}>
        {currentSlice?.error ? (
          <div className="empty-viewer error">{currentSlice.message || 'Could not decode this frame.'}</div>
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
        <div className="hud">
          {index + 1} <span className="dim">/ {detail.slices.length}</span>
        </div>
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
        <div className="filmstrip">
          {detail.slices.map((sl, i) => (
            <div
              key={sl.id}
              ref={(el) => (thumbRefs.current[i] = el)}
              className={`thumb${i === index ? ' active' : ''}`}
              onClick={() => goTo(i)}
            >
              <ThumbCanvas slice={slices[i]} />
              <span className="n">{i + 1}</span>
            </div>
          ))}
        </div>
      </div>

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
              : '—'
          }
        />
        <hr />
        <h2>STUDY</h2>
        <Field k="Modality" v={s.modality || '—'} />
        <Field k="Series description" v={s.series_description || '—'} />
        <Field k="Study date" v={s.study_date || '—'} />
        <Field k="Pixel spacing" v={s.pixel_spacing || '—'} />
        <Field k="Compression" v={s.transfer_syntax_uid || '—'} />
        <hr />
      <h2>WINDOW</h2>
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
        {loading && <p className="status">Loading slices…</p>}
      </aside>
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
  return (
    <div className="field">
      <div className="k row">
        <span>{label}</span>
        <span className="mono">{Math.round(value)}</span>
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

// A single shared offscreen canvas, reused for every thumbnail's downscale
// step instead of each ThumbCanvas creating its own full-resolution
// (e.g. 1890x2457, ~18MB) canvas. With dozens of frames all loading
// around the same time, creating that many full-size canvases - even
// briefly - puts real pressure on the browser's canvas/GPU memory budget,
// which can cause allocation to silently fail for *some* canvas (thumbnail
// or, worse, the main viewer canvas) rather than throwing a visible error.
let sharedFullResCanvas = null;
function getSharedFullResCanvas(width, height) {
  if (!sharedFullResCanvas) {
    sharedFullResCanvas = document.createElement('canvas');
  }
  // Only resize when necessary - resizing (even to the same value) clears
  // the canvas, and reusing the same backing store when dimensions already
  // match avoids a pointless reallocation.
  if (sharedFullResCanvas.width !== width || sharedFullResCanvas.height !== height) {
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
    const fctx = full.getContext('2d');
    fctx.clearRect(0, 0, full.width, full.height);
    const imgData = toImageData(fctx, slice, slice.wc, slice.ww);
    fctx.putImageData(imgData, 0, 0);
    const tctx = canvas.getContext('2d');
    tctx.clearRect(0, 0, 40, 40);
    tctx.drawImage(full, 0, 0, 40, 40);
  }, [slice]);
  return <canvas ref={ref} width={40} height={40} />;
}