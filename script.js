// Glint & Glare Report — script.js
// Real sun-position + reflection-geometry calculations, an ocular hazard
// model informed by Sandia National Laboratories' SGHAT documentation,
// full-day and full-year glare scans, live weather context, and
// Supabase persistence.
//
// IMPORTANT HONESTY NOTE: the retinal-irradiance formula below is a
// physically-reasoned approximation built from standard radiometry
// (conservation of radiance, solid-angle geometry, reflectance scaling).
// It is informed by Sandia's publicly available SGHAT user manual but is
// NOT a verified reproduction of Sandia's validated model (that model's
// exact equations live in a separate peer-reviewed paper: Ho, Ghanbari &
// Diver, 2011). Treat this tool's hazard output as informational, not as
// a certified substitute for SGHAT or a professional glare study.

const form = document.getElementById('glareForm');
const resultsEmpty = document.getElementById('resultsEmpty');
const resultsContent = document.getElementById('resultsContent');
const scanDayBtn = document.getElementById('scanDayBtn');
const scanYearBtn = document.getElementById('scanYearBtn');
const dbStatus = document.getElementById('dbStatus');
const savedReportsEl = document.getElementById('savedReports');
const toggleOcularBtn = document.getElementById('toggleOcular');
const ocularFields = document.getElementById('ocularFields');
const yearPlotContainer = document.getElementById('yearPlotContainer');
const yearPlotSvgWrap = document.getElementById('yearPlotSvgWrap');
const yearPlotStatus = document.getElementById('yearPlotStatus');

toggleOcularBtn.addEventListener('click', () => {
  const expanded = toggleOcularBtn.getAttribute('aria-expanded') === 'true';
  toggleOcularBtn.setAttribute('aria-expanded', String(!expanded));
  ocularFields.hidden = expanded;
});

/* ---------------- Vector / angle helpers ---------------- */

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

// azimuth: compass degrees, 0 = north, clockwise (90 = east)
// elevation: degrees above horizontal
function toVector(azimuthDeg, elevationDeg) {
  const az = toRad(azimuthDeg);
  const el = toRad(elevationDeg);
  return {
    x: Math.cos(el) * Math.sin(az), // east component
    y: Math.cos(el) * Math.cos(az), // north component
    z: Math.sin(el),                // up component
  };
}

function toAzEl(v) {
  const elevation = toDeg(Math.asin(clamp(v.z, -1, 1)));
  let azimuth = toDeg(Math.atan2(v.x, v.y));
  if (azimuth < 0) azimuth += 360;
  return { azimuth, elevation };
}

const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

// Reflect unit vector S (surface -> sun) across unit normal N.
function reflect(S, N) {
  const d = dot(S, N);
  return {
    x: 2 * d * N.x - S.x,
    y: 2 * d * N.y - S.y,
    z: 2 * d * N.z - S.z,
  };
}

// Angle in degrees between two direction vectors.
function angularSeparation(v1, v2) {
  return toDeg(Math.acos(clamp(dot(v1, v2), -1, 1)));
}

/* ---------------- Sun position (SunCalc) ---------------- */

function getSunPosition(date, lat, lon) {
  const pos = SunCalc.getPosition(date, lat, lon);
  // SunCalc azimuth: radians, measured from south, clockwise toward west.
  // Convert to standard compass azimuth (0 = north, clockwise).
  let compassAz = toDeg(pos.azimuth) + 180;
  if (compassAz < 0) compassAz += 360;
  if (compassAz >= 360) compassAz -= 360;
  return {
    azimuth: compassAz,
    elevation: toDeg(pos.altitude),
  };
}

/* ---------------- Ocular hazard model ---------------- */

// Average angular size of the sun as seen from Earth (~9.3 mrad / 0.5°),
// per Sandia's SGHAT documentation.
const SUN_ANGULAR_SIZE_RAD = 0.0093;

// Approximates the total angular spread ("beam spread") of the reflected
// glare image by combining the sun's own angular size with additional
// scatter introduced by the reflecting surface's slope error (roughness).
// Reflection roughly doubles a surface angle deviation (law of
// reflection), so rougher surfaces spread the reflected image over a
// wider angle — this lowers peak intensity but widens the glare window,
// matching the qualitative behavior described in Sandia's documentation.
function totalSubtendedAngleRad(slopeErrorMrad) {
  const slopeErrorRad = slopeErrorMrad / 1000;
  const scatterComponent = 4 * slopeErrorRad;
  return Math.sqrt(SUN_ANGULAR_SIZE_RAD ** 2 + scatterComponent ** 2);
}

