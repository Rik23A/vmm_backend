'use strict';
/**
 * SAP India Tax & TAN Exemption Bridge — utils/sapIndiaTaxBridge.js
 *
 * Dedicated OData client for ZBP_INDIA_SP_SRV:
 *   - EntitySet: IndiaTaxGeneralSet (PAN, ServiceRegNo, CSTNo, LSTNo, GstVenClass, CorpIdentNo)
 *   - Navigation: ToTanExemption (Assoc_IndiaTaxGeneral_TanExemption -> TanExemptionSet)
 *   - Navigation: ToAttachments  (Assoc_IndiaTaxGeneral_BPAttachment -> BPAttachmentSet)
 */

const axios = require('axios');
const https = require('https');
const path = require('path');
const fs = require('fs');

// ── Constants ──────────────────────────────────────────────────────────────
const CSRF_TTL_MS = 25 * 60 * 1000; // 25 min
const SAP_TIMEOUT = 30_000;

// Shared keep-alive HTTPS agent
const _sharedAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

// CSRF cache map for ZBP_INDIA_SP_SRV
const _csrfCache = new Map();

/**
 * Resolve the base OData URL for ZBP_INDIA_SP_SRV
 */
const resolveIndiaTaxUrl = (cfg = {}) => {
  if (cfg.sapIndiaTaxOdataUrl && cfg.sapIndiaTaxOdataUrl.trim()) {
    return cfg.sapIndiaTaxOdataUrl.trim().replace(/\/$/, '');
  }
  if (cfg.sapOdataUrl && cfg.sapOdataUrl.trim()) {
    return cfg.sapOdataUrl.trim().replace(/API_BUSINESS_PARTNER\/?$/i, 'ZBP_INDIA_SP_SRV').replace(/\/$/, '');
  }
  return 'https://sapwd.birla-sugar.com:44300/sap/opu/odata/sap/ZBP_INDIA_SP_SRV';
};

const _cacheKey = (cfg) => `${resolveIndiaTaxUrl(cfg)}::${cfg.sapClient || '100'}::${cfg.sapUser}`;
const _isFresh  = (e)   => e && (Date.now() - e.fetchedAt.getTime()) < CSRF_TTL_MS;

/**
 * Fetch CSRF token and session cookies specifically for ZBP_INDIA_SP_SRV
 */
const fetchIndiaTaxCsrfToken = async (cfg) => {
  const client = cfg.sapClient || '100';
  const baseUrl = resolveIndiaTaxUrl(cfg);
  const url = `${baseUrl}/$metadata?sap-client=${client}`;
  console.log(`🔑 [IndiaTax CSRF] Fetching token → ${url}`);

  const res = await axios.get(url, {
    headers: {
      'x-csrf-token': 'Fetch',
      Accept: 'application/xml',
      'sap-client': client,
      'X-Requested-With': 'XMLHttpRequest',
    },
    auth: { username: cfg.sapUser, password: cfg.sapPassword },
    timeout: SAP_TIMEOUT,
    validateStatus: (s) => s < 500,
    httpsAgent: _sharedAgent,
  });

  const token = res.headers['x-csrf-token'];
  if (!token || token === 'Required') {
    throw new Error('[SAP IndiaTax CSRF] No token returned for ZBP_INDIA_SP_SRV. Check credentials and authorizations.');
  }

  const rawCookies = res.headers['set-cookie'];
  const cookie = Array.isArray(rawCookies)
    ? rawCookies.map(c => c.split(';')[0]).join('; ')
    : (typeof rawCookies === 'string' ? rawCookies.split(';')[0] : '');

  _csrfCache.set(_cacheKey(cfg), { token, cookie, fetchedAt: new Date() });
  return { token, cookie };
};

const getIndiaTaxCsrfToken = async (cfg, force = false) => {
  const entry = _csrfCache.get(_cacheKey(cfg));
  if (!force && _isFresh(entry)) return entry;
  return fetchIndiaTaxCsrfToken(cfg);
};

const invalidateIndiaTaxCsrfToken = (cfg) => _csrfCache.delete(_cacheKey(cfg));

/**
 * Axios instance factory for ZBP_INDIA_SP_SRV
 */
const _indiaTaxInstance = (cfg) =>
  axios.create({
    baseURL: resolveIndiaTaxUrl(cfg),
    timeout: SAP_TIMEOUT,
    auth: { username: cfg.sapUser, password: cfg.sapPassword },
    params: {
      'sap-client': cfg.sapClient || '100',
    },
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'sap-client': cfg.sapClient || '100',
      'X-Requested-With': 'XMLHttpRequest',
    },
    httpsAgent: _sharedAgent,
  });

/**
 * Format Date to SAP OData JSON DateTime literal (/Date(timestamp)/)
 */
