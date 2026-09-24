import os
import shutil
import zipfile
import io
from pathlib import Path
from typing import List

from dotenv import load_dotenv
from fastapi import FastAPI, UploadFile, File, HTTPException, Depends, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from .db import engine, Base, get_db
from .models import Series, Slice
from .schemas import (
    SeriesSummary,
    SeriesDetailResponse,
    UploadResponse,
    UploadZipResponse,
    CreatedSeries,
)
from .dicom_utils import extract_metadata
from .pixel_utils import cache_file_pixels, read_cached_frame, PixelDecodeError

env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(dotenv_path=env_path)

UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "./uploads")).resolve()
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGIN", "http://localhost:5173").split(",")]

try:
    Base.metadata.create_all(bind=engine)
except Exception as exc:  # noqa: BLE001
    print(f"[startup warning] Could not reach MySQL to verify/create tables: {exc}")

app = FastAPI(title="DICOM Series Viewer API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Pixel-Kind", "X-Pixel-Rows", "X-Pixel-Cols"],
)

# Filenames commonly found inside DICOM study zip exports that are never
# themselves DICOM files - skipped before even attempting to parse them,
# purely as a speed optimization (extract_metadata would just fail on them
# anyway and they'd be silently counted as "skipped").
_SKIP_NAMES = {"thumbs.db", ".ds_store", "dicomdir"}


def _parse_zip_entries(raw_zip: bytes) -> tuple[list[dict], int, str | None]:
    """Recursively reads every file in a zip archive and attempts to parse
    each as DICOM, regardless of extension or folder nesting. Returns
    (successfully_parsed_items, skipped_count, common_top_level_folder).

    common_top_level_folder is the archive's single top-level folder name
    (e.g. "PatientSmith_Study1" for entries like
    "PatientSmith_Study1/series1/img001") if every parsed entry shares one -
    used as a sensible default label for the patient folder this upload
    creates, since that's usually a meaningful name the person chose
    themselves when they exported/zipped the study. None if entries are
    at the zip's root or span multiple different top-level folders.
    """
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw_zip))
    except zipfile.BadZipFile:
        raise HTTPException(status_code=400, detail="That file isn't a valid zip archive.")

    parsed = []
    skipped = 0
    top_folders: set[str] = set()
    for info in zf.infolist():
        if info.is_dir():
            continue
        name = Path(info.filename).name
        if not name or name.startswith(".") or name.lower() in _SKIP_NAMES or "__MACOSX" in info.filename:
            continue
        try:
            raw = zf.read(info)
        except Exception:
            skipped += 1
            continue
        try:
            meta = extract_metadata(raw)
        except Exception:
            skipped += 1
            continue
        parsed.append({"filename": name, "raw": raw, "meta": meta})

        parts = Path(info.filename).parts
        if len(parts) > 1:
            top_folders.add(parts[0])

    common_folder = top_folders.pop() if len(top_folders) == 1 else None
    return parsed, skipped, common_folder


def _ingest_series(db: Session, items: list[dict]) -> Series:
    """Takes a list of already-parsed {filename, raw, meta} dicts that all
    belong to ONE series, sorts them into slice order, decodes/caches
    their pixel data, and writes the Series + Slice rows. Shared by both
    the loose-file upload endpoint and the zip upload endpoint so there's
    exactly one place this logic lives."""

    def file_sort_key(item):
        m = item["meta"]
        value = m["sliceLocation"] if m["sliceLocation"] is not None else m["instanceNumber"]
        return (0, value) if value is not None else (1, 0)

    items = sorted(items, key=file_sort_key)

    first = items[0]["meta"]
    total_frames = sum(item["meta"]["numberOfFrames"] for item in items)
    ts_val = first.get("transferSyntaxUid") or first.get("transferSyntaxName") or "Unknown"

    series = Series(
        series_uid=first["seriesUid"],
        study_uid=first.get("studyInstanceUid"),
        patient_id=first.get("patientId"),
        patient_name=first.get("patientName"),
        modality=first["modality"],
        series_description=first["seriesDescription"],
        study_date=first["studyDate"],
        pixel_spacing=first["pixelSpacing"],
        transfer_syntax_uid=str(ts_val)[:255],
        slice_count=total_frames,
    )
    db.add(series)
    db.flush()  # populates series.id without committing yet

    series_dir = UPLOAD_DIR / str(series.id)
    series_dir.mkdir(parents=True, exist_ok=True)

    order = 0
    for file_index, item in enumerate(items):
        safe_name = os.path.basename(item["filename"] or f"slice_{file_index}.dcm")
        storage_path = series_dir / safe_name
        # Two files in the same zip/upload could share a filename (e.g.
        # "IM1" appearing in two different sub-folders) - keep both rather
        # than silently overwriting one.
        if storage_path.exists():
            stem, suffix = os.path.splitext(safe_name)
            safe_name = f"{stem}_{file_index}{suffix}"
            storage_path = series_dir / safe_name

        try:
            with open(storage_path, "wb") as out:
                out.write(item["raw"])
            cache_file_pixels(str(storage_path))
        except Exception:
            shutil.rmtree(series_dir, ignore_errors=True)
            raise

        m = item["meta"]
        for frame_index in range(m["numberOfFrames"]):
            db.add(Slice(
                series_id=series.id,
                file_name=safe_name,
                storage_path=str(storage_path),
                frame_index=frame_index,
                instance_number=m["instanceNumber"],
                slice_location=m["sliceLocation"],
                sort_order=order,
                rows_px=m["rows"],
                cols_px=m["cols"],
                is_color=m["isColor"],
                window_center=m["windowCenter"],
                window_width=m["windowWidth"],
                rescale_slope=m["rescaleSlope"],
                rescale_intercept=m["rescaleIntercept"],
            ))
            order += 1

    return series


