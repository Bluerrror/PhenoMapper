/*******************************************************************************
 *  PhenoMapper — Crop Phenology of Germany (2017–2021)
 *  ---------------------------------------------------------------------------
 *  Interactive Google Earth Engine viewer for the paper:
 *
 *    Shojaeezadeh, S. A., Elnashar, A., & Weber, T. K. D. (2025).
 *    "A novel fusion of Sentinel-1 and Sentinel-2 with climate data for
 *     crop phenology estimation using Machine Learning."
 *    Science of Remote Sensing, 11, 100227.
 *    https://doi.org/10.1016/j.srs.2025.100227
 *
 *  A LightGBM model fuses Sentinel-1 (radar), Sentinel-2 (optical) and
 *  high-resolution climate data to predict 13 BBCH growth stages for 8 major
 *  crops across Germany at 20 m resolution (2017–2021), validated against the
 *  DWD German phenological network (R2 > 0.43, MAE ~6 days).
 *
 *  Features
 *    • Synced split-map: Crop Type Map (left) vs. predicted Day-of-Year (right)
 *    • Click ANY field on either map → per-field phenology profile
 *    • Chart plots the real CALENDAR DATE (x) vs. BBCH stage (y); winter crops
 *      are correctly placed with sowing/emergence in the PREVIOUS autumn
 *    • Winter vs. summer/spring season logic detected from the crop type
 *    • BBCH growth-stage schematic (visual crop-growth shape)
 *    • User-selectable scientific colorbar with Day-of-Year + month ticks
 *
 *  Assets expected in the Code Editor Imports:
 *    CTM  — Crop Type Map ImageCollection (band 'b1' = crop code)
 *    FH   — Frankenhausen study-site geometry (Univ. Kassel)
 *  Contact: shahab@uni-kassel.de
 ******************************************************************************/


// ============================================================================
//  0. THEME
// ============================================================================
var THEME = {
  brand:     '#1b5e20', brandDark: '#0d3d13', accent: '#43a047',
  gold:      '#c9a227',  ink:      '#263238', sub:    '#546e7a',
  line:      '#dfe6e0',  panelBg:  '#ffffff', softBg: '#f2f7f2',
  chipBg:    '#eaf3ea',  white:    '#ffffff', mark:   '#ff1744'
};
var FONT   = 'Roboto, Arial, sans-serif';
var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
var DOYCUM = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];


// ============================================================================
//  1. STUDY AREA & DATA
// ============================================================================
var ASSET_ROOT = 'projects/ee-shahab2710/assets/Phenology/';
var DOY_BAND   = 'classification';

var AOI = ee.FeatureCollection('FAO/GAUL/2015/level0')
            .filterMetadata('ADM0_NAME', 'equals', 'Germany');

var vPoly_AOI = ee.Image().toByte().paint(AOI, 2, 2);
var vPoly_FH  = ee.Image().toByte().paint(FH,  1, 3);


// ============================================================================
//  2. COLOR PALETTES  (user-selectable scientific colorbars)
// ============================================================================
var PALETTES = {
  'Viridis (default)': [
    '#440154', '#472d7b', '#3b528b', '#2c728e', '#21918c',
    '#28ae80', '#5ec962', '#addc30', '#fde725'],
  'Turbo': [
    '#30123b', '#4145ab', '#4675ed', '#39a2fc', '#1bcfd4', '#24eca6',
    '#61fc6c', '#a4fc3b', '#d1e834', '#f3c63a', '#fe9b2d', '#f36315',
    '#cb2a04', '#7a0403'],
  'Magma': [
    '#000004', '#1c1044', '#4f127b', '#812581', '#b5367a',
    '#e55064', '#fb8761', '#fec287', '#fcfdbf'],
  'Seasonal (spring→autumn)': [
    '#2c7bb6', '#00a6ca', '#7bc043', '#a8d600', '#f4d03f',
    '#f5a623', '#e07b39', '#d7191c']
};
var DEFAULT_PALETTE = 'Viridis (default)';


// ============================================================================
//  3. BBCH GROWTH STAGES  (predicted by PhenoMapper)
// ============================================================================
// min/max = typical Day-of-Year range per stage → the colorbar is set instantly
// (no server-side percentile), which keeps year/stage switching very fast.
var BBCH_STAGES = [
  {value: '0',  code: 0,  label: 'BBCH 00 · Sowing',   short: 'Sowing',    desc: 'Sowing / dry seed', min: 60,  max: 320},
  {value: '10', code: 10, label: 'BBCH 10 · Emergence', short: 'Emergence', desc: 'Leaf development — first leaf visible', min: 90, max: 330},
  {value: '51', code: 51, label: 'BBCH 51 · Heading',   short: 'Heading',   desc: 'Inflorescence / heading — flowering onset', min: 120, max: 215},
  {value: '53', code: 53, label: 'BBCH 53 · Heading +', short: 'Heading+',  desc: 'Inflorescence emergence — heading progressing', min: 120, max: 220},
  {value: '87', code: 87, label: 'BBCH 87 · Ripening',  short: 'Ripening',  desc: 'Hard dough — grain ripening', min: 175, max: 238},
  {value: '89', code: 89, label: 'BBCH 89 · Maturity',  short: 'Maturity',  desc: 'Full ripeness — ready to harvest', min: 185, max: 255}
];
function stageRange(code) {
  for (var i = 0; i < BBCH_STAGES.length; i++)
    if (BBCH_STAGES[i].value === String(code)) return {min: BBCH_STAGES[i].min, max: BBCH_STAGES[i].max};
  return {min: 100, max: 250};
}
// Diverging palette for anomaly maps (earlier ← blue · white · red → later).
var DIVERGING = ['#2166ac', '#67a9cf', '#d1e5f0', '#f7f7f7', '#fddbc7', '#ef8a62', '#b2182b'];
// Right-map layer modes (derived products from the phenology data).
var MAP_MODES = [
  {value: 'doy',  label: 'BBCH stage · Day of Year'},
  {value: 'gsl',  label: 'Season length (emergence→maturity)'},
  {value: 'mean', label: '5-year mean · this stage'},
  {value: 'anom', label: 'Anomaly (year − 5-yr mean)'}
];
function bbchLabel(code) {
  for (var i = 0; i < BBCH_STAGES.length; i++)
    if (BBCH_STAGES[i].value === String(code)) return BBCH_STAGES[i].label;
  return 'BBCH ' + code;
}
function bbchDesc(code) {
  for (var i = 0; i < BBCH_STAGES.length; i++)
    if (BBCH_STAGES[i].value === String(code)) return BBCH_STAGES[i].desc;
  return '';
}

// Idealised BBCH principal growth stages (0–9) for the schematic. Bar height
// = relative canopy/biomass: it rises to heading/flowering, then senesces.
var GROWTH = [
  {b: '0', name: 'Germination',    h: 6,  c: '#8d6e63'},
  {b: '1', name: 'Leaf develop.',  h: 16, c: '#66bb6a'},
  {b: '2', name: 'Tillering',      h: 27, c: '#4caf50'},
  {b: '3', name: 'Stem elong.',    h: 45, c: '#43a047'},
  {b: '4', name: 'Booting',        h: 60, c: '#388e3c'},
  {b: '5', name: 'Heading',        h: 74, c: '#7cb342'},
  {b: '6', name: 'Flowering',      h: 82, c: '#c0ca33'},
  {b: '7', name: 'Milk / dough',   h: 86, c: '#d4b106'},
  {b: '8', name: 'Ripening',       h: 88, c: '#c9a227'},
  {b: '9', name: 'Senescence',     h: 66, c: '#a1704a'}
];
var PREDICTED_PRINCIPALS = {0: true, 1: true, 5: true, 8: true};  // 00,10,51,87/89


