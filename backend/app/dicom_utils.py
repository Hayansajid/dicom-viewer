from io import BytesIO
import pydicom
from pydicom.errors import InvalidDicomError


def _first_float(value) -> float | None:
    """pydicom returns some tags (WindowCenter, PixelSpacing, ...) as either
    a single DSfloat or a MultiValue list when a file has several values
    (e.g. one per VOI LUT). We only need the first one for rendering."""
    if value is None:
        return None
    try:
        if isinstance(value, (list, tuple, pydicom.multival.MultiValue)):
            return float(value[0])
        return float(value)
    except (TypeError, ValueError, IndexError):
        return None


def _format_date(raw: str | None) -> str | None:
    if not raw or len(raw) < 8:
        return None
    return f"{raw[0:4]}-{raw[4:6]}-{raw[6:8]}"


def _format_spacing(ds) -> str | None:
    # 1. Check root level
    spacing = getattr(ds, "PixelSpacing", None)

    # 2. Check SharedFunctionalGroupsSequence for enhanced multi-frame files
    if not spacing and hasattr(ds, "SharedFunctionalGroupsSequence") and len(ds.SharedFunctionalGroupsSequence) > 0:
        shared = ds.SharedFunctionalGroupsSequence[0]
        if hasattr(shared, "PixelMeasuresSequence") and len(shared.PixelMeasuresSequence) > 0:
            spacing = getattr(shared.PixelMeasuresSequence[0], "PixelSpacing", None)

    if not spacing:
        return None
    try:
        return " x ".join(f"{float(v):.2f}" for v in spacing) + " mm"
    except (TypeError, ValueError):
        return None


def _extract_window_levels(ds) -> tuple[float | None, float | None]:
    """Finds WindowCenter and WindowWidth either at the root level or
    nested inside Enhanced Multi-Frame functional group sequences.
    Returns (None, None) if missing, letting the frontend perform auto-windowing."""
    wc = getattr(ds, "WindowCenter", None)
    ww = getattr(ds, "WindowWidth", None)

    # Check SharedFunctionalGroupsSequence
    if (wc is None or ww is None) and hasattr(ds, "SharedFunctionalGroupsSequence") and len(ds.SharedFunctionalGroupsSequence) > 0:
        shared = ds.SharedFunctionalGroupsSequence[0]
        if hasattr(shared, "FrameVOILUTSequence") and len(shared.FrameVOILUTSequence) > 0:
            voi = shared.FrameVOILUTSequence[0]
            wc = wc if wc is not None else getattr(voi, "WindowCenter", None)
            ww = ww if ww is not None else getattr(voi, "WindowWidth", None)

    # Check PerFrameFunctionalGroupsSequence (first frame)
    if (wc is None or ww is None) and hasattr(ds, "PerFrameFunctionalGroupsSequence") and len(ds.PerFrameFunctionalGroupsSequence) > 0:
        per_frame = ds.PerFrameFunctionalGroupsSequence[0]
        if hasattr(per_frame, "FrameVOILUTSequence") and len(per_frame.FrameVOILUTSequence) > 0:
            voi = per_frame.FrameVOILUTSequence[0]
            wc = wc if wc is not None else getattr(voi, "WindowCenter", None)
            ww = ww if ww is not None else getattr(voi, "WindowWidth", None)

    wc_val = _first_float(wc)
    ww_val = _first_float(ww)

    # Only return values if both exist and width is positive; otherwise return None
    if wc_val is None or ww_val is None or ww_val <= 0:
        return None, None

    return wc_val, ww_val


def extract_metadata(raw_bytes: bytes) -> dict:
    buf = BytesIO(raw_bytes)
    try:
        ds = pydicom.dcmread(buf, stop_before_pixels=True)
    except InvalidDicomError:
        buf.seek(0)
        ds = pydicom.dcmread(buf, stop_before_pixels=True, force=True)

    rows = getattr(ds, "Rows", None)
    cols = getattr(ds, "Columns", None)
    if not rows or not cols:
        raise ValueError("File is missing image dimensions (Rows/Columns).")

    slope = _first_float(getattr(ds, "RescaleSlope", None))
    intercept = _first_float(getattr(ds, "RescaleIntercept", None))

    instance_number_raw = getattr(ds, "InstanceNumber", None)
    slice_location_raw = getattr(ds, "SliceLocation", None)

    samples_per_pixel = int(getattr(ds, "SamplesPerPixel", 1) or 1)
    photometric = str(getattr(ds, "PhotometricInterpretation", "") or "").strip().upper()
    is_color = samples_per_pixel > 1 or photometric.startswith(("RGB", "YBR"))

    number_of_frames = int(getattr(ds, "NumberOfFrames", 1) or 1)

    transfer_syntax_uid = None
    transfer_syntax_name = None
    if hasattr(ds, "file_meta") and "TransferSyntaxUID" in ds.file_meta:
        tsyn = ds.file_meta.TransferSyntaxUID
        transfer_syntax_uid = str(tsyn)
        transfer_syntax_name = tsyn.name

    wc, ww = _extract_window_levels(ds)

    return {
        "seriesUid": str(getattr(ds, "SeriesInstanceUID", "") or "") or None,
        "modality": str(getattr(ds, "Modality", "") or "") or None,
        "seriesDescription": str(getattr(ds, "SeriesDescription", "") or "") or None,
        "studyDate": _format_date(str(getattr(ds, "StudyDate", "") or "")),
        "pixelSpacing": _format_spacing(ds),
        "transferSyntaxUid": transfer_syntax_uid,
        "transferSyntaxName": transfer_syntax_name,
        "rows": int(rows),
        "cols": int(cols),
        "photometricInterpretation": photometric or "MONOCHROME2",
        "isColor": is_color,
        "numberOfFrames": number_of_frames,
        "instanceNumber": int(instance_number_raw) if instance_number_raw not in (None, "") else None,
        "sliceLocation": _first_float(slice_location_raw),
        "windowCenter": wc,
        "windowWidth": ww,
        "rescaleSlope": slope if slope is not None else 1.0,
        "rescaleIntercept": intercept if intercept is not None else 0.0,
    }