@app.get("/api/health")
def health():
    return {"ok": True}


@app.post("/api/series", response_model=UploadResponse, status_code=201)
async def upload_series(files: List[UploadFile] = File(...), db: Session = Depends(get_db)):
    if not files:
        raise HTTPException(status_code=400, detail="No files were uploaded.")

    parsed = []
    for f in files:
        raw = await f.read()
        try:
            meta = extract_metadata(raw)
            parsed.append({"filename": f.filename or "slice.dcm", "raw": raw, "meta": meta})
        except Exception:
            parsed.append({"filename": f.filename, "error": True})

    ok = [p for p in parsed if not p.get("error")]
    if not ok:
        raise HTTPException(status_code=400, detail="None of the uploaded files could be read as DICOM.")

    try:
        series = _ingest_series(db, ok)
        db.commit()
    except Exception:
        db.rollback()
        raise HTTPException(status_code=500, detail="Failed to store series.")

    return UploadResponse(seriesId=series.id, sliceCount=series.slice_count, skipped=len(parsed) - len(ok))


@app.post("/api/series/upload-zip", response_model=UploadZipResponse, status_code=201)
async def upload_series_zip(file: UploadFile = File(...), db: Session = Depends(get_db)):
    """Accepts one .zip archive containing an entire study - one or more
    series, each possibly across nested folders, each file possibly named
    without a .dcm extension. Every file inside is parsed as DICOM
    (regardless of extension) and grouped by SeriesInstanceUID; each group
    becomes its own series, exactly as if it had been uploaded on its own
    via /api/series."""
    if not (file.filename or "").lower().endswith(".zip"):
        raise HTTPException(status_code=400, detail="Please upload a .zip archive.")

    raw_zip = await file.read()
    parsed, skipped, folder_name = _parse_zip_entries(raw_zip)

    if not parsed:
        raise HTTPException(status_code=400, detail="No DICOM files were found inside that archive.")

    groups: dict[str, list[dict]] = {}
    for item in parsed:
        series_uid = item["meta"].get("seriesUid") or f"__no_series_uid_{item['filename']}"
        groups.setdefault(series_uid, []).append(item)

    created: list[Series] = []
    try:
        for items in groups.values():
            created.append(_ingest_series(db, items))
        db.commit()
    except Exception:
        db.rollback()
        for series in created:
            shutil.rmtree(UPLOAD_DIR / str(series.id), ignore_errors=True)
        raise HTTPException(status_code=500, detail="Failed to store one or more series from the archive.")

    return UploadZipResponse(
        series=[
            CreatedSeries(
                seriesId=s.id,
                seriesDescription=s.series_description,
                modality=s.modality,
                sliceCount=s.slice_count,
            )
            for s in created
        ],
        skipped=skipped,
        folderName=folder_name,
    )


@app.get("/api/series", response_model=List[SeriesSummary])
def list_series(db: Session = Depends(get_db)):
    rows = db.query(Series).order_by(Series.created_at.desc()).all()
    result = []
    for s in rows:
        thumb_id = (
            db.query(Slice.id)
            .filter(Slice.series_id == s.id)
            .order_by(Slice.sort_order.asc())
            .limit(1)
            .scalar()
        )
        item = SeriesSummary.model_validate(s)
        item.thumbnail_slice_id = thumb_id
        result.append(item)
    return result


@app.get("/api/series/{series_id}", response_model=SeriesDetailResponse)
def get_series(series_id: int, db: Session = Depends(get_db)):
    series = db.query(Series).filter(Series.id == series_id).first()
    if not series:
        raise HTTPException(status_code=404, detail="Series not found.")
    slices = (
        db.query(Slice)
        .filter(Slice.series_id == series_id)
        .order_by(Slice.sort_order.asc())
        .all()
    )
    return {"series": series, "slices": slices}


@app.get("/api/slices/{slice_id}/raw")
def get_slice_raw(slice_id: int, db: Session = Depends(get_db)):
    slice_row = db.query(Slice).filter(Slice.id == slice_id).first()
    if not slice_row:
        raise HTTPException(status_code=404, detail="Slice not found.")
    if not os.path.exists(slice_row.storage_path):
        raise HTTPException(status_code=404, detail="Underlying file is missing on disk.")
    return FileResponse(slice_row.storage_path, media_type="application/dicom")


@app.get("/api/slices/{slice_id}/pixels")
def get_slice_pixels(slice_id: int, db: Session = Depends(get_db)):
    slice_row = db.query(Slice).filter(Slice.id == slice_id).first()
    if not slice_row:
        raise HTTPException(status_code=404, detail="Slice not found.")
    if not os.path.exists(slice_row.storage_path):
        raise HTTPException(status_code=404, detail="Underlying file is missing on disk.")

    try:
        frame = read_cached_frame(slice_row.storage_path, slice_row.frame_index)
    except PixelDecodeError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    return Response(
        content=frame.buffer,
        media_type="application/octet-stream",
        headers={
            "X-Pixel-Kind": frame.kind,
            "X-Pixel-Rows": str(frame.rows),
            "X-Pixel-Cols": str(frame.cols),
        },
    )


@app.delete("/api/series/{series_id}", status_code=204)
def delete_series(series_id: int, db: Session = Depends(get_db)):
    series = db.query(Series).filter(Series.id == series_id).first()
    if not series:
        raise HTTPException(status_code=404, detail="Series not found.")
    db.delete(series)
    db.commit()
    series_dir = UPLOAD_DIR / str(series_id)
    shutil.rmtree(series_dir, ignore_errors=True)
    return None
