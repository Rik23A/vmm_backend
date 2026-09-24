const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const Tenant = require('../models/Tenant');
const AuditLog = require('../models/AuditLog');
const { requireLogin, requireRole } = require('../middleware/auth');
const { injectTenant, getSapConfig } = require('../middleware/tenant');
const { fetchCsrfToken, getVendorFromSAP } = require('../utils/sapBridge');
const { sendEmail } = require('../utils/email');


// ── GET /api/admin/users ────────────────────────────────────────────
router.get('/users', requireLogin, requireRole('ADMIN', 'L1_APPROVER'), async (req, res, next) => {
  try {
    const { search, role, isActive } = req.query;
    const query = { tenantId: req.tenantId };
    if (req.user.role === 'L1_APPROVER') {
      query.createdBy = req.user._id;
    }
    if (role) query.role = role;
    if (isActive !== undefined) query.isActive = isActive === 'true';
    if (search) query.$or = [
      { fullName: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
    ];
    const users = await User.find(query).sort({ createdAt: -1 });
    res.json({ users });
  } catch (err) { next(err); }
});

// ── POST /api/admin/users ───────────────────────────────────────────
router.post('/users', requireLogin, injectTenant, requireRole('ADMIN', 'L1_APPROVER'), [
  body('fullName').trim().notEmpty().withMessage('Full name is required'),
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }).withMessage('Password min 8 chars'),
  body('role').trim().notEmpty().withMessage('Role is required'),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { fullName, email, password, role, plants, sapVendorNumber } = req.body;
    if (req.user.role === 'L1_APPROVER' && role !== 'REQUESTOR') {
      return res.status(403).json({ message: 'L1 Approvers can only create Requestor (vendor) accounts' });
    }
    const exists = await User.findOne({ email, tenantId: req.tenantId });
    if (exists) return res.status(409).json({ message: 'User with this email already exists' });

    // Validate SAP vendor number if provided (for REQUESTOR role)
    if (role === 'REQUESTOR' && sapVendorNumber) {
      const sapConfig = getSapConfig(req.tenant);
      if (sapConfig.sapVersion !== 'STUB') {
        try {
          const sapVendor = await getVendorFromSAP(sapVendorNumber, sapConfig);
          if (!sapVendor) {
            return res.status(400).json({ message: `Vendor '${sapVendorNumber}' not found in SAP` });
          }
        } catch (err) {
          return res.status(400).json({ message: `Failed to verify vendor with SAP: ${err.message}` });
        }
      }
    }

    const user = await User.create({
      fullName,
      email,
      password,
      role,
      tenantId: req.tenantId,
      createdBy: req.user._id,
      plants: plants || [],
      sapVendorNumber: role === 'REQUESTOR' ? sapVendorNumber : null,
    });
    await AuditLog.log({ tenantId: req.tenantId, action: 'USER_CREATED',
      performedBy: req.user._id, performedByName: req.user.fullName,
      changes: [
        { field: 'email', newValue: email },
        { field: 'role', newValue: role },
        { field: 'plants', newValue: JSON.stringify(plants) },
        { field: 'sapVendorNumber', newValue: sapVendorNumber }
      ],
    });

    // Send onboarding email with credentials (asynchronously so HTTP endpoint does not block)
    sendEmail({
      to: email,
      templateName: 'USER_ONBOARDING',
      templateData: {
        fullName,
        tenantId: req.tenantId,
        email,
        password,
      },
      replyTo: req.user.email,
    }).catch(err => console.error('[User Onboarding Email Error]', err));

    res.status(201).json({ message: 'User created', user: user.toJSON() });
  } catch (err) { next(err); }
});

