'use strict';

const axios = require('axios');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const { getTenantUploadDir } = require('../config/storage');

/**
 * SAP Balance Bridge — utils/sapBalanceBridge.js
 *
 * Integrates with SAP OData service `FAP_VENDOR_LINE_ITEMS_SRV`
 * and generates sealed SA 505 Audit Certificates via PDFKit.
 */

/**
 * Format date helper
 */
const formatDate = (date) => {
  if (!date) return '—';
  const d = new Date(date);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
};

/**
 * Formats currency in Indian numbering format (e.g. ₹ 2,211,297.92)
 */
const formatINR = (val) => {
  if (val === undefined || val === null || isNaN(val)) return '0.00';
  return Number(val).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
};

const generateMockBalance = (vendorId, companyCode, keyDate, sourceLabel = 'STUB', fiscalYear = '') => {
  const dateObj = new Date(keyDate);
  const seed = parseInt(String(vendorId).replace(/\D/g, '') || '100452', 10);
  const fyStr = String(fiscalYear || '').trim();
  const baseYear = fyStr ? parseInt(fyStr, 10) : dateObj.getFullYear();

  const mockItems = [
    {
      sapDocumentNumber: `1900${(seed % 9000) + 1000}`,
      fiscalYear: String(baseYear),
      vendorInvoiceRef: `INV-${baseYear}-0491`,
      documentDate: new Date(dateObj.getTime() - 45 * 24 * 60 * 60 * 1000),
      netDueDate: new Date(dateObj.getTime() + 15 * 24 * 60 * 60 * 1000),
      amount: 1450000.50,
      debitCreditCode: 'H', // Credit / Payable
      itemText: 'Material Supply - Batch A',
      specialGl: '',
    },
    {
      sapDocumentNumber: `1900${(seed % 9000) + 1001}`,
      fiscalYear: String(baseYear),
      vendorInvoiceRef: `INV-${baseYear}-0522`,
      documentDate: new Date(dateObj.getTime() - 25 * 24 * 60 * 60 * 1000),
      netDueDate: new Date(dateObj.getTime() + 35 * 24 * 60 * 60 * 1000),
      amount: 885297.42,
      debitCreditCode: 'H', // Credit / Payable
      itemText: 'Material Supply - Batch B',
      specialGl: '',
    },
    {
      sapDocumentNumber: `1400${(seed % 9000) + 1002}`,
      fiscalYear: String(baseYear),
      vendorInvoiceRef: `ADV-ADJ-${baseYear}`,
      documentDate: new Date(dateObj.getTime() - 15 * 24 * 60 * 60 * 1000),
      netDueDate: null,
      amount: 100000.00,
      debitCreditCode: 'S', // Debit / Advance Deduction
      itemText: 'Advance Adjustment SpGL A',
      specialGl: 'A',
    },
    {
      sapDocumentNumber: `1700${(seed % 9000) + 1003}`,
      fiscalYear: String(baseYear),
      vendorInvoiceRef: `TDS-RET-${baseYear}`,
      documentDate: new Date(dateObj.getTime() - 10 * 24 * 60 * 60 * 1000),
      netDueDate: null,
      amount: 24000.00,
      debitCreditCode: 'S', // Debit / TDS
      itemText: 'TDS Deduction 194C',
      specialGl: '',
    },
  ];

  let grossCredit = 0;
  let grossDebit = 0;
  for (const it of mockItems) {
    if (it.debitCreditCode === 'H') grossCredit += it.amount;
    else grossDebit += it.amount;
  }

  const normalCredit = mockItems.filter(it => it.debitCreditCode === 'H' && !it.specialGl).reduce((acc, it) => acc + it.amount, 0);
  const normalDebit = mockItems.filter(it => it.debitCreditCode === 'S' && !it.specialGl).reduce((acc, it) => acc + it.amount, 0);
  const spGlDebit = mockItems.filter(it => it.specialGl === 'A').reduce((acc, it) => acc + it.amount, 0);

  const opBal = fyStr ? 150000.00 : 0.00;
  const netBalance = (grossCredit + opBal) - grossDebit;

  const mockSubledgerBreakdown = {
    normalBalance: {
      code: '',
      name: 'Account balance',
      openingBalance: opBal,
      totalDebit: Math.round(normalDebit * 100) / 100,
      totalCredit: Math.round(normalCredit * 100) / 100,
      closingBalance: Math.round(Math.abs(normalCredit + opBal - normalDebit) * 100) / 100,
      balanceIndicator: 'Credit',
    },
    specialGlBalances: [
      {
        code: 'A',
        name: 'Down Payments, Current Assets',
        openingBalance: 0,
        totalDebit: Math.round(spGlDebit * 100) / 100,
        totalCredit: 0,
        closingBalance: Math.round(spGlDebit * 100) / 100,
        balanceIndicator: 'Debit',
      },
    ],
    hasSpecialGl: true,
    specialGlTotalDebit: Math.round(spGlDebit * 100) / 100,
    specialGlTotalCredit: 0,
    combinedTotal: {
      openingBalance: opBal,
      totalDebit: Math.round(grossDebit * 100) / 100,
      totalCredit: Math.round(grossCredit * 100) / 100,
      closingBalance: Math.round(Math.abs(netBalance) * 100) / 100,
      balanceIndicator: netBalance >= 0 ? 'Credit' : 'Debit',
    },
  };

  return {
    closingBalance: Math.round(Math.abs(netBalance) * 100) / 100,
    openingBalance: opBal,
    balanceIndicator: netBalance >= 0 ? 'Credit' : 'Debit',
    currency: 'INR',
    lineItems: mockItems,
    source: sourceLabel,
    balanceSource: fyStr ? 'FAP_VENDOR_BALANCE_SRV' : 'STUB',
    subledgerBreakdown: mockSubledgerBreakdown,
    grossCredit: Math.round(grossCredit * 100) / 100,
    grossDebit: Math.round(grossDebit * 100) / 100,
    vendorNameFromSap: `Mock Supplier (${vendorId})`,
    vendorEmailFromSap: `accounts.${String(vendorId).toLowerCase()}@mockvendor.com`,
    vendorAddressFromSap: '123 Industrial Area, Phase II, New Delhi, India',
    fiscalYear: fyStr,
  };
};

/**
 * Resolves base SAP host from sapConfig or process.env
 */
