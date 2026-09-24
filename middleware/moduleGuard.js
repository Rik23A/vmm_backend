'use strict';

const Tenant = require('../models/Tenant');
const { isModuleEnabled } = require('../utils/moduleHelper');

/**
 * Middleware: requireModule
 * Blocks requests if the requested module is not enabled for the tenant.
 * Supports both TENANT_MODE=SINGLE (.env ENABLED_MODULES) and TENANT_MODE=MULTI (DB tenant.modules).
 *
 * @param {string} moduleName - e.g. "balanceConfirmation" or "VENDOR_BALANCE_CONFIRMATION"
 */
const requireModule = (moduleName) => {
  return async (req, res, next) => {
    try {
      let tenant = req.tenant;

      if (!tenant && req.tenantId) {
        tenant = await Tenant.findOne({ tenantId: req.tenantId, isActive: true });
        if (tenant) {
          req.tenant = tenant;
        }
      }

      if (!isModuleEnabled(tenant, moduleName)) {
        return res.status(403).json({
          code: 'MODULE_NOT_ENTITLED',
          message: `The '${moduleName}' module is not enabled for your organization subscription. Contact your administrator or platform support.`,
          module: moduleName,
        });
      }

      next();
    } catch (err) {
      next(err);
    }
  };
};

module.exports = {
  requireModule,
};