const _toSapODataDate = (d) => {
  if (!d) return null;
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt.getTime())) return null;
  return `/Date(${dt.getTime()})/`;
};

/**
 * Normalize and parse OData error responses
 */
const parseIndiaTaxError = (err) => {
  const data = err.response?.data;
  let message = err.message || 'Unknown SAP India Tax Error';
  let details = [];

  if (data) {
    if (typeof data === 'string') {
      const msgMatch = data.match(/<message[^>]*>([\s\S]*?)<\/message>/i);
      if (msgMatch) message = msgMatch[1].trim();
    } else if (data.error) {
      message = data.error.message?.value || data.error.message || message;
      if (Array.isArray(data.error.innererror?.errordetails)) {
        details = data.error.innererror.errordetails.map(d => ({
          code: d.code,
          message: d.message,
          target: d.target,
          severity: d.severity
        }));
      }
    }
  }

  const parsedErr = new Error(`[SAP ZBP_INDIA_SP_SRV] ${message}`);
  parsedErr.sapMessage = message;
  parsedErr.errordetails = details;
  parsedErr.status = err.response?.status;
  return parsedErr;
};

/**
 * Perform a write (POST / PATCH / PUT / DELETE) to ZBP_INDIA_SP_SRV
 */
const sapIndiaTaxWrite = async (cfg, method, endpoint, data, customHeaders = {}) => {
  const instance = _indiaTaxInstance(cfg);

  const executeCall = async () => {
    let { token, cookie } = await getIndiaTaxCsrfToken(cfg);
    const hdrs = {
      'x-csrf-token': token,
      ...customHeaders
    };
    if (cookie) hdrs['Cookie'] = cookie;
    if (method.toUpperCase() === 'PATCH') hdrs['If-Match'] = '*';
    if (method.toUpperCase() === 'POST' && !customHeaders['Content-Type']) {
      hdrs['Prefer'] = 'return=representation';
    }

    try {
      console.log(`📤 [SAP IndiaTax] ${method} ${endpoint}`);
      const res = await instance.request({ method, url: endpoint, data, headers: hdrs });
      console.log(`✅ [SAP IndiaTax] ${method} ${endpoint} → HTTP ${res.status}`);
      return res;
    } catch (err) {
      if (err.response?.status === 403) {
        console.warn('⚠️ [SAP IndiaTax] 403 Forbidden — refreshing CSRF token & retrying…');
        invalidateIndiaTaxCsrfToken(cfg);
        const fresh = await getIndiaTaxCsrfToken(cfg, true);
        const freshHdrs = { ...hdrs, 'x-csrf-token': fresh.token };
        if (fresh.cookie) freshHdrs['Cookie'] = fresh.cookie;
        return instance.request({ method, url: endpoint, data, headers: freshHdrs });
      }
      throw parseIndiaTaxError(err);
    }
  };

  const maxRetries = 2;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await executeCall();
    } catch (err) {
      if (attempt < maxRetries && (!err.status || err.status >= 500)) {
        console.warn(`⚠️ [SAP IndiaTax] Retrying after transient error (${err.message})…`);
        await new Promise(r => setTimeout(r, 2000));
      } else {
        throw err;
      }
    }
  }
};

/**
 * Perform a GET read from ZBP_INDIA_SP_SRV
 */
const sapIndiaTaxRead = async (cfg, endpoint) => {
  const instance = _indiaTaxInstance(cfg);
  const entry = _csrfCache.get(_cacheKey(cfg));
  const hdrs = (entry && entry.cookie) ? { Cookie: entry.cookie } : {};

  try {
    console.log(`📥 [SAP IndiaTax] GET ${endpoint}`);
    const res = await instance.get(endpoint, { headers: hdrs });
    console.log(`✅ [SAP IndiaTax] GET ${endpoint} → HTTP ${res.status}`);
    return res;
  } catch (err) {
    throw parseIndiaTaxError(err);
  }
};

/**
 * Build the deep-insert payload for IndiaTaxGeneralSet + ToTanExemption
 */
