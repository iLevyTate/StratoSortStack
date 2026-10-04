// @ts-check
/**
 * Migration Services
 *
 * This module provides services for migrating settings and data schemas
 * in the in-process architecture.
 *
 * @module services/migration
 */

const {
  DataMigrationService,
  getInstance: getDataMigrationService,
  createInstance: createDataMigrationService,
  MIGRATION_STATUS
} = require('./DataMigrationService');

const {
  SettingsMigrator,
  getInstance: getSettingsMigrator,
  createInstance: createSettingsMigrator,
  CURRENT_SCHEMA_VERSION
} = require('./SettingsMigrator');

module.exports = {
  // Data migration
  DataMigrationService,
  getDataMigrationService,
  createDataMigrationService,
  MIGRATION_STATUS,

  // Settings migration
  SettingsMigrator,
  getSettingsMigrator,
  createSettingsMigrator,
  CURRENT_SCHEMA_VERSION
};