// Retinal irradiance from a reflected extended source, derived from
// standard radiometric relations:
//   - source radiance L_sun = DNI / solid_angle_of_sun
//   - reflected radiance is scaled by reflectance and reduced further if
//     scatter spreads it over a larger solid angle than the sun's own
//   - retinal irradiance = L * ocular_transmission * (pupil_area / focal_length^2)
// which simplifies to the formula below. Returns W/m^2 at the retina.
function retinalIrradiance({ reflectance, peakDni, slopeErrorMrad, pupilDiameterMm, ocularTransmission, eyeFocalLengthMm }) {
  const totalAngleRad = totalSubtendedAngleRad(slopeErrorMrad);
  const solidAngleTotal = Math.PI * (totalAngleRad / 2) ** 2; // small-angle approx, steradians

  const pupilDiameterM = pupilDiameterMm / 1000;
  const pupilAreaM2 = Math.PI * (pupilDiameterM / 2) ** 2;
  const focalLengthM = eyeFocalLengthMm / 1000;

  const E = (reflectance * peakDni * ocularTransmission * pupilAreaM2) / (focalLengthM ** 2 * solidAngleTotal);
  return E; // W/m^2
}

// Hazard bands are set conservatively relative to a known reference
// point: direct unfiltered sun viewing computes to roughly single-digit
// W/cm^2 at the retina with this same formula (consistent with published
// solar-viewing hazard figures), and is well-documented as capable of
// causing eye injury. These thresholds are indicative, not clinically
// validated cutoffs — see the disclaimer in the footer.
function classifyOcularHazard(irradianceWm2) {
  const wcm2 = irradianceWm2 / 10000; // 1 m^2 = 10,000 cm^2
  if (wcm2 >= 1) return 'High';
  if (wcm2 >= 0.01) return 'Moderate';
  return 'Low';
}

/* ---------------- Core glare calculation ---------------- */

// Returns null if the sun cannot illuminate the front face of the
// surface (sun behind the panel/wall) — no reflection is possible.
function calculateGlare({
  sunAz, sunEl, tilt, surfaceAz, observerBearing, observerElevation,
  reflectance, slopeErrorMrad, peakDni, pupilDiameterMm, ocularTransmission, eyeFocalLengthMm,
}) {
  if (sunEl <= 0) return null; // sun below horizon

  const sunVector = toVector(sunAz, sunEl);
  const normalVector = toVector(surfaceAz, 90 - tilt);

  const illumination = dot(sunVector, normalVector);
  if (illumination <= 0) return null; // sun is behind the surface

  const reflectedVector = reflect(sunVector, normalVector);
  const reflectedDir = toAzEl(reflectedVector);

  const observerVector = toVector(observerBearing, observerElevation);
  const separation = angularSeparation(reflectedVector, observerVector);

  const totalAngleDeg = toDeg(totalSubtendedAngleRad(slopeErrorMrad));
  // Observer is within the spread beam if inside half the total angular width.
  const glareDetected = separation < totalAngleDeg / 2;

  const eIrradiance = retinalIrradiance({ reflectance, peakDni, slopeErrorMrad, pupilDiameterMm, ocularTransmission, eyeFocalLengthMm });
  const ocularHazard = classifyOcularHazard(eIrradiance);
  const severity = glareDetected ? ocularHazard : 'None';

  return {
    reflection: reflectedDir,
    separation,
    totalAngleDeg,
    retinalIrradianceWm2: eIrradiance,
    retinalIrradianceWcm2: eIrradiance / 10000,
    ocularHazard,
    severity,
    glareDetected,
  };
}

/* ---------------- Weather (Open-Meteo, no API key) ---------------- */

async function fetchCloudCover(lat, lon, dateStr) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=cloudcover&start_date=${dateStr}&end_date=${dateStr}&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    const values = json?.hourly?.cloudcover;
    if (!values || !values.length) return null;
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    return Math.round(avg);
  } catch (err) {
    // Open-Meteo's free forecast only covers roughly the next 16 days —
    // dates outside that range, or offline use, just skip this step.
    return null;
  }
}

