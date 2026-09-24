from datetime import datetime
from typing import List
from pydantic import BaseModel, ConfigDict


class SeriesSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    study_uid: str | None = None
    patient_id: str | None = None
    patient_name: str | None = None
    modality: str | None = None
    series_description: str | None = None
    study_date: str | None = None
    slice_count: int
    created_at: datetime | None = None
    # First slice's id, for the sidebar to fetch as a thumbnail preview via
    # the existing /api/slices/{id}/pixels endpoint - no separate
    # thumbnail-generation endpoint needed.
    thumbnail_slice_id: int | None = None


class SliceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    file_name: str
    frame_index: int
    instance_number: int | None = None
    slice_location: float | None = None
    sort_order: int
    rows_px: int | None = None
    cols_px: int | None = None
    is_color: bool
    window_center: float | None = None
    window_width: float | None = None
    rescale_slope: float
    rescale_intercept: float


class SeriesDetail(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    series_uid: str | None = None
    study_uid: str | None = None
    patient_id: str | None = None
    patient_name: str | None = None
    modality: str | None = None
    series_description: str | None = None
    study_date: str | None = None
    pixel_spacing: str | None = None
    transfer_syntax_uid: str | None = None
    slice_count: int
    created_at: datetime | None = None


class SeriesDetailResponse(BaseModel):
    series: SeriesDetail
    slices: List[SliceOut]


class UploadResponse(BaseModel):
    seriesId: int
    sliceCount: int
    skipped: int


class CreatedSeries(BaseModel):
    seriesId: int
    seriesDescription: str | None = None
    modality: str | None = None
    sliceCount: int


class UploadZipResponse(BaseModel):
    series: List[CreatedSeries]
    skipped: int
    folderName: str | None = None