// ============================================================================
//  4. CROP CATALOG & CROP TYPE MAP (CTM)
// ============================================================================
var CROPS = [
  {name: 'Winter wheat',    code: 1101, color: '#FBFB16', season: 'winter'},
  {name: 'Winter barley',   code: 1102, color: '#E4CE3F', season: 'winter'},
  {name: 'Winter rye',      code: 1103, color: '#EA7F12', season: 'winter'},
  {name: 'Spring barley',   code: 1201, color: '#C24B2D', season: 'summer'},
  {name: 'Spring oat',      code: 1202, color: '#B41717', season: 'summer'},
  {name: 'Maize',           code: 1300, color: '#37EDD8', season: 'summer'},
  {name: 'Sugar beet',      code: 1402, color: '#9A0CEE', season: 'summer'},
  {name: 'Winter rapeseed', code: 1501, color: '#EE439C', season: 'winter'}
];
var dict = {
  names:  CROPS.map(function (c) { return c.name; }),
  colors: CROPS.map(function (c) { return c.color; })
};
function findCrop(code) {                       // returns null for unknown codes
  for (var i = 0; i < CROPS.length; i++) if (CROPS[i].code === Number(code)) return CROPS[i];
  return null;
}
function cropOrFirst(code) { return findCrop(code) || CROPS[0]; }

function remapper(image) {
  return image.remap(
    [200, 1101, 1102, 1103, 1201, 1202, 1300, 1401, 1402, 1501, 1502,
     1602, 1603, 1611, 1612, 1613, 1614, 3001, 3002, 3003, 3004, 4001, 4002, 4003],
    [1,   2,    3,    4,    5,    6,    7,    8,    9,    10,   11,
     12,   13,   14,   15,   16,   17,   18,   19,   20,   21,   22,   23,   24]);
}
function ctmBands(year) {
  return CTM.filterDate(year + '-01-01', year + '-12-31').select('b1').toBands();
}
function cropMaskAll(year) {
  var b = ctmBands(year);
  var mask = b.eq(1101).or(b.eq(1102)).or(b.eq(1103)).or(b.eq(1201))
             .or(b.eq(1202)).or(b.eq(1300)).or(b.eq(1402)).or(b.eq(1501));
  return CTM.filterDate(year + '-01-01', year + '-12-31')
            .map(function (im) { return im.updateMask(mask); });
}
// Simple Germany bounding box — a light geometry for fast percentile stretches.
var GERMANY_BBOX = ee.Geometry.Rectangle([5.8, 47.2, 15.1, 55.1]);

// Single crop-type image per year (mosaic with a real projection) — far cheaper
// than toBands()+reduce() for masks, which is what made "highlight" slow.
var _ctmCache = {};
function ctmYearImg(year) {
  if (_ctmCache[year]) return _ctmCache[year];
  var col = CTM.filterDate(year + '-01-01', year + '-12-31').select('b1');
  var img = col.mosaic().setDefaultProjection(col.first().projection());
  _ctmCache[year] = img;
  return img;
}
function focusMaskImg(year) {
  var b = ctmYearImg(year);
  return b.eq(1101).or(b.eq(1102)).or(b.eq(1103)).or(b.eq(1201))
          .or(b.eq(1202)).or(b.eq(1300)).or(b.eq(1402)).or(b.eq(1501));
}
function cropMaskSingle(year, code) {
  return ctmYearImg(year).eq(Number(code)).selfMask();
}

// Zoom-aware display resolution: at national zoom, aggregate to a coarse grid so
// tiles render fast AND sparse fields fill in (instead of scattered pixels).
function scaleForZoom(z) {
  if (z == null) return 0;
  if (z <= 6) return 1500;
  if (z <= 7) return 800;
  if (z <= 8) return 400;
  if (z <= 9) return 200;
  return 0;                       // z >= 10 → native full resolution
}
function coarsen(img, reducer, s) {
  if (!s) return img;
  return img.setDefaultProjection('EPSG:3857', null, 20)
            .reduceResolution({reducer: reducer, maxPixels: 1024, bestEffort: true})
            .reproject({crs: 'EPSG:3857', scale: s});
}


// ============================================================================
//  5. MAPS  — synced split panel
// ============================================================================
var leftMap  = ui.Map();
var rightMap = ui.Map();
leftMap.setOptions('SATELLITE');
rightMap.setOptions('SATELLITE');
leftMap.setCenter(9.44, 51.41, 12);
leftMap.setControlVisibility(false);
rightMap.setControlVisibility(false);
leftMap.setControlVisibility({zoomControl: true, scaleControl: true});
rightMap.setControlVisibility({layerList: true, scaleControl: true});
leftMap.style().set('cursor', 'crosshair');
rightMap.style().set('cursor', 'crosshair');
var linker = new ui.Map.Linker([leftMap, rightMap]);

var mapSplit = ui.SplitPanel({
  firstPanel: leftMap, secondPanel: rightMap,
  orientation: 'horizontal', wipe: true, style: {stretch: 'both'}
});
ui.root.clear();

// Right map — phenology (Day of Year).
var layer = ui.Map.Layer(
  ee.Image(ASSET_ROOT + '2017_0'),
  {min: 100, max: 250, palette: PALETTES[DEFAULT_PALETTE]},
  'Phenology · Day of Year');
rightMap.layers().add(layer);

// Left map — outlines + crop type.
leftMap.layers().add(ui.Map.Layer(vPoly_AOI, {palette: 'ffffff', max: 3, opacity: 0.85}, 'Germany boundary'));
leftMap.layers().add(ui.Map.Layer(vPoly_FH,  {palette: 'ff3d00', max: 3, opacity: 0.95}, 'Frankenhausen site'));
var layer_Crop = ui.Map.Layer(cropMaskAll('2017').map(remapper),
                              {min: 1, max: 8, palette: dict.colors}, 'Crop Type Map · 10 m');
leftMap.layers().add(layer_Crop);

// Selection markers (added on top; updated on click).
var markerL = ui.Map.Layer(ee.FeatureCollection([]), {color: THEME.mark}, 'Selected field');
var markerR = ui.Map.Layer(ee.FeatureCollection([]), {color: THEME.mark}, 'Selected field');
leftMap.layers().add(markerL);
rightMap.layers().add(markerR);


// ============================================================================
//  6. STATE
// ============================================================================
var YEARS = ['2017', '2018', '2019', '2020', '2021'];
var state = {
  year: '2017', bbch: '0', cropCode: 1101,
  palette: DEFAULT_PALETTE, min: 100, max: 250, isolate: false,
  allYears: false, opacity: 1, mode: 'doy',
  mapPalette: PALETTES[DEFAULT_PALETTE], colorTitle: 'Day of Year',
  lastGeom: null, lastReducer: null, lastWhere: null   // remembers the current selection
};


