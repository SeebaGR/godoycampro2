function normalizeDirectusBaseUrl(value) {
  if (typeof value !== 'string') return null;
  let url = value.trim();
  if (!url) return null;
  url = url.replace(/\/+$/, '');
  url = url.replace(/\/collections$/, '');
  url = url.replace(/\/items$/, '');
  url = url.replace(/\/+$/, '');
  return url;
}

function buildQueryString(params) {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    search.set(k, String(v));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

async function readResponseBody(res) {
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
  try {
    return await res.text();
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const ms = Number.isFinite(timeoutMs) ? timeoutMs : 8000;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...(init || {}), signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

function getDirectusConfig() {
  const baseUrl =
    normalizeDirectusBaseUrl(process.env.DIRECTUS_URL) ||
    normalizeDirectusBaseUrl(process.env.DIRECTUSURL) ||
    normalizeDirectusBaseUrl(process.env.DIRECTUS_BASE_URL) ||
    null;
  const token =
    (typeof process.env.DIRECTUS_TOKEN === 'string' ? process.env.DIRECTUS_TOKEN.trim() : '') ||
    (typeof process.env.TOKENDIRECTUS === 'string' ? process.env.TOKENDIRECTUS.trim() : '') ||
    null;
  const collection =
    (typeof process.env.DIRECTUS_COLLECTION === 'string' ? process.env.DIRECTUS_COLLECTION.trim() : '') ||
    'vehicle_detections';
  return { baseUrl, token, collection };
}

function getDirectusGetApiCollection() {
  const v =
    (typeof process.env.DIRECTUS_GETAPI_COLLECTION === 'string' ? process.env.DIRECTUS_GETAPI_COLLECTION.trim() : '') ||
    'vehicle_detection_getapi2';
  return v || null;
}

async function directusRequest(method, path, { query, body, headers } = {}) {
  const { baseUrl, token } = getDirectusConfig();
  if (!baseUrl) throw new Error('Falta DIRECTUS_URL (o DIRECTUSURL / DIRECTUS_BASE_URL)');
  const url = `${baseUrl}${path}${buildQueryString(query)}`;

  const reqHeaders = { Accept: 'application/json', ...(headers || {}) };
  if (token) reqHeaders.Authorization = `Bearer ${token}`;

  const init = { method, headers: reqHeaders };
  if (body !== undefined) init.body = body;

  const timeoutMs = Number.parseInt(process.env.DIRECTUS_TIMEOUT_MS ?? '20000', 10) || 20000;
  const maxRetries = Number.parseInt(process.env.DIRECTUS_MAX_RETRIES ?? '3', 10) || 3;
  const retryableStatus = new Set([429, 502, 503, 504]);

  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const res = await fetchWithTimeout(url, init, timeoutMs);
      const payload = await readResponseBody(res);

      if (!res.ok) {
        const message =
          (payload && typeof payload === 'object' && Array.isArray(payload.errors) && payload.errors[0]?.message) ||
          (payload && typeof payload === 'object' && payload.error) ||
          (typeof payload === 'string' && payload) ||
          `HTTP ${res.status}`;

        const err = new Error(message);
        err.status = res.status;
        err.url = url;
        err.method = method;
        err.payload = payload;

        if (retryableStatus.has(res.status) && attempt < maxRetries) {
          lastError = err;
          await sleep(250 * (attempt + 1));
          continue;
        }
        throw err;
      }

      if (payload && typeof payload === 'object' && Array.isArray(payload.errors) && payload.errors.length > 0) {
        const err = new Error(payload.errors[0]?.message || 'Error de Directus');
        err.status = res.status;
        err.url = url;
        err.method = method;
        throw err;
      }

      return payload;
    } catch (e) {
      const retryable = (e && (e.name === 'AbortError' || e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT')) || false;
      if ((retryable || !('status' in (e || {}))) && attempt < maxRetries) {
        lastError = e;
        await sleep(250 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }

  throw lastError || new Error('Error de Directus');
}

let getApiSchemaCache = null;

function shouldLogGetApiWrites() {
  const v = process.env.DIRECTUS_GETAPI_LOG || process.env.GETAPI_TABLE_LOG || '';
  const t = String(v).trim().toLowerCase();
  return t === '1' || t === 'true' || t === 'yes' || t === 'on';
}

async function countItems(collection, filterQuery) {
  const query = { 'aggregate[count]': '*', ...(filterQuery || {}) };
  const payload = await directusRequest('GET', `/items/${encodeURIComponent(collection)}`, { query });
  const raw = Array.isArray(payload?.data) ? payload.data[0] : null;
  const n = raw && raw.count !== undefined ? Number(raw.count) : Number.NaN;
  return Number.isFinite(n) ? n : 0;
}

async function sumItemsField(collection, field, filterQuery) {
  const candidates = [
    { [`aggregate[sum]`]: field },
    { [`aggregate[sum][${field}]`]: '*' }
  ];
  for (const agg of candidates) {
    const query = { ...agg, ...(filterQuery || {}) };
    try {
      const payload = await directusRequest('GET', `/items/${encodeURIComponent(collection)}`, { query });
      const raw = Array.isArray(payload?.data) ? payload.data[0] : null;
      if (!raw || typeof raw !== 'object') continue;
      if (raw.sum && typeof raw.sum === 'object' && field in raw.sum) {
        const n = Number(raw.sum[field]);
        if (Number.isFinite(n)) return n;
      }
      if (field in raw) {
        const n = Number(raw[field]);
        if (Number.isFinite(n)) return n;
      }
      const n = Number(raw.sum);
      if (Number.isFinite(n)) return n;
    } catch {
    }
  }
  return 0;
}

async function getGetApiStats() {
  const collection = getDirectusGetApiCollection();
  if (!collection) return null;

  const statusValues = ['pending', 'ok', 'error', 'rate_limited', 'not_found', 'invalid_plate'];
  const counts = {};
  for (const s of statusValues) counts[s] = 0;

  const [total, attemptsSum, ...statusCounts] = await Promise.all([
    countItems(collection),
    sumItemsField(collection, 'attempts'),
    ...statusValues.map((s) => countItems(collection, { [`filter[status][_eq]`]: s }))
  ]);
  statusValues.forEach((s, idx) => {
    const n = Number(statusCounts[idx]);
    counts[s] = Number.isFinite(n) ? n : 0;
  });

  const minCalls = attemptsSum;
  const estimatedCalls = attemptsSum + counts.ok;

  return {
    total,
    counts,
    attempts_sum: attemptsSum,
    calls_min: minCalls,
    calls_estimated: estimatedCalls
  };
}

async function resolveGetApiSchema() {
  if (getApiSchemaCache) return getApiSchemaCache;
  const collection = getDirectusGetApiCollection();
  if (!collection) {
    getApiSchemaCache = { ok: false };
    return getApiSchemaCache;
  }
  try {
    const payload = await directusRequest('GET', `/fields/${encodeURIComponent(collection)}`);
    const fields = Array.isArray(payload?.data) ? payload.data : [];
    const names = fields.map((f) => String(f?.field || '').trim()).filter(Boolean);
    const set = new Set(names);
    const detectionField = set.has('detection_id')
      ? 'detection_id'
      : (names.find((n) => n.toLowerCase().includes('detection') && n.toLowerCase().includes('id')) || null);
    const payloadFieldOrder = ['getapi', 'payload', 'data', 'result', 'response', 'json'];
    const payloadField = payloadFieldOrder.find((n) => set.has(n)) || null;
    const vehicleField = set.has('vehicle') ? 'vehicle' : null;
    const appraisalField = set.has('appraisal') ? 'appraisal' : null;
    const plateField = set.has('plate') ? 'plate' : (set.has('license_plate') ? 'license_plate' : null);
    const fetchedAtField = set.has('fetched_at') ? 'fetched_at' : (set.has('date_created') ? 'date_created' : null);
    const statusField = set.has('status') ? 'status' : null;
    const attemptsField = set.has('attempts') ? 'attempts' : null;
    const nextRetryAtField = set.has('next_retry_at') ? 'next_retry_at' : null;
    const upstreamStatusField = set.has('upstream_status') ? 'upstream_status' : null;
    const reasonField = set.has('reason') ? 'reason' : null;
    const messageField = set.has('message') ? 'message' : null;
    const sortField = set.has('fetched_at') ? '-fetched_at' : (set.has('date_created') ? '-date_created' : '-id');
    getApiSchemaCache = {
      ok: Boolean(detectionField && (payloadField || vehicleField || appraisalField)),
      collection,
      detectionField,
      payloadField,
      vehicleField,
      appraisalField,
      plateField,
      fetchedAtField,
      statusField,
      attemptsField,
      nextRetryAtField,
      upstreamStatusField,
      reasonField,
      messageField,
      sortField
    };
    return getApiSchemaCache;
  } catch {
    getApiSchemaCache = {
      ok: true,
      collection,
      detectionField: 'detection_id',
      payloadField: 'getapi',
      vehicleField: null,
      appraisalField: null,
      plateField: 'license_plate',
      fetchedAtField: 'fetched_at',
      statusField: 'status',
      attemptsField: 'attempts',
      nextRetryAtField: 'next_retry_at',
      upstreamStatusField: 'upstream_status',
      reasonField: 'reason',
      messageField: 'message',
      sortField: '-fetched_at'
    };
    return getApiSchemaCache;
  }
}

async function resolveGetApiSchemaRelaxed() {
  const schema = await resolveGetApiSchema();
  if (!schema || !schema.collection) return null;
  const hasAnyPayloadField = Boolean(schema.payloadField || schema.vehicleField || schema.appraisalField);
  if (!hasAnyPayloadField) return null;
  return { ...schema, ok: true };
}

async function listDetections({ page, limit, license_plate, start_date, end_date, processed } = {}) {
  const { collection } = getDirectusConfig();
  const safePage = Math.max(1, Number.parseInt(page ?? '1', 10) || 1);
  const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit ?? '25', 10) || 25));
  const offset = (safePage - 1) * safeLimit;

  const baseQuery = {
    limit: safeLimit + 1,
    offset,
    sort: '-timestamp,-id'
  };

  if (license_plate) baseQuery['filter[license_plate][_contains]'] = String(license_plate);
  if (start_date) baseQuery['filter[timestamp][_gte]'] = String(start_date);
  if (end_date) baseQuery['filter[timestamp][_lte]'] = String(end_date);
  if (processed) baseQuery['filter[getapi][_null]'] = 'false';

  const withFields = {
    ...baseQuery,
    fields: 'id,timestamp,license_plate,vehicle_type,vehicle_color,speed,direction,confidence,camera_id,location,image_url,getapi,raw_data'
  };

  let payload;
  try {
    payload = await directusRequest('GET', `/items/${encodeURIComponent(collection)}`, { query: withFields });
  } catch (e) {
    const status = e?.status ?? null;
    const retrySpecific = status === 400 || status === 403;
    if (!retrySpecific) throw e;
    try {
      const allFields = { ...baseQuery, fields: '*' };
      payload = await directusRequest('GET', `/items/${encodeURIComponent(collection)}`, { query: allFields });
    } catch (e2) {
      const status2 = e2?.status ?? null;
      const retryWithoutFields = status2 === 400 || status2 === 403;
      if (!retryWithoutFields) throw e2;
      payload = await directusRequest('GET', `/items/${encodeURIComponent(collection)}`, { query: baseQuery });
    }
  }
  const items = Array.isArray(payload?.data) ? payload.data : [];
  const hasMore = items.length > safeLimit;
  const sliced = hasMore ? items.slice(0, safeLimit) : items;
  return {
    data: sliced,
    pagination: {
      page: safePage,
      limit: safeLimit,
      hasMore,
      nextPage: hasMore ? safePage + 1 : null
    }
  };
}

async function listDetectionsMissingGetApi({ limit } = {}) {
  const { collection } = getDirectusConfig();
  const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit ?? '25', 10) || 25));
  const query = {
    limit: safeLimit,
    sort: 'timestamp,id',
    fields: 'id,timestamp,license_plate,getapi',
    'filter[getapi][_null]': 'true'
  };
  const payload = await directusRequest('GET', `/items/${encodeURIComponent(collection)}`, { query });
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows;
}

