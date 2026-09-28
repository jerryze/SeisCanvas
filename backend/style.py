"""Viewer and publication styling shared by every renderer: colormaps and fonts."""

import matplotlib

matplotlib.use("Agg")
from matplotlib import colormaps
from matplotlib.colors import LinearSegmentedColormap

# A muted diverging ramp matching the supplied Pos / 0 / Neg reference:
# positive amplitudes are red, zero is near-white, and negative amplitudes are blue.
# The stops are sampled from that reference colorbar (every 5% of its length), so
# the ramp reproduces its curved blue shoulder and dark, slightly desaturated ends.
CUSTOM_CMAPS = {
    "red_white_blue": LinearSegmentedColormap.from_list(
        "red_white_blue",
        [
            (0.00, "#23238e"),
            (0.05, "#2f3294"),
            (0.10, "#444a9d"),
            (0.15, "#575fa6"),
            (0.20, "#6b75af"),
            (0.25, "#7e8cb9"),
            (0.30, "#91a1c3"),
            (0.35, "#a4b9cb"),
            (0.40, "#b7cfd3"),
            (0.45, "#dbe8e9"),
            (0.50, "#ffffff"),
            (0.55, "#ffede9"),
            (0.60, "#f7d7d3"),
            (0.65, "#e8b8b7"),
            (0.70, "#da9e9e"),
            (0.75, "#cc7f7e"),
            (0.80, "#be6868"),
            (0.85, "#af4546"),
            (0.90, "#a22e2e"),
            (0.95, "#93100f"),
            (1.00, "#8c0000"),
        ],
    ),
    # Schlumberger Petrel-style cyan-blue-white-red-yellow ramp (cigvis definition).
    "petrel": LinearSegmentedColormap(
        "petrel",
        {
            "red": [
                (0.0, 0.6313725490196078, 0.6313725490196078),
                (0.33, 0.0, 0.0),
                (0.4, 0.30196078431372547, 0.30196078431372547),
                (0.5, 0.8, 0.8),
                (0.6, 0.3803921568627451, 0.3803921568627451),
                (0.67, 0.7490196078431373, 0.7490196078431373),
                (1.0, 1.0, 1.0),
            ],
            "green": [
                (0.0, 1.0, 1.0),
                (0.33, 0.0, 0.0),
                (0.4, 0.30196078431372547, 0.30196078431372547),
                (0.5, 0.8, 0.8),
                (0.6, 0.27058823529411763, 0.27058823529411763),
                (0.67, 0.0, 0.0),
                (1.0, 1.0, 1.0),
            ],
            "blue": [
                (0.0, 1.0, 1.0),
                (0.33, 0.7490196078431373, 0.7490196078431373),
                (0.4, 0.30196078431372547, 0.30196078431372547),
                (0.5, 0.8, 0.8),
                (0.6, 0.0, 0.0),
                (0.67, 0.0, 0.0),
                (1.0, 0.0, 0.0),
            ],
        },
    ),
}
CMAPS = [
    "gray",
    "Greys",
    "binary",
    "seismic",
    "red_white_blue",
    "petrel",
    "RdBu",
    "coolwarm",
    "viridis",
    "turbo",
]


def get_cmap(name, reverse=False):
    """Return a built-in or application-defined colormap."""
    cmap = CUSTOM_CMAPS.get(name)
    if cmap is None:
        cmap = colormaps[name]
    return cmap.reversed() if reverse else cmap


def font_family(name):
    """Matplotlib family list: the requested face, then a matching bundled one.

    Times New Roman and Arial are system fonts, so a machine without them falls
    back to a serif or sans face instead of Matplotlib's default with a warning.
    """
    if not name:
        return ["DejaVu Sans"]
    serif = "Times" in name or "Serif" in name
    return [name, "DejaVu Serif" if serif else "DejaVu Sans"]
