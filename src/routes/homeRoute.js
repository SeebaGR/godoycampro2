const express = require('express');
const router = express.Router();
const directus = require('../config/directus');
const https = require('https');

let topBrandsCache = { atMs: 0, okCount: null, data: [] };
let topComunasCache = { atMs: 0, okCount: null, data: [] };
let rmGeoJsonCache = { atMs: 0, body: null };
let rmStatsCache = { atMs: 0, okCount: null, data: [] };
let dashboardStatsRefreshPromise = null;

function getDateTimePartsInTimeZone(date, timeZone) {
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
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second)
  };
}

function zonedTimeToUtc({ year, month, day, hour, minute, second }, timeZone) {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second, 0));
  const zonedParts = getDateTimePartsInTimeZone(utcGuess, timeZone);
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
}

function addDaysYmd({ year, month, day }, daysToAdd) {
  const d = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  d.setUTCDate(d.getUTCDate() + daysToAdd);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function safeJsonParse(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

router.get('/', async (req, res) => {
  try {
    const { collection } = directus.getDirectusConfig();

    const safeJsonParse = (value) => {
      if (value == null) return null;
      if (typeof value === 'object') return value;
      if (typeof value !== 'string') return null;
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    };

    const normalizeUpperText = (value) => {
      if (value == null) return null;
      const v = String(value).trim();
      if (!v) return null;
      return v.toUpperCase().replace(/\s+/g, ' ').trim();
    };

    const escapeHtml = (value) => {
      return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
    };

    const pickDisplayText = (value) => {
      if (value == null) return null;
      if (typeof value === 'string') return value.trim() || null;
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      if (typeof value === 'object') {
        const name = typeof value.name === 'string' ? value.name.trim() : '';
        if (name) return name;
        const title = typeof value.title === 'string' ? value.title.trim() : '';
        if (title) return title;
      }
      return null;
    };

    const unwrapGetApiEnvelope = (value) => {
      if (!value || typeof value !== 'object') return value;
      if ('data' in value && value.data && typeof value.data === 'object') {
        const hasMeta = value.success === true || typeof value.status === 'number' || typeof value.ok === 'boolean';
        const looksLikeVehicle = typeof value.data.licensePlate === 'string' || typeof value.data.vinNumber === 'string' || typeof value.data.engineNumber === 'string';
        const looksLikeAppraisal = typeof value.data.vehicleId === 'string' || typeof value.data.vehicleId === 'number' || value.data.precioUsado || value.data.precio_usado;
        if (hasMeta || looksLikeVehicle || looksLikeAppraisal) return value.data;
      }
      return value;
    };

    const normalizeGetApiPayload = (value) => {
      const base = unwrapGetApiEnvelope(value);
      if (!base || typeof base !== 'object') return null;
      const next = { ...base };
      if (next.vehicle && typeof next.vehicle === 'object') {
        const v = unwrapGetApiEnvelope(next.vehicle);
        next.vehicle = v;
        if (v && typeof v === 'object' && v.model && typeof v.model === 'object') {
          next.vehicle = { ...v, model: unwrapGetApiEnvelope(v.model) };
        }
      }
      if (next.appraisal && typeof next.appraisal === 'object') {
        const a = unwrapGetApiEnvelope(next.appraisal);
        next.appraisal = a;
        if (a && typeof a === 'object' && a.vehicle && typeof a.vehicle === 'object') {
          next.appraisal = { ...a, vehicle: unwrapGetApiEnvelope(a.vehicle) };
        }
      }
      return next;
    };

    const extractBrand = (row) => {
      if (!row || typeof row !== 'object') return null;
      const payloadCandidates = [
        row.getapi,
        row.payload,
        row.data,
        row.result,
        row.response,
        row.json
      ];

      const rawPayload = payloadCandidates.map(safeJsonParse).find((x) => x && typeof x === 'object') || null;
      const payload = normalizeGetApiPayload(rawPayload);
      const vehicle = payload?.vehicle && typeof payload.vehicle === 'object'
        ? payload.vehicle
        : (row.vehicle && typeof row.vehicle === 'object' ? unwrapGetApiEnvelope(row.vehicle) : null);

      const brand =
        pickDisplayText(vehicle?.brand?.name) ||
        pickDisplayText(vehicle?.brand) ||
        pickDisplayText(vehicle?.model?.brand?.name) ||
        pickDisplayText(vehicle?.model?.brand) ||
        null;

      if (!brand) return null;
      return normalizeUpperText(brand);
    };

    const extractComuna = (row) => {
      if (!row || typeof row !== 'object') return null;
      const payloadCandidates = [
        row.getapi,
        row.payload,
        row.data,
        row.result,
        row.response,
        row.json
      ];

      const rawPayload = payloadCandidates.map(safeJsonParse).find((x) => x && typeof x === 'object') || null;
      const payload = normalizeGetApiPayload(rawPayload);
      const vehicle = payload?.vehicle && typeof payload.vehicle === 'object'
        ? payload.vehicle
        : (row.vehicle && typeof row.vehicle === 'object' ? unwrapGetApiEnvelope(row.vehicle) : null);

      const comuna =
        pickDisplayText(vehicle?.plantaRevisora?.comuna) ||
        pickDisplayText(vehicle?.planta_revisora?.comuna) ||
        null;

      if (!comuna) return null;
      return normalizeUpperText(comuna);
    };

    const extractPlanta = (row) => {
      if (!row || typeof row !== 'object') return null;
      const payloadCandidates = [
        row.getapi,
        row.payload,
        row.data,
        row.result,
        row.response,
        row.json
      ];
      const rawPayload = payloadCandidates.map(safeJsonParse).find((x) => x && typeof x === 'object') || null;
      const payload = normalizeGetApiPayload(rawPayload);
      const vehicle = payload?.vehicle && typeof payload.vehicle === 'object'
        ? payload.vehicle
        : (row.vehicle && typeof row.vehicle === 'object' ? unwrapGetApiEnvelope(row.vehicle) : null);

      const pr = vehicle?.plantaRevisora && typeof vehicle.plantaRevisora === 'object' ? vehicle.plantaRevisora : null;
      if (!pr) return null;
      const name = pickDisplayText(pr?.concesionPlantaRevisora) || pickDisplayText(pr?.concesion_planta_revisora);
      const cod = pickDisplayText(pr?.codPrt) || pickDisplayText(pr?.cod_prt);
      const pretty = (cod && name) ? (cod + ' · ' + name) : (name || cod);
      if (!pretty) return null;
      return normalizeUpperText(pretty);
    };

    const statsKey = (typeof process.env.HOME_DASHBOARD_STATS_KEY === 'string' && process.env.HOME_DASHBOARD_STATS_KEY.trim())
      ? process.env.HOME_DASHBOARD_STATS_KEY.trim()
      : 'home_v1';
    const statsTtlMs = Math.max(0, Number.parseInt(process.env.HOME_DASHBOARD_STATS_TTL_MS ?? '300000', 10) || 300000);
    const deltaMaxScan = Math.max(1000, Number.parseInt(process.env.HOME_DASHBOARD_DELTA_MAX_SCAN ?? '50000', 10) || 50000);
    const fullMaxScan = Math.max(10000, Number.parseInt(process.env.HOME_DASHBOARD_FULL_MAX_SCAN ?? '400000', 10) || 400000);

    const readPersistedStats = async () => {
      const row = await directus.getDashboardStatsByKey(statsKey);
      const data = safeJsonParse(row?.data);
      return { row, data };
    };

    const writePersistedStats = async (data) => {
      return directus.upsertDashboardStatsByKey(statsKey, data);
    };

    const objectInc = (obj, key, delta = 1) => {
      if (!obj || typeof obj !== 'object') return;
      const k = String(key || '').trim();
      if (!k) return;
      obj[k] = (Number(obj[k]) || 0) + (Number(delta) || 0);
    };

    const objectIncNested = (obj, outerKey, innerKey, delta = 1) => {
      if (!obj || typeof obj !== 'object') return;
      const ok = String(outerKey || '').trim();
      const ik = String(innerKey || '').trim();
      if (!ok || !ik) return;
      if (!obj[ok] || typeof obj[ok] !== 'object') obj[ok] = {};
      obj[ok][ik] = (Number(obj[ok][ik]) || 0) + (Number(delta) || 0);
    };

    const computeDerived = ({ brandCounts, comunaCounts, plantsByComuna }) => {
      const brands = Object.entries(brandCounts || {})
        .map(([brand, count]) => ({ brand, count: Number(count) || 0 }))
        .filter((x) => x.brand && x.count > 0)
        .sort((a, b) => b.count - a.count)
        .map((x, idx) => ({ rank: idx + 1, brand: x.brand, count: x.count }));

      const rmStats = Object.entries(comunaCounts || {})
        .map(([comuna, count]) => {
          const plantsMap = (plantsByComuna && typeof plantsByComuna === 'object' && plantsByComuna[comuna] && typeof plantsByComuna[comuna] === 'object')
            ? plantsByComuna[comuna]
            : {};
          const plants = Object.entries(plantsMap)
            .map(([name, c]) => ({ name, count: Number(c) || 0 }))
            .filter((x) => x.name && x.count > 0)
            .sort((a, b) => b.count - a.count)
            .slice(0, 3);
          return { comuna, count: Number(count) || 0, plants };
        })
        .filter((x) => x.comuna && x.count > 0)
        .sort((a, b) => b.count - a.count);

      const topComunas = rmStats.slice(0, 10).map((x, idx) => ({ rank: idx + 1, comuna: x.comuna, count: x.count }));
      return { brands, rmStats, topComunas };
    };

    const computeAndPersistStats = async (previousData) => {
      const computedAtIso = new Date().toISOString();

      let totalVehicles = 0;
      try {
        const count = await directus.countItems(collection);
        if (Number.isFinite(count)) totalVehicles = Number(count);
      } catch {
        totalVehicles = 0;
      }

      let getApiStats = null;
      let totalProcesados = 0;
      let totalPendientes = 0;
      let totalInvalidPlates = 0;
      try {
        getApiStats = await directus.getGetApiStats();
        if (getApiStats?.counts && Number.isFinite(getApiStats.counts.ok)) totalProcesados = Number(getApiStats.counts.ok);
        if (getApiStats?.counts && Number.isFinite(getApiStats.counts.pending)) totalPendientes = Number(getApiStats.counts.pending);
        if (getApiStats?.counts && Number.isFinite(getApiStats.counts.invalid_plate)) totalInvalidPlates = Number(getApiStats.counts.invalid_plate);
      } catch {
        getApiStats = null;
      }

      let totalTransitadosHoy = 0;
      try {
        const timeZone = (typeof process.env.APP_TIMEZONE === 'string' && process.env.APP_TIMEZONE.trim()) || 'America/Santiago';
        const now = new Date();
        const ymd = getDateTimePartsInTimeZone(now, timeZone);
        const startUtc = zonedTimeToUtc({ year: ymd.year, month: ymd.month, day: ymd.day, hour: 0, minute: 0, second: 0 }, timeZone);
        const next = addDaysYmd({ year: ymd.year, month: ymd.month, day: ymd.day }, 1);
        const nextStartUtc = zonedTimeToUtc({ year: next.year, month: next.month, day: next.day, hour: 0, minute: 0, second: 0 }, timeZone);
        const endUtc = new Date(nextStartUtc.getTime() - 1);
        totalTransitadosHoy = await directus.countItems(collection, {
          'filter[timestamp][_gte]': startUtc.toISOString(),
          'filter[timestamp][_lte]': endUtc.toISOString()
        });
        if (!Number.isFinite(totalTransitadosHoy)) totalTransitadosHoy = 0;
      } catch {
        totalTransitadosHoy = 0;
      }

      const prev = previousData && typeof previousData === 'object' ? previousData : null;
      const prevAgg = prev?.aggregates && typeof prev.aggregates === 'object' ? prev.aggregates : null;
      const prevProgress = prev?.progress && typeof prev.progress === 'object' ? prev.progress : null;
      const prevOkCount = Number(prevProgress?.okCount ?? prev?.okCount ?? NaN);
      const prevMaxId = Number(prevProgress?.getapiMaxId ?? prevProgress?.getapi_max_id ?? prev?.getapi_max_id ?? NaN);

      let brandCounts = prevAgg?.brandCounts && typeof prevAgg.brandCounts === 'object' ? { ...prevAgg.brandCounts } : {};
      let comunaCounts = prevAgg?.comunaCounts && typeof prevAgg.comunaCounts === 'object' ? { ...prevAgg.comunaCounts } : {};
      let plantsByComuna = prevAgg?.plantsByComuna && typeof prevAgg.plantsByComuna === 'object' ? JSON.parse(JSON.stringify(prevAgg.plantsByComuna)) : {};

      const canDelta = Number.isFinite(prevOkCount) && prevOkCount >= 0 && Number.isFinite(prevMaxId) && prevMaxId > 0;
      const deltaNeeded = canDelta ? (totalProcesados - prevOkCount) : 0;
      let usedDelta = false;
      let nextMaxId = Number.isFinite(prevMaxId) ? prevMaxId : 0;

      if (canDelta && deltaNeeded > 0) {
        let offset = 0;
        let scanned = 0;
        while (true) {
          const page = await directus.listGetApiSince({ afterId: prevMaxId, offset, limit: 200, onlySuccess: true }).catch(() => null);
          const rows = Array.isArray(page?.data) ? page.data : [];
          for (const row of rows) {
            const idNum = Number(row?.id);
            if (Number.isFinite(idNum)) nextMaxId = Math.max(nextMaxId, idNum);
            const brand = extractBrand(row);
            if (brand) objectInc(brandCounts, brand, 1);
            const comuna = extractComuna(row);
            if (comuna) {
              objectInc(comunaCounts, comuna, 1);
              const planta = extractPlanta(row);
              if (planta) objectIncNested(plantsByComuna, comuna, planta, 1);
            }
            scanned += 1;
            if (scanned >= deltaMaxScan) break;
          }
          const hasMore = Boolean(page?.pagination?.hasMore);
          const nextOffset = page?.pagination?.nextOffset;
          if (scanned >= deltaMaxScan || rows.length === 0 || !hasMore || nextOffset == null) break;
          offset = nextOffset;
        }
        usedDelta = scanned > 0;
        if (!usedDelta) {
          brandCounts = {};
          comunaCounts = {};
          plantsByComuna = {};
          nextMaxId = 0;
        }
      }

      if (!usedDelta) {
        const scanLimit = Math.min(fullMaxScan, Math.max(0, totalProcesados));
        const pageSize = 100;
        let fetched = 0;
        let maxIdSeen = 0;
        brandCounts = {};
        comunaCounts = {};
        plantsByComuna = {};
        for (let page = 1; page <= 4000; page += 1) {
          const result = await directus.listGetApiPage({ page, limit: pageSize, onlySuccess: true }).catch(() => null);
          const rows = Array.isArray(result?.data) ? result.data : [];
          for (const row of rows) {
            const idNum = Number(row?.id);
            if (Number.isFinite(idNum)) maxIdSeen = Math.max(maxIdSeen, idNum);
            const brand = extractBrand(row);
            if (brand) objectInc(brandCounts, brand, 1);
            const comuna = extractComuna(row);
            if (comuna) {
              objectInc(comunaCounts, comuna, 1);
              const planta = extractPlanta(row);
              if (planta) objectIncNested(plantsByComuna, comuna, planta, 1);
            }
            fetched += 1;
            if (fetched >= scanLimit) break;
          }
          const hasMore = Boolean(result?.pagination?.hasMore);
          if (fetched >= scanLimit || !hasMore || rows.length === 0) break;
        }
        nextMaxId = maxIdSeen;
      }

      const derived = computeDerived({ brandCounts, comunaCounts, plantsByComuna });

      const data = {
        version: 1,
        computed_at: computedAtIso,
        totals: {
          totalVehicles,
          totalProcesados,
          totalPendientes,
          totalInvalidPlates,
          totalTransitadosHoy
        },
        getApiStats,
        topBrands: derived.brands,
        topComunas: derived.topComunas,
        rmStatsForUi: derived.rmStats,
        progress: {
          okCount: totalProcesados,
          getapiMaxId: nextMaxId
        },
        aggregates: {
          brandCounts,
          comunaCounts,
          plantsByComuna
        }
      };

      await writePersistedStats(data);
      return data;
    };

    const triggerBackgroundRefresh = (previousData) => {
      if (dashboardStatsRefreshPromise) return;
      dashboardStatsRefreshPromise = (async () => {
        try {
          const latest = await readPersistedStats().catch(() => ({ data: null }));
          const prev = latest?.data && typeof latest.data === 'object' ? latest.data : previousData;
          await computeAndPersistStats(prev);
        } finally {
          dashboardStatsRefreshPromise = null;
        }
      })();
    };

    let cached = null;
    try {
      cached = await readPersistedStats();
    } catch {
      cached = { data: null };
    }

    const cachedData = cached?.data && typeof cached.data === 'object' ? cached.data : null;
    const cachedAtMs = cachedData?.computed_at ? new Date(cachedData.computed_at).getTime() : 0;
    const hasCached = Boolean(cachedData && cachedData.totals && typeof cachedData.totals === 'object');
    const isFresh = statsTtlMs > 0 && cachedAtMs > 0 && (Date.now() - cachedAtMs < statsTtlMs);

    if (!isFresh) triggerBackgroundRefresh(cachedData);

    if (!hasCached) {
      const seed = {
        version: 1,
        computed_at: new Date(0).toISOString(),
        totals: {
          totalVehicles: 0,
          totalProcesados: 0,
          totalPendientes: 0,
          totalInvalidPlates: 0,
          totalTransitadosHoy: 0
        },
        getApiStats: null,
        topBrands: [],
        topComunas: [],
        rmStatsForUi: [],
        progress: { okCount: 0, getapiMaxId: 0 },
        aggregates: { brandCounts: {}, comunaCounts: {}, plantsByComuna: {} }
      };
      writePersistedStats(seed).catch(() => {});
      triggerBackgroundRefresh(seed);
    }

    const viewData = hasCached ? cachedData : {
      totals: {
        totalVehicles: 0,
        totalProcesados: 0,
        totalPendientes: 0,
        totalInvalidPlates: 0,
        totalTransitadosHoy: 0
      },
      getApiStats: null,
      topBrands: [],
      topComunas: [],
      rmStatsForUi: [],
      computed_at: null
    };

    const getTopBrands = async ({ limit = 10, okCount = null } = {}) => {
      const ttlMs = Math.max(0, Number.parseInt(process.env.HOME_TOP_BRANDS_TTL_MS ?? '300000', 10) || 300000);
      const maxScan = Math.max(1000, Number.parseInt(process.env.HOME_TOP_BRANDS_MAX_SCAN ?? '200000', 10) || 200000);
      const okN = Number(okCount);
      const scanLimit = Number.isFinite(okN) && okN > 0 ? Math.min(maxScan, okN) : maxScan;

      const cacheFresh = ttlMs > 0 && Date.now() - topBrandsCache.atMs < ttlMs;
      if (cacheFresh && Array.isArray(topBrandsCache.data) && topBrandsCache.data.length) {
        return topBrandsCache.data.slice(0, limit);
      }

      const counts = new Map();
      const pageSize = 100;
      let fetched = 0;
      for (let page = 1; page <= 2000; page += 1) {
        const result = await directus.listGetApiPage({ page, limit: pageSize, onlySuccess: true });
        const rows = Array.isArray(result?.data) ? result.data : [];
        for (const row of rows) {
          const brand = extractBrand(row);
          if (brand) counts.set(brand, (counts.get(brand) || 0) + 1);
          fetched += 1;
          if (fetched >= scanLimit) break;
        }
        const hasMore = Boolean(result?.pagination?.hasMore);
        if (fetched >= scanLimit || !hasMore || rows.length === 0) break;
      }

      const computed = Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([brand, count], idx) => ({ rank: idx + 1, brand, count }));

      topBrandsCache = {
        atMs: Date.now(),
        okCount: Number.isFinite(Number(okCount)) ? Number(okCount) : null,
        data: computed
      };

      return computed.slice(0, limit);
    };

    const getTopComunas = async ({ limit = 10, okCount = null } = {}) => {
      const ttlMs = Math.max(0, Number.parseInt(process.env.HOME_TOP_COMUNAS_TTL_MS ?? '300000', 10) || 300000);
      const maxScan = Math.max(1000, Number.parseInt(process.env.HOME_TOP_COMUNAS_MAX_SCAN ?? '200000', 10) || 200000);
      const okN = Number(okCount);
      const scanLimit = Number.isFinite(okN) && okN > 0 ? Math.min(maxScan, okN) : maxScan;

      const cacheFresh = ttlMs > 0 && Date.now() - topComunasCache.atMs < ttlMs;
      if (cacheFresh && Array.isArray(topComunasCache.data) && topComunasCache.data.length) {
        return topComunasCache.data.slice(0, limit);
      }

      const counts = new Map();
      const pageSize = 100;
      let fetched = 0;
      for (let page = 1; page <= 2000; page += 1) {
        const result = await directus.listGetApiPage({ page, limit: pageSize, onlySuccess: true });
        const rows = Array.isArray(result?.data) ? result.data : [];
        for (const row of rows) {
          const comuna = extractComuna(row);
          if (comuna) counts.set(comuna, (counts.get(comuna) || 0) + 1);
          fetched += 1;
          if (fetched >= scanLimit) break;
        }
        const hasMore = Boolean(result?.pagination?.hasMore);
        if (fetched >= scanLimit || !hasMore || rows.length === 0) break;
      }

      const computed = Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([comuna, count], idx) => ({ rank: idx + 1, comuna, count }));

      topComunasCache = {
        atMs: Date.now(),
        okCount: Number.isFinite(Number(okCount)) ? Number(okCount) : null,
        data: computed
      };

      return computed.slice(0, limit);
    };

    const getRmComunaStats = async ({ okCount = null } = {}) => {
      const ttlMs = Math.max(0, Number.parseInt(process.env.HOME_RM_STATS_TTL_MS ?? '300000', 10) || 300000);
      const maxScan = Math.max(1000, Number.parseInt(process.env.HOME_RM_STATS_MAX_SCAN ?? '200000', 10) || 200000);
      const okN = Number(okCount);
      const scanLimit = Number.isFinite(okN) && okN > 0 ? Math.min(maxScan, okN) : maxScan;

      const cacheFresh = ttlMs > 0 && Date.now() - rmStatsCache.atMs < ttlMs;
      if (cacheFresh && Array.isArray(rmStatsCache.data) && rmStatsCache.data.length) {
        return rmStatsCache.data;
      }

      const comunaCounts = new Map();
      const plantsByComuna = new Map();
      const pageSize = 100;
      let fetched = 0;
      for (let page = 1; page <= 2000; page += 1) {
        const result = await directus.listGetApiPage({ page, limit: pageSize, onlySuccess: true });
        const rows = Array.isArray(result?.data) ? result.data : [];
        for (const row of rows) {
          const comuna = extractComuna(row);
          if (comuna) {
            comunaCounts.set(comuna, (comunaCounts.get(comuna) || 0) + 1);
            const planta = extractPlanta(row);
            if (planta) {
              const current = plantsByComuna.get(comuna) || new Map();
              current.set(planta, (current.get(planta) || 0) + 1);
              plantsByComuna.set(comuna, current);
            }
          }
          fetched += 1;
          if (fetched >= scanLimit) break;
        }
        const hasMore = Boolean(result?.pagination?.hasMore);
        if (fetched >= scanLimit || !hasMore || rows.length === 0) break;
      }

      const computed = Array.from(comunaCounts.entries())
        .map(([comuna, count]) => {
          const plantsMap = plantsByComuna.get(comuna) || new Map();
          const plants = Array.from(plantsMap.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([name, c]) => ({ name, count: c }));
          return { comuna, count, plants };
        })
        .sort((a, b) => b.count - a.count);

      rmStatsCache = {
        atMs: Date.now(),
        okCount: Number.isFinite(Number(okCount)) ? Number(okCount) : null,
        data: computed
      };

      return computed;
    };

    const totalsObj = viewData?.totals && typeof viewData.totals === 'object' ? viewData.totals : {};
    const totalVehicles = Number(totalsObj.totalVehicles) || 0;
    const totalProcesados = Number(totalsObj.totalProcesados) || 0;
    const totalPendientes = Number(totalsObj.totalPendientes) || 0;
    const totalInvalidPlates = Number(totalsObj.totalInvalidPlates) || 0;
    const totalTransitadosHoy = Number(totalsObj.totalTransitadosHoy) || 0;
    const getApiStats = viewData?.getApiStats ?? null;
    const topBrands = Array.isArray(viewData?.topBrands) ? viewData.topBrands.slice(0, 10) : [];
    const rmStatsForUi = Array.isArray(viewData?.rmStatsForUi) ? viewData.rmStatsForUi : [];
    const topComunas = Array.isArray(viewData?.topComunas)
      ? viewData.topComunas.slice(0, 10)
      : rmStatsForUi.slice(0, 10).map((x, idx) => ({ rank: idx + 1, comuna: x.comuna, count: x.count }));

    const formatEsNumber = (n) => {
      const v = Number(n);
      if (!Number.isFinite(v)) return '0';
      return v.toLocaleString('es-CL');
    };

    const topBrandsPills = Array.isArray(topBrands)
      ? topBrands
          .map((b) => {
            const rank = Number(b?.rank) || 0;
            const brand = escapeHtml(String(b?.brand ?? '').trim());
            const count = formatEsNumber(b?.count);
            return `<div class="brand-pill"><span class="brand-pill-rank">#${rank}</span><span class="brand-pill-name">${brand}</span><span class="brand-pill-count">${count}</span></div>`;
          })
          .join('')
      : '';
    const topBrandsMarquee = topBrandsPills ? topBrandsPills + topBrandsPills : '';

    const maxBrandCount = Array.isArray(topBrands)
      ? topBrands.reduce((m, b) => Math.max(m, Number(b?.count) || 0), 0)
      : 0;

    const topBrandsBars = Array.isArray(topBrands) && topBrands.length
      ? topBrands
          .map((b) => {
            const rank = Number(b?.rank) || 0;
            const brandRaw = String(b?.brand ?? '').trim();
            const brand = escapeHtml(brandRaw);
            const countNum = Number(b?.count) || 0;
            const count = formatEsNumber(countNum);
            const pct = maxBrandCount > 0 ? Math.max(0, Math.min(100, (countNum / maxBrandCount) * 100)) : 0;
            return `<div class="brands-bar-row"><div class="brands-bar-rank">#${rank}</div><div class="brands-bar-name">${brand}</div><div class="brands-bar-track"><div class="brands-bar-fill" style="width:${pct.toFixed(2)}%"></div></div><div class="brands-bar-value">${count}</div></div>`;
          })
          .join('')
      : '';

    const maxComunaCount = Array.isArray(topComunas)
      ? topComunas.reduce((m, c) => Math.max(m, Number(c?.count) || 0), 0)
      : 0;

    const topComunasBars = Array.isArray(topComunas) && topComunas.length
      ? topComunas
          .map((c) => {
            const rank = Number(c?.rank) || 0;
            const comunaRaw = String(c?.comuna ?? '').trim();
            const comuna = escapeHtml(comunaRaw);
            const countNum = Number(c?.count) || 0;
            const count = formatEsNumber(countNum);
            const pct = maxComunaCount > 0 ? Math.max(0, Math.min(100, (countNum / maxComunaCount) * 100)) : 0;
            return `<div class="brands-bar-row"><div class="brands-bar-rank">#${rank}</div><div class="brands-bar-name">${comuna}</div><div class="brands-bar-track"><div class="brands-bar-fill" style="width:${pct.toFixed(2)}%"></div></div><div class="brands-bar-value">${count}</div></div>`;
          })
          .join('')
      : '';

    const title = 'Home - Dashboard';
    const getApiCalls = getApiStats ? Math.round(getApiStats.calls_estimated) : null;
    const getApiMinCalls = getApiStats ? Math.round(getApiStats.calls_min) : null;
    const getApiOk = getApiStats ? (getApiStats.counts?.ok || 0) : null;
    const getApiPending = getApiStats ? (getApiStats.counts?.pending || 0) : null;
    const getApiErrors = getApiStats
      ? ((getApiStats.counts?.error || 0) + (getApiStats.counts?.rate_limited || 0) + (getApiStats.counts?.not_found || 0) + (getApiStats.counts?.invalid_plate || 0))
      : null;

    const getApiCardsHtml =
      `
      <div class="card">
        <div class="card-header">
          <div class="card-icon red">
            <svg viewBox="0 0 24 24">
              <path d="M12 9v4"/>
              <path d="M12 17h.01"/>
              <path d="M10.3 3.2h3.4L21 20H3z"/>
            </svg>
          </div>
          <div>
            <div class="card-title">Error al Procesar</div>
          </div>
        </div>
        <div class="card-value red" id="invalidPlates">${totalInvalidPlates.toLocaleString('es-CL')}</div>
        <div class="card-description">
          Patentes inválidas
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-icon orange">
            <svg viewBox="0 0 24 24">
              <path d="M3 7h18v14H3z"/>
              <path d="M3 15h18"/>
            </svg>
          </div>
          <div>
            <div class="card-title">Total Procesados</div>
          </div>
        </div>
        <div class="card-value orange" id="totalProcessed">${totalProcesados.toLocaleString('es-CL')}</div>
        <div class="card-description">
          Total autos con datos procesados
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-icon">
            <svg viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="9"/>
              <path d="M12 7v6l3 2"/>
            </svg>
          </div>
          <div>
            <div class="card-title">TOTAL POR PROCESAR</div>
          </div>
        </div>
        <div class="card-value" id="pendingPlates">${totalPendientes.toLocaleString('es-CL')}</div>
        <div class="card-description">
          Patentes pendientes
        </div>
      </div>
      `

    const topBrandsSectionHtml =
      `
    <div class="chart-section" id="topBrandsSection">
      <div class="chart-header">
        <h2>Top 10 Marcas más Transitadas</h2>
      </div>
      <div class="wide-container">
        <div class="brands-marquee" aria-label="Top marcas">
          <div class="brands-marquee-track" id="topBrandsMarqueeTrack" data-animate="${topBrandsMarquee ? '1' : '0'}">
            ${topBrandsMarquee || '<div class="brands-empty">Sin datos de marcas para mostrar.</div>'}
          </div>
        </div>
        <div class="brands-bars" id="topBrandsBars" aria-label="Gráfico top marcas">${topBrandsBars || ''}</div>
      </div>
    </div>
      `

    const topComunasSectionHtml =
      `
    <div class="chart-section" id="topComunasSection">
      <div class="chart-header">
        <h2>Ranking Planta Revisora por Comuna</h2>
      </div>
      <div class="wide-container">
        <div class="brands-bars" id="topComunasBars" aria-label="Ranking comunas">${topComunasBars || ''}</div>
        ${topComunasBars ? '' : '<div class="brands-empty" id="topComunasEmpty">Sin datos de comunas para mostrar.</div>'}
      </div>
    </div>
      `
    
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>window.__homeDashboardStats={key:${JSON.stringify(statsKey)},computed_at:${JSON.stringify(viewData?.computed_at || null)}};</script>
  <style>
    :root { 
      color-scheme: light dark;
      --primary: #4ea0ff;
      --primary-light: rgba(78, 160, 255, 0.1);
      --border: rgba(127,127,127,.25);
      --green: #10b981;
      --green-light: rgba(16, 185, 129, 0.1);
      --purple: #8b5cf6;
      --purple-light: rgba(139, 92, 246, 0.1);
      --orange: #f59e0b;
      --orange-light: rgba(245, 158, 11, 0.1);
      --red: #ef4444;
      --red-light: rgba(239, 68, 68, 0.1);
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      margin: 0; 
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      background: #f5f5f5;
      min-height: 100vh;
    }
    @media (prefers-color-scheme: dark) {
      body { background: #1a1a1a; }
    }
    header { 
      padding: 20px 24px; 
      border-bottom: 1px solid var(--border);
      background: white;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    @media (prefers-color-scheme: dark) {
      header { background: #2a2a2a; }
    }
    .header-title {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .header-icon {
      width: 28px;
      height: 28px;
      stroke: var(--primary);
      fill: none;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    h1 { 
      margin: 0; 
      font-size: 24px; 
      font-weight: 700;
      color: #1a1a1a;
    }
    @media (prefers-color-scheme: dark) {
      h1 { color: #fff; }
    }
    .subtitle {
      margin-top: 4px;
      margin-left: 40px;
      font-size: 14px;
      opacity: 0.7;
    }
    nav {
      margin-top: 16px;
      display: flex;
      gap: 12px;
    }
    .nav-link {
      padding: 8px 16px;
      border-radius: 8px;
      text-decoration: none;
      font-size: 14px;
      font-weight: 500;
      transition: all 0.2s;
      border: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .nav-link svg {
      width: 16px;
      height: 16px;
      stroke: currentColor;
      fill: none;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .nav-link:hover {
      background: var(--primary-light);
      border-color: var(--primary);
      color: var(--primary);
    }
    main { 
      padding: 32px 24px;
      max-width: 1400px;
      margin: 0 auto;
    }
    .cards-grid { 
      display: grid; 
      grid-template-columns: repeat(1, minmax(0, 1fr)); 
      gap: 24px;
    }
    @media (min-width: 720px) {
      .cards-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
    @media (min-width: 980px) {
      .cards-grid {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
    }
    @media (min-width: 1200px) {
      .cards-grid {
        grid-template-columns: repeat(5, minmax(0, 1fr));
      }
      .card {
        padding: 18px;
      }
      .card-value {
        font-size: 30px;
      }
      .card-icon {
        width: 42px;
        height: 42px;
      }
    }
    .wide-container { 
      width: 100%; 
      max-width: none; 
      margin: 0; 
    }
    .brands-marquee {
      width: 100%;
      overflow: hidden;
      border: none;
      border-radius: 0;
      background: transparent;
    }
    .brands-marquee:hover .brands-marquee-track,
    .brands-marquee:focus-within .brands-marquee-track {
      animation-play-state: paused;
    }
    .brands-marquee-track {
      display: flex;
      gap: 10px;
      padding: 14px;
      width: max-content;
      will-change: transform;
    }
    .brands-marquee-track[data-animate="1"] {
      animation: brandsScroll 28s linear infinite;
    }
    @keyframes brandsScroll {
      from { transform: translateX(0); }
      to { transform: translateX(-50%); }
    }
    .brand-pill {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 999px;
      border: 1px solid rgba(127,127,127,.35);
      background: rgba(255,255,255,0.08);
      font-size: 14px;
      font-weight: 700;
      white-space: nowrap;
      user-select: none;
    }
    .brand-pill-rank {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border-radius: 999px;
      background: rgba(78,160,255,0.20);
      border: 1px solid rgba(78,160,255,0.35);
      font-weight: 900;
      font-size: 12px;
    }
    .brand-pill-name {
      font-weight: 800;
      letter-spacing: 0.2px;
    }
    .brand-pill-count {
      padding: 4px 8px;
      border-radius: 999px;
      background: rgba(16, 185, 129, 0.14);
      border: 1px solid rgba(16, 185, 129, 0.28);
      font-weight: 900;
      font-size: 12px;
    }
    .brands-bars {
      margin-top: 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .brands-bar-row {
      display: grid;
      grid-template-columns: 44px minmax(140px, 240px) 1fr 88px;
      gap: 12px;
      align-items: center;
    }
    .brands-bar-rank {
      font-weight: 900;
      opacity: 0.85;
      font-size: 12px;
      text-align: right;
    }
    .brands-bar-name {
      font-weight: 800;
      letter-spacing: 0.2px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .brands-bar-track {
      height: 12px;
      border-radius: 999px;
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(127,127,127,.25);
      overflow: hidden;
    }
    .brands-bar-fill {
      height: 100%;
      border-radius: 999px;
      background: linear-gradient(90deg, rgba(78,160,255,0.95), rgba(16,185,129,0.95));
    }
    .brands-bar-value {
      font-weight: 900;
      font-size: 12px;
      text-align: right;
      opacity: 0.9;
    }
    @media (max-width: 768px) {
      .brands-bar-row {
        grid-template-columns: 44px 1fr 1fr 72px;
      }
    }
    .brands-empty {
      padding: 14px;
      font-size: 14px;
      opacity: 0.75;
    }
    .card { 
      border: 1px solid var(--border);
      border-radius: 16px; 
      padding: 24px;
      background: white;
      box-shadow: 0 2px 8px rgba(0,0,0,0.05);
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .card:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 16px rgba(0,0,0,0.1);
    }
    @media (prefers-color-scheme: dark) {
      .card { 
        background: #2a2a2a;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      }
      .card:hover {
        box-shadow: 0 4px 16px rgba(0,0,0,0.5);
      }
    }
    .card-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 16px;
    }
    .card-icon {
      width: 48px;
      height: 48px;
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--primary-light);
    }
    .card-icon svg {
      width: 24px;
      height: 24px;
      stroke: var(--primary);
      fill: none;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .card-icon.green { background: var(--green-light); }
    .card-icon.green svg { stroke: var(--green); }
    .card-icon.purple { background: var(--purple-light); }
    .card-icon.purple svg { stroke: var(--purple); }
    .card-icon.orange { background: var(--orange-light); }
    .card-icon.orange svg { stroke: var(--orange); }
    .card-icon.red { background: var(--red-light); }
    .card-icon.red svg { stroke: var(--red); }
    .card-title { 
      font-size: 14px;
      font-weight: 600;
      opacity: 0.7;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .card-value { 
      font-size: 36px; 
      font-weight: 700;
      color: var(--primary);
      margin-top: 8px;
      transition: all 0.3s ease;
    }
    .card-value.green { color: var(--green); }
    .card-value.purple { color: var(--purple); }
    .card-value.orange { color: var(--orange); }
    .card-value.red { color: var(--red); }
    .card-description {
      margin-top: 12px;
      font-size: 14px;
      opacity: 0.7;
      line-height: 1.5;
    }
    .highlight {
      color: var(--primary);
      font-weight: 600;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }
    .updating {
      animation: pulse 0.5s ease-in-out;
    }
    .chart-section {
      margin-top: 48px;
      padding: 32px;
      background: white;
      border-radius: 16px;
      border: 1px solid var(--border);
      box-shadow: 0 2px 8px rgba(0,0,0,0.05);
    }
    @media (prefers-color-scheme: dark) {
      .chart-section {
        background: #2a2a2a;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      }
    }
    .chart-header {
      margin-bottom: 32px;
      text-align: center;
    }
    .chart-header h2 {
      font-size: 24px;
      font-weight: 700;
      margin: 0 0 8px 0;
    }
    .chart-subtitle {
      font-size: 14px;
      opacity: 0.7;
      margin: 0;
    }
    .chart-container {
      width: 100%;
      max-width: 900px;
      margin: 0 auto;
    }
    #mapRM {
      width: 100%;
      height: 420px;
      border: 1px solid var(--border);
      border-radius: 12px;
    }
    .rm-tiles {
      filter: brightness(0.88) contrast(1.08) saturate(1.05);
    }
    @media (prefers-color-scheme: dark) {
      .rm-tiles {
        filter: brightness(0.80) contrast(1.18) saturate(1.08);
      }
    }
    .comuna-label {
      background: transparent;
      border: none;
      box-shadow: none;
      padding: 0;
      color: #0f172a;
      font-weight: 900;
      font-size: 11px;
      letter-spacing: 0.2px;
      text-shadow:
        -1px -1px 0 rgba(255,255,255,0.92),
        1px -1px 0 rgba(255,255,255,0.92),
        -1px 1px 0 rgba(255,255,255,0.92),
        1px 1px 0 rgba(255,255,255,0.92),
        0 2px 6px rgba(0,0,0,0.25);
    }
    .filter-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }
    .filter-row label,
    .filter-row input,
    .filter-row button {
      font-size: 14px;
    }
    .filter-row label {
      font-weight: 700;
      opacity: 0.75;
    }
    .filter-row input[type="date"] {
      color-scheme: light dark;
      padding: 9px 12px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: rgba(255,255,255,0.08);
      color: inherit;
      outline: none;
    }
    .filter-row input[type="date"]:hover {
      border-color: rgba(78, 160, 255, 0.55);
    }
    .filter-row input[type="date"]:focus-visible {
      border-color: rgba(78, 160, 255, 0.9);
      box-shadow: 0 0 0 3px rgba(78, 160, 255, 0.18);
    }
    .filter-row button {
      padding: 9px 14px;
      border-radius: 10px;
      border: 1px solid rgba(78, 160, 255, 0.55);
      background: rgba(78, 160, 255, 0.20);
      color: inherit;
      font-weight: 800;
      cursor: pointer;
      transition: transform 0.15s ease, filter 0.15s ease, background 0.15s ease, border-color 0.15s ease;
    }
    .filter-row button:hover {
      background: rgba(78, 160, 255, 0.28);
      border-color: rgba(78, 160, 255, 0.9);
      filter: brightness(1.05);
    }
    .filter-row button:active {
      transform: translateY(1px);
    }
    .filter-row button:focus-visible {
      outline: none;
      box-shadow: 0 0 0 3px rgba(78, 160, 255, 0.18);
    }
    .hourly-summary {
      margin-bottom: 12px;
      font-size: 14px;
      font-weight: 600;
    }
    .hourly-chart-wrapper {
      display: grid;
      grid-template-columns: 50px 1fr;
      gap: 8px;
      width: 100%;
      min-height: 300px;
      background: rgba(16, 185, 129, 0.06);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px;
      overflow: hidden;
      align-items: end;
    }
    .hourly-yaxis {
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      align-items: flex-end;
      font-size: 12px;
      color: #666;
      padding-right: 8px;
      height: 220px;
    }
    .hourly-chart {
      position: relative;
      width: 100%;
      height: 220px;
      background: linear-gradient(180deg, rgba(16,22,27,0.24), rgba(8,12,14,0.7));
      border-left: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: flex-end;
      gap: 2px;
      padding-bottom: 0;
      box-sizing: border-box;
      overflow: hidden;
    }
    .hourly-grid-line {
      position: absolute;
      left: 0;
      width: 100%;
      height: 1px;
      background: rgba(255, 255, 255, 0.08);
      transform: translateY(-0.5px);
      pointer-events: none;
    }
    .hourly-bar {
      flex: 1;
      min-width: 8px;
      background: #40a9ff;
      border-radius: 3px;
      transition: height 0.2s ease, background 0.2s ease;
      position: relative;
    }
    .hourly-bar:hover {
      filter: brightness(1.1);
    }
    .hourly-bar::after {
      content: attr(data-count);
      position: absolute;
      top: -18px;
      left: 50%;
      transform: translateX(-50%);
      font-size: 10px;
      color: #fff;
      background: rgba(0, 0, 0, 0.6);
      padding: 2px 4px;
      border-radius: 3px;
      display: none;
    }
    .hourly-bar:hover::after {
      display: block;
    }
    .hourly-xaxis {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      margin-top: 6px;
      color: #666;
      padding-left: 58px;
    }
    .hourly-xaxis span {
      flex: 1;
      min-width: 0;
      text-align: center;
      white-space: nowrap;
    }
  </style>
</head>
<body>
  <header>
    <div class="header-title">
      <svg class="header-icon" viewBox="0 0 24 24">
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
        <polyline points="9 22 9 12 15 12 15 22"/>
      </svg>
      <h1>Dashboard Principal</h1>
    </div>
    <div class="subtitle">Sistema de Detección de Vehículos</div>
    <nav>
      <a href="/home" class="nav-link">
        <svg viewBox="0 0 24 24">
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
          <polyline points="9 22 9 12 15 12 15 22"/>
        </svg>
        Home
      </a>
      <a href="/dashboard" class="nav-link">
        <svg viewBox="0 0 24 24">
          <line x1="18" y1="20" x2="18" y2="10"/>
          <line x1="12" y1="20" x2="12" y2="4"/>
          <line x1="6" y1="20" x2="6" y2="14"/>
        </svg>
        Detecciones
      </a>
    </nav>
  </header>
  <main>
    <div class="cards-grid">
      <div class="card">
        <div class="card-header">
          <div class="card-icon green">
            <svg viewBox="0 0 24 24">
              <path d="M18 18.5a4.5 4.5 0 0 1-1.5-8.7V6A2.5 2.5 0 0 0 14 3.5h-4A2.5 2.5 0 0 0 7.5 6v3.8A4.5 4.5 0 0 1 6 18.5"/>
              <circle cx="12" cy="12" r="2"/>
              <path d="M12 14v7"/>
            </svg>
          </div>
          <div>
            <div class="card-title">TOTAL VEHICULOS</div>
          </div>
        </div>
        <div class="card-value green" id="totalVehicles">${totalVehicles.toLocaleString('es-CL')}</div>
        <div class="card-description">
          Total de vehículos detectados por el sistema
        </div>
      </div>

      ${getApiCardsHtml}

      <div class="card">
        <div class="card-header">
          <div class="card-icon purple">
            <svg viewBox="0 0 24 24">
              <rect x="3" y="10" width="18" height="7" rx="2"/>
              <path d="M7 10l1-3h8l1 3"/>
              <circle cx="8.5" cy="17.5" r="1"/>
              <circle cx="15.5" cy="17.5" r="1"/>
            </svg>
          </div>
          <div>
            <div class="card-title">TOTAL TRANSITADOS</div>
          </div>
        </div>
        <div class="card-value purple" id="todayVehicles">${totalTransitadosHoy.toLocaleString('es-CL')}</div>
        <div class="card-description">
          Total vehículos Hoy
        </div>
      </div>
    </div>

    ${topBrandsSectionHtml}

    ${topComunasSectionHtml}

    <div class="chart-section">
      <div class="chart-header">
        <h2>Mapa Región Metropolitana</h2>
        <p class="chart-subtitle">Concentración por comuna y plantas revisoras</p>
      </div>
      <div class="chart-container">
        <div id="mapRM"></div>
      </div>
    </div>

    <div class="chart-section">
      <div class="chart-header">
        <h2>Vehículos por Hora</h2>
        <p class="chart-subtitle">Selecciona un día para ver la cantidad de autos detectados por hora</p>
      </div>
      <div class="chart-container">
        <div class="filter-row">
          <label for="selectedDate">Fecha:</label>
          <input type="date" id="selectedDate" />
          <button id="loadHourly">Cargar</button>
        </div>
        <div class="hourly-summary">Total día: <strong id="dailyTotal">0</strong></div>
        <div class="hourly-chart-wrapper">
          <div class="hourly-yaxis" id="hourlyYAxis"></div>
          <div class="hourly-chart" id="hourlyChart"></div>
        </div>
        <div class="hourly-xaxis" id="hourlyXAxis"></div>
      </div>
    </div>
  </main>
  <script>
    const totalVehicles = ${totalVehicles};
    const totalProcessed = ${totalProcesados};
    const totalPending = ${totalPendientes};
    const totalInvalidPlates = ${totalInvalidPlates};
    const totalTransitadosHoy = ${totalTransitadosHoy};
    const topBrandsData = ${JSON.stringify(topBrands)};
    const topComunasData = ${JSON.stringify(topComunas)};
    const rmComunaStats = ${JSON.stringify(rmStatsForUi.map(c => ({ comuna: c.comuna, count: c.count, plants: c.plants || [] })))};
    window.__topBrandsData = Array.isArray(topBrandsData) ? topBrandsData : [];
    window.__topComunasData = Array.isArray(topComunasData) ? topComunasData : [];
    window.__rmComunaStats = Array.isArray(rmComunaStats) ? rmComunaStats : [];

    document.getElementById('totalVehicles').textContent = totalVehicles.toLocaleString('es-CL');
    const totalProcessedEl = document.getElementById('totalProcessed');
    if (totalProcessedEl) totalProcessedEl.textContent = totalProcessed.toLocaleString('es-CL');
    const pendingPlatesEl = document.getElementById('pendingPlates');
    if (pendingPlatesEl) pendingPlatesEl.textContent = totalPending.toLocaleString('es-CL');
    const invalidPlatesEl = document.getElementById('invalidPlates');
    if (invalidPlatesEl) invalidPlatesEl.textContent = totalInvalidPlates.toLocaleString('es-CL');
    document.getElementById('todayVehicles').textContent = totalTransitadosHoy.toLocaleString('es-CL');

    function pad(num){ return String(num).padStart(2,'0'); }

    async function fetchHourlyData(date) {
      const response = await fetch('/home/hourly?date=' + encodeURIComponent(date));
      if (!response.ok) throw new Error('Error al cargar datos horarios');
      return await response.json();
    }

    function renderHourlyChart(points) {
      const chart = document.getElementById('hourlyChart');
      const axis = document.getElementById('hourlyXAxis');
      const normalized = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
      if (Array.isArray(points)) {
        points.forEach((p) => {
          const hour = Number(p?.hour);
          const count = Number(p?.count);
          if (Number.isInteger(hour) && hour >= 0 && hour <= 23) {
            normalized[hour].count = Number.isFinite(count) ? count : 0;
          }
        });
      }
      const total = normalized.reduce((s, i) => s + i.count, 0);
      const maxCount = Math.max(...normalized.map((p) => p.count), 0);

      document.getElementById('dailyTotal').textContent = total.toLocaleString('es-CL');
      chart.innerHTML = '';
      axis.innerHTML = '';
      const yAxis = document.getElementById('hourlyYAxis');
      yAxis.innerHTML = '';

      const tickCount = 5;
      const niceStep = (maxValue, ticks) => {
        if (!Number.isFinite(maxValue) || maxValue <= 0) return 2;
        const rough = maxValue / ticks;
        const pow = Math.pow(10, Math.floor(Math.log10(rough)));
        const frac = rough / pow;
        const niceFrac = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
        return Math.max(niceFrac * pow, 1);
      };
      const tickStep = niceStep(maxCount, tickCount);
      const displayMax = tickStep * tickCount;
      const chartHeight = chart.clientHeight || 220;
      yAxis.style.height = chartHeight + 'px';

      for (let i = tickCount; i >= 0; i--) {
        const label = document.createElement('div');
        label.textContent = (i * tickStep).toLocaleString('es-CL');
        yAxis.appendChild(label);
      }

      for (let i = 0; i <= tickCount; i++) {
        const line = document.createElement('div');
        line.className = 'hourly-grid-line';
        line.style.bottom = (i * (chartHeight / tickCount)) + 'px';
        chart.appendChild(line);
      }

      normalized.forEach((point) => {
        const yPct = displayMax > 0 ? (point.count / displayMax) * 100 : 0;
        const bar = document.createElement('div');
        bar.className = 'hourly-bar';
        bar.style.height = yPct + '%';
        bar.dataset.count = point.count;
        bar.title = pad(point.hour) + ':00 - ' + pad(point.hour) + ':59 • ' + point.count.toLocaleString('es-CL') + ' vehículos';
        chart.appendChild(bar);
      });

      for (let hour = 0; hour < 24; hour++) {
        const el = document.createElement('span');
        el.textContent = hour === 0 ? '00:00' : hour === 23 ? '23:59' : pad(hour);
        if (hour % 2 !== 0) el.style.opacity = '0.5';
        axis.appendChild(el);
      }
    }

    async function loadHourly() {
      const input = document.getElementById('selectedDate');
      let date = input.value;
      if (!date) {
        const d = new Date();
        date = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
        input.value = date;
      }
      try {
        const data = await fetchHourlyData(date);
        renderHourlyChart(data);
      } catch (error) {
        console.error(error);
      }
    }

    document.getElementById('loadHourly').addEventListener('click', loadHourly);

    const now = new Date();
    const initialDate = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
    document.getElementById('selectedDate').value = initialDate;
    loadHourly();

    (function initRMMap() {
      const el = document.getElementById('mapRM');
      if (!el || typeof L === 'undefined') return;
      const map = L.map(el).setView([-33.45, -70.66], 11);
      L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        maxZoom: 18,
        attribution: '&copy; OpenStreetMap &copy; CARTO',
        className: 'rm-tiles'
      }).addTo(map);

      const normalizeKey = (s) => {
        return String(s || '')
          .toUpperCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/^COMUNA DE\s+/g, '')
          .replace(/^COMUNA\s+/g, '')
          .replace(/\s+/g, ' ')
          .trim();
      };

      let stats = Array.isArray(window.__rmComunaStats) ? window.__rmComunaStats : [];
      let byComuna = new Map(stats.map((x) => [normalizeKey(x.comuna), x]));
      let maxCount = stats.reduce((m, x) => Math.max(m, Number(x.count) || 0), 0);

      const colorScale = (value) => {
        const v = Number(value) || 0;
        if (maxCount <= 0) return '#60a5fa';
        const t = Math.max(0, Math.min(1, v / maxCount));
        const stops = ['#e0f2fe', '#bae6fd', '#7dd3fc', '#38bdf8', '#0ea5e9', '#0369a1'];
        const idx = Math.min(stops.length - 1, Math.floor(t * (stops.length - 1)));
        return stops[idx];
      };

      const styleForFeature = (feature) => {
        const props = feature && feature.properties ? feature.properties : {};
        const nameCandidate = props.comuna || props.Comuna || props.NOM_COM || props.NOMBRE || props.name || props.NAME || '';
        const key = normalizeKey(nameCandidate);
        const s = byComuna.get(key);
        const count = s ? (Number(s.count) || 0) : 0;
        return {
          color: 'rgba(15, 23, 42, 0.55)',
          weight: 1.25,
          fillColor: count > 0 ? colorScale(count) : 'rgba(148, 163, 184, 0.18)',
          fillOpacity: count > 0 ? 0.72 : 0.28
        };
      };

      const onEachFeature = (feature, layer) => {
        const props = feature && feature.properties ? feature.properties : {};
        const nameCandidate = props.comuna || props.Comuna || props.NOM_COM || props.NOMBRE || props.name || props.NAME || '';
        const comunaName = String(nameCandidate || '').trim() || 'COMUNA';
        const key = normalizeKey(comunaName);
        const s = byComuna.get(key);
        const count = s ? (Number(s.count) || 0) : 0;
        const plants = s && Array.isArray(s.plants) ? s.plants : [];
        const plantsHtml = plants.length
          ? ('<div style="margin-top:6px"><b>Plantas</b><br/>' + plants.map((p) => {
              const n = String(p?.name || '').trim();
              const c = Number(p?.count) || 0;
              return n ? (n + ' (' + c.toLocaleString('es-CL') + ')') : null;
            }).filter(Boolean).join('<br/>') + '</div>')
          : '';

        layer.bindPopup('<b>' + comunaName + '</b><br/>Registros: ' + count.toLocaleString('es-CL') + plantsHtml);
        if (count > 0) {
          layer.bindTooltip(comunaName, { permanent: true, direction: 'center', className: 'comuna-label', opacity: 0.95 });
        }
        layer.on('mouseover', () => layer.setStyle({ weight: 2, color: 'rgba(78,160,255,0.9)' }));
        layer.on('mouseout', () => layer.setStyle({ weight: 1, color: 'rgba(255,255,255,0.35)' }));
      };

      const statusCtrl = L.control({ position: 'topright' });
      statusCtrl.onAdd = () => {
        const d = document.createElement('div');
        d.style.background = 'rgba(0,0,0,0.45)';
        d.style.color = '#fff';
        d.style.border = '1px solid rgba(255,255,255,0.18)';
        d.style.borderRadius = '10px';
        d.style.padding = '8px 10px';
        d.style.fontSize = '12px';
        d.textContent = 'Cargando comunas…';
        return d;
      };
      statusCtrl.addTo(map);

      const loadGeo = async (url) => {
        const r = await fetch(url, { cache: 'no-store' });
        if (!r.ok) throw new Error('geojson status ' + r.status);
        return await r.json();
      };

      let geoLayer = null;

      const applyStatsToMap = (nextStats) => {
        stats = Array.isArray(nextStats) ? nextStats : [];
        byComuna = new Map(stats.map((x) => [normalizeKey(x.comuna), x]));
        maxCount = stats.reduce((m, x) => Math.max(m, Number(x.count) || 0), 0);
        if (!geoLayer) return;
        geoLayer.setStyle(styleForFeature);
        geoLayer.eachLayer((layer) => {
          const feature = layer && layer.feature ? layer.feature : null;
          const props = feature && feature.properties ? feature.properties : {};
          const nameCandidate = props.comuna || props.Comuna || props.NOM_COM || props.NOMBRE || props.name || props.NAME || '';
          const comunaName = String(nameCandidate || '').trim() || 'COMUNA';
          const key = normalizeKey(comunaName);
          const s = byComuna.get(key);
          const count = s ? (Number(s.count) || 0) : 0;
          const plants = s && Array.isArray(s.plants) ? s.plants : [];
          const plantsHtml = plants.length
            ? ('<div style="margin-top:6px"><b>Plantas</b><br/>' + plants.map((p) => {
                const n = String(p?.name || '').trim();
                const c = Number(p?.count) || 0;
                return n ? (n + ' (' + c.toLocaleString('es-CL') + ')') : null;
              }).filter(Boolean).join('<br/>') + '</div>')
            : '';
          try { layer.unbindPopup(); } catch {}
          layer.bindPopup('<b>' + comunaName + '</b><br/>Registros: ' + count.toLocaleString('es-CL') + plantsHtml);
          try { layer.unbindTooltip(); } catch {}
          if (count > 0) {
            layer.bindTooltip(comunaName, { permanent: true, direction: 'center', className: 'comuna-label', opacity: 0.95 });
          }
        });
      };

      window.__rmMapUpdate = applyStatsToMap;

      (async () => {
        const urls = ['/home/rm-geojson', 'https://raw.githubusercontent.com/sebaebc/chl-geojson/main/13.geojson'];
        for (const url of urls) {
          try {
            const geo = await loadGeo(url);
            geoLayer = L.geoJSON(geo, { style: styleForFeature, onEachFeature }).addTo(map);
            const bounds = geoLayer.getBounds();
            if (bounds && bounds.isValid()) map.fitBounds(bounds.pad(0.08));
            if (statusCtrl && statusCtrl.getContainer()) statusCtrl.getContainer().textContent = 'Listo';
            setTimeout(() => { try { map.removeControl(statusCtrl); } catch {} }, 900);
            return;
          } catch {
          }
        }
        if (statusCtrl && statusCtrl.getContainer()) statusCtrl.getContainer().textContent = 'No se pudo cargar límites';
      })();
    })();
  </script>
  <script>
    (function () {
      var meta = window.__homeDashboardStats || {};
      if (!meta.key) return;
      var url = '/home/dashboard-stats.json?key=' + encodeURIComponent(meta.key);
      function escapeHtml(value) {
        return String(value == null ? '' : value)
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('\"', '&quot;')
          .replaceAll("'", '&#039;');
      }
      function formatEsNumber(n) {
        var v = Number(n);
        if (!Number.isFinite(v)) return '0';
        return v.toLocaleString('es-CL');
      }
      function setText(id, value) {
        var el = document.getElementById(id);
        if (!el) return;
        el.textContent = value == null ? '0' : String(value);
      }
      function applyTotals(t) {
        if (!t) return;
        setText('totalVehicles', t.totalVehicles_es || t.totalVehicles || '0');
        setText('invalidPlates', t.totalInvalidPlates_es || t.totalInvalidPlates || '0');
        setText('totalProcessed', t.totalProcesados_es || t.totalProcesados || '0');
        setText('pendingPlates', t.totalPendientes_es || t.totalPendientes || '0');
        setText('todayVehicles', t.totalTransitadosHoy_es || t.totalTransitadosHoy || '0');
      }
      function applyTopBrands(items) {
        var list = Array.isArray(items) ? items.slice(0, 10) : [];
        var pills = list.map(function (b, idx) {
          var rank = Number(b && b.rank) || (idx + 1);
          var name = escapeHtml(String((b && b.brand) || '').trim());
          var count = formatEsNumber(b && b.count);
          return '<div class=\"brand-pill\"><span class=\"brand-pill-rank\">#' + rank + '</span><span class=\"brand-pill-name\">' + name + '</span><span class=\"brand-pill-count\">' + count + '</span></div>';
        }).join('');
        var marquee = pills ? (pills + pills) : '<div class=\"brands-empty\">Sin datos de marcas para mostrar.</div>';
        var track = document.getElementById('topBrandsMarqueeTrack');
        if (track) {
          track.innerHTML = marquee;
          track.dataset.animate = pills ? '1' : '0';
        }
        var max = 0;
        list.forEach(function (b) { max = Math.max(max, Number(b && b.count) || 0); });
        var bars = list.map(function (b, idx) {
          var rank = Number(b && b.rank) || (idx + 1);
          var nameRaw = String((b && b.brand) || '').trim();
          var name = escapeHtml(nameRaw);
          var countNum = Number(b && b.count) || 0;
          var count = formatEsNumber(countNum);
          var pct = max > 0 ? Math.max(0, Math.min(100, (countNum / max) * 100)) : 0;
          return '<div class=\"brands-bar-row\"><div class=\"brands-bar-rank\">#' + rank + '</div><div class=\"brands-bar-name\">' + name + '</div><div class=\"brands-bar-track\"><div class=\"brands-bar-fill\" style=\"width:' + pct.toFixed(2) + '%\"></div></div><div class=\"brands-bar-value\">' + count + '</div></div>';
        }).join('');
        var barsEl = document.getElementById('topBrandsBars');
        if (barsEl) barsEl.innerHTML = bars;
      }
      function applyTopComunas(items) {
        var list = Array.isArray(items) ? items.slice(0, 10) : [];
        var max = 0;
        list.forEach(function (c) { max = Math.max(max, Number(c && c.count) || 0); });
        var bars = list.map(function (c, idx) {
          var rank = Number(c && c.rank) || (idx + 1);
          var nameRaw = String((c && c.comuna) || '').trim();
          var name = escapeHtml(nameRaw);
          var countNum = Number(c && c.count) || 0;
          var count = formatEsNumber(countNum);
          var pct = max > 0 ? Math.max(0, Math.min(100, (countNum / max) * 100)) : 0;
          return '<div class=\"brands-bar-row\"><div class=\"brands-bar-rank\">#' + rank + '</div><div class=\"brands-bar-name\">' + name + '</div><div class=\"brands-bar-track\"><div class=\"brands-bar-fill\" style=\"width:' + pct.toFixed(2) + '%\"></div></div><div class=\"brands-bar-value\">' + count + '</div></div>';
        }).join('');
        var barsEl = document.getElementById('topComunasBars');
        if (barsEl) barsEl.innerHTML = bars;
        var emptyEl = document.getElementById('topComunasEmpty');
        if (emptyEl) emptyEl.style.display = bars ? 'none' : '';
      }
      function applyMap(stats) {
        window.__rmComunaStats = Array.isArray(stats) ? stats : [];
        if (typeof window.__rmMapUpdate === 'function') window.__rmMapUpdate(window.__rmComunaStats);
      }
      function applyAll(data) {
        applyTotals(data && data.totals);
        applyTopBrands(data && data.topBrands);
        applyTopComunas(data && data.topComunas);
        applyMap(data && data.rmComunaStats);
      }
      applyAll({ totals: null, topBrands: window.__topBrandsData, topComunas: window.__topComunasData, rmComunaStats: window.__rmComunaStats });

      var startedAt = Date.now();
      function tick() {
        fetch(url, { cache: 'no-store' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (data) {
            if (!data || !data.ok) return;
            if (data.computed_at && meta.computed_at && data.computed_at !== meta.computed_at) {
              meta.computed_at = data.computed_at;
              applyAll(data);
              return;
            }
            applyTotals(data.totals);
          })
          .catch(function () {});
      }
      tick();
      var id = setInterval(function () {
        if (Date.now() - startedAt > 120000) {
          clearInterval(id);
          return;
        }
        tick();
      }, 10000);
    })();
  </script>
</body>
</html>`);
  } catch (error) {
    console.error('Error en /home:', error);
    res.status(500).send('Error al cargar la página');
  }
});

router.get('/dashboard-stats.json', async (req, res) => {
  try {
    const fallbackKey = (typeof process.env.HOME_DASHBOARD_STATS_KEY === 'string' && process.env.HOME_DASHBOARD_STATS_KEY.trim())
      ? process.env.HOME_DASHBOARD_STATS_KEY.trim()
      : 'home_v1';
    const key = (typeof req.query.key === 'string' && req.query.key.trim()) ? req.query.key.trim() : fallbackKey;

    const row = await directus.getDashboardStatsByKey(key).catch(() => null);
    const data = row?.data && typeof row.data === 'object' ? row.data : safeJsonParse(row?.data);

    const formatEsNumber = (n) => {
      const v = Number(n);
      if (!Number.isFinite(v)) return '0';
      return v.toLocaleString('es-CL');
    };

    const totals = data?.totals && typeof data.totals === 'object' ? data.totals : null;
    const totalsOut = totals
      ? {
          ...totals,
          totalVehicles_es: formatEsNumber(totals.totalVehicles),
          totalProcesados_es: formatEsNumber(totals.totalProcesados),
          totalPendientes_es: formatEsNumber(totals.totalPendientes),
          totalInvalidPlates_es: formatEsNumber(totals.totalInvalidPlates),
          totalTransitadosHoy_es: formatEsNumber(totals.totalTransitadosHoy)
        }
      : null;

    const topBrands = Array.isArray(data?.topBrands) ? data.topBrands : [];
    const topComunas = Array.isArray(data?.topComunas) ? data.topComunas : [];
    const rmStatsForUi = Array.isArray(data?.rmStatsForUi) ? data.rmStatsForUi : [];
    const rmComunaStats = rmStatsForUi.map((c) => ({ comuna: c.comuna, count: c.count, plants: c.plants || [] }));

    res.json({
      key,
      computed_at: data?.computed_at || null,
      totals: totalsOut,
      topBrands,
      topComunas,
      rmComunaStats,
      ok: Boolean(data && totals)
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'No se pudo leer dashboard_stats', message: e?.message || String(e) });
  }
});

router.get('/hourly', async (req, res) => {
  try {
    const { date } = req.query;
    const timeZone = (typeof process.env.APP_TIMEZONE === 'string' && process.env.APP_TIMEZONE.trim()) || 'America/Santiago';
    const dateStr = String(date || '').trim();
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
    const ymd = valid
      ? { year: Number(dateStr.slice(0, 4)), month: Number(dateStr.slice(5, 7)), day: Number(dateStr.slice(8, 10)) }
      : (() => {
          const now = new Date();
          const parts = getDateTimePartsInTimeZone(now, timeZone);
          return { year: parts.year, month: parts.month, day: parts.day };
        })();
    const next = addDaysYmd(ymd, 1);

    const queries = Array.from({ length: 24 }, (_, hour) => {
      const startUtc = zonedTimeToUtc({ year: ymd.year, month: ymd.month, day: ymd.day, hour, minute: 0, second: 0 }, timeZone);
      const nextLocal = hour < 23
        ? { year: ymd.year, month: ymd.month, day: ymd.day, hour: hour + 1, minute: 0, second: 0 }
        : { year: next.year, month: next.month, day: next.day, hour: 0, minute: 0, second: 0 };
      const nextUtc = zonedTimeToUtc(nextLocal, timeZone);
      const endUtc = new Date(nextUtc.getTime() - 1);
      return directus
        .countItems(directus.getDirectusConfig().collection, {
          'filter[timestamp][_gte]': startUtc.toISOString(),
          'filter[timestamp][_lte]': endUtc.toISOString()
        })
        .catch(() => 0);
    });

    const counts = await Promise.all(queries);

    const hourlyCounts = counts.map((count, hour) => ({ hour, count: Number.isFinite(count) ? Number(count) : 0 }));

    res.json(hourlyCounts);
  } catch (error) {
    console.error('Error en /home/hourly:', error);
    res.status(500).json({ error: 'No se pudo obtener datos horarios' });
  }
});

router.get('/rm-geojson', async (req, res) => {
  try {
    const ttlMs = Math.max(0, Number.parseInt(process.env.RM_GEOJSON_TTL_MS ?? '86400000', 10) || 86400000);
    const srcUrl = (process.env.RM_GEOJSON_URL || 'https://raw.githubusercontent.com/sebaebc/chl-geojson/main/13.geojson').trim();
    const isFresh = ttlMs > 0 && rmGeoJsonCache.body && (Date.now() - rmGeoJsonCache.atMs < ttlMs);
    if (isFresh) {
      res.setHeader('Content-Type', 'application/geo+json; charset=utf-8');
      return res.status(200).send(rmGeoJsonCache.body);
    }

    const fetchText = (url, depth = 0) => new Promise((resolve, reject) => {
      const u = new URL(url);
      const opts = {
        method: 'GET',
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: {
          'User-Agent': 'cam1-home/1.0',
          'Accept': 'application/geo+json,application/json;q=0.9,*/*;q=0.8'
        }
      };
      const r = https.request(opts, (resp) => {
        const status = resp.statusCode || 0;
        if (status >= 300 && status < 400 && resp.headers.location && depth < 4) {
          const nextUrl = new URL(resp.headers.location, url).toString();
          resp.resume();
          fetchText(nextUrl, depth + 1).then(resolve).catch(reject);
          return;
        }
        if (status < 200 || status >= 300) {
          resp.resume();
          reject(new Error('RM_GEOJSON fetch status ' + status));
          return;
        }
        let data = '';
        resp.setEncoding('utf8');
        resp.on('data', (chunk) => { data += chunk; });
        resp.on('end', () => resolve(data));
      });
      r.on('error', reject);
      r.end();
    });

    const body = await fetchText(srcUrl);

    rmGeoJsonCache = { atMs: Date.now(), body };
    res.setHeader('Content-Type', 'application/geo+json; charset=utf-8');
    return res.status(200).send(body);
  } catch (e) {
    return res.status(500).json({ error: 'No se pudo cargar GeoJSON RM', message: e?.message || String(e) });
  }
});

module.exports = router;
