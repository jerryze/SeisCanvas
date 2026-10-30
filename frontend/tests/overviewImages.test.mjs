import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const moduleURL = source => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText).toString('base64');
const source = await readFile(new URL('../src/components/SeismicViewer2D/overviewImages.ts', import.meta.url), 'utf8');
const { overviewTileRGBA, buildOverviewImages, OVERVIEW_IMAGE_PIXEL_LIMIT } = await import(moduleURL(source));
// Use the numerical functions in the installed Plotly bundle as an independent
// oracle, including its operation order. These names belong to pinned 3.7.0;
// a future bundle change must deliberately recheck this rendering contract.
const plotlyBundle = await readFile(new URL('../node_modules/plotly.js-dist-min/plotly.min.js', import.meta.url), 'utf8');
function bundledFunction(name, from = 0) {
  const start = plotlyBundle.indexOf(`function ${name}(`, from);
  assert.ok(start >= 0, `installed Plotly function ${name} was not found`);
  const body = plotlyBundle.indexOf('{', start);
  let nesting = 1, end = body + 1;
  while (nesting && end < plotlyBundle.length) {
    if (plotlyBundle[end] === '{') nesting++;
    else if (plotlyBundle[end] === '}') nesting--;
    end++;
  }
  return plotlyBundle.slice(start, end);
}
const bisectAt = plotlyBundle.indexOf('e.bisectLeft=m.left');
const plotlyNumeric = Function('yae', [
  bundledFunction('f', plotlyBundle.lastIndexOf('function f(', bisectAt)),
  bundledFunction('v', plotlyBundle.lastIndexOf('function v(', bisectAt)),
  bundledFunction('Hs', plotlyBundle.indexOf('e.interpolateNumber=Hs;')),
  bundledFunction('Mu'), bundledFunction('On'), bundledFunction('Fi'),
  bundledFunction('_ae'), bundledFunction('xae'),
  'const e = {bisect: v(f).right}; return {extract: _ae, linear: (domain, range) => (domain.length > 2 ? Fi : On)(domain, range, Mu, Hs)};',
].join('\n'))(value => value);
assert.ok(plotlyBundle.includes('Mn[0]=Math.round(Mn[0]),Mn[1]=Math.round(Mn[1]),Mn[2]=Math.round(Mn[2])'),
  'Plotly heatmap channel rounding changed; recheck the oracle');

function plotlyPixel(value, colors, minimum, maximum) {
  const { domain, range } = plotlyNumeric.extract({ min: minimum, max: maximum, colorscale: colors });
  const channels = range.map(color => [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16)));
  return [0, 1, 2].map(channel => Math.round(plotlyNumeric.linear(domain, channels.map(color => color[channel]))(value))).concat(255);
}
const style = { reverse_colormap: false, reverse_polarity: false };
const grayscale = [[0, '#000000'], [1, '#ffffff']];
const rgba = (pixels, index) => [...pixels.slice(index * 4, index * 4 + 4)];
const tile = values => ({ x_edges: Array.from({ length: values[0].length + 1 }, (_, i) => i),
  time_edges: Array.from({ length: values.length + 1 }, (_, i) => i), z: values });
const overview = () => ({
  x: [1, 3], time: [1, 3], x_edges: [0, 2, 4], time_edges: [0, 2, 4],
  z: [[-1, null], [0, 1]], raster_extent: [0, 4, 0, 4],
});
const section = (extent = [1.1, 2.7, 1.3, 3.1]) => ({
  overview: overview(), raster_extent: extent, x: [2], time: [2], z: [[null]],
  vmin: -1, vmax: 1, horizons: {},
});

function withCanvas(run) {
  const previous = globalThis.document, encoded = [];
  globalThis.document = { createElement: kind => {
    assert.equal(kind, 'canvas');
    let image;
    const canvas = { width: 0, height: 0, getContext: kind => {
      assert.equal(kind, '2d');
      return { createImageData: (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
        putImageData: (pixels, x, y) => { assert.equal(x, 0); assert.equal(y, 0); image = pixels; } };
    }, toDataURL: mime => {
      assert.equal(mime, 'image/png');
      assert.equal(image.width, canvas.width); assert.equal(image.height, canvas.height);
      encoded.push(image);
      return `data:image/png;base64,fake-${encoded.length}`;
    } };
    return canvas;
  } };
  try { return run(encoded); }
  finally { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; }
}

test('RGBA uses unclipped original scalar lookup, linear RGB, fixed limits and transparent missing samples', () => {
  const values = tile([[-2, -1, -.5, 0, .5, 1, 2, null, NaN, Infinity]]);
  const before = structuredClone(values);
  const pixels = overviewTileRGBA(values, 10, 1, grayscale, -1, 1, style);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(i => rgba(pixels, i)),
    [[0, 0, 0, 255], [0, 0, 0, 255], [64, 64, 64, 255], [128, 128, 128, 255],
      [191, 191, 191, 255], [255, 255, 255, 255], [255, 255, 255, 255]]);
  for (const index of [7, 8, 9]) assert.deepEqual(rgba(pixels, index), [0, 0, 0, 0]);
  assert.deepEqual(values, before, 'display coloring never writes into amplitude arrays');
});

