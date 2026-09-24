'use strict';

/**
 * Module Entitlement & Licensing Helper — utils/moduleHelper.js
 *
 * Handles dual-mode governance:
 * 1. TENANT_MODE=SINGLE (Enterprise On-Prem / Dedicated VPC):
 *    Modules are read from process.env.ENABLED_MODULES (e.g. "VENDOR_MASTER,VENDOR_BALANCE_CONFIRMATION").
 * 2. TENANT_MODE=MULTI (Cloud SaaS):
 *    Modules are read from tenant.modules in MongoDB, controlled dynamically by Super Admin.
 */

const parseEnvModules = () => {
  const raw = process.env.ENABLED_MODULES || '';
  return raw
    .split(',')
    .map(m => m.trim().toUpperCase())
    .filter(Boolean);
};

/**
 * Resolves the effective module state for a tenant
 * @param {Object} tenant - Tenant document or object
 * @returns {Object} map of module keys to boolean
 */
const getEffectiveModules = (tenant) => {
  const isSingleTenant = (process.env.TENANT_MODE || 'MULTI').toUpperCase() === 'SINGLE';

  if (isSingleTenant) {
    const envList = parseEnvModules();
    // If ENABLED_MODULES is explicitly declared in .env:
    if (envList.length > 0) {
      const hasBalance = envList.includes('VENDOR_BALANCE_CONFIRMATION') || envList.includes('BALANCE_CONFIRMATION');
      const hasVendor = envList.includes('VENDOR_MASTER') || envList.includes('VMM');
      const hasCustomer = envList.includes('CUSTOMER_MASTER') || envList.includes('CUSTOMER');
      return {
        vendorMaster: hasVendor,
        balanceConfirmation: hasBalance,
        vendorBalanceConfirmation: hasBalance,
        customerMaster: hasCustomer,
      };
    }

    // Default for single tenant if env var is unset
    return {
      vendorMaster: true,
      balanceConfirmation: true,
      vendorBalanceConfirmation: true,
      customerMaster: false,
    };
  }

  // Multi-tenant mode (SaaS): read from database tenant document
  const tm = tenant?.modules || {};
  const hasBalance = Boolean(tm.balanceConfirmation || tm.vendorBalanceConfirmation);
  const hasVendor = tm.vendorMaster !== false; // enabled by default
  const hasCustomer = Boolean(tm.customerMaster);

  return {
    vendorMaster: hasVendor,
    balanceConfirmation: hasBalance,
    vendorBalanceConfirmation: hasBalance,
    customerMaster: hasCustomer,
  };
};

/**
 * Checks if a specific module is enabled for a tenant
 * @param {Object} tenant - Tenant document or object
 * @param {string} moduleName - Module identifier, e.g. "balanceConfirmation" or "VENDOR_BALANCE_CONFIRMATION"
 * @returns {boolean}
 */
const isModuleEnabled = (tenant, moduleName) => {
  if (!moduleName) return true;
  const effective = getEffectiveModules(tenant);

  const clean = String(moduleName).trim();
  const upper = clean.toUpperCase();

  if (upper === 'VENDOR_BALANCE_CONFIRMATION' || upper === 'BALANCE_CONFIRMATION' || clean === 'balanceConfirmation' || clean === 'vendorBalanceConfirmation') {
    return Boolean(effective.balanceConfirmation);
  }

  if (upper === 'VENDOR_MASTER' || clean === 'vendorMaster') {
    return Boolean(effective.vendorMaster);
  }

  if (upper === 'CUSTOMER_MASTER' || clean === 'customerMaster') {
    return Boolean(effective.customerMaster);
  }

  return Boolean(effective[clean]);
};

module.exports = {
  getEffectiveModules,
  isModuleEnabled,
  parseEnvModules,
};
