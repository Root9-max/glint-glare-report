// Glint & Glare Report — script.js
// Real sun-position + reflection-geometry calculations, a full-day
// glare scan, live weather context, and Supabase persistence.

const form = document.getElementById('glareForm');
const resultsEmpty = document.getElementById('resultsEmpty');
const resultsContent = document.getElementById('resultsContent');
const scanDayBtn = document.getElementById('scanDayBtn');
const dbStatus = document.getElementById('dbStatus');
const savedReportsEl = document.getElementById('savedReports');

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

/* ---------------- Core glare calculation ---------------- */

// Returns null if the sun cannot illuminate the front face of the
// surface (sun behind the panel/wall) — no reflection is possible.
function calculateGlare({ sunAz, sunEl, tilt, surfaceAz, observerBearing, observerElevation }) {
  if (sunEl <= 0) return null; // sun below horizon

  const sunVector = toVector(sunAz, sunEl);
  const normalVector = toVector(surfaceAz, 90 - tilt);

  const illumination = dot(sunVector, normalVector);
  if (illumination <= 0) return null; // sun is behind the surface

  const reflectedVector = reflect(sunVector, normalVector);
  const reflectedDir = toAzEl(reflectedVector);

  const observerVector = toVector(observerBearing, observerElevation);
  const separation = angularSeparation(reflectedVector, observerVector);

  let severity = 'None';
  if (separation < 1) severity = 'High';
  else if (separation < 3) severity = 'Moderate';
  else if (separation < 6) severity = 'Low';

  return {
    reflection: reflectedDir,
    separation,
    severity,
    glareDetected: separation < 6,
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
      <h3 class="result-heading">Reflection</h3>
      ${
        glare
          ? `<dl class="data-grid">
              <dt>Reflected azimuth</dt><dd>${glare.reflection.azimuth.toFixed(1)}°</dd>
              <dt>Reflected elevation</dt><dd>${glare.reflection.elevation.toFixed(1)}°</dd>
              <dt>Angle to observer</dt><dd>${glare.separation.toFixed(2)}°</dd>
            </dl>
            <p class="glare-verdict severity-${glare.severity.toLowerCase()}">
              ${glare.glareDetected ? `Glare likely — severity: ${glare.severity}` : 'No significant glare at this moment'}
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