async function listDetectionsWithGetApi({ limit } = {}) {
  const { collection } = getDirectusConfig();
  const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit ?? '25', 10) || 25));
  const query = {
    limit: safeLimit,
    sort: 'timestamp,id',
    fields: 'id,timestamp,license_plate,getapi',
    'filter[getapi][_null]': 'false'
  };
  const payload = await directusRequest('GET', `/items/${encodeURIComponent(collection)}`, { query });
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows;
}

async function listDetectionsByIds(ids, { fields } = {}) {
  const { collection } = getDirectusConfig();
  const arr = Array.isArray(ids) ? ids.map((x) => String(x || '').trim()).filter(Boolean) : [];
  if (arr.length === 0) return [];
  const query = {
    limit: arr.length,
    fields: fields || 'id,timestamp,license_plate,vehicle_type,vehicle_color,speed,direction,confidence,camera_id,location,image_url,raw_data,getapi',
    'filter[id][_in]': arr.join(',')
  };
  const payload = await directusRequest('GET', `/items/${encodeURIComponent(collection)}`, { query });
  return Array.isArray(payload?.data) ? payload.data : [];
}

async function listGetApiByDetectionIds(ids) {
  const schema = await resolveGetApiSchema();
  if (!schema?.ok) return new Map();
  const arr = Array.isArray(ids) ? ids.map((x) => String(x || '').trim()).filter(Boolean) : [];
  if (arr.length === 0) return new Map();
  const query = {
    limit: arr.length,
    fields: ['id', schema.detectionField, schema.payloadField, schema.vehicleField, schema.appraisalField, schema.plateField, schema.fetchedAtField, schema.statusField, schema.attemptsField, schema.nextRetryAtField, schema.upstreamStatusField, schema.reasonField, schema.messageField].filter(Boolean).join(','),
    [`filter[${schema.detectionField}][_in]`]: arr.join(',')
  };
  const payload = await directusRequest('GET', `/items/${encodeURIComponent(schema.collection)}`, { query });
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const map = new Map();
  for (const r of rows) {
    const detId = r && schema.detectionField in r ? String(r[schema.detectionField] || '').trim() : '';
    if (!detId) continue;
    map.set(detId, r);
  }
  return map;
}

