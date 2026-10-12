"""Image decoding, validation, resizing, and spatial point clamping utilities."""

import base64
import io
from typing import Any
from fastapi import HTTPException
from PIL import Image, UnidentifiedImageError


def decode_and_validate_image(image_b64: str) -> Image.Image:
    """Decodes base64 string and validates that it decodes into a valid JPEG or PNG.

    Raises:
        HTTPException(400): If decoding fails or format is not JPEG or PNG.
    """
    if not image_b64:
        raise HTTPException(status_code=400, detail="Missing image data")

    try:
        raw_bytes = base64.b64decode(image_b64)
    except Exception as e:
        raise HTTPException(status_code=400, detail="Invalid base64 image data") from e

    try:
        img = Image.open(io.BytesIO(raw_bytes))
        img_format = (img.format or "").upper()
        if img_format not in ("JPEG", "PNG", "MPO", "WEBP"):
            raise HTTPException(
                status_code=400,
                detail=f"Image format '{img_format}' is not supported. Must be JPEG, PNG, or WebP.",
            )
        img.load()  # Force load image to ensure integrity
        return img
    except UnidentifiedImageError as e:
        raise HTTPException(status_code=400, detail="Uploaded file does not decode as a valid image") from e
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Image decode error: {e}") from e


def resize_to_jpeg_bytes(img: Image.Image, max_long_side: int) -> bytes:
    """Resizes image preserving aspect ratio so the long side is at most max_long_side.

    Converts RGBA/grayscale to RGB and returns encoded JPEG bytes.
    """
    # Convert RGBA/Palette/Grayscale to standard RGB for JPEG output
    if img.mode != "RGB":
        img = img.convert("RGB")

    width, height = img.size
    long_side = max(width, height)

    if long_side > max_long_side:
        scale = max_long_side / float(long_side)
        new_width = max(1, int(round(width * scale)))
        new_height = max(1, int(round(height * scale)))
        img = img.resize((new_width, new_height), Image.Resampling.LANCZOS)

    out_buf = io.BytesIO()
    img.save(out_buf, format="JPEG", quality=85)
    return out_buf.getvalue()


def clamp_point_coordinates(raw_points: list[Any]) -> list[dict[str, Any]]:
    """Clamps coordinates to normalized 0-1000 range [y, x] and limits to at most 3 points."""
    clamped = []
    for item in raw_points[:3]:
        coords = item.get("point") if isinstance(item, dict) else getattr(item, "point", None)
        label = item.get("label", "") if isinstance(item, dict) else getattr(item, "label", "")

        if not coords or len(coords) < 2:
            continue

        try:
            y = max(0, min(1000, int(round(coords[0]))))
            x = max(0, min(1000, int(round(coords[1]))))
            clamped.append({"point": [y, x], "label": str(label)})
        except (ValueError, TypeError):
            continue

    return clamped