// ── PATCH /api/admin/users/:id ─────────────────────────────────────
router.patch('/users/:id', requireLogin, requireRole('ADMIN', 'L1_APPROVER'), async (req, res, next) => {
  try {
    const user = await User.findOne({ _id: req.params.id, tenantId: req.tenantId });
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (req.user.role === 'L1_APPROVER') {
      if (user.role !== 'REQUESTOR' || !user.createdBy || user.createdBy.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: 'You are not authorized to modify this user' });
      }
      if (req.body.role && req.body.role !== 'REQUESTOR') {
        return res.status(403).json({ message: 'L1 Approvers can only set role to REQUESTOR' });
      }
    }
    if (user._id.toString() === req.user._id.toString()) {
      return res.status(400).json({ message: 'You cannot modify your own account here' });
    }

    if (req.body.email && req.body.email.trim().toLowerCase() !== user.email.toLowerCase()) {
      const newEmail = req.body.email.trim().toLowerCase();
      const exists = await User.findOne({ email: newEmail, tenantId: req.tenantId, _id: { $ne: user._id } });
      if (exists) {
        return res.status(409).json({ message: 'A user with this email address already exists.' });
      }
    }

    const changes = [];
    ['isActive', 'role', 'fullName', 'email', 'plants'].forEach(field => {
      if (req.body[field] !== undefined) {
        if (field === 'plants') {
          changes.push({ field, oldValue: JSON.stringify(user.plants), newValue: JSON.stringify(req.body[field]) });
        } else {
          changes.push({ field, oldValue: user[field], newValue: req.body[field] });
        }
        user[field] = req.body[field];
      }
    });
    if (req.body.password) { user.password = req.body.password; changes.push({ field: 'password', newValue: '[changed]' }); }
    await user.save();
    const action = req.body.isActive === false ? 'USER_DEACTIVATED' : req.body.role ? 'USER_ROLE_CHANGED' : 'USER_UPDATED';
    await AuditLog.log({ tenantId: req.tenantId, action, performedBy: req.user._id, performedByName: req.user.fullName, changes });
    res.json({ message: 'User updated', user: user.toJSON() });
  } catch (err) { next(err); }
});

// ── DELETE /api/admin/users/:id ────────────────────────────────────
router.delete('/users/:id', requireLogin, requireRole('ADMIN', 'L1_APPROVER'), async (req, res, next) => {
  try {
    const user = await User.findOne({ _id: req.params.id, tenantId: req.tenantId });
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (req.user.role === 'L1_APPROVER') {
      if (user.role !== 'REQUESTOR' || !user.createdBy || user.createdBy.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: 'You are not authorized to delete this user' });
      }
    }
    if (user._id.toString() === req.user._id.toString()) {
      return res.status(400).json({ message: 'You cannot delete your own account' });
    }

    await User.deleteOne({ _id: user._id });

    await AuditLog.log({
      tenantId: req.tenantId,
      action: 'USER_DELETED',
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      changes: [
        { field: 'email', oldValue: user.email },
        { field: 'fullName', oldValue: user.fullName },
        { field: 'role', oldValue: user.role }
      ]
    });

    res.json({ message: 'User deleted successfully' });
  } catch (err) { next(err); }
});

// ── GET /api/admin/settings ─────────────────────────────────────────
router.get('/settings', requireLogin, requireRole('ADMIN', 'L1_APPROVER'), async (req, res, next) => {
  try {
    const tenant = await Tenant.findOne({ tenantId: req.tenantId }).select('+geminiConfig.geminiApiKey');
    if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
    const safeTenant = tenant.toObject();
    if (safeTenant.sapConfig) delete safeTenant.sapConfig.sapPassword;
    if (safeTenant.emailConfig) delete safeTenant.emailConfig.emailPass;
    if (safeTenant.geminiConfig) {
      safeTenant.geminiConfig.geminiApiKey = safeTenant.geminiConfig.geminiApiKey ? '••••••••••••••••' : '';
    }
    res.json({ settings: safeTenant });
  } catch (err) { next(err); }
});

