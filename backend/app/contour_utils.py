"""
Convert a class mask (0/1/2) into polygon outlines for the frontend overlay.
"""
import cv2
import numpy as np

# Ignore specks smaller than this (pixels)
MIN_CONTOUR_AREA = 20
# Polygon simplification tolerance (pixels). Higher = fewer points per polygon.
APPROX_EPSILON = 1.5


def mask_to_contours(mask: np.ndarray) -> dict:
    """
    Convert a (rows, cols) int8 mask with classes 0/1/2 into polygon lists.
    Returns:
        {
          "core":     [[[x, y], [x, y], ...], ...],
          "penumbra": [[[x, y], [x, y], ...], ...]
        }
    Coordinates are in pixel space: x = column, y = row.
    """
    result = {"core": [], "penumbra": []}

    for class_id, key in ((1, "core"), (2, "penumbra")):
        binary = (mask == class_id).astype(np.uint8)
        if binary.sum() == 0:
            continue

        contours, _ = cv2.findContours(
            binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )

        polygons = []
        for c in contours:
            if cv2.contourArea(c) < MIN_CONTOUR_AREA:
                continue
            approx = cv2.approxPolyDP(c, epsilon=APPROX_EPSILON, closed=True)
            pts = approx.reshape(-1, 2).tolist()  # [[x, y], ...]
            if len(pts) >= 3:
                polygons.append(pts)

        result[key] = polygons

    return result