async function listGetApiPage({ page, limit, onlySuccess } = {}) {
  const schema = await resolveGetApiSchema();
  if (!schema?.ok) return { data: [], pagination: { page: 1, limit: 0, hasMore: false, nextPage: null } };
  const safePage = Math.max(1, Number.parseInt(page ?? '1', 10) || 1);
  const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit ?? '25', 10) || 25));
  const offset = (safePage - 1) * safeLimit;
  const hasAnyPayloadField = Boolean(schema.payloadField || schema.vehicleField || schema.appraisalField);
  const query = {
    limit: safeLimit + 1,
    offset,
    sort: schema.sortField,
    fields: hasAnyPayloadField
      ? ['id', schema.detectionField, schema.payloadField, schema.vehicleField, schema.appraisalField, schema.plateField, schema.fetchedAtField, schema.statusField, schema.attemptsField, schema.nextRetryAtField, schema.upstreamStatusField, schema.reasonField, schema.messageField].filter(Boolean).join(',')
      : '*'
  };
  if (onlySuccess) {
    const statusField = schema.statusField || 'status';
    query[`filter[${statusField}][_eq]`] = 'ok';
  }
  let payload;
  try {
    payload = await directusRequest('GET', `/items/${encodeURIComponent(schema.collection)}`, { query });
  } catch (e) {
    const status = e?.status ?? null;
    const retrySpecific = status === 400 || status === 403;
    if (!retrySpecific) throw e;
    try {
      const query2 = { ...query, fields: '*' };
      payload = await directusRequest('GET', `/items/${encodeURIComponent(schema.collection)}`, { query: query2 });
    } catch (e2) {
      const status2 = e2?.status ?? null;
      const retryWithoutFields = status2 === 400 || status2 === 403;
      if (!retryWithoutFields) throw e2;
      const query3 = { ...query };
      delete query3.fields;
      payload = await directusRequest('GET', `/items/${encodeURIComponent(schema.collection)}`, { query: query3 });
    }
  }
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const hasMore = rows.length > safeLimit;
  const sliced = hasMore ? rows.slice(0, safeLimit) : rows;
  return {
    data: sliced,
    pagination: {
      page: safePage,
      limit: safeLimit,
      hasMore,
      nextPage: hasMore ? safePage + 1 : null
    }
  };
}