function weatherNote(cloudCover) {
  if (cloudCover === null) {
    return 'Weather data unavailable for this date (only ~16 days ahead are forecastable).';
  }
  if (cloudCover < 20) return `Clear skies expected (${cloudCover}% average cloud cover) — glare highly likely if geometry lines up.`;
  if (cloudCover < 60) return `Partly cloudy expected (${cloudCover}% average cloud cover) — glare possible during clear spells.`;
  return `Mostly cloudy expected (${cloudCover}% average cloud cover) — direct sun, and therefore glare, less likely.`;
}

/* ---------------- Form input handling ---------------- */

function readForm() {
  return {
    latitude: parseFloat(form.latitude.value),
    longitude: parseFloat(form.longitude.value),
    date: form.reportDate.value,
    time: form.reportTime.value,
    tilt: parseFloat(form.tilt.value),
    surfaceAz: parseFloat(form.azimuth.value),
    surfaceType: form.surfaceType.value,
    observerBearing: parseFloat(form.observerBearing.value),
    observerElevation: parseFloat(form.observerElevation.value),
    reflectance: parseFloat(form.reflectance.value) / 100, // stored as %, used as fraction
    slopeErrorMrad: parseFloat(form.slopeError.value),
    peakDni: parseFloat(form.peakDni.value),
    pupilDiameterMm: parseFloat(form.pupilDiameter.value),
    ocularTransmission: parseFloat(form.ocularTransmission.value),
    eyeFocalLengthMm: parseFloat(form.eyeFocalLength.value),
  };
}

function validate(d) {
  const errors = [];
  if (Number.isNaN(d.latitude) || d.latitude < -90 || d.latitude > 90) errors.push('Latitude must be between -90 and 90.');
  if (Number.isNaN(d.longitude) || d.longitude < -180 || d.longitude > 180) errors.push('Longitude must be between -180 and 180.');
  if (Number.isNaN(d.tilt) || d.tilt < 0 || d.tilt > 90) errors.push('Tilt must be between 0 and 90.');
  if (Number.isNaN(d.surfaceAz) || d.surfaceAz < 0 || d.surfaceAz > 360) errors.push('Surface azimuth must be between 0 and 360.');
  if (Number.isNaN(d.observerBearing) || d.observerBearing < 0 || d.observerBearing > 360) errors.push('Observer bearing must be between 0 and 360.');
  if (Number.isNaN(d.observerElevation) || d.observerElevation < -90 || d.observerElevation > 90) errors.push('Observer elevation must be between -90 and 90.');
  if (!d.date) errors.push('Date is required.');
  if (!d.time) errors.push('Time is required.');
  if (Number.isNaN(d.reflectance) || d.reflectance < 0 || d.reflectance > 1) errors.push('Surface reflectance must be between 0 and 100%.');
  if (Number.isNaN(d.slopeErrorMrad) || d.slopeErrorMrad < 0) errors.push('Slope error must be 0 or greater.');
  if (Number.isNaN(d.peakDni) || d.peakDni <= 0) errors.push('Peak DNI must be greater than 0.');
  if (Number.isNaN(d.pupilDiameterMm) || d.pupilDiameterMm <= 0) errors.push('Pupil diameter must be greater than 0.');
  if (Number.isNaN(d.ocularTransmission) || d.ocularTransmission <= 0 || d.ocularTransmission > 1) errors.push('Ocular transmission coefficient must be between 0 and 1.');
  if (Number.isNaN(d.eyeFocalLengthMm) || d.eyeFocalLengthMm <= 0) errors.push('Eye focal length must be greater than 0.');
  return errors;
}

/* ---------------- Single-moment report ---------------- */

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const d = readForm();
  const errors = validate(d);
  if (errors.length) {
    alert(errors.join('\n'));
    return;
  }

  const dateObj = new Date(`${d.date}T${d.time}:00`);
  const sun = getSunPosition(dateObj, d.latitude, d.longitude);
  const glare = calculateGlare({
    sunAz: sun.azimuth,
    sunEl: sun.elevation,
    tilt: d.tilt,
    surfaceAz: d.surfaceAz,
    observerBearing: d.observerBearing,
    observerElevation: d.observerElevation,
    reflectance: d.reflectance,
    slopeErrorMrad: d.slopeErrorMrad,
    peakDni: d.peakDni,
    pupilDiameterMm: d.pupilDiameterMm,
    ocularTransmission: d.ocularTransmission,
    eyeFocalLengthMm: d.eyeFocalLengthMm,
  });

  renderResult(d, sun, glare);

  const cloudCover = await fetchCloudCover(d.latitude, d.longitude, d.date);
  appendWeatherNote(cloudCover);

  await saveReport(d, sun, glare, cloudCover);
  loadSavedReports();
});