// ── PUT /api/admin/settings ─────────────────────────────────────────
router.put('/settings', requireLogin, requireRole('ADMIN'), async (req, res, next) => {
  try {
    const tenant = await Tenant.findOne({ tenantId: req.tenantId }).select('+sapConfig.sapPassword +emailConfig.emailPass +geminiConfig.geminiApiKey');
    if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
    const changes = [];
    const allowedFields = [
      'sapConfig', 'emailConfig', 'workflowConfig', 'geminiConfig',
      'companyName', 'regdOfficeAddress', 'cin', 'phone', 'fax', 'website',
      'companyEntities', 'plants', 'balanceConfirmationConfig', 'modules'
    ];
    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        if (typeof req.body[field] === 'object' && !Array.isArray(req.body[field]) && req.body[field] !== null) {
          if (!tenant[field]) tenant[field] = {};
          Object.keys(req.body[field]).forEach(k => {
            if (['sapPassword', 'emailPass', 'geminiApiKey'].includes(k)) {
              // Only update password/API key if a new one is provided (not empty and not masked placeholder)
              if (req.body[field][k] && req.body[field][k].trim() !== '' && !req.body[field][k].includes('••')) {
                tenant[field][k] = req.body[field][k];
                changes.push({ field: `${field}.${k}`, newValue: '[CHANGED]' });
                console.log(`🔐 [Settings] ${field}.${k} updated for tenant ${req.tenantId}`);
              } else {
                console.log(`ℹ️  [Settings] ${field}.${k} was empty or placeholder — keeping existing stored value`);
              }
            } else {
              changes.push({ field: `${field}.${k}`, oldValue: tenant[field]?.[k], newValue: req.body[field][k] });
              if (tenant[field]) tenant[field][k] = req.body[field][k];
            }
          });
        } else {
          changes.push({ field, oldValue: tenant[field], newValue: req.body[field] });
          tenant[field] = req.body[field];
        }
      }
    });

    if (tenant.geminiConfig && tenant.geminiConfig.primaryModel) {
      tenant.geminiConfig.geminiModel = tenant.geminiConfig.primaryModel;
    }

    // Diagnostic: log whether SAP password is stored in DB after save
    const pwStored = !!(tenant.sapConfig?.sapPassword?.trim());
    console.log(`🔍 [Settings] SAP password stored in DB after save: ${pwStored ? 'YES ✅' : 'NO ❌ — password was never set or is blank!'}`);
    console.log(`🔍 [Settings] SAP user: ${tenant.sapConfig?.sapUser || '(empty)'}, OData URL: ${tenant.sapConfig?.sapOdataUrl || '(empty)'}`);

    tenant.markModified('sapConfig');
    tenant.markModified('sapConfig.bpGroupings');
    tenant.markModified('sapConfig.legalForms');
    tenant.markModified('emailConfig');
    tenant.markModified('workflowConfig');
    tenant.markModified('geminiConfig');
    tenant.markModified('plants');
    tenant.markModified('companyEntities');
    tenant.markModified('balanceConfirmationConfig');
    tenant.markModified('modules');
    await tenant.save();
    await AuditLog.log({ tenantId: req.tenantId, action: 'TENANT_SETTINGS_CHANGED',
      performedBy: req.user._id, performedByName: req.user.fullName, changes });
    const safeTenant = tenant.toObject();
    if (safeTenant.sapConfig) delete safeTenant.sapConfig.sapPassword;
    if (safeTenant.emailConfig) delete safeTenant.emailConfig.emailPass;
    if (safeTenant.geminiConfig) {
      safeTenant.geminiConfig.geminiApiKey = safeTenant.geminiConfig.geminiApiKey ? '••••••••••••••••' : '';
    }
    res.json({ message: 'Settings updated', settings: safeTenant });
  } catch (err) { next(err); }
});

