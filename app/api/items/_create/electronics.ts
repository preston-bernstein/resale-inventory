import { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import db from '@/lib/db';
import {
  validateBatteryHealthPct,
  validateBatteryCycleCount,
  validateRamGb,
  validateStorageGb,
  validateScreenSizeIn,
} from '@/lib/electronics';
import {
  insertBaseItemRow,
  invalidFieldsResponse,
  newBaseItemRow,
  type BaseItemRow,
  type SharedFields,
} from './shared';

interface ElectronicsFields {
  brand: string;
  model: string;
  processor: string | null;
  ram_gb: number | null;
  storage_gb: number | null;
  screen_size_in: number | null;
  battery_health_pct: number | null;
  battery_cycle_count: number | null;
}

/** A present-but-empty numeric field round-trips as null, same convention as clothing's optional measurements. */
function toOptionalNumber(value: unknown): number | null {
  return value === undefined || value === null ? null : (value as number);
}

/** Validate brand/model/processor — the free-text identity fields. */
function validateElectronicsIdentityFields(
  body: Record<string, unknown>,
  invalidFields: string[],
): { brand: string; model: string; processor: string | null } {
  const brand =
    typeof body.brand === 'string' && body.brand.trim() !== '' ? body.brand.trim() : '';
  if (!brand) invalidFields.push('brand');

  const model =
    typeof body.model === 'string' && body.model.trim() !== '' ? body.model.trim() : '';
  if (!model) invalidFields.push('model');

  const processor = typeof body.processor === 'string' ? body.processor.trim() || null : null;

  return { brand, model, processor };
}

/** Validate ram_gb/storage_gb/screen_size_in — the optional spec fields. */
function validateElectronicsSpecFields(
  body: Record<string, unknown>,
  invalidFields: string[],
): { ram_gb: number | null; storage_gb: number | null; screen_size_in: number | null } {
  if (!validateRamGb(body.ram_gb)) invalidFields.push('ram_gb');
  if (!validateStorageGb(body.storage_gb)) invalidFields.push('storage_gb');
  if (!validateScreenSizeIn(body.screen_size_in)) invalidFields.push('screen_size_in');

  return {
    ram_gb: toOptionalNumber(body.ram_gb),
    storage_gb: toOptionalNumber(body.storage_gb),
    screen_size_in: toOptionalNumber(body.screen_size_in),
  };
}

/** Validate battery_health_pct/battery_cycle_count — the optional battery fields. */
function validateElectronicsBatteryFields(
  body: Record<string, unknown>,
  invalidFields: string[],
): { battery_health_pct: number | null; battery_cycle_count: number | null } {
  if (!validateBatteryHealthPct(body.battery_health_pct)) {
    invalidFields.push('battery_health_pct');
  }
  if (!validateBatteryCycleCount(body.battery_cycle_count)) {
    invalidFields.push('battery_cycle_count');
  }

  return {
    battery_health_pct: toOptionalNumber(body.battery_health_pct),
    battery_cycle_count: toOptionalNumber(body.battery_cycle_count),
  };
}

/**
 * Validate electronics-only fields, appending to the shared `invalidFields`.
 * `condition` is already validated against ELECTRONICS_CONDITIONS by the
 * shared validateSharedFields() → conditionsForCategory('electronics') path,
 * mirroring how clothing's condition is validated (no separate per-category
 * condition check here). `device_type` is fixed to 'laptop' for this
 * increment and is never read from the request body — it's hardcoded at
 * insert time instead (see insertElectronicsRecord).
 */
function validateElectronicsFields(
  body: Record<string, unknown>,
  invalidFields: string[],
): ElectronicsFields {
  const identity = validateElectronicsIdentityFields(body, invalidFields);
  const specs = validateElectronicsSpecFields(body, invalidFields);
  const battery = validateElectronicsBatteryFields(body, invalidFields);

  return { ...identity, ...specs, ...battery };
}

/** Insert the items + electronics_details rows in a transaction. Errors propagate (→ outer 500), same as the clothing branch. */
function insertElectronicsRecord(
  item: BaseItemRow,
  fields: ElectronicsFields,
  condition: string,
): void {
  db.transaction(() => {
    insertBaseItemRow('electronics', item);

    // device_type is hardcoded to 'laptop' here (never read from the request
    // body) — see the comment on validateElectronicsFields.
    db.prepare(
      `INSERT INTO electronics_details
         (item_id, tenant_id, device_type, brand, model, processor, ram_gb, storage_gb,
          screen_size_in, battery_health_pct, battery_cycle_count, condition)
       VALUES (?, ?, 'laptop', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      item.id,
      item.tenantId,
      fields.brand,
      fields.model,
      fields.processor,
      fields.ram_gb,
      fields.storage_gb,
      fields.screen_size_in,
      fields.battery_health_pct,
      fields.battery_cycle_count,
      condition,
    );
  })();
}

function fetchElectronicsRow(id: string): Record<string, unknown> {
  return db
    .prepare(
      `SELECT i.*, ed.device_type, ed.brand, ed.model, ed.processor, ed.ram_gb, ed.storage_gb,
              ed.screen_size_in, ed.battery_health_pct, ed.battery_cycle_count, ed.condition
         FROM items i JOIN electronics_details ed ON ed.item_id = i.id
        WHERE i.id = ?`,
    )
    .get(id) as Record<string, unknown>;
}

export function handleElectronicsCreate(
  body: Record<string, unknown>,
  shared: SharedFields,
  tenantId: string,
): NextResponse {
  const fields = validateElectronicsFields(body, shared.invalidFields);

  const invalidResponse = invalidFieldsResponse(shared.invalidFields);
  if (invalidResponse) return invalidResponse;

  const id = uuidv4();
  insertElectronicsRecord(newBaseItemRow(id, tenantId, shared), fields, shared.condition as string);

  const row = fetchElectronicsRow(id);
  return NextResponse.json({ ...row }, { status: 201 });
}
