import { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import db from '@/lib/db';
import {
  validateWeightOz,
  validateMeasurement,
  validateSizeSystem,
  validateSizeAgainstSystem,
  CLOTHING_MEASUREMENT_FIELDS,
  type SizeSystem,
} from '@/lib/clothing';
import { resolveCanonicalBrand, validateBrandInput } from '@/lib/brands';
import { resolveCanonicalColor, validateColorInput } from '@/lib/colors';
import { resolveCanonicalMaterial, validateMaterialInput } from '@/lib/materials';
import { resolveCanonicalDepartment, validateDepartmentInput } from '@/lib/departments';
import {
  insertBaseItemRow,
  invalidFieldsResponse,
  newBaseItemRow,
  type BaseItemRow,
  type SharedFields,
} from './shared';

interface ClothingFields {
  brand: string;
  size_label: string;
  color: string | null;
  material: string | null;
  gender_department: string | null;
  weight_oz: number | null;
  measurements: Record<string, number | null>;
  size_system: SizeSystem | null;
}

/** Validate brand + size_label, the required free-text identity fields. */
function validateClothingBrandAndSize(
  body: Record<string, unknown>,
  invalidFields: string[],
): { brand: string; size_label: string } {
  const brandValid = validateBrandInput(body.brand);
  if (!brandValid) invalidFields.push('brand');
  const brand = typeof body.brand === 'string' ? body.brand.trim() : '';

  // size_label: stored exactly as entered, only whitespace-trimmed —
  // never case- or format-normalized (FR9).
  const size_label =
    typeof body.size_label === 'string' && body.size_label.trim() !== ''
      ? body.size_label.trim()
      : '';
  if (!size_label) invalidFields.push('size_label');

  return { brand, size_label };
}

/**
 * Validate an optional vocabulary field (color, material). Explicit null
 * bypasses the vocab validator (not just undefined/'') to preserve this
 * route's pre-existing "explicit null is valid" contract for an optional
 * nullable field — the vocab validators only special-case undefined/''.
 */
function optionalVocabField(
  raw: unknown,
  isValid: (value: unknown) => boolean,
  fieldName: string,
  invalidFields: string[],
): string | null {
  if (raw !== null && !isValid(raw)) invalidFields.push(fieldName);
  return typeof raw === 'string' ? raw.trim() || null : null;
}

/** Validate brand/size_label/color/material — the free-text identity fields. */
function validateClothingIdentityFields(
  body: Record<string, unknown>,
  invalidFields: string[],
): { brand: string; size_label: string; color: string | null; material: string | null } {
  const { brand, size_label } = validateClothingBrandAndSize(body, invalidFields);
  const color = optionalVocabField(body.color, validateColorInput, 'color', invalidFields);
  const material = optionalVocabField(body.material, validateMaterialInput, 'material', invalidFields);

  return { brand, size_label, color, material };
}

/** Validate gender_department + weight_oz — the scalar attribute fields. */
function validateClothingAttributeFields(
  body: Record<string, unknown>,
  invalidFields: string[],
): { gender_department: string | null; weight_oz: number | null } {
  // Explicit null bypasses the validator (see optionalVocabField) — it only
  // special-cases undefined/''.
  if (body.gender_department !== null && !validateDepartmentInput(body.gender_department)) {
    invalidFields.push('gender_department');
  }
  const gender_department =
    typeof body.gender_department === 'string' ? body.gender_department : null;

  if (!validateWeightOz(body.weight_oz)) {
    invalidFields.push('weight_oz');
  }
  const weight_oz =
    body.weight_oz === undefined || body.weight_oz === null ? null : (body.weight_oz as number);

  return { gender_department, weight_oz };
}

/** Validate the 8-field measurement allowlist (FR5). */
function validateClothingMeasurements(
  body: Record<string, unknown>,
  invalidFields: string[],
): Record<string, number | null> {
  const measurements: Record<string, number | null> = {};
  for (const field of CLOTHING_MEASUREMENT_FIELDS) {
    const value = body[field];
    if (!validateMeasurement(value)) {
      invalidFields.push(field);
    }
    measurements[field] = value === undefined || value === null ? null : (value as number);
  }
  return measurements;
}

/** Validate size_system (optional enum) + size_label membership in that system's vocabulary. */
function validateClothingSizeSystem(
  body: Record<string, unknown>,
  size_label: string,
  invalidFields: string[],
): SizeSystem | null {
  const raw = body.size_system;
  if (raw === undefined || raw === null || raw === '') return null;
  if (!validateSizeSystem(raw)) {
    invalidFields.push('size_system');
    return null;
  }
  const system = raw as SizeSystem;
  if (!validateSizeAgainstSystem(system, size_label)) {
    invalidFields.push('size_label');
  }
  return system;
}

/** Validate clothing-only fields, appending to the shared `invalidFields`. */
function validateClothingFields(
  body: Record<string, unknown>,
  invalidFields: string[],
): ClothingFields {
  const identity = validateClothingIdentityFields(body, invalidFields);
  const attributes = validateClothingAttributeFields(body, invalidFields);
  const measurements = validateClothingMeasurements(body, invalidFields);
  const size_system = validateClothingSizeSystem(body, identity.size_label, invalidFields);

  return { ...identity, ...attributes, measurements, size_system };
}

/** Insert the items + clothing_details rows in a transaction. Errors propagate (→ outer 500), unlike the book branch. */
function insertClothingRecord(item: BaseItemRow, fields: ClothingFields, condition: string): void {
  db.transaction(() => {
    insertBaseItemRow('clothing', item);

    db.prepare(
      `INSERT INTO clothing_details
         (item_id, tenant_id, brand, size_label, color, material, gender_department, weight_oz,
          pit_to_pit_in, length_in, sleeve_length_in, waist_in, rise_in, inseam_in,
          leg_opening_in, hip_in, condition, size_system)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      item.id,
      item.tenantId,
      fields.brand,
      fields.size_label,
      fields.color,
      fields.material,
      fields.gender_department,
      fields.weight_oz,
      fields.measurements.pit_to_pit_in,
      fields.measurements.length_in,
      fields.measurements.sleeve_length_in,
      fields.measurements.waist_in,
      fields.measurements.rise_in,
      fields.measurements.inseam_in,
      fields.measurements.leg_opening_in,
      fields.measurements.hip_in,
      condition,
      fields.size_system,
    );
  })();
}

function fetchClothingRow(id: string): Record<string, unknown> {
  return db
    .prepare(
      `SELECT i.*, cd.brand, cd.size_label, cd.color, cd.material, cd.gender_department,
              cd.weight_oz, cd.pit_to_pit_in, cd.length_in, cd.sleeve_length_in, cd.waist_in,
              cd.rise_in, cd.inseam_in, cd.leg_opening_in, cd.hip_in, cd.condition, cd.size_system
         FROM items i JOIN clothing_details cd ON cd.item_id = i.id
        WHERE i.id = ?`,
    )
    .get(id) as Record<string, unknown>;
}

/** Replace each free-text vocabulary value with its tenant's canonical spelling, creating it when new. */
function canonicalizeClothingFields(tenantId: string, fields: ClothingFields): void {
  fields.brand = resolveCanonicalBrand(tenantId, fields.brand);
  if (fields.color) fields.color = resolveCanonicalColor(tenantId, fields.color);
  if (fields.material) fields.material = resolveCanonicalMaterial(tenantId, fields.material);
  if (fields.gender_department) {
    fields.gender_department = resolveCanonicalDepartment(tenantId, fields.gender_department);
  }
}

export function handleClothingCreate(
  body: Record<string, unknown>,
  shared: SharedFields,
  tenantId: string,
): NextResponse {
  const fields = validateClothingFields(body, shared.invalidFields);

  const invalidResponse = invalidFieldsResponse(shared.invalidFields);
  if (invalidResponse) return invalidResponse;

  canonicalizeClothingFields(tenantId, fields);

  const id = uuidv4();
  insertClothingRecord(newBaseItemRow(id, tenantId, shared), fields, shared.condition as string);

  const row = fetchClothingRow(id);
  return NextResponse.json({ ...row }, { status: 201 });
}
