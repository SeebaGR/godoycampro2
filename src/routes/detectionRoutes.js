const express = require('express');
const router = express.Router();
const cameraService = require('../services/cameraService');
const directus = require('../config/directus');
const { createPlateDedupeGate } = require('../services/plateDedupeGate');

const detectionsCache = new Map();
const plateGate = createPlateDedupeGate();
let lastDetectionsOk = null;
let lastDetectionsOkAt = 0;

function safeJsonParse(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function cleanPlateText(input) {
  if (typeof input !== 'string') return null;
  const upper = input.trim().toUpperCase();
  const mapped = upper.replace(/[\u0400-\u04FF\u0370-\u03FF]/g, (ch) => {
    const map = {
      'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X', 'У': 'Y', 'І': 'I', 'Ј': 'J',
      'З': 'Z',
      'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X'
    };
    return map[ch] || '';
  });
  const cleaned = mapped.replace(/[^A-Z0-9]/g, '');
  if (!cleaned || cleaned.length < 5) return null;
  if (/^[A-Z]{4}\d{3}$/.test(cleaned)) return cleaned;
  if (/^[A-Z]{4}\d{2}$/.test(cleaned)) return cleaned;
  if (/^[A-Z]{2}\d{4}$/.test(cleaned)) return cleaned;
  const modern = cleaned.match(/[A-Z]{4}\d{2}/);
  if (modern) return modern[0];
  const old = cleaned.match(/[A-Z]{2}\d{4}/);
  if (old) return old[0];
  if (cleaned.length >= 6) {
    const mapDigit = (ch) => {
      if (ch === 'O' || ch === 'Q') return '0';
      if (ch === 'I') return '1';
      if (ch === 'Z') return '2';
      if (ch === 'S') return '5';
      if (ch === 'B') return '8';
      return ch;
    };
    const seven = cleaned.slice(0, 7);
    if (/^[A-Z]{4}[A-Z0-9]{3}$/.test(seven)) {
      const maybeMoto = seven.slice(0, 4) + mapDigit(seven[4]) + mapDigit(seven[5]) + mapDigit(seven[6]);
      if (/^[A-Z]{4}\d{3}$/.test(maybeMoto)) return maybeMoto;
    }
    const six = cleaned.slice(0, 6);
    const asModern = six.slice(0, 4) + mapDigit(six[4]) + mapDigit(six[5]);
    if (/^[A-Z]{4}\d{2}$/.test(asModern)) return asModern;
    const asOld = six.slice(0, 2) + mapDigit(six[2]) + mapDigit(six[3]) + mapDigit(six[4]) + mapDigit(six[5]);
    if (/^[A-Z]{2}\d{4}$/.test(asOld)) return asOld;
    return six;
  }
  return cleaned;
}

function isChileanPlate(plate) {
  if (typeof plate !== 'string') return false;
  const p = cleanPlateText(plate);
  if (!p) return false;
  // Relaxed check: Aceptamos cualquier patente alfanumérica entre 4 y 10 caracteres
  return /^[A-Z0-9]{4,10}$/.test(p);
}

let getApiCooldownUntilMs = 0;
const enrichInFlight = new Set();
let getApiRateChain = Promise.resolve();
let getApiNextSlotMs = 0;
let getApiWindowStartMs = Date.now();
let getApiRequestsInWindow = 0;
let getApiDetectionsAttemptedInWindow = 0;
let getApiDetectionsOkInWindow = 0;

function envBool(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return Boolean(defaultValue);
  const v = String(raw).trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return Boolean(defaultValue);
}

function isGetApiEnabled() {
  return envBool('GETAPI_ENABLED', false);
}

function getGetApiRateLimitPerMin() {
  const n = Number.parseInt(process.env.GETAPI_RATE_LIMIT_PER_MIN ?? '25', 10);
  return Math.min(600, Math.max(1, Number.isFinite(n) ? n : 25));
}

function rollGetApiWindow(nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const elapsed = now - getApiWindowStartMs;
  if (elapsed < 60000) return;
  const rpm = elapsed > 0 ? Math.round((getApiRequestsInWindow * 60000) / elapsed) : 0;
  const cooldownMs = Math.max(0, getApiCooldownUntilMs - now);
  const shouldLog = getApiRequestsInWindow > 0 || getApiDetectionsAttemptedInWindow > 0 || getApiDetectionsOkInWindow > 0 || cooldownMs > 0;
  if (shouldLog) {
    console.log('GetAPI throughput (última ventana):', {
      requests: getApiRequestsInWindow,
      rpm,
      detections_attempted: getApiDetectionsAttemptedInWindow,
      detections_ok: getApiDetectionsOkInWindow,
      cooldown_ms: cooldownMs
    });
  }
  getApiWindowStartMs = now;
  getApiRequestsInWindow = 0;
  getApiDetectionsAttemptedInWindow = 0;
  getApiDetectionsOkInWindow = 0;
}

function recordGetApiRequest(nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  rollGetApiWindow(now);
  getApiRequestsInWindow += 1;
}

function recordGetApiDetectionAttempt(nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  rollGetApiWindow(now);
  getApiDetectionsAttemptedInWindow += 1;
}

function recordGetApiDetectionOk(nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  rollGetApiWindow(now);
  getApiDetectionsOkInWindow += 1;
}

function waitForGetApiSlot() {
  const ratePerMin = getGetApiRateLimitPerMin();
  const intervalMs = Math.max(1, Math.ceil(60000 / ratePerMin));
  const scheduled = getApiRateChain.then(async () => {
    const now = Date.now();
    const earliest = Math.max(now, getApiNextSlotMs);
    const waitMs = earliest - now;
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    const started = Date.now();
    getApiNextSlotMs = started + intervalMs;
    recordGetApiRequest(started);
  });
  getApiRateChain = scheduled.catch(() => null);
  return scheduled;
}

function isMotorcycleType(vehicleType) {
  if (!vehicleType) return false;
  const t = String(vehicleType).trim().toLowerCase();
  if (!t) return false;
  return t.includes('moto') || t.includes('motorcycle');
}

function formatMotorcyclePlate(plate) {
  if (typeof plate !== 'string') return plate;
  if (/^[A-Z]{4}\d{3}$/.test(plate)) return plate;
  if (/^[A-Z]{4}\d{2}$/.test(plate)) return plate.slice(0, 4) + '0' + plate.slice(4);
  return plate;
}

const getApiMetricsTimer = setInterval(() => {
  rollGetApiWindow(Date.now());
}, 60000);
if (getApiMetricsTimer && typeof getApiMetricsTimer.unref === 'function') getApiMetricsTimer.unref();

function getGetApiKey() {
  const v =
    process.env.GETAPI_API_KEY ||
    process.env.GETAPI_KEY ||
    process.env.GETAPI_X_API_KEY ||
    process.env.X_API_KEY_GETAPI ||
    '';
  const t = String(v).trim();
  return t || null;
}

function absolutizePublicUrl(pathOrUrl) {
  if (typeof pathOrUrl !== 'string') return null;
  const s = pathOrUrl.trim();
  if (!s) return null;
  if (s.startsWith('http://') || s.startsWith('https://')) return s;
  const base = (process.env.PUBLIC_BASE_URL || process.env.APP_URL || process.env.BASE_URL || '').trim().replace(/\/+$/, '');
  if (!base) return null;
  if (s.startsWith('/')) return base + s;
  return base + '/' + s;
}

async function fetchGetApiJson(path) {
  const base = (process.env.GETAPI_BASE_URL || 'https://chile.getapi.cl').trim().replace(/\/+$/, '');
  const key = getGetApiKey();
  if (!key) return { ok: false, status: 401, data: null, reason: 'missing_getapi_key', message: 'Falta GETAPI_API_KEY' };
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
  if (Date.now() < getApiCooldownUntilMs) {
    return { ok: false, status: 429, data: null, reason: 'rate_limited', message: 'Cooldown activo' };
  }
  await waitForGetApiSlot();
  if (Date.now() < getApiCooldownUntilMs) {
    return { ok: false, status: 429, data: null, reason: 'rate_limited', message: 'Cooldown activo' };
  }
  if (envBool('GETAPI_LOG_REQUESTS', false)) {
    console.log('Consultando GetAPI:', url);
  }
  const res = await fetch(url, { headers: { 'X-Api-Key': key, Accept: 'application/json' } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const parsed = safeJsonParse(text);
    const msg =
      parsed?.data?.message ||
      parsed?.message ||
      parsed?.error?.message ||
      (typeof text === 'string' && text.trim()) ||
      `HTTP ${res.status}`;
    const reason =
      res.status === 429 ? 'rate_limited' :
      res.status === 404 ? 'not_found' :
      res.status === 422 ? 'invalid_plate' :
      res.status === 401 ? 'unauthorized' :
      res.status === 403 ? 'forbidden' :
      'upstream_error';
    return { ok: false, status: res.status, data: null, reason, message: msg };
  }
  const json = await res.json().catch(() => null);
  return { ok: true, status: res.status, data: json, reason: null, message: null };
}

function unwrapGetApiData(payload) {
  let cur = payload;
  for (let i = 0; i < 3; i += 1) {
    if (!cur || typeof cur !== 'object') break;
    if (!('data' in cur)) break;
    const next = cur.data;
    if (!next || typeof next !== 'object') break;
    cur = next;
  }
  return cur;
}

function normalizeVehicleData(vehicleData) {
  if (!vehicleData || typeof vehicleData !== 'object') return vehicleData;
  const v = { ...vehicleData };
  if (v.model?.brand && !v.brand) v.brand = v.model.brand;
  if (!v.monthRT && v.month_rt) v.monthRT = v.month_rt;
  if (!v.rtDate && v.rt_date) v.rtDate = v.rt_date;
  if (!v.rtResult && v.rt_result) v.rtResult = v.rt_result;
  if (!v.rtResultGas && v.rt_result_gas) v.rtResultGas = v.rt_result_gas;
  if (!v.plantaRevisora && v.planta_revisora) v.plantaRevisora = v.planta_revisora;
  const rt = v.rt && typeof v.rt === 'object' ? v.rt : null;
  if (rt) {
    if (!v.monthRT && (rt.monthRT || rt.month_rt || rt.month)) v.monthRT = rt.monthRT || rt.month_rt || rt.month;
    if (!v.rtDate && (rt.rtDate || rt.rt_date || rt.date)) v.rtDate = rt.rtDate || rt.rt_date || rt.date;
    if (!v.rtResult && (rt.rtResult || rt.rt_result || rt.result)) v.rtResult = rt.rtResult || rt.rt_result || rt.result;
    if (!v.rtResultGas && (rt.rtResultGas || rt.rt_result_gas || rt.resultGas || rt.gasResult)) v.rtResultGas = rt.rtResultGas || rt.rt_result_gas || rt.resultGas || rt.gasResult;
    if (!v.plantaRevisora && (rt.plantaRevisora || rt.planta_revisora)) v.plantaRevisora = rt.plantaRevisora || rt.planta_revisora;
  }
  return v;
}

function normalizeAppraisalData(appraisalData) {
  if (!appraisalData || typeof appraisalData !== 'object') return appraisalData;
  const a = { ...appraisalData };
  if (!a.precioUsado && a.precio_usado) a.precioUsado = a.precio_usado;
  if (!a.precioRetoma && a.precio_retoma) a.precioRetoma = a.precio_retoma;
  return a;
}

function parseGetApiField(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') return safeJsonParse(value);
  return null;
}

function extractGetApiPayloadFromRow(row) {
  if (!row || typeof row !== 'object') return null;
  const candidates = [
    row.getapi,
    row.payload,
    row.data,
    row.result,
    row.response,
    row.json
  ];
  for (const c of candidates) {
    const parsed = parseGetApiField(c);
    if (parsed && typeof parsed === 'object') return parsed;
  }
  const vehicle = parseGetApiField(row.vehicle);
  const appraisal = parseGetApiField(row.appraisal);
  const plate = typeof row.plate === 'string' ? row.plate : (typeof row.license_plate === 'string' ? row.license_plate : null);
  const fetchedAt = typeof row.fetched_at === 'string' ? row.fetched_at : null;
  if ((vehicle && typeof vehicle === 'object') || (appraisal && typeof appraisal === 'object')) {
    return {
      plate: plate || null,
      fetched_at: fetchedAt || null,
      vehicle: vehicle && typeof vehicle === 'object' ? vehicle : null,
      appraisal: appraisal && typeof appraisal === 'object' ? appraisal : null
    };
  }
  for (const v of Object.values(row)) {
    const parsed = parseGetApiField(v);
    if (parsed && typeof parsed === 'object' && (parsed.fetched_at || parsed.vehicle || parsed.appraisal)) return parsed;
  }
  return null;
}

function extractDetectionIdFromGetApiRow(row) {
  if (!row || typeof row !== 'object') return null;
  const direct = row.detection_id ?? row.detectionId ?? row.detection ?? null;
  if (typeof direct === 'string' || typeof direct === 'number') {
    const s = String(direct).trim();
    return s || null;
  }
  for (const [k, v] of Object.entries(row)) {
    if (!k.toLowerCase().includes('detection')) continue;
    if (typeof v === 'string' || typeof v === 'number') {
      const s = String(v).trim();
      if (s) return s;
    }
    if (v && typeof v === 'object' && ('id' in v)) {
      const s = String(v.id || '').trim();
      if (s) return s;
    }
  }
  return null;
}

function hasRtSignal(vehicle) {
  if (!vehicle || typeof vehicle !== 'object') return false;
  if (vehicle.rtDate && vehicle.rtDate !== '0000-00-00 00:00:00') return true;
  if (vehicle.rtResult) return true;
  if (vehicle.rtResultGas) return true;
  const pr = vehicle.plantaRevisora;
  if (pr && typeof pr === 'object' && (pr.concesionPlantaRevisora || pr.name || pr.nombre || pr.direccion || pr.comuna || pr.region)) return true;
  if (vehicle.rtPlant || vehicle.rtPlantName || vehicle.rtStation || vehicle.rtStationName) return true;
  return false;
}

function shouldBackfillRt(getapiObj, minAgeMs) {
  if (!getapiObj || typeof getapiObj !== 'object') return true;
  const fetchedAt = typeof getapiObj.fetched_at === 'string' ? Date.parse(getapiObj.fetched_at) : Number.NaN;
  if (Number.isFinite(fetchedAt)) {
    const age = Date.now() - fetchedAt;
    if (Number.isFinite(minAgeMs) && age < minAgeMs) return false;
  }
  const vehicle = getapiObj.vehicle;
  if (!vehicle || typeof vehicle !== 'object') return true;
  const normalized = normalizeVehicleData(vehicle);
  return !hasRtSignal(normalized);
}

function isTerminalGetApiReason(reason, upstreamStatus) {
  const r = typeof reason === 'string' ? reason : null;
  const s = Number.isFinite(Number(upstreamStatus)) ? Number(upstreamStatus) : null;
  if (r === 'invalid_plate_format') return true;
  if (r === 'invalid_plate' || s === 422) return true;
  if (r === 'not_found' || s === 404) return true;
  if (r === 'no_plate') return true;
  if (r === 'missing_getapi_key' || s === 401) return true;
  if (r === 'unauthorized' || r === 'forbidden' || s === 403) return true;
  return false;
}

function parseRetryAfterMs(message) {
  if (typeof message !== 'string') return null;
  const s = message.trim();
  if (!s) return null;
  const m1 = s.match(/try again in\s+(\d+)\s*s/i);
  if (m1 && Number.isFinite(Number(m1[1]))) return Math.max(0, Number(m1[1])) * 1000;
  const m2 = s.match(/retry[-\s]?after\s+(\d+)\s*s/i);
  if (m2 && Number.isFinite(Number(m2[1]))) return Math.max(0, Number(m2[1])) * 1000;
  return null;
}

function nextRetryDelayMs(attempt, reason, upstreamStatus, message) {
  const r = typeof reason === 'string' ? reason : null;
  const s = Number.isFinite(Number(upstreamStatus)) ? Number(upstreamStatus) : null;

  let base = 5000;
  if (r === 'no_plate') base = 6000;
  else if (r === 'invalid_plate' || s === 422) base = 15000;
  else if (r === 'not_found' || s === 404) base = 15000;
  else if (r === 'missing_getapi_key' || s === 401) base = 30000;
  else if (r === 'upstream_error' || r === 'internal_error') base = 6000;
  else if (r === 'rate_limited' || s === 429) base = parseRetryAfterMs(message) ?? 5000;

  const n = Math.max(0, Number(attempt) || 0);
  const backoff = Math.min(10 * 60 * 1000, base * Math.pow(2, Math.min(n, 5)));
  return Math.round(backoff);
}

function mapStatusForRow(reason, upstreamStatus) {
  const r = typeof reason === 'string' ? reason : null;
  const s = Number.isFinite(Number(upstreamStatus)) ? Number(upstreamStatus) : null;
  if (r === 'rate_limited' || s === 429) return 'rate_limited';
  if (r === 'not_found' || s === 404) return 'not_found';
  if (r === 'invalid_plate_format' || r === 'invalid_plate' || s === 422) return 'invalid_plate';
  return 'error';
}

async function enrichAndPersistDetection({ id, plate, vehicleType }) {
  if (!isGetApiEnabled()) return;
  const detId = String(id || '').trim();
  if (!detId) return;
  if (enrichInFlight.has(detId)) return;
  const key = getGetApiKey();
  if (!key) return;

  const basePlate = cleanPlateText(plate) || null;
  if (!basePlate) return;
  if (!isChileanPlate(basePlate)) return;
  if (Date.now() < getApiCooldownUntilMs) return;

  enrichInFlight.add(detId);
  try {
    recordGetApiDetectionAttempt(Date.now());
    let prevAttempts = 0;
    try {
      const m = await directus.listGetApiByDetectionIds([detId]);
      const row = m && typeof m.get === 'function' ? m.get(detId) : null;
      const a = row ? Number(row.attempts) : Number.NaN;
      if (Number.isFinite(a)) prevAttempts = a;
    } catch {
    }
    const attempt = prevAttempts + 1;
    const nowIso = new Date().toISOString();

    const motoZeroEnabled = envBool('GETAPI_MOTO_ZERO', true);
    const wantsMotoFormat = motoZeroEnabled && isMotorcycleType(vehicleType);
    const preferredPlate = wantsMotoFormat ? formatMotorcyclePlate(basePlate) : basePlate;
    const fallbackPlate = (!wantsMotoFormat && motoZeroEnabled) ? formatMotorcyclePlate(basePlate) : null;
    let plateForApi = preferredPlate;

    console.log('Iniciando enriquecimiento GetAPI para detección:', detId, 'patente:', plateForApi);

    let vehicleRes = await fetchGetApiJson(`/v1/vehicles/plate/${encodeURIComponent(plateForApi)}`);
    if (!vehicleRes.ok && fallbackPlate && fallbackPlate !== plateForApi && (vehicleRes.reason === 'invalid_plate' || vehicleRes.status === 422 || vehicleRes.reason === 'not_found' || vehicleRes.status === 404)) {
      const retryRes = await fetchGetApiJson(`/v1/vehicles/plate/${encodeURIComponent(fallbackPlate)}`);
      if (retryRes.ok) {
        vehicleRes = retryRes;
        plateForApi = fallbackPlate;
      }
    }
    if (!vehicleRes.ok) {
      const failure = {
        plate: plateForApi,
        fetched_at: nowIso,
        vehicle: null,
        appraisal: null,
        error: {
          upstream_status: vehicleRes.status,
          reason: vehicleRes.reason || null,
          message: vehicleRes.message || null
        }
      };

      const terminal = isTerminalGetApiReason(vehicleRes.reason, vehicleRes.status);
      const retryMs = nextRetryDelayMs(attempt, vehicleRes.reason, vehicleRes.status, vehicleRes.message);
      const nextRetryAt = (!terminal && retryMs > 0) ? new Date(Date.now() + retryMs).toISOString() : null;
      if (vehicleRes.reason === 'rate_limited' || vehicleRes.status === 429) {
        const pauseMs = Math.max(1000, retryMs);
        getApiCooldownUntilMs = Math.max(getApiCooldownUntilMs, Date.now() + pauseMs);
        console.warn('GetAPI limitado por tasa, se pausará solicitudes por ms:', pauseMs);
      }
      const meta = {
        license_plate: plateForApi,
        status: mapStatusForRow(vehicleRes.reason, vehicleRes.status),
        attempts: attempt,
        next_retry_at: nextRetryAt,
        fetched_at: nowIso,
        upstream_status: vehicleRes.status,
        reason: vehicleRes.reason || null,
        message: vehicleRes.message || null
      };

      let stored = false;
      try {
        stored = Boolean(await directus.upsertGetApiByDetectionId(detId, failure, meta));
      } catch {
      }

      const mirror = envBool('GETAPI_MIRROR_TO_DETECTIONS', false);
      if (!stored || mirror) {
        try {
          await directus.updateDetectionById(detId, { getapi: failure });
          console.log('Persistido fallo GetAPI en Directus para id:', detId);
        } catch (e1) {
          try {
            await directus.updateDetectionById(detId, { getapi: JSON.stringify(failure) });
            console.log('Persistido fallo GetAPI (string) en Directus para id:', detId);
          } catch (e2) {
            console.error('No se pudo persistir fallo GetAPI en Directus:', e2?.message || e2);
          }
        }
      }
      return;
    }

    const vehiclePayload = unwrapGetApiData(vehicleRes.data);
    const vehicleData = normalizeVehicleData(vehiclePayload);

    const appraisalRes = await fetchGetApiJson(`/v1/vehicles/appraisal/${encodeURIComponent(plateForApi)}`);
    if (!appraisalRes.ok) {
      if (appraisalRes.reason === 'rate_limited' || appraisalRes.status === 429) {
        const retryMs = nextRetryDelayMs(attempt, appraisalRes.reason, appraisalRes.status, appraisalRes.message);
        const pauseMs = Math.max(1000, retryMs);
        getApiCooldownUntilMs = Math.max(getApiCooldownUntilMs, Date.now() + pauseMs);
        console.warn('GetAPI tasación limitado por tasa, se pausará solicitudes por ms:', pauseMs);
      }

      const partial = {
        plate: plateForApi,
        fetched_at: nowIso,
        vehicle: vehicleData || null,
        appraisal: null,
        error: {
          upstream_status: appraisalRes.status,
          reason: appraisalRes.reason || null,
          message: appraisalRes.message || null
        }
      };

      const terminal = isTerminalGetApiReason(appraisalRes.reason, appraisalRes.status);
      const retryMs = nextRetryDelayMs(attempt, appraisalRes.reason, appraisalRes.status, appraisalRes.message);
      const nextRetryAt = (!terminal && retryMs > 0) ? new Date(Date.now() + retryMs).toISOString() : null;
      const meta = {
        license_plate: plateForApi,
        status: mapStatusForRow(appraisalRes.reason, appraisalRes.status),
        attempts: attempt,
        next_retry_at: nextRetryAt,
        fetched_at: nowIso,
        upstream_status: appraisalRes.status,
        reason: appraisalRes.reason || null,
        message: appraisalRes.message || null
      };

      let stored = false;
      try {
        stored = Boolean(await directus.upsertGetApiByDetectionId(detId, partial, meta));
      } catch {
      }

      const mirror = envBool('GETAPI_MIRROR_TO_DETECTIONS', false);
      if (!stored || mirror) {
        try {
          await directus.updateDetectionById(detId, { getapi: partial });
        } catch {
        }
      }
      return;
    }

    const appraisalPayload = unwrapGetApiData(appraisalRes.data);
    const appraisalData = normalizeAppraisalData(appraisalPayload);

    const result = {
      plate: plateForApi,
      fetched_at: nowIso,
      vehicle: vehicleData || null,
      appraisal: appraisalData || null
    };

    let stored = false;
    try {
      const meta = {
        license_plate: plateForApi,
        status: 'ok',
        attempts: attempt,
        next_retry_at: null,
        fetched_at: nowIso,
        upstream_status: 200
      };
      stored = Boolean(await directus.upsertGetApiByDetectionId(detId, result, meta));
    } catch {
    }

    const mirror = envBool('GETAPI_MIRROR_TO_DETECTIONS', false);
    if (!stored || mirror) {
      try {
        await directus.updateDetectionById(detId, { getapi: result });
        console.log('Enriquecimiento GetAPI persistido en Directus para id:', detId);
      } catch (e1) {
        try {
          await directus.updateDetectionById(detId, { getapi: JSON.stringify(result) });
          console.log('Enriquecimiento GetAPI persistido como string en Directus para id:', detId);
        } catch (e2) {
          console.error('No se pudo persistir enriquecimiento GetAPI en Directus:', e2?.message || e2);
        }
      }
    }
    recordGetApiDetectionOk(Date.now());
  } finally {
    enrichInFlight.delete(detId);
  }
}

let workerTimer = null;
let workerRunning = false;

async function runGetApiWorkerTick() {
  if (workerRunning) return;
  const enabled = envBool('GETAPI_BACKGROUND_WORKER', true);
  if (!enabled) return;
  if (!isGetApiEnabled()) return;
  if (!getGetApiKey()) return;
  if (Date.now() < getApiCooldownUntilMs) return;

  workerRunning = true;
  try {
    const fetchLimit = Math.min(100, Math.max(1, Number.parseInt(process.env.GETAPI_WORKER_FETCH_LIMIT ?? '50', 10) || 50));
    const defaultBatchSize = Math.max(1, Math.ceil(getGetApiRateLimitPerMin() / 2));
    const batchSize = Math.min(50, Math.max(1, Number.parseInt(process.env.GETAPI_WORKER_BATCH_SIZE ?? String(defaultBatchSize), 10) || defaultBatchSize));
    const concurrency = Math.min(10, Math.max(1, Number.parseInt(process.env.GETAPI_WORKER_CONCURRENCY ?? '4', 10) || 4));

    const scheduled = [];
    const seen = new Set();
    const push = (item) => {
      const detId = item && item.id != null ? String(item.id).trim() : '';
      if (!detId) return;
      if (seen.has(detId)) return;
      seen.add(detId);
      scheduled.push(item);
    };

    const retryRows = await directus.listGetApiRetryQueue({ limit: fetchLimit, nowIso: new Date().toISOString() }).catch(() => []);
    for (const row of (Array.isArray(retryRows) ? retryRows : [])) {
      if (scheduled.length >= batchSize) break;
      const detId = extractDetectionIdFromGetApiRow(row);
      if (!detId) continue;
      const plateFromRow = typeof row.license_plate === 'string' ? row.license_plate : (typeof row.plate === 'string' ? row.plate : null);
      const ga = extractGetApiPayloadFromRow(row);
      const plate = plateFromRow || (ga && typeof ga.plate === 'string' ? ga.plate : null);
      if (!plate) continue;
      push({ id: detId, plate, vehicleType: null });
    }

    const scanDetections = envBool('GETAPI_WORKER_SCAN_DETECTIONS', false);
    if (scanDetections && scheduled.length < batchSize && Date.now() >= getApiCooldownUntilMs) {
      const recent = await directus.listDetections({ page: 1, limit: fetchLimit });
      const recentRows = Array.isArray(recent?.data) ? recent.data : [];
      const ids = recentRows.map((x) => x?.id).filter(Boolean);
      const getApiById = await directus.listGetApiByDetectionIds(ids);
      for (const x of recentRows) {
        if (scheduled.length >= batchSize) break;
        if (!x || !x.id) continue;
        if (getApiById.has(String(x.id))) continue;
        if (typeof x.license_plate !== 'string' || !isChileanPlate(x.license_plate)) continue;
        push({ id: x.id, plate: x.license_plate, vehicleType: x.vehicle_type || null });
      }

      if (scheduled.length === 0 && envBool('GETAPI_WORKER_BACKFILL_RT', true)) {
        const minAgeMs = Math.max(0, Number.parseInt(process.env.GETAPI_WORKER_BACKFILL_MIN_AGE_MS ?? '3600000', 10) || 3600000);
        const page = await directus.listGetApiPage({ page: 1, limit: fetchLimit });
        const rows = Array.isArray(page?.data) ? page.data : [];
        const backfill = rows
          .map((r) => {
            const detId = extractDetectionIdFromGetApiRow(r) || '';
            const ga2 = extractGetApiPayloadFromRow(r);
            return { detId, ga: ga2 };
          })
          .filter((x) => x.detId && x.ga && shouldBackfillRt(x.ga, minAgeMs))
          .slice(0, batchSize);
        if (backfill.length) {
          const dets = await directus.listDetectionsByIds(backfill.map((x) => x.detId));
          const byId = new Map((Array.isArray(dets) ? dets : []).map((d) => [String(d?.id || ''), d]));
          for (const x of backfill) {
            if (scheduled.length >= batchSize) break;
            const det = byId.get(x.detId);
            const plate = det && typeof det.license_plate === 'string' ? det.license_plate : (x.ga && typeof x.ga.plate === 'string' ? x.ga.plate : null);
            if (!plate) continue;
            push({ id: x.detId, plate, vehicleType: det?.vehicle_type || null });
          }
        }
      }
    }

    if (scheduled.length === 0) return;

    let idx = 0;
    const runners = new Array(Math.min(concurrency, scheduled.length)).fill(0).map(async () => {
      while (idx < scheduled.length) {
        const cur = scheduled[idx];
        idx += 1;
        if (Date.now() < getApiCooldownUntilMs) break;
        await enrichAndPersistDetection(cur);
      }
    });
    await Promise.allSettled(runners);
  } catch (e) {
    console.warn('Worker GetAPI: fallo en tick:', e?.message || e);
  } finally {
    workerRunning = false;
  }
}

function startGetApiWorker() {
  if (workerTimer) return;
  const enabled = envBool('GETAPI_BACKGROUND_WORKER', true);
  if (!enabled) return;
  if (!isGetApiEnabled()) return;
  const intervalMs = Math.max(1000, Number.parseInt(process.env.GETAPI_WORKER_INTERVAL_MS ?? '5000', 10) || 5000);
  workerTimer = setInterval(() => {
    runGetApiWorkerTick().catch(() => null);
  }, intervalMs);
  runGetApiWorkerTick().catch(() => null);
}

startGetApiWorker();

router.get('/assets/:id', async (req, res) => {
  try {
    const { baseUrl, token } = directus.getDirectusConfig();
    if (!baseUrl) return res.status(500).send('DIRECTUS_URL no está configurado');
    if (!token) return res.status(500).send('DIRECTUS_TOKEN no está configurado');

    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).send('id requerido');

    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query || {})) {
      if (Array.isArray(v)) {
        for (const x of v) sp.append(k, String(x));
      } else if (v !== undefined && v !== null) {
        sp.set(k, String(v));
      }
    }
    const qs = sp.toString();
    const upstreamUrl = `${baseUrl}/assets/${encodeURIComponent(id)}${qs ? `?${qs}` : ''}`;

    const upstream = await fetch(upstreamUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      return res.status(upstream.status).send(text || upstream.statusText);
    }

    const contentType = upstream.headers.get('content-type');
    const contentLength = upstream.headers.get('content-length');
    const cacheControl = upstream.headers.get('cache-control');
    if (contentType) res.setHeader('Content-Type', contentType);
    if (contentLength) res.setHeader('Content-Length', contentLength);
    res.setHeader('Cache-Control', cacheControl || 'public, max-age=31536000, immutable');

    const arrayBuffer = await upstream.arrayBuffer();
    return res.status(200).send(Buffer.from(arrayBuffer));
  } catch (error) {
    console.error('Error sirviendo asset de Directus:', error);
    return res.status(500).send('Error');
  }
});