// ============================================================================
//  7. LEGENDS  &  CONTINUOUS COLORBAR
// ============================================================================
var legend = ui.Panel({
  style: {position: 'bottom-left', padding: '10px 14px 12px 14px',
          backgroundColor: 'rgba(255,255,255,0.92)', border: '1px solid ' + THEME.line}
});
function renderCropLegend(title) {
  legend.clear();
  legend.add(ui.Label(title, {fontWeight: 'bold', fontSize: '15px', color: THEME.brand,
                              margin: '0 0 6px 0', fontFamily: FONT}));
  for (var i = 0; i < dict.names.length; i++) {
    var box = ui.Label('', {backgroundColor: dict.colors[i], padding: '8px',
                            margin: '0 8px 5px 0', border: '1px solid rgba(0,0,0,0.15)'});
    var name = ui.Label(dict.names[i], {margin: '0 0 5px 0', fontSize: '13px',
                                        color: THEME.ink, fontFamily: FONT});
    legend.add(ui.Panel([box, name], ui.Panel.Layout.Flow('horizontal')));
  }
}
leftMap.add(legend);

function doyToMonth(doy) {
  for (var i = 0; i < 12; i++) if (doy <= DOYCUM[i + 1]) return MONTHS[i];
  return 'Dec';
}
function colorBarThumb(paletteArr) {
  return ui.Thumbnail({
    image: ee.Image.pixelLonLat().select(0),
    params: {bbox: [0, 0, 1, 0.1], dimensions: '260x16', format: 'png',
             min: 0, max: 1, palette: paletteArr},
    style: {stretch: 'horizontal', maxHeight: '16px', margin: '0', padding: '0'}
  });
}
function tickRow(vmin, vmax, asMonth) {
  var fr = [0, 0.25, 0.5, 0.75, 1];
  var widgets = fr.map(function (f, i) {
    var v = Math.round(vmin + (vmax - vmin) * f);
    return ui.Label(asMonth ? doyToMonth(v) : String(v), {
      fontSize: '10px', color: asMonth ? THEME.accent : THEME.sub, stretch: 'horizontal',
      textAlign: i === 0 ? 'left' : (i === 4 ? 'right' : 'center'),
      margin: asMonth ? '0' : '2px 0 0 0', padding: '0', fontFamily: FONT});
  });
  return ui.Panel(widgets, ui.Panel.Layout.flow('horizontal'), {stretch: 'horizontal', margin: '0'});
}
var colorBar = ui.Panel({
  style: {position: 'bottom-right', padding: '10px 14px 12px 14px', width: '300px',
          backgroundColor: 'rgba(255,255,255,0.94)', border: '1px solid ' + THEME.line}
});
function renderColorBar() {
  colorBar.clear();
  colorBar.add(ui.Label(state.colorTitle, {
    fontWeight: 'bold', fontSize: '14px', color: THEME.brand, margin: '0 0 6px 0', fontFamily: FONT}));
  colorBar.add(colorBarThumb(state.mapPalette));
  colorBar.add(tickRow(state.min, state.max, false));
  // Month row only makes sense for Day-of-Year scales, not day-count/anomaly.
  if (state.mode === 'doy' || state.mode === 'mean') colorBar.add(tickRow(state.min, state.max, true));
}
rightMap.add(colorBar);


// ============================================================================
//  8. MAP UPDATE LOGIC
// ============================================================================
function phenoImg(year, stage) {
  return ee.Image(ASSET_ROOT + year + '_' + stage).select(DOY_BAND);
}
function meanImg(stage) {
  return ee.ImageCollection(YEARS.map(function (y) { return phenoImg(y, stage); })).mean();
}
function updateCropLayer() {
  var s = scaleForZoom(leftMap.getZoom());
  if (state.isolate) {
    var crop = cropOrFirst(state.cropCode);
    layer_Crop.setEeObject(coarsen(cropMaskSingle(state.year, state.cropCode), ee.Reducer.mean(), s));
    layer_Crop.setVisParams({min: 0.001, max: 1, palette: [crop.color]});
    layer_Crop.setName('Crop · ' + crop.name + ' · ' + state.year);
    renderCropLegend(crop.name + ' — ' + state.year);
  } else {
    var img = remapper(ctmYearImg(state.year)).updateMask(focusMaskImg(state.year));
    layer_Crop.setEeObject(coarsen(img, ee.Reducer.mode(), s));
    layer_Crop.setVisParams({min: 1, max: 8, palette: dict.colors});
    layer_Crop.setName('Crop Type Map · 10 m · ' + state.year);
    renderCropLegend('Crop Type — ' + state.year);
  }
}
// Colorbar ranges are computed once per (mode,year,stage,crop) with a 2–98%
// percentile stretch (good colours) and cached, so re-visits are instant.
var rangeCache = {};
function currentKey() {
  return state.mode + '|' + state.year + '|' + state.bbch + '|' + (state.isolate ? state.cropCode : 'all');
}

// Build the right-map image + colorbar for the current mode.
function updatePhenology() {
  var year = state.year, stage = state.bbch, r = stageRange(stage);
  var refProj = phenoImg(year, stage).projection();
  var base, palette = PALETTES[state.palette], title, name, isAnom = (state.mode === 'anom');

  if (state.mode === 'gsl') {                       // emergence → maturity, in days
    var g = phenoImg(year, '89').subtract(phenoImg(year, '10'));
    base = g.where(g.lt(0), g.add(365)).setDefaultProjection(refProj);
    title = 'Season length · days — ' + year;
    name = 'Season length (10→89) · ' + year;
  } else if (state.mode === 'mean') {               // 5-year mean DOY for this stage
    base = meanImg(stage).setDefaultProjection(refProj);
    title = '5-yr mean DOY — ' + bbchLabel(stage);
    name = '5-yr mean DOY · ' + bbchLabel(stage);
  } else if (isAnom) {                              // this year − 5-year mean
    base = phenoImg(year, stage).subtract(meanImg(stage)).setDefaultProjection(refProj);
    palette = DIVERGING;
    title = 'Anomaly · days — ' + bbchLabel(stage) + ' · ' + year;
    name = 'Anomaly vs 5-yr mean · ' + bbchLabel(stage) + ' · ' + year;
  } else {                                          // default: single-stage DOY
    base = phenoImg(year, stage);
    title = 'Day of Year — ' + bbchLabel(stage);
    name = 'Phenology · DOY · ' + bbchLabel(stage) + ' · ' + year;
  }

  // "Highlight this crop" → show only that crop's phenology.
  if (state.isolate) {
    base = base.updateMask(cropMaskSingle(state.year, state.cropCode));
    name += ' · ' + cropOrFirst(state.cropCode).name + ' only';
    title += '  ·  ' + cropOrFirst(state.cropCode).name;
  }

  state.mapPalette = palette; state.colorTitle = title;
  layer.setEeObject(coarsen(base, ee.Reducer.mean(), scaleForZoom(rightMap.getZoom())));
  layer.setName(name);
  layer.setOpacity(state.opacity);

  function applyRange(mn, mx) {
    state.min = mn; state.max = mx;
    layer.setVisParams({min: mn, max: mx, palette: state.mapPalette});
    renderColorBar();
  }

  if (isAnom) { applyRange(-20, 20); return; }      // symmetric fixed range

  var key = currentKey();
  if (rangeCache[key]) { applyRange(rangeCache[key].min, rangeCache[key].max); return; }

  // Render immediately with a sensible default, then refine with a cached percentile.
  applyRange(state.mode === 'gsl' ? 80 : r.min, state.mode === 'gsl' ? 300 : r.max);
  base.reduceRegion({
    reducer: ee.Reducer.percentile([2, 98]).setOutputs(['min', 'max']),
    geometry: GERMANY_BBOX, scale: 3000, bestEffort: true, maxPixels: 1e9
  }).evaluate(function (d, err) {
    if (err || !d) return;
    var mn = d[DOY_BAND + '_min'], mx = d[DOY_BAND + '_max'];
    if (mn == null || mx == null || mx <= mn) return;
    mn = Math.round(mn); mx = Math.round(mx);
    rangeCache[key] = {min: mn, max: mx};
    if (currentKey() === key) applyRange(mn, mx);    // ignore stale responses
  });
}


