// Barrel: this file is a thin re-export of src/lib/api/*.js. It exists so every existing
// `from '../lib/api'` (or similar relative path) import keeps working unchanged after the
// module was split into per-domain files — see docs/superpowers/plans/2026-08-21-api-modularization.md.
export {
  hasSupabase,
  allowDemoMode,
  mapDayEndRow,
  formatProductCode,
  mapProduct,
  fetchStaffIdentities,
  mapTransaction,
  approverLabel,
} from './api/shared.js'

export {
  pingBackend,
  hasAuthSession,
  fetchSessionStaff,
  signIn,
  signInWithPin,
  verifySupervisorPin,
  fetchSupervisorPinVerifiers,
  saveStaffPinVerifier,
  logApprovalEventRemote,
  signOut,
  claimStaffSession,
  heartbeatStaffSession,
  releaseStaffSession,
  isSessionRevokedError,
  setManagerUnlockSecret,
  clearManagerUnlockSecret,
  verifyAccountPassword,
  verifyOwnPin,
  getOrCreateDeviceSessionId,
  clearDeviceSessionId,
} from './api/auth.js'

export {
  bootstrapPosCatalog,
  bootstrapBranchActivity,
  bootstrapBranchData,
  bootstrapBranchInventory,
  fetchBranchProducts,
  fetchCatalogProducts,
  createCatalogProduct,
  commitCatalogImport,
  updateCatalogProduct,
  cascadeDiscountEligibleToBranches,
  resyncDiscountEligibleToBranches,
  cascadeCatalogFieldsToBranches,
  adoptCatalogProducts,
  createProduct,
  updateProductRow,
  setProductActive,
  deleteProduct,
  fetchInactiveBranchProducts,
  setMenuAvailableToday,
  updateProductPrice,
  recordPriceChange,
  fetchPriceHistory,
} from './api/catalog.js'

export {
  mapMovement,
  MOVEMENT_TYPES,
  fetchStockMovements,
  setInventoryStock,
  adjustStock,
  fetchInventoryReport,
} from './api/inventory.js'

export {
  findRecentImportByHash,
  fetchImportBatches,
  fetchImportBatchItems,
  commitInventoryImport,
  revertInventoryImport,
  requestImportRevert,
  dismissImportRevertRequest,
} from './api/inventoryImport.js'

export {
  loadTransactionByClientId,
  fetchEarliestTransactionDate,
  completeSale,
  fetchTransactionDetail,
  voidSale,
  refundSaleItems,
  requestRefundApproval,
  approveRefundRequest,
  rejectRefundRequest,
  cancelRefundRequest,
  dismissPendingRefundRequestsForTransaction,
  fetchRefundRequestById,
  fetchRefundRequests,
  fetchRefundSummary,
  fetchRefundedQuantities,
} from './api/sales.js'

export {
  createTillActionRequest,
  resolveTillActionRequest,
  dismissPendingTillActionsOnSite,
  fetchTillActionRequestById,
  fetchCartRemoveReport,
  fetchPendingTillActionRequests,
} from './api/till.js'

export { fetchPendingApprovals, dismissNotificationItem } from './api/approvals.js'

export {
  fetchAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  markAnnouncementsSeen,
} from './api/announcements.js'

export {
  clearResolvedDayEndRequest,
  submitDayEnd,
  approveDayEnd,
  closeDayEnd,
  reopenDayEnd,
  confirmDayEndHandoff,
  requestDayReopen,
  rejectDayEndRequest,
  requestDayEnd,
  fetchRecentDayEndStatuses,
} from './api/dayend.js'

export {
  composeTin,
  fetchCompanyProfile,
  saveCompanyProfile,
  fetchBranches,
  mapBranchFiscalHeader,
  fetchBranchFiscalHeader,
  reorderBranches,
  BRANCH_ONLINE_WINDOW_SEC,
  isBranchOnline,
  heartbeatBranch,
  fetchBranchDeviceSettings,
  reportBranchDevices,
  fetchBranchTelemetry,
  deviceSummary,
  saveBranch,
} from './api/branches.js'

export {
  fetchRoles,
  fetchStaffRoster,
  fetchAllStaff,
  fetchActiveSessions,
  forceReleaseStaffSession,
  releaseAllStaffSessions,
  createStaffAccount,
  updateStaffRow,
  revealStaffPin,
} from './api/staff.js'

export {
  mapShiftRow,
  openShift,
  closeShift,
  fetchShiftCashSummary,
  fetchOpenShiftOnDrawer,
  fetchOpenShiftsForBranch,
  fetchLastClosedShiftOnDrawer,
  adjustShiftCash,
  receiveShiftHandoff,
  fetchShiftAdjustments,
  clockIn,
  clockOut,
  fetchOpenShift,
  fetchStaffShifts,
} from './api/shifts.js'

export {
  CASH_DRAWER_TABLE,
  addPettyCash,
  recordChangeFund,
  CASH_MOVEMENT_COUNTING_STATUSES,
  createCashMovementApproved,
  createCashMovementPending,
  approveCashMovementPin,
  approveCashMovementManager,
  denyCashMovement,
  cancelCashMovement,
  selfRecordCashMovement,
  reviewCashMovement,
  resolveFlaggedCashMovement,
  fetchCashMovementById,
  fetchCashMovements,
  fetchPendingCashMovements,
  fetchPettyCash,
  fetchPettyCashTimeline,
  fetchBranchCashImpact,
} from './api/cash.js'

export {
  branchSummary,
  fetchManagerOverviewMetrics,
  fetchPeriodComparison,
  fetchNetworkDashboard,
  fetchSoldLineItems,
  fetchReportSalesDetail,
  fetchDailyReading,
  fetchBirDailyBreakdown,
  fetchScPwdReport,
  fetchDiscountReport,
  fetchTenderSummary,
  fetchElectronicJournal,
  fetchGrossMarginReport,
  fetchStockMovementReport,
  fetchShrinkageValue,
  fetchShrinkageReport,
  fetchPriceChangeReport,
  fetchCashHandoffReport,
  fetchTerminalReportSource,
  fetchFiscalBackup,
  fetchBranchSalesTotal,
  fetchNetworkSalesTotal,
} from './api/reports.js'

export {
  logAuditEvent,
  logApprovalEvent,
  fetchAuditEvents,
  fetchNotificationHistory,
  fetchSecurityAuditEvents,
  fetchSaleEvents,
} from './api/audit.js'

export {
  expireEndedPromos,
  promoHasEnded,
  promoEffectiveStatus,
  promoStatusBadge,
  fetchActivePromoEventsWithRules,
  fetchActivePromoEventWithRules,
  fetchPromoRulesForEvent,
  createAndActivatePromoEvent,
  approvePromoEvent,
  rejectPromoEvent,
  requestStopPromo,
  approveStopPromo,
  rejectStopPromo,
  fetchPromoSalesStatsSummary,
  fetchPromoSalesStats,
  fetchPromoRuleTypesForEvents,
  requestPromoEdit,
  createPromoWithRules,
  createPromoAcrossBranches,
  copyPromoEventToBranches,
  createPromoRule,
  updatePromoEventDetails,
  deletePromoRule,
  fetchPromoEventsForBranch,
  fetchActivePromosAcrossBranches,
  fetchPromoEventsAcrossBranches,
  deletePromoEvent,
} from './api/promos.js'