const _buildIndiaTaxPayload = (bpNumber, vendorData = {}) => {
  let formattedBp = String(bpNumber || '').trim();
  if (/^\d+$/.test(formattedBp) && formattedBp.length < 10) {
    formattedBp = formattedBp.padStart(10, '0');
  }

  const taxDetails = vendorData.taxDetails || {};
  const companyCode = vendorData.companyCodeData?.companyCode || '1000';

  // 1. Base Tax Payload (IndiaTaxGeneral)
  const payload = {
    BusinessPartner: formattedBp,
    PAN: (taxDetails.pan || '').trim().toUpperCase().substring(0, 40),
    ServiceRegNo: (taxDetails.serviceRegNo || '').trim().toUpperCase().substring(0, 40),
    CSTNo: (taxDetails.cstNo || '').trim().toUpperCase().substring(0, 40),
    LSTNo: (taxDetails.lstNo || '').trim().toUpperCase().substring(0, 40),
    GstVenClass: (taxDetails.gstVenClass !== undefined && taxDetails.gstVenClass !== null ? String(taxDetails.gstVenClass) : ' ').substring(0, 1),
  };

  // 2. TAN Exemptions list
  const tanList = [];
  if (Array.isArray(taxDetails.tanExemptions) && taxDetails.tanExemptions.length > 0) {
    for (const tan of taxDetails.tanExemptions) {
      if (tan.sectionCode || tan.withholdingCode || tan.exemptionNumber) {
          const cc = (tan.companyCode || companyCode).trim().toUpperCase().substring(0, 4);
          const defaultSec = cc === '5000' ? '5005' : cc === '6000' ? '6006' : (tan.sectionCode || '5005');
          const secCode = (tan.sectionCode || defaultSec).trim().toUpperCase().substring(0, 4);
          tanList.push({
            BusinessPartner: formattedBp,
            CompanyCode: cc,
            SectionCode: secCode,
          WithholdingCode: (tan.withholdingCode || '').trim().toUpperCase().substring(0, 2),
          WithholdingTaxType: (tan.withholdingTaxType || 'W1').trim().toUpperCase().substring(0, 2),
          ValidFrom: _toSapODataDate(tan.validFrom || new Date()),
          ValidTo: _toSapODataDate(tan.validTo || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)),
          ExemptionNumber: (tan.exemptionNumber || '').trim().substring(0, 15),
          ExemptionRate: Number(tan.exemptionRate || 0).toFixed(2),
          ExemThreshold: Number(tan.exemThreshold || 0).toFixed(2),
          Currency: (tan.currency || 'INR').trim().toUpperCase().substring(0, 5),
        });
      }
    }
  }

  // Fallback: If no explicit tanExemptions but companyCodeData has withholdingTax exemptions
  if (tanList.length === 0 && Array.isArray(vendorData.companyCodeData?.withholdingTax)) {
    for (const wt of vendorData.companyCodeData.withholdingTax) {
      if (wt.exemptionNumber || wt.exemptionPercent) {
        tanList.push({
          BusinessPartner: formattedBp,
          CompanyCode: companyCode.substring(0, 4),
          SectionCode: (wt.taxCode || '194C').substring(0, 4),
          WithholdingCode: (wt.taxCode || 'C1').substring(0, 2),
          WithholdingTaxType: (wt.taxType || 'W1').substring(0, 2),
          ValidFrom: _toSapODataDate(wt.exemptFrom || new Date()),
          ValidTo: _toSapODataDate(wt.exemptTo || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)),
          ExemptionNumber: (wt.exemptionNumber || '').substring(0, 15),
          ExemptionRate: Number(wt.exemptionPercent || 0).toFixed(2),
          ExemThreshold: '0.00',
          Currency: 'INR',
        });
      }
    }
  }

  if (tanList.length > 0) {
    payload.ToTanExemption = tanList;
  }

  return payload;
};

/**
 * Post India Tax Details (PAN, Service Reg, TAN Exemptions) to SAP
 */