// ============================================================================
//  9. FIELD PROFILE  — click a field → date-vs-BBCH phenology trajectory
// ============================================================================
function doyToDate(year, doy) {
  var d = new Date(Date.UTC(year, 0, 1));
  d.setUTCDate(d.getUTCDate() + Math.round(doy) - 1);
  return d;
}
// Monotone cubic (PCHIP) interpolation → a smooth, non-overshooting BBCH curve
// resembling a classic crop-development curve.
function buildPchip(xs, ys) {
  var n = xs.length, h = [], delta = [], m = new Array(n), i;
  if (n === 1) { return {xs: xs, ys: ys, m: [0]}; }
  for (i = 0; i < n - 1; i++) { h[i] = xs[i + 1] - xs[i]; delta[i] = (ys[i + 1] - ys[i]) / h[i]; }
  m[0] = delta[0]; m[n - 1] = delta[n - 2];
  for (i = 1; i < n - 1; i++) {
    if (delta[i - 1] * delta[i] <= 0) { m[i] = 0; }
    else {
      var w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i]);
    }
  }
  return {xs: xs, ys: ys, m: m};
}
function pchipEval(p, x) {
  var xs = p.xs, ys = p.ys, m = p.m, n = xs.length, i = 0;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  while (i < n - 1 && x > xs[i + 1]) i++;
  var hh = xs[i + 1] - xs[i], t = (x - xs[i]) / hh, t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * hh * m[i] +
         (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * hh * m[i + 1];
}
function fmtDate(d) {
  return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
}
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function dateDOY(d) {
  return Math.round((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) + 1;
}

function fmtShort(d) {
  return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + " '" + String(d.getUTCFullYear()).slice(2);
}

// Bands to sample for a set of years: crop code + DOY of every BBCH stage.
function profileBands(years) {
  var bands = [];
  years.forEach(function (y) {
    bands.push(ctmBands(y).reduce(ee.Reducer.firstNonNull()).rename('c_' + y));
    BBCH_STAGES.forEach(function (s) {
      bands.push(ee.Image(ASSET_ROOT + y + '_' + s.value).select(DOY_BAND).rename('d_' + y + '_' + s.value));
    });
  });
  return bands;
}

// Sample crop + DOY of every stage over a point OR a drawn area, for the
// current year or all five years (crop rotation).
function runProfile(geometry, reducer, where) {
  state.lastGeom = geometry; state.lastReducer = reducer; state.lastWhere = where;
  var years = state.allYears ? YEARS : [state.year];
  var fc = ee.FeatureCollection([ee.Feature(geometry)]);
  markerL.setEeObject(fc); markerR.setEeObject(fc);

  profileTitle.setValue('Sampling ' + where + ' …');
  seasonInfo.setValue(''); statsPanel.style().set('shown', false);
  downloadLink.style().set('shown', false);
  chartHolder.widgets().reset([ui.Label('◔  Reading PhenoMapper' + (state.allYears ? ' · 5 years…' : '…'),
    {fontSize: '12px', color: THEME.sub, margin: '8px 0', fontFamily: FONT})]);

  ee.Image.cat(profileBands(years)).reduceRegion({
    reducer: reducer, geometry: geometry, scale: 20, maxPixels: 1e9, bestEffort: true
  }).evaluate(function (vals, err) {
    if (err || !vals) {
      profileTitle.setValue('Sampling failed — try another field or area.');
      chartHolder.widgets().reset([msgLabel('Earth Engine could not read this location. ' +
        'Zoom in and click a clear crop field.')]);
      seasonInfo.setValue(''); statsPanel.style().set('shown', false);
      downloadLink.style().set('shown', false);
      return;
    }
    renderProfile(vals, where, years, geometry);
  });
}

function handleClick(coords) {
  runProfile(ee.Geometry.Point([coords.lon, coords.lat]), ee.Reducer.first(),
             'field at ' + coords.lat.toFixed(4) + '°N, ' + coords.lon.toFixed(4) + '°E');
}

// Turn one year's sampled values into a smoothed BBCH season, or null.
function buildSeason(vals, y) {
  var codeVal = vals['c_' + y];
  var crop = (codeVal !== null && codeVal !== undefined) ? findCrop(Math.round(codeVal)) : null;

  var stages = [];
  BBCH_STAGES.forEach(function (s) {
    var v = vals['d_' + y + '_' + s.value];
    if (v !== null && v !== undefined) stages.push({code: s.code, short: s.short, doy: v});
  });
  if (stages.length < 2) return null;

  // Anchor maturity to the season year, walk backward so winter sowing/emergence
  // fall into the previous autumn (summer crops stay in-year).
  var yrs = [];
  for (var i = stages.length - 1; i >= 0; i--) {
    yrs[i] = (i === stages.length - 1) ? Number(y)
      : yrs[i + 1] - (stages[i].doy > stages[i + 1].doy ? 1 : 0);
  }
  var known = stages.map(function (x, i) {
    return {t: doyToDate(yrs[i], x.doy).getTime(), b: x.code, short: x.short, doy: Math.round(x.doy)};
  }).sort(function (a, b) { return a.t - b.t; });

  var stageAt = {}, byCode = {};
  known.forEach(function (k) { stageAt[k.t] = k; byCode[k.b] = k.t; });
  var t0 = known[0].t, tN = known[known.length - 1].t;
  var pchip = buildPchip(known.map(function (k) { return k.t; }), known.map(function (k) { return k.b; }));
  var dstep = 3 * 86400000, times = [];
  for (var t = t0; t <= tN; t += dstep) times.push(t);
  if (times[times.length - 1] !== tN) times.push(tN);

  return {
    year: y, crop: crop, color: crop ? crop.color : THEME.gold,
    known: known, stageAt: stageAt, byCode: byCode, times: times, t0: t0, tN: tN,
    smooth: function (tt) { return Math.max(0, Math.min(99, pchipEval(pchip, tt))); }
  };
}

function renderProfile(vals, where, years, geom) {
  var multi = years.length > 1;
  var seasons = [];
  years.forEach(function (y) { var s = buildSeason(vals, y); if (s) seasons.push(s); });

  if (!seasons.length) {
    profileTitle.setValue('No phenology · ' + where);
    chartHolder.widgets().reset([msgLabel('No clear phenology at this location. ' +
      'Zoom in and click a crop field.')]);
    seasonInfo.setValue(''); statsPanel.style().set('shown', false);
    downloadLink.style().set('shown', false);
    return;
  }

  // Columns: Date + one crop-coloured development column per season + markers.
  var header = ['Date'];
  seasons.forEach(function (s) {
    header.push(multi ? (s.year + ' · ' + (s.crop ? s.crop.name : 'unknown'))
                      : (s.crop ? s.crop.name : 'Field'));
  });
  header.push('BBCH stage');

  var timeSet = {};
  seasons.forEach(function (s) { s.times.forEach(function (t) { timeSet[t] = true; }); });
  var allT = Object.keys(timeSet).map(Number).sort(function (a, b) { return a - b; });

  // Use NaN (not null) for out-of-season cells: NaN infers as a numeric column
  // in arrayToDataTable and renders as a gap, whereas null breaks type
  // inference when a later season's column is empty in the first row.
  var data = [header];
  allT.forEach(function (tt) {
    var row = [new Date(tt)], marker = NaN;
    seasons.forEach(function (s) {
      if (tt >= s.t0 && tt <= s.tN) {
        row.push(Math.round(s.smooth(tt) * 10) / 10);
        if (s.stageAt[tt]) marker = s.stageAt[tt].b;
      } else { row.push(NaN); }
    });
    row.push(marker);
    data.push(row);
  });

  // Each season coloured by its crop; the marker series is brand green.
  var series = {};
  seasons.forEach(function (s, i) { series[i] = {color: s.color, lineWidth: 3, pointSize: 0}; });
  series[seasons.length] = {color: THEME.brand, lineWidth: 0, pointSize: multi ? 6 : 11};

  var span = new Date(seasons[0].t0).getUTCFullYear() + '–' +
             new Date(seasons[seasons.length - 1].tN).getUTCFullYear();
  var chart = ui.Chart(data, 'LineChart', {
    title: (multi ? 'Crop rotation & BBCH phenology' : (seasons[0].crop ? seasons[0].crop.name : 'Field')) +
           ' — ' + span,
    titleTextStyle: {fontSize: 13, bold: true, color: THEME.brand},
    fontName: 'Roboto', interpolateNulls: false, curveType: 'function',
    hAxis: {title: 'Date (PhenoMapper prediction)', format: multi ? 'yyyy' : "MMM ''yy",
            titleTextStyle: {italic: false, fontSize: 11}, gridlines: {color: '#eeeeee'}},
    vAxis: {title: 'BBCH growth stage', titleTextStyle: {italic: false, fontSize: 11},
            viewWindow: {min: -4, max: 99}, gridlines: {color: '#f4f4f4'},
            ticks: [{v: 0, f: '00 Sow'}, {v: 10, f: '10 Emg'}, {v: 30, f: '30 Stem'},
                    {v: 51, f: '51 Head'}, {v: 65, f: '65 Flwr'}, {v: 87, f: '87 Ripe'},
                    {v: 89, f: '89 Mat'}]},
    series: series,
    legend: multi ? {position: 'top', maxLines: 3, textStyle: {fontSize: 9}} : {position: 'none'},
    chartArea: {left: 66, right: 14, top: multi ? 56 : 34, bottom: 44}
  });
  chart.style().set({height: multi ? '290px' : '250px', stretch: 'horizontal', margin: '4px 0 0 0'});

  profileTitle.setValue((multi ? seasons.length + ' seasons' :
    (seasons[0].crop ? seasons[0].crop.name : 'Field')) + '  (' + where + ')');
  chartHolder.widgets().reset([chart]);

  // Info / per-season stats.
  statsPanel.clear();
  if (multi) {
    seasonInfo.setValue('Each line is coloured by that year’s crop (crop rotation). ' +
      'Markers = predicted BBCH stages.');
    seasons.forEach(function (s) { statsPanel.add(statsRow(s)); });
    statsPanel.style().set('shown', true);
  } else {
    seasonInfo.setValue(seasons[0].crop ? seasonSentence(seasons[0].crop)
      : 'Crop type mixed/unknown here — stages ordered by development.');
    statsPanel.style().set('shown', false);
  }

  buildDownload(seasons, where, geom, span);
}

// One coloured summary line per season (crop, emergence→maturity, length).
function statsRow(s) {
  var e = s.byCode[10] ? new Date(s.byCode[10]) : null;
  var m = s.byCode[89] ? new Date(s.byCode[89]) : null;
  var len = (e && m) ? Math.round((m.getTime() - e.getTime()) / 86400000) : null;
  var swatch = ui.Label('', {backgroundColor: s.color, padding: '5px', margin: '3px 6px 0 16px',
                             border: '1px solid rgba(0,0,0,0.25)'});
  var txt = s.year + ' · ' + (s.crop ? s.crop.name : 'unknown') +
    (e ? ('  emrg ' + fmtShort(e)) : '') + (m ? (' → mat ' + fmtShort(m)) : '') +
    (len != null ? ('  (' + len + ' d)') : '');
  return ui.Panel([swatch, ui.Label(txt, {fontSize: '10px', color: THEME.ink, margin: '3px 16px 0 0',
    fontFamily: FONT, whiteSpace: 'normal', stretch: 'horizontal'})],
    ui.Panel.Layout.flow('horizontal'), {margin: '0', stretch: 'horizontal'});
}

// CSV export (all seasons) via Earth Engine — strings + real geometry + ASCII
// filename so the server-side table export cannot fail with a 500.
function buildDownload(seasons, where, geom, span) {
  var namePart = seasons.length > 1 ? 'rotation' : (seasons[0].crop ? seasons[0].crop.name : 'field');
  var fname = ('phenomapper_' + namePart + '_' + span).replace(/[^A-Za-z0-9]+/g, '_');
  var exportGeom = ee.Geometry(geom).centroid(1);
  var COLS = ['date', 'year', 'crop', 'day_of_year', 'bbch_smoothed',
              'predicted_stage_bbch', 'stage_name', 'season_type'];
  var feats = [];
  seasons.forEach(function (s) {
    s.times.forEach(function (tt) {
      var d = new Date(tt), st = s.stageAt[tt];
      feats.push(ee.Feature(exportGeom, {
        date: d.toISOString().slice(0, 10),
        year: String(s.year),
        crop: s.crop ? s.crop.name : 'unknown',
        day_of_year: String(dateDOY(d)),
        bbch_smoothed: String(Math.round(s.smooth(tt) * 10) / 10),
        predicted_stage_bbch: st ? String(st.b) : 'NA',
        stage_name: st ? st.short : 'NA',
        season_type: s.crop ? s.crop.season : 'unknown'
      }));
    });
  });
  downloadLink.setValue('◔  Preparing CSV…'); downloadLink.setUrl('');
  downloadLink.style().set('shown', true);
  function onUrl(url) { downloadLink.setUrl(url); downloadLink.setValue('⤓ Download CSV — ' + fname + '.csv'); }
  function onFail() { downloadLink.setValue('⚠ CSV export failed — try another field.'); }
  try {
    var maybeUrl = ee.FeatureCollection(feats).getDownloadURL('CSV', COLS, fname, function (url, err) {
      if (url && !err) { onUrl(url); } else { onFail(); }
    });
    if (typeof maybeUrl === 'string' && maybeUrl) { onUrl(maybeUrl); }
  } catch (e) { onFail(); }
}

function seasonSentence(crop) {
  return crop.season === 'winter'
    ? '❄ Winter crop — sown the previous autumn; heading→harvest the following summer.'
    : '☀ Summer / spring crop — sown in spring; heading→harvest the same year.';
}
function msgLabel(t) {
  return ui.Label(t, {fontSize: '12px', color: THEME.sub, margin: '8px 0', fontFamily: FONT,
                      whiteSpace: 'normal'});
}

// ---- Point clicks (both maps) ----
leftMap.onClick(handleClick);
rightMap.onClick(handleClick);

// ---- Area selection via drawing tools (averaged profile) ----
function setupDrawing(map) {
  var dt = map.drawingTools();
  dt.setShown(false);
  dt.setLinked(false);
  dt.setDrawModes(['polygon', 'rectangle']);
  dt.onDraw(function (geometry) {
    dt.stop();
    runProfile(geometry, ee.Reducer.mean(), 'drawn area (average)');
  });
  return dt;
}
var dtLeft  = setupDrawing(leftMap);
var dtRight = setupDrawing(rightMap);
function startAreaDraw() {
  [dtLeft, dtRight].forEach(function (dt) { dt.layers().reset(); dt.stop(); });
  dtRight.setShape('polygon');
  dtRight.draw();
  profileTitle.setValue('Draw a polygon on the RIGHT map, then double-click to finish…');
}
function clearSelection() {
  [dtLeft, dtRight].forEach(function (dt) { dt.layers().reset(); dt.stop(); dt.setShape(null); });
  markerL.setEeObject(ee.FeatureCollection([]));
  markerR.setEeObject(ee.FeatureCollection([]));
  state.lastGeom = null; state.lastReducer = null; state.lastWhere = null;
  profileTitle.setValue('No field selected yet.');
  seasonInfo.setValue(''); downloadLink.style().set('shown', false);
  statsPanel.clear(); statsPanel.style().set('shown', false);
  chartHolder.widgets().reset([]);
}


// ============================================================================
//  10. CONTROL / BRANDING PANEL
// ============================================================================
function sectionHeader(text) {
  return ui.Label(text, {fontSize: '11px', fontWeight: 'bold', color: THEME.accent,
                         margin: '14px 16px 4px 16px', fontFamily: FONT});
}
function bodyText(text, extra) {
  var base = {fontSize: '12px', color: THEME.sub, margin: '0 16px 4px 16px',
              fontFamily: FONT, whiteSpace: 'normal'};
  if (extra) for (var k in extra) base[k] = extra[k];
  return ui.Label(text, base);
}
function hr() {
  return ui.Label('', {margin: '10px 16px 0 16px', padding: '0',
                       border: '0.5px solid ' + THEME.line, stretch: 'horizontal'});
}

// ---- Header ----
var headerPanel = ui.Panel({
  widgets: [
    ui.Label('🌾  PhenoMapper', {fontSize: '24px', fontWeight: 'bold', color: THEME.white,
        backgroundColor: THEME.brand, margin: '0', padding: '14px 16px 2px 16px',
        fontFamily: FONT, stretch: 'horizontal'}),
    ui.Label('Crop Phenology of Germany · 2017–2021', {fontSize: '12px', color: '#c8e6c9',
        backgroundColor: THEME.brand, margin: '0', padding: '0 16px 14px 16px',
        fontFamily: FONT, stretch: 'horizontal'})
  ],
  style: {padding: '0', backgroundColor: THEME.brand, stretch: 'horizontal'}
});

// ---- About / citation ----
var aboutText = bodyText(
  'Growth-stage timing for eight major crops across Germany, predicted by a ' +
  'LightGBM model that fuses Sentinel-1 radar, Sentinel-2 optical and climate ' +
  'data at 20 m resolution. Each map shows the Day of Year (DOY) on which a ' +
  'crop reaches the selected BBCH growth stage.',
  {fontSize: '12px', color: THEME.ink, margin: '10px 16px 0 16px'});
var citationBox = ui.Label(
  'Shojaeezadeh, Elnashar & Weber (2025). A novel fusion of Sentinel-1 and ' +
  'Sentinel-2 with climate data for crop phenology estimation using Machine ' +
  'Learning. Science of Remote Sensing, 11, 100227.',
  {fontSize: '11px', color: THEME.sub, fontStyle: 'italic', backgroundColor: THEME.softBg,
   padding: '8px 10px', margin: '8px 16px 0 16px', border: '1px solid ' + THEME.line,
   fontFamily: FONT, whiteSpace: 'normal'});
var paperLink = ui.Label('› Read the paper (ScienceDirect · Elsevier)', {
  fontSize: '11px', color: THEME.accent, margin: '6px 16px 0 16px', fontFamily: FONT});
paperLink.setUrl('https://www.sciencedirect.com/science/article/pii/S2666017225000331');

// ---- Stat chips ----
function chip(big, small) {
  return ui.Panel([
    ui.Label(big,   {fontSize: '15px', fontWeight: 'bold', color: THEME.brand,
                     textAlign: 'center', margin: '0', fontFamily: FONT}),
    ui.Label(small, {fontSize: '10px', color: THEME.sub, textAlign: 'center',
                     margin: '0', fontFamily: FONT})
  ], ui.Panel.Layout.flow('vertical'),
     {backgroundColor: THEME.chipBg, padding: '8px 4px', margin: '0 4px 0 0',
      border: '1px solid ' + THEME.line, stretch: 'horizontal'});
}
var chipsPanel = ui.Panel(
  [chip('20 m', 'resolution'), chip('~6 d', 'MAE'), chip('8', 'crops'), chip('13', 'BBCH')],
  ui.Panel.Layout.flow('horizontal'), {margin: '10px 16px 0 16px', stretch: 'horizontal'});

// ---- BBCH schematic (crop-growth shape) ----
function growthSchematic() {
  var maxH = 88;
  var cols = GROWTH.map(function (g) {
    var predicted = PREDICTED_PRINCIPALS[Number(g.b)];
    var spacer = ui.Label('', {height: (maxH - g.h) + 'px', margin: '0', padding: '0'});
    var bar = ui.Label('', {backgroundColor: g.c, height: g.h + 'px', margin: '0',
                            stretch: 'horizontal', border: '1px solid rgba(0,0,0,0.10)'});
    var num = ui.Label(g.b, {fontSize: '9px', textAlign: 'center', stretch: 'horizontal',
                             margin: '2px 0 0 0', fontFamily: FONT,
                             fontWeight: predicted ? 'bold' : 'normal',
                             color: predicted ? THEME.brand : THEME.sub});
    var mark = ui.Label(predicted ? '▲' : '', {fontSize: '8px', color: THEME.mark,
                             textAlign: 'center', stretch: 'horizontal', margin: '0', fontFamily: FONT});
    return ui.Panel([spacer, bar, num, mark], ui.Panel.Layout.flow('vertical'),
                    {stretch: 'horizontal', margin: '0 1px'});
  });
  return ui.Panel(cols, ui.Panel.Layout.flow('horizontal'),
                  {margin: '8px 16px 0 16px', stretch: 'horizontal'});
}

// A painted crop-growth scene rendered as an image: gradient sky + sun, soil,
// and wheat plants that grow, sprout leaves, form an awned ear, ripen to gold
// and senesce. Design coordinates are scaled by S into a valid lon/lat window
// (must stay within ±180°/±90°, or the geometry is invalid and renders blank).
function bbchIllustration() {
  try {
    var W = 184, H = 64, G = 10, S = 0.4;            // S keeps coords well inside ±90°
    function rect(x0, y0, x1, y1) {
      return ee.Geometry.Rectangle([x0 * S, y0 * S, x1 * S, y1 * S]);
    }
    function poly(coords) {
      return ee.Geometry.Polygon([coords.map(function (p) { return [p[0] * S, p[1] * S]; })]);
    }
    function disc(cx, cy, rad, n) {
      var pts = []; n = n || 14;
      for (var a = 0; a < n; a++) { var t = a / n * 2 * Math.PI; pts.push([cx + rad * Math.cos(t), cy + rad * Math.sin(t)]); }
      return poly(pts);
    }
    var plants = [
      {x: 16,  h: 5,  col: 'green', ear: null},   // germination
      {x: 40,  h: 15, col: 'green', ear: null},   // leaf development
      {x: 64,  h: 24, col: 'green', ear: null},   // tillering
      {x: 88,  h: 34, col: 'green', ear: null},   // stem elongation
      {x: 112, h: 40, col: 'green', ear: 'green'},// heading
      {x: 136, h: 40, col: 'gold',  ear: 'gold'}, // ripening
      {x: 162, h: 30, col: 'tan',   ear: 'tan'}   // senescence
    ];
    var stems = {green: [], gold: [], tan: []}, ears = {green: [], gold: [], tan: []},
        leaves = [], awns = [];
    plants.forEach(function (p) {
      var w = 1.3, top = G + p.h, stemTop = top - (p.ear ? 5 : 0);
      stems[p.col].push(rect(p.x - w, G, p.x + w, stemTop));
      if (p.h > 12) {                                  // leaf blades
        var l1 = G + p.h * 0.32, l2 = G + p.h * 0.58;
        leaves.push(poly([[p.x - w, l1], [p.x - 13, l1 + 7], [p.x - 11, l1 + 2], [p.x - w, l1 - 2]]));
        leaves.push(poly([[p.x + w, l2], [p.x + 13, l2 + 7], [p.x + 11, l2 + 2], [p.x + w, l2 - 2]]));
      }
      if (p.ear) {                                     // spike (ear) body + awns
        ears[p.ear].push(poly([[p.x, stemTop - 1], [p.x - 3, stemTop + 3], [p.x - 2.3, stemTop + 8],
          [p.x, stemTop + 11], [p.x + 2.3, stemTop + 8], [p.x + 3, stemTop + 3]]));
        [-2.2, 0, 2.2].forEach(function (dx) {
          awns.push(poly([[p.x + dx, stemTop + 9], [p.x + dx - 0.5, stemTop + 15], [p.x + dx + 0.5, stemTop + 15]]));
        });
      }
    });
    var C = {
      skyTop: [138, 196, 232], skyLow: [222, 240, 246],
      soil: [128, 94, 66], soilLow: [92, 66, 46],
      green: [70, 160, 73], gold: [206, 165, 40], tan: [166, 120, 80],
      egreen: [140, 190, 78], egold: [224, 188, 26], etan: [190, 154, 104],
      leaf: [86, 168, 74], awn: [232, 206, 120], sun: [255, 216, 96]
    };
    var Gg = G * S, Hg = H * S;
    var lat = ee.Image.pixelLonLat().select('latitude');
    function mix(f, c1, c2) {
      return ee.Image.cat([0, 1, 2].map(function (i) { return f.multiply(c1[i] - c2[i]).add(c2[i]); })).toByte();
    }
    var img = mix(lat.subtract(Gg).divide(Hg - Gg).clamp(0, 1), C.skyTop, C.skyLow);  // sky
    img = img.where(lat.lt(Gg), mix(lat.divide(Gg).clamp(0, 1), C.soil, C.soilLow));  // soil
    function stamp(image, list, color) {
      if (!list.length) return image;
      var m = ee.Image(0).byte().paint(ee.FeatureCollection(list), 1);
      return image.where(m, ee.Image.constant(color).toByte());
    }
    img = stamp(img, [disc(30, 54, 6, 16)], C.sun);
    img = stamp(img, leaves, C.leaf);
    img = stamp(img, stems.green, C.green);
    img = stamp(img, stems.gold, C.gold);
    img = stamp(img, stems.tan, C.tan);
    img = stamp(img, awns, C.awn);
    img = stamp(img, ears.green, C.egreen);
    img = stamp(img, ears.gold, C.egold);
    img = stamp(img, ears.tan, C.etan);
    return ui.Thumbnail({
      image: img.visualize({min: 0, max: 255}),
      params: {dimensions: '368x128', region: rect(0, 0, W, H), format: 'png'},
      style: {stretch: 'horizontal', maxHeight: '124px', margin: '8px 16px 0 16px',
              border: '1px solid ' + THEME.line}
    });
  } catch (e) {
    return growthSchematic();   // fall back to the bar schematic if anything fails
  }
}
var schematicAxis = ui.Panel([
  ui.Label('← seed', {fontSize: '9px', color: THEME.sub, stretch: 'horizontal',
                      textAlign: 'left', fontFamily: FONT}),
  ui.Label('development →', {fontSize: '9px', color: THEME.sub, stretch: 'horizontal',
                      textAlign: 'right', fontFamily: FONT})
], ui.Panel.Layout.flow('horizontal'), {margin: '2px 16px 0 16px', stretch: 'horizontal'});
var schematicCaption = bodyText(
  'The BBCH scale tracks a crop from sowing to harvest: it germinates, develops ' +
  'leaves, tillers, elongates, forms an ear (heading), ripens to gold, then ' +
  'senesces. PhenoMapper predicts BBCH 00, 10, 51, 53, 87 and 89.',
  {fontSize: '10px', margin: '6px 16px 0 16px'});

// ---- Controls ----
function labeledSelect(labelText, select, topMargin) {
  return ui.Panel([
    ui.Label(labelText, {fontSize: '11px', fontWeight: 'bold', color: THEME.ink,
                         margin: (topMargin || '4px') + ' 0 2px 0', fontFamily: FONT}),
    select
  ], ui.Panel.Layout.flow('vertical'), {margin: '4px 16px 0 16px', stretch: 'horizontal'});
}
var yearSelect = ui.Select({
  items: ['2017', '2018', '2019', '2020', '2021'], value: '2017',
  style: {stretch: 'horizontal', margin: '2px 0 0 0'},
  onChange: function (v) { state.year = v; updatePhenology(); updateCropLayer(); }
});
var bbchSelect = ui.Select({
  items: BBCH_STAGES, value: '0',
  style: {stretch: 'horizontal', margin: '2px 0 0 0'},
  onChange: function (v) { state.bbch = v; stageInfo.setValue('◔  ' + bbchDesc(v) + '.'); updatePhenology(); }
});
var stageInfo = ui.Label('◔  Sowing / dry seed.', {fontSize: '11px', color: THEME.sub,
  fontStyle: 'italic', margin: '6px 16px 0 16px', fontFamily: FONT, whiteSpace: 'normal'});
var mapModeSelect = ui.Select({
  items: MAP_MODES, value: 'doy',
  style: {stretch: 'horizontal', margin: '2px 0 0 0'},
  onChange: function (v) { state.mode = v; updatePhenology(); }
});
var basemapSelect = ui.Select({
  items: [{label: 'Satellite', value: 'SATELLITE'}, {label: 'Hybrid (with labels)', value: 'HYBRID'},
          {label: 'Roadmap', value: 'ROADMAP'}, {label: 'Terrain', value: 'TERRAIN'}],
  value: 'SATELLITE',
  style: {stretch: 'horizontal', margin: '2px 0 0 0'},
  onChange: function (v) { leftMap.setOptions(v); rightMap.setOptions(v); }
});
var paletteSelect = ui.Select({
  items: Object.keys(PALETTES), value: DEFAULT_PALETTE,
  style: {stretch: 'horizontal', margin: '2px 0 0 0'},
  onChange: function (v) { state.palette = v; updatePhenology(); }
});
var opacitySlider = ui.Slider({
  min: 0, max: 1, value: 1, step: 0.05,
  style: {stretch: 'horizontal', margin: '2px 0 0 0'},
  onChange: function (v) { state.opacity = v; layer.setOpacity(v); }
});

// ---- Crop layer highlight ----
var cropSelect = ui.Select({
  items: CROPS.map(function (c) { return {label: c.name, value: String(c.code)}; }),
  value: String(CROPS[0].code),
  style: {stretch: 'horizontal', margin: '2px 0 0 0'},
  onChange: function (v) {
    state.cropCode = Number(v);
    if (state.isolate) { updateCropLayer(); updatePhenology(); }
  }
});
var isolateCheck = ui.Checkbox({
  label: 'Highlight this crop (crop map + phenology)', value: false,
  style: {fontSize: '11px', margin: '6px 16px 0 16px', fontFamily: FONT},
  onChange: function (checked) { state.isolate = checked; updateCropLayer(); updatePhenology(); }
});

// ---- Field profile (click / draw-driven chart + export) ----
var profileHint = bodyText(
  '👆 Click any field on either map, or draw an area to average. The chart shows a ' +
  'smoothed BBCH development curve with the predicted stages marked — winter crops ' +
  'start with sowing in the previous autumn. Tick “all 5 years” to see the full ' +
  '2017–2021 series, each season coloured by that year’s crop.',
  {fontSize: '11px', margin: '4px 16px 0 16px'});
var yearsCheck = ui.Checkbox({
  label: 'Show all 5 years (crop rotation)', value: false,
  style: {fontSize: '11px', margin: '6px 16px 0 16px', fontFamily: FONT},
  onChange: function (checked) {
    state.allYears = checked;
    if (state.lastGeom) { runProfile(state.lastGeom, state.lastReducer, state.lastWhere); }
  }
});
var drawButton = ui.Button({label: '▢  Draw area (avg)', onClick: startAreaDraw,
  style: {stretch: 'horizontal', margin: '0 4px 0 0'}});
var clearButton = ui.Button({label: '✕  Clear', onClick: clearSelection,
  style: {stretch: 'horizontal', margin: '0'}});
var profileTitle = ui.Label('No field selected yet.', {fontSize: '11px', fontWeight: 'bold',
  color: THEME.ink, margin: '8px 16px 0 16px', fontFamily: FONT, whiteSpace: 'normal'});
var chartHolder = ui.Panel({style: {margin: '4px 16px 0 16px', stretch: 'horizontal'}});
var statsPanel = ui.Panel({style: {margin: '2px 0 0 0', stretch: 'horizontal', shown: false}});
var seasonInfo = ui.Label('', {fontSize: '11px', color: THEME.sub, fontStyle: 'italic',
  margin: '2px 16px 0 16px', fontFamily: FONT, whiteSpace: 'normal'});
var downloadLink = ui.Label('⤓ Download CSV', {fontSize: '11px', fontWeight: 'bold',
  color: THEME.accent, backgroundColor: THEME.chipBg, padding: '6px 8px',
  border: '1px solid ' + THEME.line, margin: '8px 16px 0 16px', fontFamily: FONT,
  textAlign: 'center', stretch: 'horizontal', shown: false});

// ---- How to read ----
var howToText = bodyText(
  'Left map — Crop Type Map (CTM) at 10 m over the Frankenhausen study site. ' +
  'Right map — predicted Day of Year for the chosen stage. Drag the centre ' +
  'divider to wipe between them; the maps stay zoom-linked.',
  {margin: '4px 16px 0 16px'});
var footer = ui.Label('University of Kassel  ·  Contact: shahab@uni-kassel.de', {
  fontSize: '11px', color: THEME.white, backgroundColor: THEME.brandDark,
  padding: '10px 16px', margin: '14px 0 0 0', fontFamily: FONT,
  stretch: 'horizontal', textAlign: 'center'});

// ---- Assemble ----
var controlPanel = ui.Panel({
  widgets: [
    headerPanel, aboutText, citationBox, paperLink, chipsPanel,
    sectionHeader('WHAT IS BBCH?'),
    bbchIllustration(), schematicAxis, schematicCaption,
    hr(),
    sectionHeader('EXPLORE'),
    labeledSelect('Season (year)', yearSelect),
    labeledSelect('Growth stage (BBCH)', bbchSelect, '8px'),
    stageInfo,
    labeledSelect('Right-map layer', mapModeSelect, '8px'),
    labeledSelect('Basemap', basemapSelect, '8px'),
    labeledSelect('Colorbar', paletteSelect, '8px'),
    labeledSelect('Phenology layer opacity', opacitySlider, '8px'),
    hr(),
    sectionHeader('CROP LAYER'),
    labeledSelect('Crop', cropSelect),
    isolateCheck,
    hr(),
    sectionHeader('FIELD PROFILE  (click a field or draw an area)'),
    profileHint,
    yearsCheck,
    ui.Panel([drawButton, clearButton], ui.Panel.Layout.flow('horizontal'),
             {stretch: 'horizontal', margin: '6px 16px 0 16px'}),
    profileTitle, chartHolder, statsPanel, seasonInfo, downloadLink,
    hr(),
    sectionHeader('HOW TO READ'),
    howToText,
    footer
  ],
  style: {width: '380px', padding: '0', backgroundColor: THEME.panelBg,
          border: '1px solid ' + THEME.line, stretch: 'vertical'}
});

// Outer split panel → the divider between the maps and the control panel is
// draggable, so the user can resize / expand the panel with the mouse.
var mapArea = ui.Panel({widgets: [mapSplit], style: {stretch: 'both'}});
var appSplit = ui.SplitPanel({
  firstPanel: mapArea,
  secondPanel: controlPanel,
  orientation: 'horizontal',
  wipe: false,
  style: {stretch: 'both'}
});
ui.root.add(appSplit);


// ============================================================================
//  11. INITIAL RENDER
// ============================================================================
renderColorBar();
updatePhenology();
updateCropLayer();

// Re-render at a coarser resolution when the map crosses a zoom band (national
// vs. local), so low zoom stays fast and fields fill in instead of showing as
// scattered pixels. Guarded so panning at the same zoom does not re-render.
var lastZoomBucket = scaleForZoom(rightMap.getZoom());
function onZoomChange() {
  var b = scaleForZoom(rightMap.getZoom());
  if (b !== lastZoomBucket) { lastZoomBucket = b; updatePhenology(); updateCropLayer(); }
}
rightMap.onChangeZoom(onZoomChange);
leftMap.onChangeZoom(onZoomChange);

// Center on the Frankenhausen study site AFTER the maps are attached to the
// root — a setCenter call before attachment is dropped once the nested split
// panels lay the maps out. Linked maps move together, so centering the left
// map frames both.
leftMap.setCenter(9.44, 51.41, 13);
