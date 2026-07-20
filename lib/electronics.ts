/**
 * Validate battery_health_pct against the DB CHECK constraint:
 *   battery_health_pct IS NULL OR (battery_health_pct BETWEEN 0 AND 100)
 *
 * battery_health_pct is optional, so absence (null/undefined) is valid —
 * only a present-but-invalid value is rejected.
 */
export function validateBatteryHealthPct(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return false;
  }
  return value >= 0 && value <= 100 && Number.isInteger(value);
}

/**
 * Validate battery_cycle_count against the DB CHECK constraint:
 *   battery_cycle_count IS NULL OR battery_cycle_count >= 0
 *
 * battery_cycle_count is optional, so absence (null/undefined) is valid —
 * only a present-but-invalid value is rejected.
 */
export function validateBatteryCycleCount(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return false;
  }
  return value >= 0 && Number.isInteger(value);
}

/**
 * Validate ram_gb against the DB CHECK constraint:
 *   ram_gb IS NULL OR ram_gb > 0
 *
 * ram_gb is optional, so absence (null/undefined) is valid —
 * only a present-but-invalid value is rejected.
 */
export function validateRamGb(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return false;
  }
  return value > 0;
}

/**
 * Validate storage_gb against the DB CHECK constraint:
 *   storage_gb IS NULL OR storage_gb > 0
 *
 * storage_gb is optional, so absence (null/undefined) is valid —
 * only a present-but-invalid value is rejected.
 */
export function validateStorageGb(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return false;
  }
  return value > 0;
}

/**
 * Validate screen_size_in against the DB CHECK constraint:
 *   screen_size_in IS NULL OR screen_size_in > 0
 *
 * screen_size_in is optional, so absence (null/undefined) is valid —
 * only a present-but-invalid value is rejected.
 */
export function validateScreenSizeIn(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return false;
  }
  return value > 0;
}
