"""Compatibility facade for the former monolith, now split into focused modules.

The original ``core.py`` mixed SEG-Y access, horizon parsing, styling and
rendering.  The pieces now live in ``backend.style``, ``backend.segy``,
``backend.horizon`` and ``backend.rendering``; this module keeps existing
imports (the test suite included) working until they are migrated.  New code
should import from those modules directly.
"""

from backend.style import CMAPS, CUSTOM_CMAPS, font_family, get_cmap
from backend.segy import LOCK, ArrayCache, Survey
from backend.horizon import Horizon, horizon_preview
from backend.rendering import (
    EXPORT_MAX_UPSCALE,
    VIEW_TARGET,
    amplitude,
    display_raster,
    render,
    window_indices,
)
