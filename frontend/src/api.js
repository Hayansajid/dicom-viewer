const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

const pixelCache = new Map();

async function handle(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || body.error || `Request failed (${res.status})`);
  }
  return res;
}

export async function uploadSeries(files) {
  const form = new FormData();
  Array.from(files).forEach((f) => form.append('files', f));
  const res = await fetch(`${BASE_URL}/api/series`, { method: 'POST', body: form });
  await handle(res);
  return res.json();
}

/**
 * Uploads a single .zip archive containing an entire study - one or more
 * series, possibly across nested folders, files possibly without a .dcm
 * extension. The backend groups files by SeriesInstanceUID and returns
 * every series it created.
 */
export async function uploadZip(file) {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${BASE_URL}/api/series/upload-zip`, { method: 'POST', body: form });
  await handle(res);
  return res.json();
}

export async function listSeries() {
  const res = await fetch(`${BASE_URL}/api/series`);
  await handle(res);
  return res.json();
}

export async function getSeriesDetail(id) {
  const res = await fetch(`${BASE_URL}/api/series/${id}`);
  await handle(res);
  return res.json();
}

/**
 * Fetches one fully-decoded frame with deduplicated in-flight requests and memory caching.
 */
export async function fetchSlicePixels(id) {
  if (pixelCache.has(id)) {
    return pixelCache.get(id);
  }

  const promise = (async () => {
    const res = await fetch(`${BASE_URL}/api/slices/${id}/pixels`);
    await handle(res);
    const kind = res.headers.get('X-Pixel-Kind');
    const rows = parseInt(res.headers.get('X-Pixel-Rows'), 10);
    const cols = parseInt(res.headers.get('X-Pixel-Cols'), 10);
    const buffer = await res.arrayBuffer();

    return {
      isColor: kind === 'color',
      rows,
      cols,
      pixelData: kind === 'color' ? new Uint8Array(buffer) : new Float32Array(buffer),
    };
  })();

  pixelCache.set(id, promise);

  try {
    return await promise;
  } catch (err) {
    pixelCache.delete(id);
    throw err;
  }
}

export async function deleteSeries(id) {
  const res = await fetch(`${BASE_URL}/api/series/${id}`, { method: 'DELETE' });
  await handle(res);
}