async function listItems(collection, query) {
  const payload = await directusRequest('GET', `/items/${encodeURIComponent(collection)}`, { query: query || {} });
  return Array.isArray(payload?.data) ? payload.data : [];
}

async function createItem(collection, data) {
  const payload = await directusRequest('POST', `/items/${encodeURIComponent(collection)}`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data || {})
  });
  return payload?.data || null;
}

async function updateItem(collection, id, patch) {
  const payload = await directusRequest('PATCH', `/items/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch || {})
  });
  return payload?.data || null;
}

async function getLatestGetApiCursor({ onlySuccess } = {}) {
  const schema = await resolveGetApiSchemaRelaxed();
  if (!schema?.ok) return null;
  const statusField = schema.statusField || 'status';
  const fetchedAtField = schema.fetchedAtField || null;

  const runQuery = async ({ sort, fields }) => {
    const query = { limit: 1, sort, fields };
    if (onlySuccess) query[`filter[${statusField}][_eq]`] = 'ok';
    const rows = await listItems(schema.collection, query);
    return rows[0] || null;
  };

  const primarySort = fetchedAtField ? `-${fetchedAtField},-id` : '-id';
  const primaryFields = fetchedAtField ? `id,${fetchedAtField},${statusField}` : `id,${statusField}`;

  let row = null;
  try {
    row = await runQuery({ sort: primarySort, fields: primaryFields });
  } catch {
    row = null;
  }

  if (!row) {
    try {
      row = await runQuery({ sort: '-id', fields: `id,${statusField}` });
    } catch {
      row = null;
    }
  }

  if (!row) return null;
  const id = row?.id != null ? Number(row.id) : null;
  const at = fetchedAtField && typeof row?.[fetchedAtField] === 'string' ? row[fetchedAtField] : null;
  return { id: Number.isFinite(id) ? id : null, at, field: fetchedAtField };
}

async function listGetApiAfter({ afterAt, afterId, limit, onlySuccess } = {}) {
  const schema = await resolveGetApiSchemaRelaxed();
  if (!schema?.ok) return [];
  const safeLimit = Math.min(500, Math.max(1, Number.parseInt(limit ?? '200', 10) || 200));
  const statusField = schema.statusField || 'status';
  const fetchedAtField = schema.fetchedAtField || null;

  const hasAnyPayloadField = Boolean(schema.payloadField || schema.vehicleField || schema.appraisalField);
  const fields = hasAnyPayloadField
    ? ['id', schema.detectionField, schema.payloadField, schema.vehicleField, schema.appraisalField, schema.plateField, schema.fetchedAtField, schema.statusField, schema.attemptsField, schema.nextRetryAtField, schema.upstreamStatusField, schema.reasonField, schema.messageField].filter(Boolean).join(',')
    : '*';

  const query = {
    limit: safeLimit,
    fields
  };

  if (fetchedAtField) {
    query.sort = `${fetchedAtField},id`;
  } else {
    query.sort = 'id';
  }

  if (onlySuccess) query[`filter[${statusField}][_eq]`] = 'ok';

  const afterIdNum = afterId != null ? Number(afterId) : null;
  const hasAfterId = Number.isFinite(afterIdNum) && afterIdNum >= 0;
  const afterAtStr = typeof afterAt === 'string' && afterAt.trim() ? afterAt.trim() : null;

  if (fetchedAtField && afterAtStr && hasAfterId) {
    query[`filter[_or][0][${fetchedAtField}][_gt]`] = afterAtStr;
    query[`filter[_or][1][_and][0][${fetchedAtField}][_eq]`] = afterAtStr;
    query[`filter[_or][1][_and][1][id][_gt]`] = String(afterIdNum);
  } else if (fetchedAtField && afterAtStr) {
    query[`filter[${fetchedAtField}][_gt]`] = afterAtStr;
  } else if (!fetchedAtField && hasAfterId) {
    query['filter[id][_gt]'] = String(afterIdNum);
  }

  let payload;
  try {
    payload = await directusRequest('GET', `/items/${encodeURIComponent(schema.collection)}`, { query });
  } catch (e) {
    const status = e?.status ?? null;
    const retrySpecific = status === 400 || status === 403;
    if (!retrySpecific) throw e;
    try {
      const query2 = { ...query };
      delete query2.fields;
      payload = await directusRequest('GET', `/items/${encodeURIComponent(schema.collection)}`, { query: query2 });
    } catch (e2) {
      const status2 = e2?.status ?? null;
      const retrySpecific2 = status2 === 400 || status2 === 403;
      if (!retrySpecific2) throw e2;

      const query3 = {
        limit: safeLimit,
        sort: 'id'
      };
      if (onlySuccess) query3[`filter[${statusField}][_eq]`] = 'ok';
      if (hasAfterId) query3['filter[id][_gt]'] = String(afterIdNum);

      payload = await directusRequest('GET', `/items/${encodeURIComponent(schema.collection)}`, { query: query3 });
    }
  }
  return Array.isArray(payload?.data) ? payload.data : [];
}

async function upsertGetApiByDetectionId(detectionId, getapiPayload, meta) {
  const schema = await resolveGetApiSchema();
  if (!schema?.ok) return null;
  const detId = String(detectionId || '').trim();
  if (!detId) return null;

  const detRef = /^\d+$/.test(detId) ? Number.parseInt(detId, 10) : detId;

  const body = {};
  body[schema.detectionField] = detRef;
  if (schema.payloadField) body[schema.payloadField] = getapiPayload;
  if (!schema.payloadField && schema.vehicleField && getapiPayload && typeof getapiPayload === 'object') {
    body[schema.vehicleField] = getapiPayload.vehicle || null;
  }
  if (!schema.payloadField && schema.appraisalField && getapiPayload && typeof getapiPayload === 'object') {
    body[schema.appraisalField] = getapiPayload.appraisal || null;
  }
  if (schema.statusField && meta && typeof meta.status === 'string') body[schema.statusField] = meta.status;
  if (schema.upstreamStatusField && meta && Number.isFinite(Number(meta.upstream_status))) body[schema.upstreamStatusField] = Number(meta.upstream_status);
  if (schema.reasonField && meta && typeof meta.reason === 'string') body[schema.reasonField] = meta.reason;
  if (schema.messageField && meta && typeof meta.message === 'string') body[schema.messageField] = meta.message;
  if (schema.nextRetryAtField && meta && typeof meta.next_retry_at === 'string') body[schema.nextRetryAtField] = meta.next_retry_at;
  if (schema.plateField && getapiPayload && typeof getapiPayload === 'object' && typeof getapiPayload.plate === 'string') {
    body[schema.plateField] = getapiPayload.plate;
  }
  if (schema.fetchedAtField && getapiPayload && typeof getapiPayload === 'object' && typeof getapiPayload.fetched_at === 'string') {
    body[schema.fetchedAtField] = getapiPayload.fetched_at;
  }
  if (schema.plateField && meta && typeof meta.license_plate === 'string') {
    body[schema.plateField] = meta.license_plate;
  }
  if (schema.fetchedAtField && meta && typeof meta.fetched_at === 'string') {
    body[schema.fetchedAtField] = meta.fetched_at;
  }

  const findRowId = async () => {
    const base = {
      limit: 1,
      sort: '-id',
      fields: ['id', schema.attemptsField, schema.statusField, schema.nextRetryAtField].filter(Boolean).join(',') || 'id'
    };
    const candidates = [];
    if (detRef != null) {
      candidates.push({ ...base, [`filter[${schema.detectionField}][_eq]`]: detRef });
      candidates.push({ ...base, [`filter[${schema.detectionField}][id][_eq]`]: detRef });
    }
    candidates.push({ ...base, [`filter[${schema.detectionField}][_eq]`]: detId });
    candidates.push({ ...base, [`filter[${schema.detectionField}][id][_eq]`]: detId });
    for (const q of candidates) {
      try {
        const found = await directusRequest('GET', `/items/${encodeURIComponent(schema.collection)}`, { query: q });
        const row = Array.isArray(found?.data) ? found.data[0] : null;
        if (row?.id) return String(row.id);
      } catch {
      }
    }
    return null;
  };

  const existingId = await findRowId();
  const row = existingId ? { id: existingId } : null;
  if (schema.attemptsField) {
    if (meta && meta.increment_attempts) {
      body[schema.attemptsField] = (Number.isFinite(Number(meta.attempts)) ? Number(meta.attempts) : 0) + 1;
    } else if (meta && Number.isFinite(Number(meta.attempts))) {
      body[schema.attemptsField] = Number(meta.attempts);
    }
  }

  const log = shouldLogGetApiWrites();
  const op = existingId ? 'PATCH' : 'POST';
  const opPath = existingId
    ? `/items/${encodeURIComponent(schema.collection)}/${encodeURIComponent(existingId)}`
    : `/items/${encodeURIComponent(schema.collection)}`;

  const attemptWrite = async (payloadBody) => {
    if (log) {
      console.log('Directus GetAPI upsert:', JSON.stringify({
        op,
        collection: schema.collection,
        detection_id: detId,
        has_getapi: payloadBody && schema.payloadField ? payloadBody[schema.payloadField] != null : null,
        status: schema.statusField ? payloadBody[schema.statusField] : null,
        attempts: schema.attemptsField ? payloadBody[schema.attemptsField] : null,
        next_retry_at: schema.nextRetryAtField ? payloadBody[schema.nextRetryAtField] : null,
        upstream_status: schema.upstreamStatusField ? payloadBody[schema.upstreamStatusField] : null
      }));
    }
    const payload = await directusRequest(op, opPath, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payloadBody || {})
    });
    return payload?.data || null;
  };

  try {
    return await attemptWrite(body);
  } catch (e1) {
    if (log) {
      console.warn('Directus GetAPI upsert ERROR:', JSON.stringify({
        op,
        collection: schema.collection,
        detection_id: detId,
        status: e1?.status ?? null,
        message: e1?.message || null,
        url: typeof e1?.url === 'string' ? e1.url : null,
        payload: e1?.payload ?? null
      }));
    }
    const retryable = e1 && Number(e1.status) === 400;
    if (!retryable) throw e1;

    const maybeUnique = e1?.payload && typeof e1.payload === 'object'
      && Array.isArray(e1.payload.errors)
      && e1.payload.errors[0]?.extensions?.code === 'RECORD_NOT_UNIQUE';
    if (maybeUnique) {
      const foundId = await findRowId();
      if (foundId) {
        const patchPath = `/items/${encodeURIComponent(schema.collection)}/${encodeURIComponent(foundId)}`;
        const payload = await directusRequest('PATCH', patchPath, {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body || {})
        });
        return payload?.data || null;
      }
    }

    const body2 = { ...(body || {}) };
    body2[schema.detectionField] = { id: detRef };
    return await attemptWrite(body2);
  }
}

async function listGetApiRetryQueue({ limit, nowIso } = {}) {
  const schema = await resolveGetApiSchema();
  if (!schema?.ok) return [];
  if (!schema.nextRetryAtField || !schema.statusField) return [];
  const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit ?? '25', 10) || 25));
  const now = typeof nowIso === 'string' && nowIso ? nowIso : new Date().toISOString();
  const query = {
    limit: safeLimit,
    sort: schema.nextRetryAtField,
    fields: ['id', schema.detectionField, schema.payloadField, schema.vehicleField, schema.appraisalField, schema.plateField, schema.fetchedAtField, schema.statusField, schema.attemptsField, schema.nextRetryAtField, schema.upstreamStatusField, schema.reasonField, schema.messageField].filter(Boolean).join(','),
    [`filter[${schema.statusField}][_neq]`]: 'ok',
    [`filter[${schema.nextRetryAtField}][_lte]`]: now
  };
  const payload = await directusRequest('GET', `/items/${encodeURIComponent(schema.collection)}`, { query });
  return Array.isArray(payload?.data) ? payload.data : [];
}

async function getDetectionById(id) {
  const { collection } = getDirectusConfig();
  const payload = await directusRequest('GET', `/items/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`);
  return payload?.data || null;
}

async function searchByPlate(plate) {
  const { collection } = getDirectusConfig();
  const query = {
    limit: 200,
    sort: '-timestamp,-id',
    'filter[license_plate][_contains]': String(plate)
  };
  const payload = await directusRequest('GET', `/items/${encodeURIComponent(collection)}`, { query });
  return Array.isArray(payload?.data) ? payload.data : [];
}

async function listStatsFields({ start_date, end_date } = {}) {
  const { collection } = getDirectusConfig();
  const query = {
    limit: -1,
    fields: 'vehicle_type,vehicle_color,direction'
  };
  if (start_date) query['filter[timestamp][_gte]'] = String(start_date);
  if (end_date) query['filter[timestamp][_lte]'] = String(end_date);
  const payload = await directusRequest('GET', `/items/${encodeURIComponent(collection)}`, { query });
  return Array.isArray(payload?.data) ? payload.data : [];
}

async function getLatestByPlate(plate) {
  const { collection } = getDirectusConfig();
  const query = {
    limit: 1,
    sort: '-date_created,-id',
    fields: 'id,date_created',
    'filter[license_plate][_eq]': String(plate)
  };
  const payload = await directusRequest('GET', `/items/${encodeURIComponent(collection)}`, { query });
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows[0] || null;
}

async function getLatestTimestampByPlate(plate) {
  const { collection } = getDirectusConfig();
  const query = {
    limit: 1,
    sort: '-timestamp,-id',
    fields: 'id,timestamp',
    'filter[license_plate][_eq]': String(plate)
  };
  const payload = await directusRequest('GET', `/items/${encodeURIComponent(collection)}`, { query });
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows[0] || null;
}

async function createDetection(data) {
  const { collection } = getDirectusConfig();
  const payload = await directusRequest('POST', `/items/${encodeURIComponent(collection)}`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  return payload?.data || null;
}

async function updateDetectionById(id, patch) {
  const { collection } = getDirectusConfig();
  const payload = await directusRequest('PATCH', `/items/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch || {})
  });
  return payload?.data || null;
}

async function uploadImageBytes(bytes, { contentType, filename, title } = {}) {
  const form = new FormData();
  const blob = new Blob([bytes], { type: contentType || 'application/octet-stream' });
  form.append('file', blob, filename || 'image');
  if (title) form.append('title', String(title));

  const payload = await directusRequest('POST', '/files', { body: form });
  const fileId = payload?.data?.id || null;
  if (!fileId) return null;

  const { baseUrl } = getDirectusConfig();
  return { fileId, assetUrl: `${baseUrl}/assets/${fileId}` };
}

module.exports = {
  getDirectusConfig,
  getDirectusGetApiCollection,
  directusRequest,
  countItems,
  getGetApiStats,
  listDetections,
  listDetectionsMissingGetApi,
  listDetectionsWithGetApi,
  listDetectionsByIds,
  listItems,
  createItem,
  updateItem,
  listGetApiByDetectionIds,
  listGetApiPage,
  listGetApiAfter,
  getLatestGetApiCursor,
  upsertGetApiByDetectionId,
  listGetApiRetryQueue,
  getDetectionById,
  searchByPlate,
  listStatsFields,
  getLatestByPlate,
  getLatestTimestampByPlate,
  createDetection,
  updateDetectionById,
  uploadImageBytes
};
