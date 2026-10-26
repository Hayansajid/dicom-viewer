"""
Stroke segmentation inference: loads FPN + EfficientNet checkpoint,
runs on one slice, returns a native-resolution mask (0/1/2).

Test-Time Augmentation (TTA):
    Runs the model on the original slice plus horizontal and vertical flips,
    averages the softmax probabilities across all passes, then takes argmax.
    This gives a more robust prediction than a single forward pass with
    minimal cost (~3x inference time, still well under 200ms per slice).
"""
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
import segmentation_models_pytorch as smp

from .pixel_utils import read_cached_frame

WEIGHTS_PATH = Path(__file__).resolve().parent.parent / "weights" / "stroke_fpn_best.pth"

NUM_CLASSES = 3

# Brain window for CT (Hounsfield Units)
WINDOW_CENTER = 40.0
WINDOW_WIDTH = 80.0
LOWER = WINDOW_CENTER - WINDOW_WIDTH / 2.0   # 0
UPPER = WINDOW_CENTER + WINDOW_WIDTH / 2.0   # 80

# Mean/std from train_stats.json — MUST match training preprocessing.
MEAN = 0.1862
STD = 0.3235

# TTA configuration
USE_TTA = False       # master switch
TTA_HFLIP = True     # horizontal flip (was in training aug — safe)
TTA_VFLIP = True     # vertical flip (not in training — usually still helps)

_MODEL = None


def _load_model():
    """Loads and caches the stroke model in memory."""
    global _MODEL
    if _MODEL is not None:
        return _MODEL

    if not WEIGHTS_PATH.exists():
        raise FileNotFoundError(f"Stroke weights not found at {WEIGHTS_PATH}")

    ckpt = torch.load(str(WEIGHTS_PATH), map_location="cpu", weights_only=False)
    encoder = ckpt.get("encoder", "efficientnet-b0")

    model = smp.FPN(
        encoder_name=encoder,
        encoder_weights=None,
        in_channels=1,
        classes=NUM_CLASSES,
    )
    model.load_state_dict(ckpt["model_state"])
    model.eval()
    _MODEL = model
    return _MODEL


def weights_available() -> bool:
    return WEIGHTS_PATH.exists()


@torch.no_grad()
def _forward_probs(model, tensor):
    """Softmax probabilities for a single input tensor."""
    return F.softmax(model(tensor), dim=1)


def predict_stroke_mask(storage_path: str, frame_index: int) -> np.ndarray:
    """
    Runs stroke segmentation on one slice.
    Returns a (rows, cols) int8 array of class labels (0/1/2) at native resolution.
    """
    decoded = read_cached_frame(storage_path, frame_index)

    if decoded.kind != "gray":
        raise ValueError("Stroke inference expects a grayscale CT slice.")

    hu = np.frombuffer(decoded.buffer, dtype=np.float32).reshape(
        decoded.rows, decoded.cols
    )

    # 1. Brain window -> [0, 1]
    hu_win = np.clip(hu, LOWER, UPPER)
    img_norm = (hu_win - LOWER) / (UPPER - LOWER)

    # 2. Mean/std normalization — must match training
    img_norm = (img_norm - MEAN) / STD

    # 3. To tensor: (1, 1, H, W). FPN accepts any spatial size.
    t = torch.from_numpy(img_norm).unsqueeze(0).unsqueeze(0).float()

    model = _load_model()

    if not USE_TTA:
        probs = _forward_probs(model, t)
    else:
        probs_sum = _forward_probs(model, t)
        n_passes = 1

        if TTA_HFLIP:
            t_h = torch.flip(t, dims=[-1])
            p_h = _forward_probs(model, t_h)
            # Un-flip the prediction to align with the original slice
            probs_sum = probs_sum + torch.flip(p_h, dims=[-1])
            n_passes += 1

        if TTA_VFLIP:
            t_v = torch.flip(t, dims=[-2])
            p_v = _forward_probs(model, t_v)
            probs_sum = probs_sum + torch.flip(p_v, dims=[-2])
            n_passes += 1

        probs = probs_sum / n_passes

    preds = probs.argmax(dim=1)  # (1, H, W)
    return preds.squeeze(0).numpy().astype(np.int8)