const getSapBaseHost = (sapConfig = {}) => {
  let baseHost = '';
  const odataUrl = sapConfig.sapOdataUrl || sapConfig.sapODataUrl;
  if (odataUrl) {
    try {
      baseHost = new URL(odataUrl).origin;
    } catch (_) {
      baseHost = String(odataUrl).replace(/\/sap\/opu\/odata\/sap\/.*$/i, '');
    }
  } else if (sapConfig.sapHost) {
    const host = String(sapConfig.sapHost).trim();
    if (host.startsWith('http://') || host.startsWith('https://')) {
      baseHost = host;
    } else {
      const protocol = sapConfig.sapProtocol || (host.includes(':443') ? 'https' : 'http');
      const port = sapConfig.sapPort || '';
      baseHost = `${protocol}://${host}${port ? `:${port}` : ''}`;
    }
  } else if (process.env.SAP_ODATA_URL && !process.env.SAP_ODATA_URL.includes('your-s4hana.com')) {
    try {
      baseHost = new URL(process.env.SAP_ODATA_URL).origin;
    } catch (_) {
      baseHost = String(process.env.SAP_ODATA_URL).replace(/\/sap\/opu\/odata\/sap\/.*$/i, '');
    }
  } else if (process.env.SAP_HOST && process.env.SAP_HOST !== '192.168.1.100') {
    const host = String(process.env.SAP_HOST).trim();
    if (host.startsWith('http://') || host.startsWith('https://')) {
      baseHost = host;
    } else {
      const protocol = process.env.SAP_PROTOCOL || (host.includes(':443') ? 'https' : 'http');
      const port = process.env.SAP_PORT || '';
      baseHost = `${protocol}://${host}${port ? `:${port}` : ''}`;
    }
  }
  return baseHost ? baseHost.replace(/\/+$/, '') : '';
};

/**
 * Fetch vendor contact details (email, address, BP name) from SAP OData API_BUSINESS_PARTNER
 */
const fetchVendorContactFromSap = async (vendorId, sapConfig = {}) => {
  const version = (sapConfig.sapVersion || process.env.SAP_VERSION || 'STUB').toUpperCase();
  if (version === 'STUB') {
    return {
      email: `accounts.${String(vendorId).toLowerCase()}@mockvendor.com`,
      address: '123 Industrial Area, Phase II, New Delhi, India',
      name: `Supplier ${vendorId}`,
    };
  }

  const baseHost = getSapBaseHost(sapConfig);
  if (!baseHost) return null;

  const sapClient = sapConfig.sapClient || process.env.SAP_CLIENT || '800';
  const bpServiceUrl = `${baseHost}/sap/opu/odata/sap/API_BUSINESS_PARTNER`;
  const sapAuth = (sapConfig.sapUser && sapConfig.sapPassword) ? {
    username: sapConfig.sapUser,
    password: sapConfig.sapPassword,
  } : (process.env.SAP_USER && process.env.SAP_PASSWORD) ? {
    username: process.env.SAP_USER,
    password: process.env.SAP_PASSWORD,
  } : undefined;

  const raw = String(vendorId || '').trim();
  const padded = /^\d+$/.test(raw) && raw.length < 10 ? raw.padStart(10, '0') : raw;
  const unpadded = raw.replace(/^0+/, '');

  const httpsAgent = new https.Agent({
    rejectUnauthorized: false,
    keepAlive: true,
  });

  try {
    const filter = `BusinessPartner eq '${padded}' or BusinessPartner eq '${raw}' or BusinessPartner eq '${unpadded}'`;
    const url = `${bpServiceUrl}/A_BusinessPartnerAddress?$filter=(${encodeURIComponent(filter)})&$expand=to_EmailAddress&$format=json&sap-client=${sapClient}`;

    const res = await axios.get(url, {
      auth: sapAuth,
      httpsAgent,
      timeout: 15000,
      headers: {
        'sap-client': sapClient,
        Accept: 'application/json',
      },
    });

    const addrs = res.data?.d?.results || [];
    let derivedEmail = '';
    let derivedAddress = '';
    let derivedName = '';

    for (const a of addrs) {
      if (!derivedName && a.FullName) {
        derivedName = a.FullName.trim();
      }
      if (!derivedAddress) {
        const parts = [
          a.CareOfName ? `C/O ${a.CareOfName}` : '',
          a.StreetName,
          a.District || a.CityName,
          a.PostalCode ? `PIN ${a.PostalCode}` : '',
          a.Country === 'IN' ? 'India' : a.Country,
        ].filter(Boolean);
        if (parts.length > 0) {
          derivedAddress = parts.join(', ');
        }
      }

      const emails = a.to_EmailAddress?.results || [];
      if (emails.length > 0) {
        const defaultMail = emails.find(e => e.IsDefaultEmailAddress === true || e.IsDefaultEmailAddress === 'X') || emails[0];
        if (defaultMail?.EmailAddress) {
          derivedEmail = defaultMail.EmailAddress.trim();
          break;
        }
      }

      // Secondary fallback: query A_AddressEmailAddress directly with AddressID if expand was empty
      if (!derivedEmail && a.AddressID) {
        try {
          const directUrl = `${bpServiceUrl}/A_AddressEmailAddress?$filter=AddressID eq '${a.AddressID}'&$format=json&sap-client=${sapClient}`;
          const directRes = await axios.get(directUrl, {
            auth: sapAuth,
            httpsAgent,
            timeout: 10000,
            headers: { 'sap-client': sapClient, Accept: 'application/json' },
          });
          const directEmails = directRes.data?.d?.results || [];
          if (directEmails.length > 0) {
            const defM = directEmails.find(e => e.IsDefaultEmailAddress === true || e.IsDefaultEmailAddress === 'X') || directEmails[0];
            if (defM?.EmailAddress) {
              derivedEmail = defM.EmailAddress.trim();
              break;
            }
          }
        } catch (_) {
          // secondary lookup ignored
        }
      }
    }

    return {
      email: derivedEmail || null,
      address: derivedAddress || null,
      name: derivedName || null,
    };
  } catch (err) {
    console.warn(`[SAP Balance Bridge] BP email lookup failed for vendor ${vendorId}:`, err.message);
    return null;
  }
};

/**
 * Query official vendor subledger summary from SAP OData FAP_VENDOR_BALANCE_SRV
 * Returns { openingBalance, totalDebit, totalCredit, closingBalance, balanceIndicator, currency, periodsCount }
 */
