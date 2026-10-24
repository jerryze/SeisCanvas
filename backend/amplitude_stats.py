"""Exact amplitude percentiles with bounded memory and replayable sources.

The large-data path uses 16-bit radix selection of IEEE floating-point (or
integer) order statistics. Every pass consumes bounded blocks; it never copies
the full collection, partitions a memory-mapped file, or approximates a rank.
Sources must yield the same values on every ``iter_blocks`` call.
"""
from __future__ import annotations

import numpy as np


# Leave room for generator overlap, a source's incoming float64 block, radix
# masks, and NumPy's bincount conversion within an ~8 MiB working allowance.
BLOCK_ELEMENTS = 131_072
SMALL_BUFFER_BYTES = 2 * 1024 * 1024


def _sources(sources):
    if isinstance(sources, np.ndarray) or hasattr(sources, "iter_blocks"):
        return [sources]
    return list(sources)


def _chunks(sources):
    for source in sources:
        if isinstance(source, np.ndarray):
            # Reshaping a strided input can copy its entire contents. Buffered
            # nditer also bounds copies of transposed, reversed and mmap inputs.
            with np.nditer(source, flags=["external_loop", "buffered", "zerosize_ok"],
                           op_flags=["readonly"], order="C", buffersize=BLOCK_ELEMENTS) as iterator:
                yield from iterator
        else:
            # Sparse time grids may omit geometric NaN holes while retaining
            # every effective data value. Selection/rank semantics are unchanged
            # because the full-grid path filters those same holes as nonfinite.
            iterate = getattr(source, "iter_amplitude_blocks", None) or source.iter_blocks
            for block in iterate(max_elements=BLOCK_ELEMENTS):
                block = np.asarray(block)
                if block.size > BLOCK_ELEMENTS:
                    raise ValueError("Amplitude source exceeded its requested block size.")
                yield block


def _values(sources, dtype, seismic):
    for block in _chunks(sources):
        # Cast to the joint dtype BEFORE polarity/abs, matching concatenate.
        # Own this bounded allocation: radix selection may overwrite its bits.
        values = np.array(block, dtype=dtype, copy=True, order="C").reshape(-1)
        if seismic.reverse_polarity:
            np.negative(values, out=values)
        finite = np.isfinite(values)
        if not finite.all():
            values = values[finite]
        if seismic.symmetric:
            np.absolute(values, out=values)
        if values.size:
            yield values


def _sortable_keys(values):
    """Turn an owned native array into unsigned keys ordered by numeric value."""
    dtype = values.dtype
    unsigned = np.dtype(f"u{dtype.itemsize}")
    keys = values.view(unsigned)
    sign = 1 << (8 * dtype.itemsize - 1)
    if dtype.kind == "f":
        negative = np.signbit(values)
        np.bitwise_not(keys, out=keys, where=negative)
        np.logical_not(negative, out=negative)
        np.bitwise_xor(keys, sign, out=keys, where=negative)
    elif dtype.kind == "i":
        np.bitwise_xor(keys, sign, out=keys)
    return keys


def _from_key(key, dtype):
    bits = 8 * dtype.itemsize
    sign = 1 << (bits - 1)
    if dtype.kind == "f":
        key = key ^ sign if key & sign else key ^ ((1 << bits) - 1)
    elif dtype.kind == "i":
        key ^= sign
    return np.array([key], dtype=f"u{dtype.itemsize}").view(dtype)[0]


def _accumulate_histograms(values, histograms, shift, *, first, digit_bits):
    keys = _sortable_keys(values)
    digits = np.empty(keys.size, dtype=np.uint16 if digit_bits == 16 else np.uint8)
    np.right_shift(keys, shift, out=digits, casting="unsafe")
    for prefix, histogram in histograms.items():
        selected = digits if first else digits[(keys >> (shift + digit_bits)) == prefix]
        histogram += np.bincount(selected, minlength=1 << digit_bits)


def _select(sources, dtype, seismic, ranks, first_histogram):
    # A task contains absolute output ranks and ranks within its current prefix.
    tasks = {0: [(rank, rank) for rank in sorted(set(ranks))]}
    digit_bits = min(16, dtype.itemsize * 8)
    bins = 1 << digit_bits
    top_shift = dtype.itemsize * 8 - digit_bits
    for shift in range(top_shift, -1, -digit_bits):
        if shift == top_shift:
            histograms = {0: first_histogram}
        else:
            histograms = {prefix: np.zeros(bins, dtype=np.int64) for prefix in tasks}
            for values in _values(sources, dtype, seismic):
                _accumulate_histograms(values, histograms, shift, first=False, digit_bits=digit_bits)
        following = {}
        for prefix, wanted in tasks.items():
            cumulative = np.cumsum(histograms[prefix])
            for original, rank in wanted:
                digit = int(np.searchsorted(cumulative, rank, side="right"))
                if digit >= bins:
                    raise ValueError("Amplitude source changed while computing its percentile.")
                before = int(cumulative[digit - 1]) if digit else 0
                following.setdefault((prefix << digit_bits) | digit, []).append((original, rank - before))
        tasks = following
    return {original: _from_key(key, dtype) for key, wanted in tasks.items() for original, _ in wanted}