function renderResult(d, sun, glare) {
  resultsEmpty.hidden = true;
  resultsContent.hidden = false;
  yearPlotContainer.hidden = true;

  const sunBelowHorizon = sun.elevation <= 0;

  resultsContent.innerHTML = `
    <div class="result-block">
      <h3 class="result-heading">Sun position</h3>
      <dl class="data-grid">
        <dt>Azimuth</dt><dd>${sun.azimuth.toFixed(1)}°</dd>
        <dt>Elevation</dt><dd>${sun.elevation.toFixed(1)}°${sunBelowHorizon ? ' (below horizon)' : ''}</dd>
      </dl>
    </div>

    <div class="result-block">
      <h3 class="result-heading">Reflection &amp; Ocular Hazard</h3>
      ${
        glare
          ? `<dl class="data-grid">
              <dt>Reflected azimuth</dt><dd>${glare.reflection.azimuth.toFixed(1)}°</dd>
              <dt>Reflected elevation</dt><dd>${glare.reflection.elevation.toFixed(1)}°</dd>
              <dt>Angle to observer</dt><dd>${glare.separation.toFixed(2)}°</dd>
              <dt>Beam spread (total)</dt><dd>${glare.totalAngleDeg.toFixed(2)}°</dd>
              <dt>Retinal irradiance</dt><dd>${glare.retinalIrradianceWcm2.toFixed(4)} W/cm²</dd>
            </dl>
            <p class="glare-verdict severity-${glare.severity.toLowerCase()}">
              ${
                glare.glareDetected
                  ? glare.severity === 'High'
                    ? 'Glare present — potential retinal injury risk'
                    : glare.severity === 'Moderate'
                    ? 'Glare present — potential temporary after-image (flash blindness)'
                    : 'Glare present — low hazard'
                  : 'No significant glare at this moment'
              }
            </p>`
          : `<p class="glare-verdict severity-none">No reflection reaches the observer direction — sun is below the horizon or behind the surface.</p>`
      }
    </div>

    <div id="weatherNote" class="result-block weather-block"></div>
  `;
}

function appendWeatherNote(cloudCover) {
  const el = document.getElementById('weatherNote');
  if (el) {
    el.innerHTML = `<h3 class="result-heading">Real-world conditions</h3><p class="weather-text">${weatherNote(cloudCover)}</p>`;
  }
}

/* ---------------- Full-day scan ---------------- */

scanDayBtn.addEventListener('click', () => {
  const d = readForm();
  const errors = validate(d);
  if (errors.length) {
    alert(errors.join('\n'));
    return;
  }

  const baseDate = new Date(`${d.date}T00:00:00`);
  const times = SunCalc.getTimes(baseDate, d.latitude, d.longitude);
  const start = times.sunrise;
  const end = times.sunset;

  if (!start || !end || isNaN(start) || isNaN(end)) {
    alert('Could not determine sunrise/sunset for this location and date (likely polar day/night).');
    return;
  }

  const stepMinutes = 5;
  const points = [];
  for (let t = new Date(start); t <= end; t = new Date(t.getTime() + stepMinutes * 60000)) {
    const sun = getSunPosition(t, d.latitude, d.longitude);
    const glare = calculateGlare({
      sunAz: sun.azimuth,
      sunEl: sun.elevation,
      tilt: d.tilt,
      surfaceAz: d.surfaceAz,
      observerBearing: d.observerBearing,
      observerElevation: d.observerElevation,
      reflectance: d.reflectance,
      slopeErrorMrad: d.slopeErrorMrad,
      peakDni: d.peakDni,
      pupilDiameterMm: d.pupilDiameterMm,
      ocularTransmission: d.ocularTransmission,
      eyeFocalLengthMm: d.eyeFocalLengthMm,
    });
    points.push({ time: new Date(t), glare });
  }

  const windows = [];
  let current = null;
  for (const p of points) {
    if (p.glare && p.glare.glareDetected) {
      if (!current) {
        current = { start: p.time, end: p.time, worst: p.glare.severity };
      } else {
        current.end = p.time;
        if (severityRank(p.glare.severity) > severityRank(current.worst)) {
          current.worst = p.glare.severity;
        }
      }
    } else if (current) {
      windows.push(current);
      current = null;
    }
  }
  if (current) windows.push(current);

  renderDayScan(windows);
});