test('nonuniform color stops and reversals follow the shared heatmap convention', () => {
  const values = tile([[0, .125, .25, .625, 1]]);
  const colors = [[0, '#000'], [.25, '#ff0000'], [1, '#ffffff']];
  const expected = [[0, 0, 0, 255], [128, 0, 0, 255], [255, 0, 0, 255], [255, 128, 128, 255], [255, 255, 255, 255]];
  assert.deepEqual(Array.from({ length: 5 }, (_, i) => rgba(overviewTileRGBA(values, 5, 1, colors, 0, 1, style), i)), expected);
  const reversedColors = colors.map((stop, index) => [stop[0], colors.at(-1 - index)[1]]);
  assert.deepEqual(overviewTileRGBA(values, 5, 1, colors, 0, 1, { ...style, reverse_colormap: true }),
    overviewTileRGBA(values, 5, 1, reversedColors, 0, 1, style));
  assert.deepEqual(overviewTileRGBA(values, 5, 1, colors, -1, 0, { ...style, reverse_polarity: true }),
    overviewTileRGBA(tile([[0, -.125, -.25, -.625, -1]]), 5, 1, colors, -1, 0, style));
});

test('RGBA matches installed Plotly arithmetic at descending RGB ties and manual-domain boundaries', () => {
  const descending = [[0, '#ffffff'], [1, '#000000']];
  assert.deepEqual(plotlyPixel(.9, descending, 0, 1), [25, 25, 25, 255]);
  assert.deepEqual(rgba(overviewTileRGBA(tile([[.9]]), 1, 1, descending, 0, 1, style), 0), [25, 25, 25, 255]);
  for (const [minimum, maximum, colors] of [
    [0, 1, descending],
    [321.25, 896.75, [[0, '#ff00a1'], [.13, '#0011ff'], [.82, '#caef00'], [1, '#ffffff']]],
    [-9569.125, 7.3, [[0, '#d0c0b0'], [.001, '#001122'], [.81, '#ffff00'], [1, '#010203']]],
  ]) {
    const domain = colors.map(([stop]) => minimum + stop * (maximum - minimum));
    const values = [minimum - 100, maximum + 100];
    for (let i = 1; i < domain.length; i++) for (const ratio of [0, .1, .5, .9, 1]) {
      const value = domain[i - 1] + ratio * (domain[i] - domain[i - 1]);
      const epsilon = Math.max(1, Math.abs(value)) * Number.EPSILON;
      values.push(value - epsilon, value, value + epsilon);
    }
    for (const reverse_colormap of [false, true]) for (const reverse_polarity of [false, true]) {
      const effectiveColors = reverse_colormap ? colors.map(([stop], i) => [stop, colors.at(-1 - i)[1]]) : colors;
      const pixels = overviewTileRGBA(tile([values]), values.length, 1, colors, minimum, maximum, { reverse_colormap, reverse_polarity });
      values.forEach((value, i) => assert.deepEqual(rgba(pixels, i),
        plotlyPixel(reverse_polarity ? -value : value, effectiveColors, minimum, maximum),
        `Plotly color mismatch at ${value} in [${minimum}, ${maximum}]`));
    }
  }
});

test('physical edge lookup handles irregular cells and preserves top-to-bottom time direction', () => {
  const values = { x_edges: [0, 1, 4], time_edges: [10, 11, 14], z: [[0, 1], [.5, null]] };
  const pixels = overviewTileRGBA(values, 4, 4, grayscale, 0, 1, style);
  assert.deepEqual(rgba(pixels, 0), [0, 0, 0, 255]);
  for (const index of [1, 2, 3]) assert.deepEqual(rgba(pixels, index), [255, 255, 255, 255]);
  for (const index of [4, 8, 12]) assert.deepEqual(rgba(pixels, index), [128, 128, 128, 255]);
  for (const index of [5, 6, 7, 9, 10, 11, 13, 14, 15]) assert.deepEqual(rgba(pixels, index), [0, 0, 0, 0]);
});