// ── POST /api/admin/settings/test-sap ──────────────────────────────────────
// Verifies SAP credentials & connectivity by fetching a CSRF token from $metadata.
// Returns whether auth and network are working without making any data changes.
router.post('/settings/test-sap', requireLogin, requireRole('ADMIN'), injectTenant, async (req, res, next) => {
  try {
    const sapConfig = getSapConfig(req.tenant);

    // Diagnostic: log what credentials are being used
    console.log(`🧪 [Test SAP] user=${sapConfig.sapUser || '(empty)'}, hasPassword=${!!(sapConfig.sapPassword?.trim())}, url=${sapConfig.sapOdataUrl || '(empty)'}, client=${sapConfig.sapClient}, version=${sapConfig.sapVersion}`);

    if (sapConfig.sapVersion === 'STUB') {
      return res.json({ ok: true, message: 'SAP mode is STUB — no real connection needed.', version: 'STUB' });
    }

    if (!sapConfig.sapUser || !sapConfig.sapPassword?.trim()) {
      return res.status(400).json({
        ok: false,
        message: 'SAP credentials are not configured. Please enter the SAP User and Password in Settings and save first.',
      });
    }

    if (!sapConfig.sapOdataUrl) {
      return res.status(400).json({ ok: false, message: 'OData Base URL is not configured in Settings.' });
    }

    // Attempt CSRF token fetch — this authenticates and proves the connection works
    const token = await fetchCsrfToken(sapConfig);
    console.log(`✅ [Test SAP] CSRF token received — connection successful!`);

    res.json({
      ok: true,
      message: `✅ SAP connection successful! CSRF token received. User '${sapConfig.sapUser}' is authenticated on client ${sapConfig.sapClient}.`,
      version: sapConfig.sapVersion,
    });
  } catch (err) {
    const status = err.status || 500;
    console.error(`❌ [Test SAP] Connection test failed:`, err.message);
    res.status(200).json({
      ok: false,
      message: `❌ SAP connection failed: ${err.message}`,
      hint: err.message.includes('401') || err.message.includes('Authentication')
        ? 'Incorrect username or password. Verify credentials and that the SAP user is not locked.'
        : err.message.includes('ECONNREFUSED') || err.message.includes('Network')
        ? 'Network unreachable. Check the SAP host/port and VPN/firewall.'
        : 'Check backend console logs for details.',
    });
  }
});

// ── GET /api/admin/workflow-settings ────────────────────────────────
router.get('/workflow-settings', requireLogin, requireRole('ADMIN'), async (req, res, next) => {
  try {
    const ApprovalSettings = require('../models/ApprovalSettings');
    const plant = req.query.plant || 'DEFAULT';
    let settings = await ApprovalSettings.findOne({ tenantId: req.tenantId, plant });
    if (!settings) {
      // Create defaults
      settings = await ApprovalSettings.create({
        tenantId: req.tenantId,
        plant,
        steps: ApprovalSettings.getDefaultSteps(),
      });
    }
    res.json({ settings });
  } catch (err) { next(err); }
});

// ── PUT /api/admin/workflow-settings ────────────────────────────────
router.put('/workflow-settings', requireLogin, requireRole('ADMIN'), async (req, res, next) => {
  try {
    const ApprovalSettings = require('../models/ApprovalSettings');
    const { steps, plant } = req.body;
    const targetPlant = plant || 'DEFAULT';
    if (!Array.isArray(steps) || steps.length === 0) {
      return res.status(400).json({ message: 'Steps must be a non-empty array' });
    }

    // Validate steps format
    const CustomRole = require('../models/CustomRole');
    const customRoles = await CustomRole.find({ tenantId: req.tenantId });
    const allowedRoles = [
      'L1_APPROVER', 'L2_APPROVER', 'MASTER_DATA', 'ADMIN', 'REQUESTOR',
      ...customRoles.map(cr => cr.name)
    ];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step.role || !allowedRoles.includes(step.role)) {
        return res.status(400).json({ message: `Step ${i + 1} has an invalid role` });
      }
      if (!step.levelLabel || step.levelLabel.trim() === '') {
        return res.status(400).json({ message: `Step ${i + 1} has an empty label` });
      }
      step.sequence = i + 1; // set sequence automatically based on array order
    }

    let settings = await ApprovalSettings.findOne({ tenantId: req.tenantId, plant: targetPlant });
    if (!settings) {
      settings = new ApprovalSettings({ tenantId: req.tenantId, plant: targetPlant });
    }
    settings.steps = steps;
    await settings.save();

    await AuditLog.log({
      tenantId: req.tenantId,
      action: 'WORKFLOW_SETTINGS_CHANGED',
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      changes: [{ field: `steps.${targetPlant}`, newValue: JSON.stringify(steps) }],
    });

    res.json({ message: 'Workflow settings updated successfully', settings });
  } catch (err) { next(err); }
});

