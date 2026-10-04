// @ts-check
/**
 * Analysis History Service
 *
 * Main export for the decomposed AnalysisHistoryService.
 * Provides backward-compatible API.
 *
 * @module analysisHistory
 */

const AnalysisHistoryServiceCore = require('./AnalysisHistoryServiceCore');

// Re-export the core class as AnalysisHistoryService for backward compatibility
module.exports = AnalysisHistoryServiceCore;