def _interpolate(selected, count, percentiles, dtype):
    # NumPy's linear percentile computes b-a in the INPUT dtype, then
    # interpolates in float64. Keep that order, including native overflow and
    # the upper-half subtraction used to avoid cancellation.
    positions = (count - 1) * (np.asarray(percentiles, dtype=np.float64) / 100)
    lower = np.floor(positions).astype(np.int64)
    upper = np.minimum(lower + 1, count - 1)
    a = np.array([selected[int(rank)] for rank in lower], dtype=dtype)
    b = np.array([selected[int(rank)] for rank in upper], dtype=dtype)
    fraction = positions - lower
    difference = np.subtract(b, a)
    result = np.asarray(a + difference * fraction)
    np.subtract(b, difference * (1 - fraction), out=result, where=fraction >= 0.5)
    return result


def amplitude_limits(sources, seismic, *, omit_empty_sources=False):
    """Match ``rendering.amplitude(concatenate(sources), seismic)[1:]``.

    Each source is an ndarray or an object with ``dtype``, ``shape`` and a
    replayable ``iter_blocks(max_elements=...)`` method. An optional
    ``iter_amplitude_blocks`` is preferred for statistics; it may omit only
    nonfinite geometric holes, preserving every effective finite sample.
    Source blocks never
    exceed 131072 elements. All supplied dtypes participate in promotion, even
    for empty/nonfinite sources, unless ``omit_empty_sources=True``. That option
    scans sources until their first finite sample and omits entirely nonfinite
    sources before dtype promotion, matching finite-only scene concatenation.
    With float64 inputs, working storage is
    bounded to approximately 8 MiB, independent of total source size; this
    excludes arrays already owned by the caller/source implementation.
    """
    if seismic.clip_mode == "manual":
        if seismic.vmin is None or seismic.vmax is None or seismic.vmin >= seismic.vmax:
            raise ValueError("Manual amplitude minimum must be less than maximum.")
        return seismic.vmin, seismic.vmax
    sources = _sources(sources)
    if omit_empty_sources:
        sources = [source for source in sources
                   if any(np.isfinite(block).any() for block in _chunks([source]))]
    dtype = np.result_type(*(source.dtype for source in sources)) if sources else np.dtype("f8")
    dtype = dtype.newbyteorder("=")
    if dtype.kind not in "fiu" or dtype.itemsize not in (1, 2, 4, 8) or dtype.kind == "f" and dtype.itemsize == 1:
        raise TypeError("Amplitude statistics require real float16/32/64 or integer samples.")
    percentiles = [seismic.clip_percentile] if seismic.symmetric else [
        (100 - seismic.clip_percentile) / 2, 100 - (100 - seismic.clip_percentile) / 2]
    capacity = max(1, SMALL_BUFFER_BYTES // dtype.itemsize)
    buffer = np.empty(capacity, dtype=dtype)
    first_histogram = None
    digit_bits = min(16, dtype.itemsize * 8)
    top_shift = dtype.itemsize * 8 - digit_bits
    count = 0
    minimum = maximum = None
    for values in _values(sources, dtype, seismic):
        size = values.size
        lo, hi = values.min(), values.max()
        minimum = lo if minimum is None else min(minimum, lo)
        maximum = hi if maximum is None else max(maximum, hi)
        if buffer is not None:
            if count + size <= capacity:
                buffer[count:count + size] = values
            else:
                # Start the first radix histogram only once the exact small
                # buffer overflows. Reuse its already-transformed values and
                # continue counting high bits during this same initial pass.
                first_histogram = np.zeros(1 << digit_bits, dtype=np.int64)
                for offset in range(0, count, BLOCK_ELEMENTS):
                    _accumulate_histograms(buffer[offset:min(count, offset + BLOCK_ELEMENTS)],
                                           {0: first_histogram}, top_shift, first=True, digit_bits=digit_bits)
                buffer = None
        if buffer is None:
            _accumulate_histograms(values, {0: first_histogram}, top_shift, first=True, digit_bits=digit_bits)
        count += size
    # Do not retain the final scan block alongside the radix work arrays.
    values = None
    if count == 0:
        result = np.percentile(np.array([0.0]), percentiles)
    elif buffer is not None:
        result = np.percentile(buffer[:count], percentiles)
    elif minimum == maximum:
        result = np.percentile(np.array([minimum], dtype=dtype), percentiles)
    else:
        positions = (count - 1) * (np.asarray(percentiles, dtype=np.float64) / 100)
        lower = np.floor(positions).astype(np.int64)
        ranks = [int(rank) for rank in np.concatenate((lower, np.minimum(lower + 1, count - 1)))]
        selected = _select(sources, dtype, seismic, ranks, first_histogram)
        result = _interpolate(selected, count, percentiles, dtype)
    if seismic.symmetric:
        hi = float(result[0]) or 1.0
        return -hi, hi
    lo, hi = result.tolist()
    return (lo - 1, hi + 1) if hi == lo else (lo, hi)