const postIndiaTaxDetails = async (cfg, bpNumber, vendorData) => {
  const mode = (cfg.sapVersion || 'STUB').toUpperCase();
  if (mode === 'STUB') {
    console.log(`🧪 [SAP IndiaTax STUB] Simulated postIndiaTaxDetails for BP: ${bpNumber}`);
    await new Promise(r => setTimeout(r, 400));
    return {
      status: 'SUCCESS_STUB',
      businessPartner: bpNumber,
      taxData: _buildIndiaTaxPayload(bpNumber, vendorData)
    };
  }

  let formattedBp = String(bpNumber || '').trim();
  if (/^\d+$/.test(formattedBp) && formattedBp.length < 10) {
    formattedBp = formattedBp.padStart(10, '0');
  }

  const payload = _buildIndiaTaxPayload(formattedBp, vendorData);
  console.log(`📦 [SAP IndiaTax] Deep-inserting IndiaTaxGeneralSet for BP: ${formattedBp}`);

  try {
    // Attempt 1: Deep insert POST
    const res = await sapIndiaTaxWrite(cfg, 'POST', '/IndiaTaxGeneralSet', payload);
    console.log(`🎉 [SAP IndiaTax] IndiaTaxGeneralSet created successfully for BP: ${formattedBp}`);
    return res.data?.d || res.data;
  } catch (err) {
    // If already exists or cannot create with POST, try PATCH on header and separate inserts on TanExemptionSet
    console.warn(`⚠️ [SAP IndiaTax] Deep insert POST failed: ${err.message}. Checking if record already exists…`);
    
    // Header PATCH payload (without navigation property)
    const headerPatch = { ...payload };
    delete headerPatch.ToTanExemption;
    delete headerPatch.ToAttachments;

    const patchKey = `IndiaTaxGeneralSet('${formattedBp}')`;
    try {
      await sapIndiaTaxWrite(cfg, 'PATCH', `/${patchKey}`, headerPatch);
      console.log(`✅ [SAP IndiaTax] IndiaTaxGeneralSet updated via PATCH for BP: ${formattedBp}`);

      // If TAN exemptions provided, insert them individually
      if (Array.isArray(payload.ToTanExemption) && payload.ToTanExemption.length > 0) {
        for (const tan of payload.ToTanExemption) {
          try {
            await sapIndiaTaxWrite(cfg, 'POST', '/TanExemptionSet', tan);
            console.log(`✅ [SAP IndiaTax] TanExemption inserted: ${tan.SectionCode}`);
          } catch (tanErr) {
            console.warn(`⚠️ [SAP IndiaTax] Failed to insert individual TanExemption: ${tanErr.message}`);
          }
        }
      }
      return { status: 'UPDATED', businessPartner: formattedBp };
    } catch (patchErr) {
      console.error(`❌ [SAP IndiaTax] PATCH fallback also failed: ${patchErr.message}`);
      throw patchErr;
    }
  }
};

/**
 * Upload a document stream to BPAttachmentSet
 */
const uploadIndiaTaxAttachment = async (cfg, bpNumber, documentItem) => {
  const mode = (cfg.sapVersion || 'STUB').toUpperCase();
  if (mode === 'STUB') {
    console.log(`🧪 [SAP IndiaTax STUB] Simulated attachment upload for BP: ${bpNumber}, file: ${documentItem?.fileName}`);
    return { status: 'ATTACHED_STUB', fileName: documentItem?.fileName };
  }

  let formattedBp = String(bpNumber || '').trim();
  if (/^\d+$/.test(formattedBp) && formattedBp.length < 10) {
    formattedBp = formattedBp.padStart(10, '0');
  }

  const filePath = documentItem.filePath ? path.resolve(process.cwd(), documentItem.filePath) : null;
  if (!filePath || !fs.existsSync(filePath)) {
    console.warn(`⚠️ [SAP IndiaTax Attachment] File not found on disk: ${filePath}, skipping upload.`);
    return null;
  }

  const fileBuffer = fs.readFileSync(filePath);
  const fileName = documentItem.fileName || path.basename(filePath);
  const mimeType = documentItem.mimeType || 'application/pdf';

  console.log(`📤 [SAP IndiaTax Attachment] Uploading ${fileName} (${mimeType}) for BP ${formattedBp}…`);

  const headers = {
    'Content-Type': mimeType,
    'Slug': `${formattedBp}/${fileName}`,
    'BusinessPartner': formattedBp,
  };

  const res = await sapIndiaTaxWrite(cfg, 'POST', '/BPAttachmentSet', fileBuffer, headers);
  console.log(`✅ [SAP IndiaTax Attachment] Uploaded ${fileName} successfully`);
  return res.data?.d || res.data;
};

/**
 * Read India Tax & TAN details from SAP
 */
const getIndiaTaxDetails = async (cfg, bpNumber) => {
  const mode = (cfg.sapVersion || 'STUB').toUpperCase();
  if (mode === 'STUB') {
    return {
      BusinessPartner: bpNumber,
      PAN: 'AABCS1234F',
      ServiceRegNo: 'SRN999888',
      GstVenClass: '1',
      ToTanExemption: { results: [] },
      ToAttachments: { results: [] }
    };
  }

  let formattedBp = String(bpNumber || '').trim();
  if (/^\d+$/.test(formattedBp) && formattedBp.length < 10) {
    formattedBp = formattedBp.padStart(10, '0');
  }

  const endpoint = `/IndiaTaxGeneralSet('${formattedBp}')?$expand=ToTanExemption,ToAttachments&$format=json`;
  const res = await sapIndiaTaxRead(cfg, endpoint);
  return res.data?.d || res.data || null;
};

module.exports = {
  resolveIndiaTaxUrl,
  fetchIndiaTaxCsrfToken,
  getIndiaTaxCsrfToken,
  invalidateIndiaTaxCsrfToken,
  sapIndiaTaxWrite,
  sapIndiaTaxRead,
  _buildIndiaTaxPayload,
  postIndiaTaxDetails,
  uploadIndiaTaxAttachment,
  getIndiaTaxDetails,
};