test('one full-world PNG remains available below the separately masked precise bitmap', () => withCanvas(encoded => {
  const data = section(), before = structuredClone(data);
  const images = buildOverviewImages(data, { seismic: style }, grayscale);
  assert.equal(images.length, 1);
  assert.equal(encoded.length, 1);
  assert.ok(encoded.reduce((sum, image) => sum + image.width * image.height, 0) <= OVERVIEW_IMAGE_PIXEL_LIMIT);
  for (const image of images) {
    assert.equal(image.xref, 'x'); assert.equal(image.yref, 'y');
    assert.equal(image.xanchor, 'left'); assert.equal(image.yanchor, 'top');
    assert.equal(image.sizing, 'stretch'); assert.equal(image.layer, 'below'); assert.equal(image.opacity, 1);
    assert.match(image.source, /^data:image\/png/);
    assert.deepEqual([image.x, image.y, image.sizex, image.sizey], [0, 0, 4, 4],
      'coverage follows the full source; the fine bitmap mask handles its actual current bounds');
  }
  assert.equal(images[0].y, 0, 'PNG row zero anchors to the smallest time on the reversed axis');
  assert.deepEqual(data, before);
}));

test('image cache survives viewport-only calls and invalidates source, palette or reverse settings', () => withCanvas(encoded => {
  const data = section();
  const first = buildOverviewImages(data, { seismic: style }, grayscale);
  assert.equal(encoded.length, 1);
  assert.equal(buildOverviewImages(data, { seismic: { ...style, wiggle_gain: 2 } }, grayscale), first);
  assert.equal(encoded.length, 1, 'no repeated canvas encoding for a pan or irrelevant style edit');
  assert.equal(buildOverviewImages({ ...data, raster_extent: [2, 3, 2, 3], z: [[.123]] }, { seismic: style }, grayscale), first);
  assert.equal(encoded.length, 1, 'new precise windows share the same complete source overview PNG');
  const reversed = buildOverviewImages(data, { seismic: { ...style, reverse_colormap: true } }, grayscale);
  assert.notEqual(reversed, first); assert.equal(encoded.length, 2);
  assert.equal(buildOverviewImages(data, { seismic: { ...style, reverse_colormap: true } }, grayscale), reversed);
  buildOverviewImages(data, { seismic: { ...style, reverse_polarity: true } }, grayscale);
  assert.equal(encoded.length, 3);
  buildOverviewImages(data, { seismic: style }, [[0, '#000000'], [1, '#ff0000']]);
  assert.equal(encoded.length, 4);
  assert.notEqual(buildOverviewImages(data, { seismic: style }, grayscale), first);
  assert.equal(encoded.length, 5, 'only the most recent palette is retained per overview');
  buildOverviewImages({ ...data, vmin: -2 }, { seismic: style }, grayscale);
  assert.equal(encoded.length, 6);
  buildOverviewImages({ ...data, overview: overview() }, { seismic: style }, grayscale);
  assert.equal(encoded.length, 7, 'a new source overview gets an independent image');
}));

test('full precise coverage still keeps its overview, while missing colors and horizon-only content do not', () => withCanvas(encoded => {
  assert.equal(buildOverviewImages(section([0, 4, 0, 4]), { seismic: style }, grayscale).length, 1);
  assert.deepEqual(buildOverviewImages(section(), { seismic: style }, []), []);
  assert.deepEqual(buildOverviewImages({ ...section(), has_seismic: false }, { seismic: style }, grayscale), []);
  assert.deepEqual(buildOverviewImages({ ...section(), overview: undefined }, { seismic: style }, grayscale), []);
  assert.deepEqual(buildOverviewImages({ ...section(), vmin: null }, { seismic: style }, grayscale), []);
  assert.deepEqual(buildOverviewImages(section(), { seismic: style }, [[0, 'invalid']]), []);
  assert.equal(encoded.length, 1);
}));

test('offscreen, thin and partial fine windows always use one fixed-budget full-world image', () => withCanvas(encoded => {
  for (const extent of [[5, 6, 5, 6], [1.9999, 2.0001, 1.9999, 2.0001],
    [.00001, 3.99999, .00001, 3.99999], [-1, 3.99, -1, 3.99], [.13, 2.17, 1.37, 3.89]]) {
    const start = encoded.length;
    const images = buildOverviewImages(section(extent), { seismic: style }, grayscale);
    assert.equal(images.length, 1);
    const current = encoded.slice(start);
    assert.ok(current.every(image => image.width <= 512 && image.height <= 256));
    assert.equal(current.reduce((sum, image) => sum + image.width * image.height, 0), OVERVIEW_IMAGE_PIXEL_LIMIT);
    assert.deepEqual([images[0].x, images[0].y, images[0].sizex, images[0].sizey], [0, 0, 4, 4]);
  }
}));

test('pure RGBA helper rejects unbounded allocations and does not require the DOM', () => {
  assert.throws(() => overviewTileRGBA(tile([[1]]), 513, 256, grayscale, 0, 1, style), RangeError);
  assert.throws(() => overviewTileRGBA(tile([[1]]), 512, 257, grayscale, 0, 1, style), RangeError);
  assert.throws(() => overviewTileRGBA(tile([[1]]), 1.5, 1, grayscale, 0, 1, style), RangeError);
  assert.deepEqual(rgba(overviewTileRGBA(tile([[1]]), 1, 1, grayscale, 0, 1, style), 0), [255, 255, 255, 255]);
});