// Endpoint para recibir detecciones desde la cámara DAHUA
router.post('/webhook/detection', async (req, res) => {
  try {
    const logPayload = process.env.LOG_DETECTION_PAYLOAD === '1' || process.env.LOG_DETECTION_PAYLOAD === 'true';
    const logMax = Number.parseInt(process.env.LOG_DETECTION_PAYLOAD_MAX ?? '8000', 10) || 8000;
    const dedupeSeconds = Number.parseInt((process.env.DEDUPE_WINDOW_SECONDS ?? process.env.EVENT_DEDUPE_WINDOW_SECONDS ?? '900'), 10) || 900;

    const safeStringify = (value) => {
      try {
        const text = JSON.stringify(
          value,
          (k, v) => {
            if (typeof v === 'string' && v.length > 800) return v.slice(0, 800) + '…';
            return v;
          },
          2
        );
        return text.length > logMax ? text.slice(0, logMax) + '…' : text;
      } catch {
        return '[unserializable]';
      }
    };

    if (logPayload) {
      console.log('Detección recibida de la cámara (raw):', safeStringify(req.body));
    }

    const rawItems = Array.isArray(req.body) ? req.body : [req.body];
    const normalizedPairs = rawItems.map((raw) => ({ raw, data: cameraService.normalizeDetectionData(raw) }));

    const byPlate = new Map();
    const noPlate = [];
    for (const p of normalizedPairs) {
      const plate = plateGate.normalizePlateKey(p.data?.license_plate);
      if (!plate) {
        noPlate.push(p);
        continue;
      }
      const existing = byPlate.get(plate);
      const ms = p.data?.timestamp ? Date.parse(p.data.timestamp) : Number.NaN;
      const exMs = existing?.data?.timestamp ? Date.parse(existing.data.timestamp) : Number.NaN;
      if (!existing || (!Number.isFinite(exMs) && Number.isFinite(ms)) || (Number.isFinite(ms) && Number.isFinite(exMs) && ms > exMs)) {
        byPlate.set(plate, p);
      }
    }

    const selected = rawItems.length > 1 ? [...byPlate.values(), ...noPlate] : normalizedPairs;

    const insertedIds = [];
    const ignored = [];

    for (const { raw, data } of selected) {
      console.log('Detección normalizada:', {
        license_plate: data.license_plate,
        timestamp: data.timestamp,
        has_image_url: Boolean(data.image_url),
        image_url_preview: typeof data.image_url === 'string' ? data.image_url.slice(0, 160) : null
      });

      const validation = cameraService.validateDetectionData(data);
      if (!validation.valid) {
        console.warn('Detección ignorada:', {
          reason: validation.error,
          license_plate: data.license_plate,
          timestamp: data.timestamp
        });
        ignored.push({ license_plate: data.license_plate || null, reason: validation.error });
        continue;
      }

      const windowMs = Math.max(0, dedupeSeconds * 1000);
      const eventMs = data.timestamp ? Date.parse(data.timestamp) : Number.NaN;
      const gate = windowMs > 0 ? plateGate.begin(data.license_plate, eventMs, windowMs) : { allow: true, key: plateGate.normalizePlateKey(data.license_plate) };
      if (!gate.allow) {
        console.warn('Detección ignorada:', { reason: gate.reason, license_plate: data.license_plate, timestamp: data.timestamp });
        ignored.push({ license_plate: data.license_plate || null, reason: gate.reason });
        continue;
      }

      try {
        if (windowMs > 0 && data.license_plate) {
          const latest = await directus.getLatestTimestampByPlate(data.license_plate);
          const lastMs = latest?.timestamp ? Date.parse(latest.timestamp) : Number.NaN;
          if (Number.isFinite(lastMs) && Number.isFinite(eventMs)) {
            const deltaMs = eventMs - lastMs;
            if (deltaMs >= 0 && deltaMs <= windowMs) {
              console.warn('Detección ignorada (duplicado por placa):', {
                license_plate: data.license_plate,
                delta_seconds: Math.round(deltaMs / 1000),
                window_seconds: dedupeSeconds
              });
              ignored.push({ license_plate: data.license_plate, reason: `Duplicado reciente (<${Math.round(dedupeSeconds / 60)}m)` });
              plateGate.end(gate.key, { acceptedEventMs: eventMs });
              continue;
            }
            if (deltaMs < 0) {
              console.warn('Detección ignorada (fuera de orden):', {
                license_plate: data.license_plate,
                current: data.timestamp,
                last: latest.timestamp
              });
              ignored.push({ license_plate: data.license_plate, reason: 'Evento fuera de orden' });
              plateGate.end(gate.key, { acceptedEventMs: eventMs });
              continue;
            }
          }
        }

        if (!data.image_url) {
          const base64 = cameraService.extractImageBase64(raw);
          if (base64) {
            let bytes;
            try {
              bytes = Buffer.from(base64, 'base64');
            } catch {
              bytes = null;
            }
            if (bytes) {
              try {
                const uploaded = await directus.uploadImageBytes(bytes, {
                  contentType: 'image/jpeg',
                  filename: `${data.license_plate || 'unknown'}-${Date.now()}.jpg`,
                  title: `${data.license_plate || 'unknown'}`
                });
                if (uploaded?.fileId) {
                  data.image_url = `/api/assets/${uploaded.fileId}`;
                  console.log('Imagen subida a Directus:', uploaded.assetUrl?.slice(0, 180) || uploaded.fileId);
                }
              } catch (e) {
                console.error('Error subiendo imagen a Directus (se continúa sin imagen):', e?.message || e);
              }
            }
          }
        }

        const inserted = await directus.createDetection(data);
        console.log('Detección guardada exitosamente:', inserted?.id);
        insertedIds.push(inserted?.id || null);
        const queueOnInsert = envBool('GETAPI_QUEUE_ON_INSERT', true);
        const insertedId = inserted?.id ? String(inserted.id) : '';
        if (!queueOnInsert) {
          console.log('[GETAPI2] enqueue_skipped', { source: 'webhook', detection_id: insertedId || null, plate: data?.license_plate || null, queue_on_insert: false });
        } else if (!insertedId) {
          console.log('[GETAPI2] enqueue_skipped', { source: 'webhook', detection_id: null, plate: data?.license_plate || null, reason: 'missing_detection_id' });
        } else if (typeof data?.license_plate !== 'string' || !isChileanPlate(data.license_plate)) {
          console.log('[GETAPI2] enqueue_skipped', { source: 'webhook', detection_id: insertedId, plate: data?.license_plate || null, reason: 'invalid_plate' });
        } else {
          try {
            await directus.upsertGetApiByDetectionId(insertedId, null, {
              license_plate: cleanPlateText(data.license_plate) || data.license_plate,
              status: 'pending',
              attempts: 0,
              next_retry_at: new Date().toISOString()
            });
            console.log('[GETAPI2] enqueued', { source: 'webhook', detection_id: insertedId, plate: cleanPlateText(data.license_plate) || data.license_plate });
          } catch (e) {
            console.warn('[GETAPI2] enqueue_failed', { source: 'webhook', detection_id: insertedId, plate: data.license_plate, error: e?.message || e, status: e?.status ?? null });
          }
        }
        const enrichOnInsert = envBool('GETAPI_ENRICH_ON_INSERT', false);
        if (isGetApiEnabled() && enrichOnInsert && insertedId && data?.license_plate) {
          enrichAndPersistDetection({ id: insertedId, plate: data.license_plate }).catch(() => null);
        }
        plateGate.end(gate.key, { acceptedEventMs: eventMs });
      } catch (e) {
        plateGate.end(gate.key);
        throw e;
      }
    }

    if (!Array.isArray(req.body)) {
      return res.json({
        success: true,
        message: insertedIds.length > 0 ? 'Detección guardada correctamente' : 'Detección ignorada',
        id: insertedIds[0] || null,
        ignored: insertedIds.length === 0 ? ignored?.[0]?.reason || null : null
      });
    }

    return res.json({ success: true, inserted_ids: insertedIds.filter(Boolean), ignored });

  } catch (error) {
    console.error('❌ Error procesando detección:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Obtener todas las detecciones (con paginación)
router.get('/detections', async (req, res) => {
  try {
    const rawPage = Array.isArray(req.query.page) ? req.query.page[0] : req.query.page;
    const rawLimit = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
    const license_plate = Array.isArray(req.query.license_plate) ? req.query.license_plate[0] : req.query.license_plate;
    const start_date = Array.isArray(req.query.start_date) ? req.query.start_date[0] : req.query.start_date;
    const end_date = Array.isArray(req.query.end_date) ? req.query.end_date[0] : req.query.end_date;
    const processedRaw = Array.isArray(req.query.processed) ? req.query.processed[0] : req.query.processed;
    const processed = processedRaw === '1' || processedRaw === 'true';

    const cacheMs = Number.parseInt(process.env.DETECTIONS_CACHE_MS ?? '8000', 10) || 8000;
    const minPollMs = Number.parseInt(process.env.DETECTIONS_MIN_POLL_MS ?? '8000', 10) || 8000;
    const maxPollMs = Number.parseInt(process.env.DETECTIONS_MAX_POLL_MS ?? '20000', 10) || 20000;
    const basePollMs = Math.min(maxPollMs, Math.max(minPollMs, cacheMs));
    const cacheKey = JSON.stringify({
      page: rawPage ?? '1',
      limit: rawLimit ?? '25',
      license_plate: license_plate || '',
      start_date: start_date || '',
      end_date: end_date || '',
      processed: processed ? '1' : '0'
    });
    const cached = detectionsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return res.json(cached.payload);
    }

    const startedAt = Date.now();
    let result;
    if (processed) {
      const getapiPage = await directus.listGetApiPage({ page: rawPage ?? '1', limit: rawLimit ?? '25', onlySuccess: true });
      const rows = Array.isArray(getapiPage?.data) ? getapiPage.data : [];
      const ids = rows.map((r) => extractDetectionIdFromGetApiRow(r) || '').filter(Boolean);
      const dets = await directus.listDetectionsByIds(ids);
      const byId = new Map((Array.isArray(dets) ? dets : []).map((d) => [String(d?.id || ''), d]));
      const data = ids.map((id) => {
        const det = byId.get(id) || { id };
        const row = rows.find((r) => (extractDetectionIdFromGetApiRow(r) || '') === id) || null;
        const ga = extractGetApiPayloadFromRow(row);
        return { ...(det || {}), getapi: ga || det?.getapi || null };
      });
      result = { data, pagination: getapiPage.pagination };
    } else {
      result = await directus.listDetections({
        page: rawPage ?? '1',
        limit: rawLimit ?? '25',
        license_plate,
        start_date,
        end_date,
        processed
      });
      const baseItems = Array.isArray(result.data) ? result.data : [];
      const ids = baseItems.map((x) => x?.id).filter(Boolean);
      const getApiById = await directus.listGetApiByDetectionIds(ids).catch(() => new Map());
      const withGetApi = baseItems.map((item) => {
        const id = item?.id ? String(item.id) : '';
        const row = id ? getApiById.get(id) : null;
        const ga = extractGetApiPayloadFromRow(row);
        return { ...(item || {}), getapi: ga || item?.getapi || null };
      });
      result = { data: withGetApi, pagination: result.pagination };
    }
    const elapsedMs = Date.now() - startedAt;
    const pollAfterMs = Math.min(maxPollMs, Math.max(basePollMs, Math.round(elapsedMs * 1.25)));

    const payload = { success: true, data: Array.isArray(result?.data) ? result.data : [], pagination: result?.pagination, poll_after_ms: pollAfterMs };
    if (cacheMs > 0) {
      detectionsCache.set(cacheKey, { expiresAt: Date.now() + cacheMs, payload });
    }
    lastDetectionsOk = payload;
    lastDetectionsOkAt = Date.now();
    return res.json(payload);

  } catch (error) {
    console.error('Error obteniendo detecciones:', {
      message: error?.message,
      status: error?.status,
      method: error?.method,
      url: error?.url
    });
    const retryAfterMs = Number.parseInt(process.env.DETECTIONS_RETRY_AFTER_MS ?? '5000', 10) || 5000;
    res.setHeader('Retry-After', String(Math.max(1, Math.round(retryAfterMs / 1000))));
    const staleMaxMs = Number.parseInt(process.env.DETECTIONS_STALE_MAX_MS ?? '60000', 10) || 60000;
    if (lastDetectionsOk && (Date.now() - lastDetectionsOkAt) <= Math.max(0, staleMaxMs)) {
      res.setHeader('X-Data-Stale', '1');
      return res.status(200).json({
        ...lastDetectionsOk,
        stale: true,
        upstream_error: {
          message: error?.message || 'Error consultando Directus',
          status: error?.status ?? null
        }
      });
    }

    res.status(502).json({
      success: false,
      error: error?.message || 'Error consultando Directus',
      retry_after_ms: retryAfterMs,
      upstream: {
        status: error?.status ?? null,
        method: error?.method ?? null,
        url: typeof error?.url === 'string' ? error.url.replace(/(Bearer\\s+)[^\\s]+/gi, '$1***') : null
      }
    });
  }
});

// Obtener detección por ID
router.get('/detections/:id', async (req, res) => {
  try {
    const data = await directus.getDetectionById(req.params.id);
    if (!data) {
      return res.status(404).json({ 
        success: false, 
        error: 'Detección no encontrada' 
      });
    }

    res.json({ success: true, data });

  } catch (error) {
    console.error('Error obteniendo detección:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

router.get('/detections/:id/enrich', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ success: false, error: 'id requerido' });
    const forceRaw = Array.isArray(req.query.force) ? req.query.force[0] : req.query.force;
    const force = forceRaw === '1' || forceRaw === 'true';

    const item = await directus.getDetectionById(id);
    if (!item) return res.status(404).json({ success: false, error: 'Detección no encontrada' });
    console.log('Solicitud de enriquecimiento manual para id:', id);

    function isGetApiData(data) {
      if (!data || typeof data !== 'object') return false;
      if (typeof data.fetched_at === 'string' && data.fetched_at) return true;
      if (data.vehicle && typeof data.vehicle === 'object') return true;
      if (data.appraisal && typeof data.appraisal === 'object') return true;
      return false;
    }

    const rawDataObj = safeJsonParse(item.raw_data) || {};
    const existing = rawDataObj?.enrichment?.getapi || null;
    let existingField = item ? item.getapi : null;
    if (typeof existingField === 'string') existingField = safeJsonParse(existingField);
    const cached = isGetApiData(existingField) ? existingField : (isGetApiData(existing) ? existing : null);
    const cachedNeedsRt = cached && shouldBackfillRt(cached, 0);
    if (cached && !force && !cachedNeedsRt) {
      return res.json({ success: true, data: cached, cached: true });
    }

    const basePlate = cleanPlateText(item.license_plate) || null;
    let plate = basePlate;
    if (plate && envBool('GETAPI_MOTO_ZERO', true) && isMotorcycleType(item.vehicle_type)) {
      plate = formatMotorcyclePlate(plate);
    }
    if (!plate) {
      console.warn('Detección sin patente para enriquecimiento:', id);
      return res.json({ success: true, data: null, cached: false, reason: 'no_plate' });
    }

    if (!isChileanPlate(plate)) {
      console.warn('Formato de patente inválido para enriquecimiento:', { id, raw: item.license_plate, cleaned: plate });
      return res.json({ success: true, data: null, cached: false, reason: 'invalid_plate_format', plate });
    }

    let vehicleRes = await fetchGetApiJson(`/v1/vehicles/plate/${encodeURIComponent(plate)}`);
    if (!vehicleRes.ok && basePlate && basePlate !== plate && (vehicleRes.reason === 'invalid_plate' || vehicleRes.status === 422 || vehicleRes.reason === 'not_found' || vehicleRes.status === 404)) {
      const retry = await fetchGetApiJson(`/v1/vehicles/plate/${encodeURIComponent(basePlate)}`);
      if (retry.ok) {
        vehicleRes = retry;
        plate = basePlate;
      }
    }
    if (!vehicleRes.ok) {
      console.warn('Fallo consulta vehículo en GetAPI:', { id, plate, status: vehicleRes.status, reason: vehicleRes.reason, message: vehicleRes.message });
      return res.json({
        success: true,
        data: null,
        cached: false,
        plate,
        upstream_status: vehicleRes.status,
        reason: vehicleRes.reason || null,
        message: vehicleRes.message || null
      });
    }

    const vehiclePayload = unwrapGetApiData(vehicleRes.data);
    const vehicleData = normalizeVehicleData(vehiclePayload);

    const appraisalRes = await fetchGetApiJson(`/v1/vehicles/appraisal/${encodeURIComponent(plate)}`);
    const appraisalPayload = appraisalRes.ok ? unwrapGetApiData(appraisalRes.data) : null;
    const appraisalData = appraisalPayload ? normalizeAppraisalData(appraisalPayload) : null;

    const result = {
      plate,
      fetched_at: new Date().toISOString(),
      vehicle: vehicleData || null,
      appraisal: appraisalData || null
    };

    const nextRaw = {
      ...rawDataObj,
      enrichment: {
        ...(rawDataObj.enrichment && typeof rawDataObj.enrichment === 'object' ? rawDataObj.enrichment : {}),
        getapi: result
      }
    };

    try {
      await directus.upsertGetApiByDetectionId(id, result);
    } catch {
    }
    const mirror = envBool('GETAPI_MIRROR_TO_DETECTIONS', false);
    if (mirror) {
      try {
        await directus.updateDetectionById(id, { getapi: result, raw_data: nextRaw });
        console.log('Persistido enriquecimiento en Directus desde endpoint manual para id:', id);
      } catch (e) {
        try {
          await directus.updateDetectionById(id, { getapi: result, raw_data: JSON.stringify(nextRaw) });
          console.log('Persistido enriquecimiento (raw_data string) en Directus para id:', id);
        } catch (e2) {
          try {
            await directus.updateDetectionById(id, { getapi: result });
          } catch (e3) {
            console.warn('No se pudo persistir getapi:', e3?.message || e3);
          }
        }
      }
    }

    return res.json({ success: true, data: result, cached: false });
  } catch (e) {
    return res.json({ success: true, data: null, cached: false, reason: 'internal_error' });
  }
});

// Estadísticas de detecciones
router.get('/stats', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const data = await directus.listStatsFields({ start_date, end_date });

    // Calcular estadísticas
    const stats = {
      total_detections: data.length,
      by_vehicle_type: {},
      by_color: {},
      by_direction: {}
    };

    data.forEach(detection => {
      // Por tipo de vehículo
      if (detection.vehicle_type) {
        stats.by_vehicle_type[detection.vehicle_type] = 
          (stats.by_vehicle_type[detection.vehicle_type] || 0) + 1;
      }
      // Por color
      if (detection.vehicle_color) {
        stats.by_color[detection.vehicle_color] = 
          (stats.by_color[detection.vehicle_color] || 0) + 1;
      }
      // Por dirección
      if (detection.direction) {
        stats.by_direction[detection.direction] = 
          (stats.by_direction[detection.direction] || 0) + 1;
      }
    });

    res.json({ success: true, stats });

  } catch (error) {
    console.error('Error obteniendo estadísticas:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

router.get('/stats/detections-window', async (req, res) => {
  try {
    const timeZone = (typeof process.env.APP_TIMEZONE === 'string' && process.env.APP_TIMEZONE.trim()) || 'America/Santiago';
    const { collection } = directus.getDirectusConfig();

    const getDateTimePartsInTimeZone = (date) => {
      const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
      });
      const parts = dtf.formatToParts(date);
      const map = {};
      for (const p of parts) {
        if (p.type !== 'literal') map[p.type] = p.value;
      }
      return {
        year: Number(map.year),
        month: Number(map.month),
        day: Number(map.day)
      };
    };

    const zonedTimeToUtc = ({ year, month, day, hour, minute, second }) => {
      const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second, 0));
      const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
      });
      const parts = dtf.formatToParts(utcGuess);
      const map = {};
      for (const p of parts) {
        if (p.type !== 'literal') map[p.type] = p.value;
      }
      const zonedParts = {
        year: Number(map.year),
        month: Number(map.month),
        day: Number(map.day),
        hour: Number(map.hour),
        minute: Number(map.minute),
        second: Number(map.second)
      };
      const desiredAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0);
      const zonedAsUtcMs = Date.UTC(
        zonedParts.year,
        zonedParts.month - 1,
        zonedParts.day,
        zonedParts.hour,
        zonedParts.minute,
        zonedParts.second,
        0
      );
      return new Date(utcGuess.getTime() + (desiredAsUtcMs - zonedAsUtcMs));
    };

    const parseYmd = (s) => {
      const str = String(s || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
      return { year: Number(str.slice(0, 4)), month: Number(str.slice(5, 7)), day: Number(str.slice(8, 10)) };
    };

    const parseHms = (s) => {
      const str = String(s || '').trim();
      const m = str.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
      if (!m) return null;
      const hour = Number(m[1]);
      const minute = Number(m[2]);
      const second = Number(m[3] || '0');
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
      if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
      if (!Number.isInteger(second) || second < 0 || second > 59) return null;
      return { hour, minute, second };
    };

    const ymd = parseYmd(req.query.date) || getDateTimePartsInTimeZone(new Date());
    const start = parseHms(req.query.start || req.query.from);
    const end = parseHms(req.query.end || req.query.to);
    if (!start || !end) {
      return res.status(400).json({
        success: false,
        error: 'Parámetros inválidos',
        hint: 'Usa ?date=YYYY-MM-DD&start=HH:MM:SS&end=HH:MM:SS'
      });
    }

    const startUtc = zonedTimeToUtc({ ...ymd, ...start });
    const endUtc = zonedTimeToUtc({ ...ymd, ...end });
    const startIso = startUtc.toISOString();
    const endIso = endUtc.toISOString();

    const count = await directus.countItems(collection, {
      'filter[timestamp][_gte]': startIso,
      'filter[timestamp][_lte]': endIso
    });

    return res.json({
      success: true,
      timeZone,
      date: `${String(ymd.year).padStart(4,'0')}-${String(ymd.month).padStart(2,'0')}-${String(ymd.day).padStart(2,'0')}`,
      start_local: `${String(start.hour).padStart(2,'0')}:${String(start.minute).padStart(2,'0')}:${String(start.second).padStart(2,'0')}`,
      end_local: `${String(end.hour).padStart(2,'0')}:${String(end.minute).padStart(2,'0')}:${String(end.second).padStart(2,'0')}`,
      start_utc: startIso,
      end_utc: endIso,
      count: Number.isFinite(Number(count)) ? Number(count) : 0
    });
  } catch (error) {
    console.error('Error en /stats/detections-window:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Buscar por placa
router.get('/search/plate/:plate', async (req, res) => {
  try {
    const data = await directus.searchByPlate(req.params.plate);

    res.json({ 
      success: true, 
      data,
      count: data.length 
    });

  } catch (error) {
    console.error('Error buscando placa:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

module.exports = router;
