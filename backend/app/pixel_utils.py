import json
import os
from dataclasses import dataclass

import numpy as np
import pydicom
from pydicom.pixel_data_handlers.util import convert_color_space


class PixelDecodeError(Exception):
    pass


@dataclass
class DecodedFrame:
    kind: str           # "gray" or "color"
    rows: int
    cols: int
    buffer: bytes       # float32 little-endian (gray) or uint8 RGB triplets (color)


def cache_file_pixels(dicom_path: str) -> dict:
    """Decodes an entire DICOM file (all frames) ONCE and dumps the raw
    decompressed bytes to a .raw binary file with a .meta.json descriptor.
    """
    raw_cache_path = dicom_path + ".raw"
    meta_cache_path = dicom_path + ".meta.json"

    # Avoid re-processing if already cached
    if os.path.exists(raw_cache_path) and os.path.exists(meta_cache_path):
        with open(meta_cache_path, "r", encoding="utf-8") as f:
            return json.load(f)

    try:
        ds = pydicom.dcmread(dicom_path)
        pixels = ds.pixel_array
    except Exception as exc:
        raise PixelDecodeError(f"Could not decode pixel data: {exc}") from exc

    samples_per_pixel = int(getattr(ds, "SamplesPerPixel", 1) or 1)
    photometric = str(getattr(ds, "PhotometricInterpretation", "") or "")
    is_color = samples_per_pixel > 1 or photometric.startswith(("RGB", "YBR"))
    number_of_frames = int(getattr(ds, "NumberOfFrames", 1) or 1)

    if is_color:
        if photometric.startswith("YBR") and photometric != "YBR_RCT":
            pixels = convert_color_space(pixels, photometric, "RGB")
        processed = np.ascontiguousarray(pixels, dtype=np.uint8)
        kind = "color"
    else:
        slope = float(getattr(ds, "RescaleSlope", 1) or 1)
        intercept = float(getattr(ds, "RescaleIntercept", 0) or 0)
        processed = pixels.astype(np.float32) * slope + intercept

        # MONOCHROME1 means LOW pixel values should display BRIGHT and HIGH
        # values should display DARK - the opposite of MONOCHROME2, which is
        # what our windowing (and every other part of this pipeline) assumes.
        # Some modalities/vendors (mammography and DBT among them) use
        # MONOCHROME1, and without this the whole image renders inverted -
        # which, depending on how the actual tissue signal is distributed,
        # can look like a solid black (or solid white) frame rather than an
        # obviously "photo negative" one. Invert here, once, at cache time,
        # around the file's own observed min/max, so every consumer
        # downstream can keep assuming "high value = bright" unconditionally.
        if photometric == "MONOCHROME1":
            data_min = float(processed.min())
            data_max = float(processed.max())
            processed = (data_min + data_max) - processed

        processed = np.ascontiguousarray(processed, dtype=np.float32)
        kind = "gray"

    # Normalize dimensions so frame indexing is consistent
    if is_color:
        # Expected: (frames, rows, cols, 3) or (rows, cols, 3)
        if processed.ndim == 3:
            processed = np.expand_dims(processed, axis=0)
        frames, rows, cols, channels = processed.shape
        bytes_per_frame = rows * cols * channels * processed.dtype.itemsize
    else:
        # Expected: (frames, rows, cols) or (rows, cols)
        if processed.ndim == 2:
            processed = np.expand_dims(processed, axis=0)
        frames, rows, cols = processed.shape
        bytes_per_frame = rows * cols * processed.dtype.itemsize

    # Dump the flat buffer to disk
    processed.tofile(raw_cache_path)

    meta = {
        "kind": kind,
        "frames": frames,
        "rows": rows,
        "cols": cols,
        "bytes_per_frame": bytes_per_frame,
        "raw_path": raw_cache_path,
    }

    with open(meta_cache_path, "w", encoding="utf-8") as f:
        json.dump(meta, f)

    return meta


def read_cached_frame(dicom_path: str, frame_index: int) -> DecodedFrame:
    """Reads a single frame using an offset seek against the pre-decoded binary file.
    No decompression occurs here.
    """
    raw_cache_path = dicom_path + ".raw"
    meta_cache_path = dicom_path + ".meta.json"

    # Fallback to caching if the file was uploaded before this migration
    if not (os.path.exists(raw_cache_path) and os.path.exists(meta_cache_path)):
        meta = cache_file_pixels(dicom_path)
    else:
        with open(meta_cache_path, "r", encoding="utf-8") as f:
            meta = json.load(f)

    if frame_index < 0 or frame_index >= meta["frames"]:
        raise PixelDecodeError(f"frame_index {frame_index} out of bounds (0-{meta['frames'] - 1})")

    offset = frame_index * meta["bytes_per_frame"]
    with open(meta["raw_path"], "rb") as f:
        f.seek(offset)
        buffer = f.read(meta["bytes_per_frame"])

    return DecodedFrame(
        kind=meta["kind"],
        rows=meta["rows"],
        cols=meta["cols"],
        buffer=buffer,
    )