from sqlalchemy import (
    Column, Integer, String, Float, Boolean, ForeignKey, TIMESTAMP, func
)
from sqlalchemy.orm import relationship
from .db import Base


class Series(Base):
    __tablename__ = "series"

    id = Column(Integer, primary_key=True, autoincrement=True)
    series_uid = Column(String(128), nullable=True)
    modality = Column(String(16), nullable=True)
    series_description = Column(String(255), nullable=True)
    study_date = Column(String(10), nullable=True)
    pixel_spacing = Column(String(32), nullable=True)
    transfer_syntax_uid = Column(String(255), nullable=True)
    slice_count = Column(Integer, nullable=False, default=0)
    created_at = Column(TIMESTAMP, server_default=func.now())

    slices = relationship(
        "Slice", back_populates="series", cascade="all, delete-orphan"
    )


class Slice(Base):
    __tablename__ = "slices"

    id = Column(Integer, primary_key=True, autoincrement=True)
    series_id = Column(Integer, ForeignKey("series.id", ondelete="CASCADE"), nullable=False)
    file_name = Column(String(255), nullable=False)
    storage_path = Column(String(512), nullable=False)
    frame_index = Column(Integer, nullable=False, default=0)
    instance_number = Column(Integer, nullable=True)
    slice_location = Column(Float, nullable=True)
    sort_order = Column(Integer, nullable=False)
    rows_px = Column(Integer, nullable=True)
    cols_px = Column(Integer, nullable=True)
    is_color = Column(Boolean, nullable=False, default=False)
    window_center = Column(Float, nullable=True)
    window_width = Column(Float, nullable=True)
    rescale_slope = Column(Float, nullable=False, default=1)
    rescale_intercept = Column(Float, nullable=False, default=0)

    series = relationship("Series", back_populates="slices")