const fetchVendorBalanceFromSapBalanceSrv = async (vendorId, companyCode, fiscalYear, sapConfig = {}) => {
  const baseHost = getSapBaseHost(sapConfig);
  if (!baseHost) return null;

  const sapClient = sapConfig.sapClient || process.env.SAP_CLIENT || '800';
  const sapAuth = (sapConfig.sapUser && sapConfig.sapPassword) ? {
    username: sapConfig.sapUser,
    password: sapConfig.sapPassword,
  } : (process.env.SAP_USER && process.env.SAP_PASSWORD) ? {
    username: process.env.SAP_USER,
    password: process.env.SAP_PASSWORD,
  } : undefined;

  const rawVendor = String(vendorId || '').trim();
  const paddedVendor = /^\d+$/.test(rawVendor) && rawVendor.length < 10
    ? rawVendor.padStart(10, '0')
    : rawVendor.slice(0, 10);

  // SAP OData requires CompanyCode and FiscalYear first in the filter predicate
  const filter = `CompanyCode eq '${companyCode}' and FiscalYear eq '${fiscalYear}' and Supplier eq '${paddedVendor}'`;
  const url = `${baseHost}/sap/opu/odata/sap/FAP_VENDOR_BALANCE_SRV/SupplierBalanceSet`;

  const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

  try {
    const res = await axios.get(url, {
      params: {
        $filter: filter,
        $format: 'json',
        'sap-client': sapClient,
      },
      headers: {
        'sap-client': sapClient,
        Accept: 'application/json',
      },
      auth: sapAuth,
      httpsAgent,
      timeout: 20000,
    });

    const records = res.data?.d?.results || [];
    if (records.length === 0) return null;

    const currency = records[0]?.Currency || 'INR';

    // ── 1. Canonical SAP FK10N Summary Rows ─────────────────────────────
    // In SAP FAP_VENDOR_BALANCE_SRV:
    // Period 97 (or SpecialGLCode === '9' with name 'Total'): Grand Total of FK10N (Normal AP + all Special G/L)
    const p97 = records.find(r => r.FiscalPeriod === '97' || (r.SpecialGLCode === '9' && r.SpecialGLCodeLongName === 'Total'));

    // Period 96 (or SpecialGLCode === '9' with name 'Account Balance'): Normal Trade AP Invoices subledger row
    const p96 = records.find(r => r.FiscalPeriod === '96' || (r.SpecialGLCode === '9' && r.SpecialGLCodeLongName === 'Account Balance'));

    // Period 95: Normal transactions period total
    const p95 = records.find(r => r.FiscalPeriod === '95' && !r.SpecialGLCode);

    // ── 2. Real Special G/L Breakdown Rows ──────────────────────────────
    // SAP uses SpecialGLCode === '9' as an internal summary indicator.
    // Real Special G/L items are codes like 'A' (Down Payments), 'F', etc.
    const spGlRecords = records.filter(r => r.SpecialGLCode && r.SpecialGLCode !== '9');
    const spGlByCode = {};
    for (const r of spGlRecords) {
      const code = r.SpecialGLCode;
      if (!spGlByCode[code] || parseInt(r.FiscalPeriod, 10) >= parseInt(spGlByCode[code].FiscalPeriod, 10)) {
        spGlByCode[code] = r;
      }
    }

    const specialGlList = Object.values(spGlByCode).map(r => {
      const rawBal = parseFloat(r.BalAmtInDisplayCrcy) || 0;
      // In SAP vendor accounting: Positive BalAmt in Special G/L is Debit (Advance/Asset held by vendor)
      // Negative BalAmt is Credit
      const balInd = rawBal > 0 ? 'Debit' : (rawBal < 0 ? 'Credit' : 'Debit');
      return {
        code: r.SpecialGLCode,
        name: r.SpecialGLCodeLongName || `Special G/L (${r.SpecialGLCode})`,
        openingBalance: Math.abs(parseFloat(r.BalCarFwdAmntInDisplayCrcy) || 0),
        totalDebit: Math.abs(parseFloat(r.DebitAmtInDisplayCrcy) || 0),
        totalCredit: Math.abs(parseFloat(r.CreditAmtInDisplayCrcy) || 0),
        closingBalance: Math.round(Math.abs(rawBal) * 100) / 100,
        balanceIndicator: balInd,
        rawBal,
      };
    });

    // ── 3. Normal Accounts Payable (Trade Invoices) ─────────────────────
    let normalOpening = 0;
    let normalDebit = 0;
    let normalCredit = 0;
    let normalClosing = 0;
    let normalIndicator = 'Credit';
    let normalRawAccum = 0;

    if (p96) {
      normalOpening = Math.abs(parseFloat(p96.BalCarFwdAmntInDisplayCrcy) || 0);
      normalDebit = Math.abs(parseFloat(p96.DebitAmtInDisplayCrcy) || 0);
      normalCredit = Math.abs(parseFloat(p96.CreditAmtInDisplayCrcy) || 0);
      normalRawAccum = parseFloat(p96.BalAmtInDisplayCrcy) || 0;
      normalClosing = Math.round(Math.abs(normalRawAccum) * 100) / 100;
      normalIndicator = normalRawAccum <= 0 ? 'Credit' : 'Debit';
    } else if (p95) {
      const p00 = records.find(r => r.FiscalPeriod === '00' && !r.SpecialGLCode);
      normalOpening = Math.abs(parseFloat(p00?.BalCarFwdAmntInDisplayCrcy) || 0);
      normalDebit = Math.abs(parseFloat(p95.DebitAmtInDisplayCrcy) || 0);
      normalCredit = Math.abs(parseFloat(p95.CreditAmtInDisplayCrcy) || 0);
      normalRawAccum = parseFloat(p95.AccumulatedBalAmtInDisplayCrcy) || 0;
      normalClosing = Math.round(Math.abs(normalRawAccum) * 100) / 100;
      normalIndicator = normalRawAccum <= 0 ? 'Credit' : 'Debit';
    } else {
      const regular = records.filter(r => !r.SpecialGLCode && parseInt(r.FiscalPeriod, 10) >= 1 && parseInt(r.FiscalPeriod, 10) <= 16);
      const p00 = records.find(r => r.FiscalPeriod === '00' && !r.SpecialGLCode);
      normalOpening = Math.abs(parseFloat(p00?.BalCarFwdAmntInDisplayCrcy) || 0);
      normalDebit = regular.reduce((acc, r) => acc + Math.abs(parseFloat(r.DebitAmtInDisplayCrcy) || 0), 0);
      normalCredit = regular.reduce((acc, r) => acc + Math.abs(parseFloat(r.CreditAmtInDisplayCrcy) || 0), 0);
      const last = regular[regular.length - 1];
      normalRawAccum = last ? (parseFloat(last.AccumulatedBalAmtInDisplayCrcy) || 0) : 0;
      normalClosing = Math.round(Math.abs(normalRawAccum) * 100) / 100;
      normalIndicator = normalRawAccum <= 0 ? 'Credit' : 'Debit';
    }

    const normalGroupData = {
      code: '',
      name: 'Account balance (Trade Invoices)',
      openingBalance: Math.round(normalOpening * 100) / 100,
      totalDebit: Math.round(normalDebit * 100) / 100,
      totalCredit: Math.round(normalCredit * 100) / 100,
      closingBalance: normalClosing,
      balanceIndicator: normalIndicator,
      rawAccum: normalRawAccum,
    };

    // ── 4. Grand Net Confirmed Position (Period 97) ─────────────────────
    let grandOpening = 0;
    let grandDebit = 0;
    let grandCredit = 0;
    let grandClosing = 0;
    let grandIndicator = 'Credit';

    if (p97) {
      grandOpening = Math.abs(parseFloat(p97.BalCarFwdAmntInDisplayCrcy) || 0);
      grandDebit = Math.abs(parseFloat(p97.DebitAmtInDisplayCrcy) || 0);
      grandCredit = Math.abs(parseFloat(p97.CreditAmtInDisplayCrcy) || 0);
      const grandRaw = parseFloat(p97.BalAmtInDisplayCrcy) || 0;
      grandClosing = Math.round(Math.abs(grandRaw) * 100) / 100;
      grandIndicator = grandRaw <= 0 ? 'Credit' : 'Debit';
    } else {
      const spGlDebitTotal = specialGlList.filter(s => s.balanceIndicator === 'Debit').reduce((a, s) => a + s.closingBalance, 0);
      const spGlCreditTotal = specialGlList.filter(s => s.balanceIndicator === 'Credit').reduce((a, s) => a + s.closingBalance, 0);
      const netNormal = normalIndicator === 'Credit' ? -normalClosing : normalClosing;
      const netSpGl = spGlDebitTotal - spGlCreditTotal;
      const combinedNet = netNormal + netSpGl;
      grandClosing = Math.round(Math.abs(combinedNet) * 100) / 100;
      grandIndicator = combinedNet <= 0 ? 'Credit' : 'Debit';
      grandOpening = normalOpening + specialGlList.reduce((a, s) => a + s.openingBalance, 0);
      grandDebit = normalDebit + specialGlList.reduce((a, s) => a + s.totalDebit, 0);
      grandCredit = normalCredit + specialGlList.reduce((a, s) => a + s.totalCredit, 0);
    }

    const spGlTotalDebit = specialGlList.filter(s => s.balanceIndicator === 'Debit').reduce((acc, s) => acc + s.closingBalance, 0);
    const spGlTotalCredit = specialGlList.filter(s => s.balanceIndicator === 'Credit').reduce((acc, s) => acc + s.closingBalance, 0);

    return {
      openingBalance: Math.round(grandOpening * 100) / 100,
      totalCredit: Math.round(grandCredit * 100) / 100,
      totalDebit: Math.round(grandDebit * 100) / 100,
      closingBalance: grandClosing,
      balanceIndicator: grandIndicator,
      currency,
      periodsCount: records.length,
      sourceService: 'FAP_VENDOR_BALANCE_SRV',
      subledgerBreakdown: {
        normalBalance: normalGroupData,
        specialGlBalances: specialGlList,
        hasSpecialGl: specialGlList.length > 0,
        specialGlTotalDebit: Math.round(spGlTotalDebit * 100) / 100,
        specialGlTotalCredit: Math.round(spGlTotalCredit * 100) / 100,
        combinedTotal: {
          openingBalance: Math.round(grandOpening * 100) / 100,
          totalDebit: Math.round(grandDebit * 100) / 100,
          totalCredit: Math.round(grandCredit * 100) / 100,
          closingBalance: grandClosing,
          balanceIndicator: grandIndicator,
        },
      },
    };
  } catch (err) {
    console.warn(`[SAP Balance Bridge] FAP_VENDOR_BALANCE_SRV lookup failed for vendor ${vendorId} FY ${fiscalYear}:`, err.response?.data?.error?.message?.value || err.message);
    return null;
  }
};

