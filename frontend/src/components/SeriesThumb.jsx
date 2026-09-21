import { useEffect, useRef, useState } from 'react';
import { fetchSlicePixels } from '../api.js';
import { toImageData, computeFallbackWindow } from '../dicomRender.js';

/** Fetches one slice's pixel data and renders it as a small preview canvas. */
export default function SeriesThumb({ sliceId }) {
  const canvasRef = useRef(null);
  const [state, setState] = useState('loading'); // 'loading' | 'ready' | 'error'

  useEffect(() => {
    let cancelled = false;
    if (!sliceId) {
      setState('error');
      return;
    }
    setState('loading');
    fetchSlicePixels(sliceId)
      .then((frame) => {
        if (cancelled) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const { wc, ww } = frame.isColor ? { wc: 0, ww: 1 } : computeFallbackWindow(frame);
        const full = document.createElement('canvas');
        full.width = frame.cols;
        full.height = frame.rows;
        const fctx = full.getContext('2d');
        const imgData = toImageData(fctx, frame, wc, ww);
        fctx.putImageData(imgData, 0, 0);
        const tctx = canvas.getContext('2d');
        tctx.clearRect(0, 0, canvas.width, canvas.height);
        tctx.drawImage(full, 0, 0, canvas.width, canvas.height);
        setState('ready');
      })
      .catch(() => !cancelled && setState('error'));
    return () => {
      cancelled = true;
    };
  }, [sliceId]);

  return (
    <div className="series-thumb">
      <canvas ref={canvasRef} width={48} height={48} style={{ display: state === 'ready' ? 'block' : 'none' }} />
      {state !== 'ready' && (
        <div className={`series-thumb-fallback${state === 'error' ? ' error' : ''}`}>
          {state === 'error' ? '—' : ''}
        </div>
      )}
    </div>
  );
}