// ── GET /api/admin/roles ────────────────────────────────────────────
// Returns both standard system roles and dynamic tenant-specific roles
router.get('/roles', requireLogin, requireRole('ADMIN', 'L1_APPROVER'), async (req, res, next) => {
  try {
    const CustomRole = require('../models/CustomRole');
    const customRoles = await CustomRole.find({ tenantId: req.tenantId }).sort({ createdAt: 1 });
    
    const defaults = [
      { name: 'REQUESTOR', label: 'Requestor', isSystem: true },
      { name: 'L1_APPROVER', label: 'L1 Approver', isSystem: true },
      { name: 'L2_APPROVER', label: 'L2 Approver', isSystem: true },
      { name: 'MASTER_DATA', label: 'Master Data Team', isSystem: true },
      { name: 'ADMIN', label: 'Admin', isSystem: true }
    ];

    const roles = [
      ...defaults,
      ...customRoles.map(cr => ({ _id: cr._id, name: cr.name, label: cr.label, isSystem: false }))
    ];
    res.json({ roles });
  } catch (err) { next(err); }
});

// ── POST /api/admin/roles ───────────────────────────────────────────
router.post('/roles', requireLogin, requireRole('ADMIN'), [
  body('name').trim().toUpperCase().notEmpty().withMessage('Role name is required'),
  body('label').trim().notEmpty().withMessage('Role label is required')
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const CustomRole = require('../models/CustomRole');
    const { name, label } = req.body;

    // Prevent overriding system roles
    const systemRoles = ['REQUESTOR', 'L1_APPROVER', 'L2_APPROVER', 'MASTER_DATA', 'ADMIN'];
    if (systemRoles.includes(name)) {
      return res.status(400).json({ message: 'Cannot create a custom role with a system role name' });
    }

    const exists = await CustomRole.findOne({ name, tenantId: req.tenantId });
    if (exists) return res.status(409).json({ message: 'Role with this name already exists' });

    const customRole = await CustomRole.create({ name, label, tenantId: req.tenantId });

    await AuditLog.log({
      tenantId: req.tenantId,
      action: 'CUSTOM_ROLE_CREATED',
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      changes: [{ field: 'name', newValue: name }, { field: 'label', newValue: label }]
    });

    res.status(201).json({ message: 'Custom role created', role: customRole });
  } catch (err) { next(err); }
});

// ── DELETE /api/admin/roles/:id ──────────────────────────────────────
router.delete('/roles/:id', requireLogin, requireRole('ADMIN'), async (req, res, next) => {
  try {
    const CustomRole = require('../models/CustomRole');
    const customRole = await CustomRole.findOne({ _id: req.params.id, tenantId: req.tenantId });
    if (!customRole) return res.status(404).json({ message: 'Custom role not found' });

    // Check if any user is currently assigned this role before deleting
    const assignedUsers = await User.countDocuments({ role: customRole.name, tenantId: req.tenantId });
    if (assignedUsers > 0) {
      return res.status(400).json({ message: `Cannot delete role. There are ${assignedUsers} user(s) currently assigned to it.` });
    }

    await CustomRole.deleteOne({ _id: customRole._id });

    await AuditLog.log({
      tenantId: req.tenantId,
      action: 'CUSTOM_ROLE_DELETED',
      performedBy: req.user._id,
      performedByName: req.user.fullName,
      changes: [{ field: 'name', oldValue: customRole.name }]
    });

    res.json({ message: 'Custom role deleted successfully' });
  } catch (err) { next(err); }
});

module.exports = router;