function severityRank(s) {
  return { High: 3, Moderate: 2, Low: 1, None: 0 }[s] ?? 0;
}

function fmtTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function renderDayScan(windows) {
  resultsEmpty.hidden = true;
  resultsContent.hidden = false;
  yearPlotContainer.hidden = true;

  if (!windows.length) {
    resultsContent.innerHTML = `<p class="glare-verdict severity-none">No glare windows found for this geometry across the whole day.</p>`;
    return;
  }

  const rows = windows
    .map(
      (w) => `<tr>
        <td>${fmtTime(w.start)} – ${fmtTime(w.end)}</td>
        <td class="severity-${w.worst.toLowerCase()}">${w.worst}</td>
      </tr>`
    )
    .join('');

  resultsContent.innerHTML = `
    <h3 class="result-heading">Glare windows (5-minute resolution)</h3>
    <table class="scan-table">
      <thead><tr><th>Time range</th><th>Peak severity</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

/* ---------------- Full-year scan (glare occurrence plot) ---------------- */

scanYearBtn.addEventListener('click', () => {
  const d = readForm();
  const errors = validate(d);
  if (errors.length) {
    alert(errors.join('\n'));
    return;
  }

  const year = parseInt(d.date.slice(0, 4), 10);
  const stepMinutes = 10; // coarser than day-scan to keep ~365 days fast
  const points = []; // { dayOfYear, minutesSinceMidnight, severity }

  const jan1 = new Date(year, 0, 1);
  for (let dayOffset = 0; dayOffset < 365; dayOffset++) {
    const dayDate = new Date(jan1.getTime() + dayOffset * 86400000);
    const times = SunCalc.getTimes(dayDate, d.latitude, d.longitude);
    const start = times.sunrise;
    const end = times.sunset;
    if (!start || !end || isNaN(start) || isNaN(end)) continue; // polar day/night

    for (let t = new Date(start); t <= end; t = new Date(t.getTime() + stepMinutes * 60000)) {
      const sun = getSunPosition(t, d.latitude, d.longitude);
      const glare = calculateGlare({
        sunAz: sun.azimuth,
        sunEl: sun.elevation,
        tilt: d.tilt,
        surfaceAz: d.surfaceAz,
        observerBearing: d.observerBearing,
        observerElevation: d.observerElevation,
        reflectance: d.reflectance,
        slopeErrorMrad: d.slopeErrorMrad,
        peakDni: d.peakDni,
        pupilDiameterMm: d.pupilDiameterMm,
        ocularTransmission: d.ocularTransmission,
        eyeFocalLengthMm: d.eyeFocalLengthMm,
      });
      if (glare && glare.glareDetected) {
        points.push({
          dayOfYear: dayOffset,
          minutesSinceMidnight: t.getHours() * 60 + t.getMinutes(),
          severity: glare.severity,
        });
      }
    }
  }

  renderYearPlot(points, year);
});

function renderYearPlot(points, year) {
  resultsEmpty.hidden = true;
  resultsContent.hidden = true;
  yearPlotContainer.hidden = false;

  if (!points.length) {
    yearPlotSvgWrap.innerHTML = '';
    yearPlotStatus.textContent = `No glare found at any point across ${year} for this geometry.`;
    return;
  }

  yearPlotStatus.textContent = `${points.length} glare moments found across ${year} (10-minute resolution).`;

  const width = 900;
  const height = 340;
  const marginLeft = 50;
  const marginBottom = 30;
  const marginTop = 10;
  const marginRight = 10;
  const plotW = width - marginLeft - marginRight;
  const plotH = height - marginTop - marginBottom;

  const colorFor = (sev) => (sev === 'High' ? '#E0654F' : sev === 'Moderate' ? '#F4A736' : '#4FA8E0');

  const dots = points
    .map((p) => {
      const x = marginLeft + (p.dayOfYear / 365) * plotW;
      const y = marginTop + (1 - p.minutesSinceMidnight / 1440) * plotH;
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.6" fill="${colorFor(p.severity)}" opacity="0.85" />`;
    })
    .join('');

  // Month gridlines/labels
  const monthLabels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthLines = monthLabels
    .map((label, i) => {
      const dayFrac = i / 12;
      const x = marginLeft + dayFrac * plotW;
      return `
        <line x1="${x}" y1="${marginTop}" x2="${x}" y2="${marginTop + plotH}" stroke="#232E47" stroke-width="1" />
        <text x="${x + 4}" y="${height - 10}" fill="#7C8699" font-size="11" font-family="IBM Plex Mono, monospace">${label}</text>
      `;
    })
    .join('');

  // Hour gridlines (every 4 hours)
  const hourLines = [0, 4, 8, 12, 16, 20, 24]
    .map((h) => {
      const y = marginTop + (1 - h / 24) * plotH;
      return `
        <line x1="${marginLeft}" y1="${y}" x2="${marginLeft + plotW}" y2="${y}" stroke="#1A2439" stroke-width="1" />
        <text x="8" y="${y + 4}" fill="#7C8699" font-size="11" font-family="IBM Plex Mono, monospace">${String(h).padStart(2, '0')}:00</text>
      `;
    })
    .join('');

  yearPlotSvgWrap.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" style="width:100%; height:auto; background:#0D1526; border:1px solid #232E47; border-radius:8px;">
      ${hourLines}
      ${monthLines}
      ${dots}
    </svg>
  `;
}

/* ---------------- Supabase persistence ---------------- */

async function saveReport(d, sun, glare, cloudCover) {
  if (!window.db) return; // no database configured yet

  // If someone is logged in, tag the report as theirs so it shows up
  // in their dashboard and can later be marked "official" by an admin.
  // Logged-out visitors can still save/use the tool as a guest report.
  let userId = null;
  const { data: userData } = await window.db.auth.getUser();
  if (userData?.user) userId = userData.user.id;

  const { error } = await window.db.from('reports').insert({
    user_id: userId,
    latitude: d.latitude,
    longitude: d.longitude,
    report_date: d.date,
    report_time: d.time,
    tilt: d.tilt,
    surface_azimuth: d.surfaceAz,
    surface_type: d.surfaceType,
    observer_bearing: d.observerBearing,
    observer_elevation: d.observerElevation,
    sun_azimuth: sun.azimuth,
    sun_elevation: sun.elevation,
    reflection_azimuth: glare ? glare.reflection.azimuth : null,
    reflection_elevation: glare ? glare.reflection.elevation : null,
    angular_separation: glare ? glare.separation : null,
    glare_detected: glare ? glare.glareDetected : false,
    severity: glare ? glare.severity : 'None',
    cloud_cover_pct: cloudCover,
    reflectance_pct: d.reflectance * 100,
    slope_error_mrad: d.slopeErrorMrad,
    peak_dni: d.peakDni,
    pupil_diameter_mm: d.pupilDiameterMm,
    ocular_transmission: d.ocularTransmission,
    eye_focal_length_mm: d.eyeFocalLengthMm,
    total_beam_spread_deg: glare ? glare.totalAngleDeg : null,
    retinal_irradiance_wcm2: glare ? glare.retinalIrradianceWcm2 : null,
    ocular_hazard: glare ? glare.ocularHazard : null,
  });

  if (error) console.error('Supabase insert failed:', error.message);
}

async function loadSavedReports() {
  if (!window.db) {
    dbStatus.textContent = 'No database connected — reports run in this session only. See config.js.';
    return;
  }

  const { data, error } = await window.db
    .from('reports')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) {
    dbStatus.textContent = `Database connected, but couldn't load reports: ${error.message}`;
    return;
  }

  dbStatus.textContent = `Connected — showing the ${data.length} most recent report${data.length === 1 ? '' : 's'}.`;
  savedReportsEl.innerHTML = data
    .map(
      (r) => `<div class="saved-item">
        <span class="saved-item-loc">${Number(r.latitude).toFixed(3)}, ${Number(r.longitude).toFixed(3)}</span>
        <span class="saved-item-date">${r.report_date} ${r.report_time}</span>
        <span class="saved-item-severity severity-${(r.severity || 'none').toLowerCase()}">${r.severity || 'None'}</span>
      </div>`
    )
    .join('');
}

document.addEventListener('DOMContentLoaded', loadSavedReports);