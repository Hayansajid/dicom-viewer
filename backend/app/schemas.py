from datetime import datetime
from typing import Optional, List
from pydantic import BaseModel, ConfigDict


class SeriesSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    study_uid: Optional[str] = None
    patient_id: Optional[str] = None
    patient_name: Optional[str] = None
    modality: Optional[str] = None
    series_description: Optional[str] = None
    study_date: Optional[str] = None
    slice_count: int
    created_at: Optional[datetime] = None
    # First slice's id, for the sidebar to fetch as a thumbnail preview via
    # the existing /api/slices/{id}/pixels endpoint - no separate
    # thumbnail-generation endpoint needed.
    thumbnail_slice_id: Optional[int] = None


class SliceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    file_name: str
    frame_index: int
    instance_number: Optional[int] = None
    slice_location: Optional[float] = None
    sort_order: int
    rows_px: Optional[int] = None
    cols_px: Optional[int] = None
    is_color: bool
    window_center: Optional[float] = None
    window_width: Optional[float] = None
    rescale_slope: float
    rescale_intercept: float


class SeriesDetail(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    series_uid: Optional[str] = None
    study_uid: Optional[str] = None
    patient_id: Optional[str] = None
    patient_name: Optional[str] = None
    modality: Optional[str] = None
    series_description: Optional[str] = None
    study_date: Optional[str] = None
    pixel_spacing: Optional[str] = None
    transfer_syntax_uid: Optional[str] = None
    slice_count: int
    created_at: Optional[datetime] = None


class SeriesDetailResponse(BaseModel):
    series: SeriesDetail
    slices: List[SliceOut]


class UploadResponse(BaseModel):
    seriesId: int
    sliceCount: int
    skipped: int


class CreatedSeries(BaseModel):
    seriesId: int
    seriesDescription: Optional[str] = None
    modality: Optional[str] = None
    sliceCount: int


class UploadZipResponse(BaseModel):
    series: List[CreatedSeries]
    skipped: int