/**
 * Fetch and derive vendor closing balance & open items from SAP
 */
const fetchAndDeriveVendorBalance = async (vendorId, companyCode, keyDate, sapConfig = {}, fiscalYear = '') => {
  const version = (sapConfig.sapVersion || process.env.SAP_VERSION || 'STUB').toUpperCase();
  const dateObj = keyDate ? new Date(keyDate) : new Date();
  const formattedKeyDate = !isNaN(dateObj.getTime()) ? dateObj.toISOString().slice(0, 10) : '';
  const fyStr = String(fiscalYear || '').trim();

  // ── STUB Simulation Mode ────────────────────────────────────────────────
  if (version === 'STUB') {
    return generateMockBalance(vendorId, companyCode, keyDate, 'STUB', fyStr);
  }

  // ── Real SAP OData Mode (ECC / S4HANA) ──────────────────────────────────
  const baseHost = getSapBaseHost(sapConfig);

  if (!baseHost) {
    console.warn('[SAP Balance Bridge] No SAP host or OData URL configured.');
    if (process.env.ALLOW_SAP_MOCK_FALLBACK === 'true') {
      return generateMockBalance(vendorId, companyCode, keyDate, 'STUB', fyStr);
    }
    throw new Error('SAP Host / OData URL is not configured.');
  }

  const sapClient = sapConfig.sapClient || process.env.SAP_CLIENT || '800';
  const sapUrl = `${baseHost}/sap/opu/odata/sap/FAP_VENDOR_LINE_ITEMS_SRV/Items`;

  const sapAuth = (sapConfig.sapUser && sapConfig.sapPassword) ? {
    username: sapConfig.sapUser,
    password: sapConfig.sapPassword,
  } : (process.env.SAP_USER && process.env.SAP_PASSWORD) ? {
    username: process.env.SAP_USER,
    password: process.env.SAP_PASSWORD,
  } : undefined;

  const rawVendor = String(vendorId || '').trim();
  const paddedVendor = /^\d+$/.test(rawVendor) && rawVendor.length < 10
    ? rawVendor.padStart(10, '0')
    : rawVendor;

  let filter = `(Supplier eq '${paddedVendor}' or Supplier eq '${rawVendor}') and CompanyCode eq '${companyCode}' and IsCleared eq ''`;
  if (formattedKeyDate) {
    filter += ` and KeyDate eq datetime'${formattedKeyDate}T00:00:00'`;
  }
  if (fyStr) {
    filter += ` and FiscalYear eq '${fyStr}'`;
  }

  const httpsAgent = new https.Agent({
    rejectUnauthorized: false,
    keepAlive: true,
  });

  try {
    const lineItemsPromise = axios.get(sapUrl, {
      params: {
        $filter: filter,
        $select: 'AccountingDocument,FiscalYear,AccountingDocumentItem,DocumentReferenceID,DocumentDate,PostingDate,NetDueDate,AmountInCompanyCodeCurrency,CompanyCodeCurrency,DebitCreditCode,DocumentItemText,SpecialGeneralLedgerCode,SupplierName',
        $format: 'json',
        'sap-client': sapClient,
      },
      headers: {
        'sap-client': sapClient,
        Accept: 'application/json',
      },
      auth: sapAuth,
      httpsAgent,
      timeout: 30000,
    });

    const contactPromise = fetchVendorContactFromSap(vendorId, sapConfig).catch(err => {
      console.warn('[SAP Balance Bridge] Non-fatal contact lookup error:', err.message);
      return null;
    });

    const [itemsResult, contactResult] = await Promise.allSettled([
      lineItemsPromise,
      contactPromise,
    ]);

    if (itemsResult.status === 'rejected') {
      const sapErr = itemsResult.reason;
      const errMsg = sapErr.response?.data?.error?.message?.value || sapErr.message;
      console.error(`[SAP Balance Bridge] Live SAP call failed for vendor ${vendorId} (CoCode: ${companyCode}):`, errMsg);

      // Only fallback if explicitly configured for fallback or in STUB mode
      if (version === 'STUB' || process.env.ALLOW_SAP_MOCK_FALLBACK === 'true') {
        console.warn(`[SAP Balance Bridge] Using simulation fallback for vendor ${vendorId}.`);
        return generateMockBalance(vendorId, companyCode, keyDate, 'SAP_OFFLINE_SIMULATION', fyStr);
      }

      throw new Error(`Live SAP S/4HANA OData Error: ${errMsg}`);
    }

    const response = itemsResult.value;
    let rawResults = response.data?.d?.results || [];
    const contactDetails = contactResult.status === 'fulfilled' ? contactResult.value : null;

    // Additional safeguard: in case OData service did not filter FiscalYear on server
    if (fyStr) {
      rawResults = rawResults.filter(item => String(item.FiscalYear || '').trim() === fyStr);
    }

    const parseSapDate = (val) => {
      if (!val) return null;
      const match = String(val).match(/\/Date\((\d+)\)\//) || String(val).match(/\d+/);
      return match ? new Date(parseInt(match[1] || match[0], 10)) : new Date(val);
    };

    const lineItems = rawResults.map(item => {
      return {
        sapDocumentNumber: item.AccountingDocument,
        fiscalYear: item.FiscalYear,
        vendorInvoiceRef: item.DocumentReferenceID || '',
        documentDate: parseSapDate(item.DocumentDate),
        postingDate: parseSapDate(item.PostingDate),
        netDueDate: parseSapDate(item.NetDueDate),
        amount: Math.abs(parseFloat(item.AmountInCompanyCodeCurrency) || 0),
        debitCreditCode: (item.DebitCreditCode || 'H').toUpperCase(),
        itemText: item.DocumentItemText || '',
        specialGl: item.SpecialGeneralLedgerCode || '',
      };
    });

    let grossCredit = 0;
    let grossDebit = 0;
    for (const it of lineItems) {
      if (it.debitCreditCode === 'H') {
        grossCredit += it.amount;
      } else {
        grossDebit += it.amount;
      }
    }

    const netBalance = grossCredit - grossDebit;
    let closingBalance = Math.round(Math.abs(netBalance) * 100) / 100;
    let balanceIndicator = netBalance >= 0 ? 'Credit' : 'Debit';
    let openingBalance = 0;
    let totalCredit = Math.round(grossCredit * 100) / 100;
    let totalDebit = Math.round(grossDebit * 100) / 100;
    let balanceSource = 'FAP_VENDOR_LINE_ITEMS_SRV';
    let subledgerBreakdown = null;

    // ── Primary Source for Fiscal Year: FAP_VENDOR_BALANCE_SRV ──────────
    if (fyStr) {
      try {
        const officialBal = await fetchVendorBalanceFromSapBalanceSrv(vendorId, companyCode, fyStr, sapConfig);
        if (officialBal) {
          closingBalance = officialBal.closingBalance;
          openingBalance = officialBal.openingBalance;
          totalCredit = officialBal.totalCredit;
          totalDebit = officialBal.totalDebit;
          balanceIndicator = officialBal.balanceIndicator;
          balanceSource = 'FAP_VENDOR_BALANCE_SRV';
          subledgerBreakdown = officialBal.subledgerBreakdown;
          console.log(`[SAP Balance Bridge] Using official FAP_VENDOR_BALANCE_SRV subledger figures for vendor ${vendorId} FY ${fyStr}: Closing ₹${closingBalance} (Op: ₹${openingBalance}, Cr: ₹${totalCredit}, Dr: ₹${totalDebit})`);
        }
      } catch (balErr) {
        console.warn(`[SAP Balance Bridge] Non-fatal FAP_VENDOR_BALANCE_SRV query fallback:`, balErr.message);
      }
    }

    // Synthesize breakdown for open items view if not already set by FAP_VENDOR_BALANCE_SRV
    if (!subledgerBreakdown && lineItems.length > 0) {
      const normalCredit = lineItems.filter(it => it.debitCreditCode === 'H' && !it.specialGl).reduce((acc, it) => acc + it.amount, 0);
      const normalDebit = lineItems.filter(it => it.debitCreditCode === 'S' && !it.specialGl).reduce((acc, it) => acc + it.amount, 0);
      const spGlCredit = lineItems.filter(it => it.debitCreditCode === 'H' && it.specialGl).reduce((acc, it) => acc + it.amount, 0);
      const spGlDebit = lineItems.filter(it => it.debitCreditCode === 'S' && it.specialGl).reduce((acc, it) => acc + it.amount, 0);
      const hasSpGl = lineItems.some(it => it.specialGl);

      if (hasSpGl) {
        subledgerBreakdown = {
          normalBalance: {
            code: '',
            name: 'Account balance (Trade Invoices)',
            openingBalance: 0,
            totalDebit: Math.round(normalDebit * 100) / 100,
            totalCredit: Math.round(normalCredit * 100) / 100,
            closingBalance: Math.round(Math.abs(normalCredit - normalDebit) * 100) / 100,
            balanceIndicator: normalCredit >= normalDebit ? 'Credit' : 'Debit',
          },
          specialGlBalances: [
            {
              code: 'A',
              name: 'Down Payments, Current Assets',
              openingBalance: 0,
              totalDebit: Math.round(spGlDebit * 100) / 100,
              totalCredit: Math.round(spGlCredit * 100) / 100,
              closingBalance: Math.round(Math.abs(spGlDebit - spGlCredit) * 100) / 100,
              balanceIndicator: spGlDebit >= spGlCredit ? 'Debit' : 'Credit',
            },
          ],
          hasSpecialGl: true,
          specialGlTotalDebit: Math.round(spGlDebit * 100) / 100,
          specialGlTotalCredit: Math.round(spGlCredit * 100) / 100,
          combinedTotal: {
            openingBalance: 0,
            totalDebit: Math.round(grossDebit * 100) / 100,
            totalCredit: Math.round(grossCredit * 100) / 100,
            closingBalance,
            balanceIndicator,
          },
        };
      }
    }

    const currency = rawResults[0]?.CompanyCodeCurrency || 'INR';
    const vendorNameFromSap = rawResults[0]?.SupplierName || contactDetails?.name || '';
    const vendorEmailFromSap = contactDetails?.email || '';
    const vendorAddressFromSap = contactDetails?.address || '';

    return {
      closingBalance,
      openingBalance,
      balanceIndicator,
      currency,
      lineItems,
      source: version,
      balanceSource,
      subledgerBreakdown,
      vendorNameFromSap,
      vendorEmailFromSap,
      vendorAddressFromSap,
      grossCredit: totalCredit,
      grossDebit: totalDebit,
      fiscalYear: fyStr,
    };
  } catch (sapErr) {
    const errMsg = sapErr.response?.data?.error?.message?.value || sapErr.message;
    console.error(`[SAP Balance Bridge] Live SAP call failed for vendor ${vendorId} (CoCode: ${companyCode}):`, errMsg);

    // Only fallback if explicitly configured for fallback or in STUB mode
    if (version === 'STUB' || process.env.ALLOW_SAP_MOCK_FALLBACK === 'true') {
      console.warn(`[SAP Balance Bridge] Using simulation fallback for vendor ${vendorId}.`);
      return generateMockBalance(vendorId, companyCode, keyDate, 'SAP_OFFLINE_SIMULATION', fyStr);
    }

    throw new Error(`Live SAP S/4HANA OData Error: ${errMsg}`);
  }
};

/**
 * Computes legally accurate phrasing for external balance confirmations (SA 505)
 * depending on Credit (payable), Debit (advance/recoverable), or Nil.
 */
const getBalanceNarrative = (amount, indicator, cutOffDateFormatted) => {
  const numAmount = Math.abs(Number(amount) || 0);
  const formattedAmount = formatINR(numAmount);

  if (numAmount === 0) {
    return {
      type: 'NIL',
      narrative: `Our records as on ${cutOffDateFormatted} shows a Nil balance (Rs. 0.00) with no amount outstanding payable to or receivable from you.`,
      displayBadge: 'Nil / Settled',
      vendorConfirmText: 'The above Nil balance is correct and matches our books of account.',
    };
  }

  if (indicator === 'Debit') {
    return {
      type: 'DEBIT',
      narrative: `Our records as on ${cutOffDateFormatted} shows a debit amount of Rs. ${formattedAmount} given as receivable from you (representing advance payments made or deductions recoverable from you).`,
      displayBadge: 'Debit (Advance / Recoverable)',
      vendorConfirmText: `The above debit balance of Rs. ${formattedAmount} (recoverable) is correct.`,
    };
  }

  return {
    type: 'CREDIT',
    narrative: `Our records as on ${cutOffDateFormatted} shows a credit amount of Rs. ${formattedAmount} given as payable to you.`,
    displayBadge: 'Credit (Payable to Vendor)',
    vendorConfirmText: `The above credit balance of Rs. ${formattedAmount} (payable) is correct.`,
  };
};

/**
 * Backward compatibility alias: generateAuditCertificatePDF delegates to canonical generateCreditorBalanceConfirmationLetterPDF
 */
const generateAuditCertificatePDF = (confirmation, tenant = {}, options = {}) => {
  return generateCreditorBalanceConfirmationLetterPDF(confirmation, tenant, { sealed: true, ...options });
};

/**
 * Generates the official Creditors Balance Confirmation Notice PDF
 * (Matches standard statutory audit SA 505 format as issued by corporate clients)
 * @param {Object} confirmation - VendorConfirmation document
 * @param {Object} tenant - Tenant document or info
 * @param {Object} options - Optional overrides
 * @returns {Promise<string>} relative file path to the stored PDF
 */
const generateCreditorBalanceConfirmationLetterPDF = (confirmation, tenant = {}, options = {}) => {
  return new Promise((resolve, reject) => {
    try {
      const uploadDir = getTenantUploadDir(confirmation.tenantId);
      const safeRef = String(confirmation.referenceNumber || 'SC_CB').replace(/[^a-zA-Z0-9_-]/g, '_');
      const isResponded = ['CONFIRMED', 'DISPUTED', 'RECONCILED', 'PRESUMED_CONFIRMED'].includes(confirmation.status);
      const prefix = (options.sealed || isResponded) ? 'Creditors_Confirmation_Certificate' : 'Creditors_Letter';
      const filename = `${prefix}_${safeRef}_${Date.now()}.pdf`;
      const absolutePath = path.join(uploadDir, filename);

      const writeStream = fs.createWriteStream(absolutePath);
      const doc = new PDFDocument({ margin: 40, size: 'A4' });

      doc.pipe(writeStream);

      // Company Entity Details (Matches companyCode from Multi-Entity / Company Code Registry)
      const matchingEntity = (tenant.companyEntities && confirmation.companyCode)
        ? tenant.companyEntities.find(c => String(c.companyCode).trim() === String(confirmation.companyCode).trim())
        : null;

      // Organization Plants & Operating Units Details
      const matchingPlant = (tenant.plants && tenant.plants.length > 0)
        ? (tenant.plants.find(p => confirmation.unitName && (p.name?.toLowerCase() === confirmation.unitName.toLowerCase() || p.code === confirmation.unitName))
          || tenant.plants.find(p => confirmation.companyCode && String(p.companyCode).trim() === String(confirmation.companyCode).trim()))
        : null;

      const companyLegalName = (matchingEntity?.legalName || confirmation.companyName || tenant.companyName || 'BALRAMPUR CHINI MILLS LTD.').toUpperCase();
      const unitName = (confirmation.unitName || matchingPlant?.name || '').trim();
      const plantAddress = (confirmation.unitAddress || matchingPlant?.address || '').trim();
      const rawRegd = (matchingEntity?.regdOfficeAddress || confirmation.companyAddress || tenant.regdOfficeAddress || tenant.companyAddress || '').trim();
      const regdOffice = rawRegd ? (rawRegd.toLowerCase().startsWith('regd') ? rawRegd : `Regd. Office: ${rawRegd}`) : 'Regd. Office: FMC FORTUNA, 234/3A, Acharya Jagdish Chandra Bose Road, 2nd Floor, Kolkata-700020';
      const phone = matchingEntity?.phone || tenant.phone || '';
      const fax = matchingEntity?.fax || tenant.fax || '';
      const website = matchingEntity?.website || tenant.website || '';
      const cin = (matchingEntity?.cin || confirmation.cin || tenant.cin || '').trim();
      const signatoryTitle = matchingPlant?.signatoryTitle || confirmation.signatoryTitle || 'Authorized Signatory';

      // ── 1. Top Header (Centered) ──────────────────────────────────────────
      doc.fillColor('#0f172a').fontSize(12).font('Helvetica-Bold')
        .text(companyLegalName, 40, 36, { align: 'center', width: 515 });

      if (unitName) {
        doc.fontSize(9.5).font('Helvetica-Bold')
          .text(`Unit : ${unitName.toUpperCase()}`, 40, doc.y + 2, { align: 'center', width: 515 });
      }

      doc.fontSize(8.5).font('Helvetica');

      if (plantAddress) {
        const cleanPlantAddr = plantAddress.replace(/[\r\n]+/g, ', ');
        doc.text(cleanPlantAddr, 40, doc.y + 2, { align: 'center', width: 515 });
      }

      if (regdOffice) {
        doc.text(regdOffice, 40, doc.y + 2, { align: 'center', width: 515 });
      }

      const contactParts = [];
      if (phone) contactParts.push(`Phone: ${phone}`);
      if (fax) contactParts.push(`Fax No.: ${fax}`);
      if (website) contactParts.push(`website: ${website}`);
      if (contactParts.length > 0) {
        doc.text(contactParts.join(', '), 40, doc.y + 2, { align: 'center', width: 515 });
      }

      if (cin) {
        doc.text(`CIN - ${cin}`, 40, doc.y + 2, { align: 'center', width: 515 });
      }

      // ── 2. Title (Centered, Bold, Underlined) ─────────────────────────────
      const titleY = Math.max(doc.y + 10, 126);
      const docTitle = (options.sealed || isResponded) ? 'CREDITORS BALANCE CONFIRMATION CERTIFICATE' : 'CREDITORS BALANCE CONFIRMATION';
      doc.fontSize(11).font('Helvetica-Bold')
        .text(docTitle, 40, titleY, { align: 'center', width: 515, underline: true });

      // ── 3. Reference No & Date ───────────────────────────────────────────
      const refY = titleY + 20;
      doc.fontSize(9).font('Helvetica')
        .text(`Ref. No: ${confirmation.referenceNumber || 'SC/CB/...' }`, 40, refY)
        .text(formatDate(confirmation.createdAt || new Date()), 360, refY, { align: 'right', width: 195 });

      // ── 4. Addressee (Vendor / Creditor) ─────────────────────────────────
      const vendorY = refY + 20;
      doc.fontSize(9).font('Helvetica')
        .text('To:', 40, vendorY)
        .font('Helvetica-Bold').text((confirmation.vendorName || 'Vendor').toUpperCase(), 40, vendorY + 13)
        .font('Helvetica');

      let currentY = vendorY + 27;
      if (confirmation.vendorAddress) {
        doc.text(confirmation.vendorAddress, 40, currentY, { width: 320 });
        currentY = doc.y;
      } else {
        doc.text('As per SAP Master Record', 40, currentY, { width: 320 });
        currentY = doc.y;
      }

      // ── 5. Legal Body Paragraphs ─────────────────────────────────────────
      const narrativeY = Math.max(currentY + 10, 240);
      const formattedCutOffDate = formatDate(confirmation.keyCutOffDate);
      const narrativeObj = getBalanceNarrative(confirmation.sapClosingBalance, confirmation.balanceIndicator, formattedCutOffDate);

      // Auditor details from tenant config / confirmation
      const auditorName = confirmation.auditorFirmName || tenant.balanceConfirmationConfig?.auditorFirmName || 'Statutory Auditor';
      const auditorAddress = confirmation.auditorAddress || tenant.balanceConfirmationConfig?.auditorAddress || '';
      const rawAuditorEmails = (confirmation.auditorEmails && confirmation.auditorEmails.length > 0)
        ? confirmation.auditorEmails.join(', ')
        : (tenant.balanceConfirmationConfig?.defaultAuditorGroupEmail || 'auditor@example.com');
      const auditorEmails = rawAuditorEmails.split(/[,;\s]+/).filter(Boolean).join(', ');

      const clientApEmail = confirmation.clientApEmail || matchingPlant?.apEmail || confirmation.initiatorEmail || tenant.balanceConfirmationConfig?.defaultClientApEmail || 'ap@example.com';
      const plantUnitLines = [];
      if (unitName) plantUnitLines.push(`Unit: ${unitName}`);
      if (plantAddress) plantUnitLines.push(plantAddress);
      const plantUnitAddress = plantUnitLines.length > 0 ? plantUnitLines.join('\n') : (regdOffice || companyLegalName);

      const p1 = `${narrativeObj.narrative} Please confirm whether this agrees with your records by signing and returning this letter or confirming by e-mail directly to our statutory auditors, ${auditorName} with a copy of the same to us. The balance confirmation is required for audit purpose for the compliance of SA 505 on "External Confirmations".`;

      const p2 = `However, if you find any difference, please report details in the space provided below.`;

      const p3 = `It is requested to confirm the balance within ten days of the date of this letter. In case, if, the balances are not confirmed within a period of 10 days, it will be presumed that the same matches with your books of account.`;

      doc.fontSize(8.5).font('Helvetica')
        .text(p1, 40, narrativeY, { width: 515, align: 'justify', lineGap: 3 });

      const p2Y = doc.y + 6;
      doc.text(p2, 40, p2Y, { width: 515 });

      const p3Y = doc.y + 6;
      doc.text(p3, 40, p3Y, { width: 515, align: 'justify', lineGap: 2 });

      // ── 6. Two-Column Contact Box ────────────────────────────────────────
      const boxY = doc.y + 10;
      const colWidth = 257.5;
      const boxHeight = 115;

      // Outer bounding box and divider
      doc.rect(40, boxY, 515, boxHeight).stroke('#334155');
      doc.moveTo(40 + colWidth, boxY).lineTo(40 + colWidth, boxY + boxHeight).stroke('#334155');

      // Left Column: Statutory Auditors
      doc.fontSize(8.5).font('Helvetica-Bold')
        .text('Address of the Statutory Auditors', 46, boxY + 6, { underline: true, width: colWidth - 12 });
      doc.font('Helvetica-Bold').fontSize(8)
        .text(auditorName, 46, boxY + 18)
        .font('Helvetica')
        .text(auditorAddress, 46, boxY + 30, { width: colWidth - 12, lineGap: 1.5 });
      const auditorEmailY = Math.max(doc.y + 4, boxY + 70);
      doc.text(`Email Id - ${auditorEmails}`, 46, auditorEmailY, { width: colWidth - 12 });

      // Right Column: Client Company Unit & Plant Address
      doc.fontSize(8.5).font('Helvetica-Bold')
        .text(`Address of ${companyLegalName}`, 40 + colWidth + 6, boxY + 6, { underline: true, width: colWidth - 12 });
      doc.font('Helvetica').fontSize(8)
        .text(plantUnitAddress, 40 + colWidth + 6, boxY + 18, { width: colWidth - 12, lineGap: 1.5 });

      const clientEmailY = Math.max(doc.y + 4, boxY + 60);
      doc.text(`Email Id - ${clientApEmail}`, 40 + colWidth + 6, clientEmailY, { width: colWidth - 12 })
        .font('Helvetica-Bold')
        .text(`For ${companyLegalName}`, 40 + colWidth + 6, boxY + 78, { align: 'right', width: colWidth - 16 })
        .font('Helvetica')
        .text('[....................................................]', 40 + colWidth + 6, boxY + 89, { align: 'right', width: colWidth - 16 })
        .font('Helvetica-Bold')
        .text(signatoryTitle, 40 + colWidth + 6, boxY + 98, { align: 'right', width: colWidth - 16 });

      // ── 7. Vendor Confirmation & Sign-Off Section ────────────────────────
      const signY = boxY + boxHeight + 14;
      const isConfirmed = confirmation.status === 'CONFIRMED' || confirmation.status === 'PRESUMED_CONFIRMED' || (confirmation.status === 'RECONCILED' && !confirmation.differenceAmount);
      const isDisputed = confirmation.status === 'DISPUTED' || (confirmation.differenceAmount && confirmation.differenceAmount !== 0);
      const hasResponse = isConfirmed || isDisputed || Boolean(options.sealed);

      if (hasResponse && isConfirmed) {
        doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#059669')
          .text('[ X ]  The above amount is correct (Confirmed by Vendor).', 40, signY);

        doc.fontSize(8.5).font('Helvetica').fillColor('#94a3b8')
          .text('[    ]  The above amount is incorrect for the following reasons: N/A - Agreed without variance', 40, signY + 16, { width: 515 });

        const vendorSigY = signY + 38;
        doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(8.5)
          .text(`For ${(confirmation.vendorName || 'Vendor').toUpperCase()}`, 250, vendorSigY, { align: 'right', width: 305 })
          .font('Helvetica').fontSize(8)
          .text(`Digitally Signed by: ${confirmation.signatoryName || 'Authorized Signatory'}`, 250, vendorSigY + 13, { align: 'right', width: 305 })
          .text(`Designation: ${confirmation.signatoryDesignation || 'Finance / Accounts'}`, 250, vendorSigY + 24, { align: 'right', width: 305 })
          .text(`Date & Time: ${formatDate(confirmation.actionTimestamp || confirmation.confirmedAt || confirmation.updatedAt || new Date())}`, 250, vendorSigY + 35, { align: 'right', width: 305 })
          .fillColor('#059669')
          .text(`[Electronically Authenticated & Sealed • IP: ${confirmation.signatoryIp || 'Portal Verified'}]`, 250, vendorSigY + 46, { align: 'right', width: 305 });
      } else if (hasResponse && isDisputed) {
        doc.fontSize(8.5).font('Helvetica').fillColor('#94a3b8')
          .text('[    ]  The above amount is correct.', 40, signY);

        doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#dc2626')
          .text('[ X ]  The above amount is incorrect for the following reasons:', 40, signY + 16, { width: 515 });

        doc.fontSize(8).font('Helvetica').fillColor('#0f172a')
          .text(`Reason: ${confirmation.disputeReason || 'Discrepancy reported by vendor in stated balance'}`, 55, signY + 29, { width: 500 })
          .text(`Vendor Stated Balance: Rs. ${formatINR(confirmation.vendorStatedBalance || 0)}  |  Variance: Rs. ${formatINR(confirmation.differenceAmount || 0)}`, 55, signY + 40, { width: 500 });

        const vendorSigY = signY + 54;
        doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(8.5)
          .text(`For ${(confirmation.vendorName || 'Vendor').toUpperCase()}`, 250, vendorSigY, { align: 'right', width: 305 })
          .font('Helvetica').fontSize(8)
          .text(`Reported by: ${confirmation.signatoryName || 'Authorized Signatory'}`, 250, vendorSigY + 13, { align: 'right', width: 305 })
          .text(`Designation: ${confirmation.signatoryDesignation || 'Finance / Accounts'}`, 250, vendorSigY + 24, { align: 'right', width: 305 })
          .text(`Date & Time: ${formatDate(confirmation.actionTimestamp || confirmation.updatedAt || new Date())}`, 250, vendorSigY + 35, { align: 'right', width: 305 })
          .fillColor('#dc2626')
          .text(`[Dispute Recorded & Logged • IP: ${confirmation.signatoryIp || 'Portal Recorded'}]`, 250, vendorSigY + 46, { align: 'right', width: 305 });
      } else {
        // Pending dispatch / blank letter for vendor signature
        doc.fillColor('#0f172a').fontSize(8.5).font('Helvetica')
          .text('[    ]  The above amount is correct.', 40, signY);

        doc.text('[    ]  The above amount is incorrect for the following reasons: ____________________________________________________', 40, signY + 16, { width: 515 });
        doc.text('         ____________________________________________________________________________________________________________', 40, signY + 28, { width: 515 });

        const vendorSigY = signY + 50;
        doc.text(`For ${confirmation.vendorName || 'Vendor'}`, 280, vendorSigY, { align: 'right', width: 275 })
          .text('[................................................................]', 280, vendorSigY + 14, { align: 'right', width: 275 })
          .font('Helvetica-Bold')
          .text('Authorized Signatory', 280, vendorSigY + 24, { align: 'right', width: 275 })
          .font('Helvetica')
          .text('Date: ....................................', 280, vendorSigY + 40, { align: 'right', width: 275 });
      }

      if (confirmation.status === 'RECONCILED') {
        const reconY = 725;
        doc.rect(40, reconY, 515, 24).fill('#f0fdf4');
        doc.rect(40, reconY, 515, 24).stroke('#86efac');
        doc.fillColor('#15803d').fontSize(8).font('Helvetica-Bold')
          .text(`STATUS: RECONCILED & CLOSED  •  Notes: ${confirmation.reconciliationNotes || 'Verified with vendor ledger by AP Team'}`, 48, reconY + 7, { width: 499 });
      }

      // ── 8. System Footer ────────────────────────────────────────────────
      doc.fillColor('#64748b').fontSize(7.5).font('Helvetica')
        .text('THIS IS AN OFFICIAL COMPUTER-GENERATED BALANCE CONFIRMATION DOCUMENT ISSUED IN COMPLIANCE WITH ICAI SA 505.', 40, 780, { align: 'center', width: 515 });

      doc.end();

      writeStream.on('finish', () => {
        const cleanRelative = path.join('uploads', String(confirmation.tenantId || 'default'), filename).replace(/\\/g, '/');
        resolve(cleanRelative);
      });

      writeStream.on('error', (err) => {
        reject(err);
      });
    } catch (err) {
      reject(err);
    }
  });
};

module.exports = {
  fetchAndDeriveVendorBalance,
  fetchVendorContactFromSap,
  generateAuditCertificatePDF,
  generateCreditorBalanceConfirmationLetterPDF,
  getBalanceNarrative,
  formatINR,
  formatDate,
};
