'use client';

import { useEffect, useRef, useState } from 'react';
import { CLOTHING_CONDITIONS } from '@/lib/constants';
import { CLOTHING_MEASUREMENT_FIELDS, type ClothingMeasurementField, type SizeSystem, SIZE_SYSTEMS } from '@/lib/clothing';
import { CLOTHING_ANCHORS } from '@/lib/tourAnchors';
import { fetchFieldSuggestions } from '@/lib/suggestions';
import { useSubmitItemForm } from './useSubmitItemForm';
import { BrandCombobox } from './BrandCombobox';
import { SizeSystemPicker } from './SizeSystemPicker';
import { ConditionSelect } from './ConditionSelect';
import { AcquisitionFields } from './AcquisitionFields';
import { SubmitButton } from './SubmitButton';
import { SubmitError } from './SubmitError';
import { FieldError } from './FieldError';
import { VocabCombobox } from './VocabCombobox';
import { FormField, INPUT_CLASS, NumberField, TextField, useFieldValues } from './FormField';
import { assignOptionalNumber, assignTrimmed, parseDecimalInt } from './formBody';

// Title-Case label for each measurement field, e.g. pit_to_pit_in -> "Pit to Pit (in)".
const MEASUREMENT_LABELS: Record<ClothingMeasurementField, string> = {
  pit_to_pit_in: 'Pit to Pit (in)',
  length_in: 'Length (in)',
  sleeve_length_in: 'Sleeve Length (in)',
  waist_in: 'Waist (in)',
  rise_in: 'Rise (in)',
  inseam_in: 'Inseam (in)',
  leg_opening_in: 'Leg Opening (in)',
  hip_in: 'Hip (in)',
};

interface MeasurementFieldsProps {
  measurements: Measurements;
  errors: Record<string, string>;
  onChange: (field: ClothingMeasurementField, value: string) => void;
}

interface TitleFieldProps {
  value: string;
  onChange: (title: string) => void;
}

// The seeded-vocabulary comboboxes, in form order.
const VOCAB_FIELDS = [
  { key: 'color', endpoint: '/api/colors', responseKey: 'colors', suggestionField: 'color', label: 'Color', errorKey: 'color' },
  { key: 'material', endpoint: '/api/materials', responseKey: 'materials', suggestionField: 'material', label: 'Material', errorKey: 'material' },
  {
    key: 'genderDepartment',
    endpoint: '/api/departments',
    responseKey: 'departments',
    suggestionField: 'gender_department',
    label: 'Department',
    errorKey: 'gender_department',
  },
] as const;

// Playbook title formula: Brand + Item Type + Distinguishing Style + Key
// Attribute (color/material) + Size. We only capture brand/color/size
// structurally — "item type" (e.g. "Jeans", "Dress") isn't a field of its
// own, so the suggestion leaves a bracketed placeholder for the operator to
// replace inline rather than guessing a garment type from nothing.
function suggestTitle(brand: string, color: string, sizeLabel: string): string {
  const parts = [brand.trim() || '[Brand]', '[item type]'];
  if (color.trim()) parts.push(color.trim());
  parts.push(sizeLabel.trim() ? `Size ${sizeLabel.trim()}` : '[Size]');
  return parts.join(' ');
}

interface ClothingValues {
  title: string;
  brand: string;
  sizeLabel: string;
  waistValue: string;
  inseamValue: string;
  color: string;
  material: string;
  genderDepartment: string;
  condition: string;
  weightOz: string;
  acquisitionCost: string;
  acquisitionDate: string;
}

const INITIAL_VALUES: ClothingValues = {
  title: '',
  brand: '',
  sizeLabel: '',
  waistValue: '',
  inseamValue: '',
  color: '',
  material: '',
  genderDepartment: '',
  condition: 'EUC', // most closet-clearout items are used, not deadstock
  weightOz: '',
  acquisitionCost: '',
  acquisitionDate: '',
};

type Measurements = Record<ClothingMeasurementField, string>;

type SetValue = (key: keyof ClothingValues, value: string) => void;

const EMPTY_MEASUREMENTS: Measurements = {
  pit_to_pit_in: '',
  length_in: '',
  sleeve_length_in: '',
  waist_in: '',
  rise_in: '',
  inseam_in: '',
  leg_opening_in: '',
  hip_in: '',
};

interface ClothingSubmission {
  values: ClothingValues;
  measurements: Measurements;
  sizeSystem: SizeSystem | null;
}

function buildClothingBody(
  { values, measurements, sizeSystem }: ClothingSubmission,
  costCents: number,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    category: 'clothing',
    title: values.title.trim() || `${values.brand.trim()} ${values.sizeLabel.trim()}`.trim(),
    brand: values.brand.trim(),
    size_label: values.sizeLabel.trim(),
    condition: values.condition,
    acquisition_cost: costCents,
    acquisition_date: values.acquisitionDate,
  };
  if (sizeSystem) body.size_system = sizeSystem;
  assignTrimmed(body, 'color', values.color);
  assignTrimmed(body, 'material', values.material);
  assignTrimmed(body, 'gender_department', values.genderDepartment);
  assignOptionalNumber(body, 'weight_oz', values.weightOz, parseDecimalInt);
  for (const field of CLOTHING_MEASUREMENT_FIELDS) {
    assignOptionalNumber(body, field, measurements[field], parseFloat);
  }
  return body;
}

// Autocomplete suggestion list for size — re-fetched whenever brand changes,
// since sizes aren't standardized across brands (FR9) and a brand-scoped list
// is far more useful than a flat one. Color/material/gender_department
// suggestions are fetched internally by VocabCombobox. The lookup is
// debounced: it fires ~400ms after the operator stops typing a brand, not on
// every keystroke.
function useBrandScopedSizeOptions(brand: string): string[] {
  const [sizeOptions, setSizeOptions] = useState<string[]>([]);

  const brandDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (brandDebounce.current) clearTimeout(brandDebounce.current);
    if (!brand.trim()) {
      setSizeOptions([]);
      return;
    }
    brandDebounce.current = setTimeout(() => {
      void fetchFieldSuggestions('size_label', { brand: brand.trim() }).then(setSizeOptions);
    }, 400);
    return () => {
      if (brandDebounce.current) clearTimeout(brandDebounce.current);
    };
  }, [brand]);

  return sizeOptions;
}

// Keep the title suggestion in sync with brand/color/size until the operator
// edits the title field directly — once touched, their edit always wins and
// we stop overwriting it.
function useSuggestedTitle(
  { brand, color, sizeLabel }: Pick<ClothingValues, 'brand' | 'color' | 'sizeLabel'>,
  setValue: SetValue,
) {
  const [titleTouched, setTitleTouched] = useState(false);

  useEffect(() => {
    if (!titleTouched) {
      setValue('title', suggestTitle(brand, color, sizeLabel));
    }
  }, [brand, color, sizeLabel, titleTouched, setValue]);

  return () => setTitleTouched(true);
}

interface SizeFieldsProps {
  sizeSystem: SizeSystem | null;
  values: ClothingValues;
  sizeOptions: string[];
  onChange: SetValue;
}

const FREE_TEXT_SIZE_HINT = (hasSuggestions: boolean) => (
  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
    Enter exactly as shown on the tag — sizes aren&apos;t standardized across brands
    {hasSuggestions && ' — suggestions below are sizes you\'ve used for this brand before'}
  </p>
);

function WaistInseamFields({ values, onChange }: Pick<SizeFieldsProps, 'values' | 'onChange'>) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {(['waistValue', 'inseamValue'] as const).map(key => (
        <FormField key={key} label={key === 'waistValue' ? 'Waist *' : 'Inseam *'}>
          <input
            type="number"
            min="0"
            required={true}
            value={values[key]}
            onChange={e => onChange(key, e.target.value)}
            className={INPUT_CLASS}
          />
        </FormField>
      ))}
    </div>
  );
}

function SizeFields({ sizeSystem, values, sizeOptions, onChange }: SizeFieldsProps) {
  if (sizeSystem === null) {
    return (
      <TextField
        label="Size *"
        required={true}
        value={values.sizeLabel}
        onChange={(value) => onChange('sizeLabel', value)}
        suggestions={{ listId: 'size-options', options: sizeOptions }}
        hint={FREE_TEXT_SIZE_HINT(sizeOptions.length > 0)}
      />
    );
  }

  if (sizeSystem === 'numeric_waist_inseam') {
    return <WaistInseamFields values={values} onChange={onChange} />;
  }

  return (
    <FormField label="Size *">
      <select
        required={true}
        value={values.sizeLabel}
        onChange={e => onChange('sizeLabel', e.target.value)}
        className={INPUT_CLASS}
      >
        <option value="">Select...</option>
        {SIZE_SYSTEMS[sizeSystem].map(s => <option key={s} value={s}>{s}</option>)}
      </select>
    </FormField>
  );
}

function MeasurementFields({ measurements, errors, onChange }: MeasurementFieldsProps) {
  return (
    <>
      {CLOTHING_MEASUREMENT_FIELDS.map(field => (
        <NumberField
          key={field}
          spec={{ label: MEASUREMENT_LABELS[field], step: '0.1', min: '0' }}
          value={measurements[field]}
          onChange={(value) => onChange(field, value)}
          error={errors[field]}
        />
      ))}
    </>
  );
}

// For numeric_waist_inseam, size_label is derived from the two number
// inputs rather than typed directly; leave it empty until both are filled
// so an incomplete pair never submits a malformed value.
function useDerivedWaistInseamLabel(
  sizeSystem: SizeSystem | null,
  { waistValue, inseamValue }: Pick<ClothingValues, 'waistValue' | 'inseamValue'>,
  setValue: SetValue,
) {
  useEffect(() => {
    if (sizeSystem === 'numeric_waist_inseam') {
      setValue('sizeLabel', waistValue.trim() && inseamValue.trim() ? `${waistValue.trim()}x${inseamValue.trim()}` : '');
    }
  }, [sizeSystem, waistValue, inseamValue, setValue]);
}

function useMeasurements() {
  const [measurements, setMeasurements] = useState<Measurements>(EMPTY_MEASUREMENTS);

  function setMeasurement(field: ClothingMeasurementField, value: string) {
    setMeasurements(prev => ({ ...prev, [field]: value }));
  }

  return [measurements, setMeasurement] as const;
}

function useClothingForm() {
  const [values, setValue] = useFieldValues(INITIAL_VALUES);
  const [sizeSystem, setSizeSystem] = useState<SizeSystem | null>(null);
  const [measurements, setMeasurement] = useMeasurements();

  const sizeOptions = useBrandScopedSizeOptions(values.brand);
  const markTitleTouched = useSuggestedTitle(values, setValue);
  const { submitLoading, fieldErrors, submitError, submit } = useSubmitItemForm();

  // Switching size systems clears any size data entered under the previous
  // system — a stale free-text or waist/inseam value isn't valid once the
  // vocabulary changes.
  function handleSizeSystemChange(next: SizeSystem | null) {
    setSizeSystem(next);
    setValue('sizeLabel', '');
    setValue('waistValue', '');
    setValue('inseamValue', '');
  }

  useDerivedWaistInseamLabel(sizeSystem, values, setValue);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await submit({
      acquisitionCost: values.acquisitionCost,
      buildBody: (costCents) => buildClothingBody({ values, measurements, sizeSystem }, costCents),
    });
  }

  return {
    values,
    setValue,
    sizeSystem,
    sizeOptions,
    measurements,
    fieldErrors,
    submitError,
    submitLoading,
    markTitleTouched,
    handleSizeSystemChange,
    setMeasurement,
    handleSubmit,
  };
}

type ClothingForm = ReturnType<typeof useClothingForm>;

interface SectionProps {
  form: ClothingForm;
}

function IdentityFields({ form }: SectionProps) {
  const { values, setValue, fieldErrors } = form;

  return (
    <>
      <div data-tour={CLOTHING_ANCHORS.brand}>
        <BrandCombobox value={values.brand} onChange={(v) => setValue('brand', v)} error={fieldErrors.brand} />
      </div>

      <div data-tour={CLOTHING_ANCHORS.size}>
        <SizeSystemPicker value={form.sizeSystem} onChange={form.handleSizeSystemChange} />
        <SizeFields sizeSystem={form.sizeSystem} values={values} sizeOptions={form.sizeOptions} onChange={setValue} />
        <FieldError message={fieldErrors.size_label} />
      </div>

      {VOCAB_FIELDS.map(field => (
        <div key={field.key}>
          <VocabCombobox
            value={values[field.key]}
            onChange={(v) => setValue(field.key, v)}
            error={fieldErrors[field.errorKey]}
            endpoint={field.endpoint}
            responseKey={field.responseKey}
            suggestionField={field.suggestionField}
            label={field.label}
            maxLength={255}
          />
        </div>
      ))}

      {/* Title — suggested from the fields above using the Playbook's title
          formula (Brand + Item Type + Attribute + Size); editable, and once
          edited directly it stops auto-updating. */}
      <TitleField
        value={values.title}
        onChange={(title) => {
          setValue('title', title);
          form.markTitleTouched();
        }}
      />
    </>
  );
}

function DetailFields({ form }: SectionProps) {
  const { values, setValue, fieldErrors } = form;

  return (
    <>
      <div data-tour={CLOTHING_ANCHORS.condition}>
        <ConditionSelect
          conditions={CLOTHING_CONDITIONS}
          value={values.condition}
          onChange={(v) => setValue('condition', v)}
          error={fieldErrors.condition}
        />
      </div>

      <NumberField
        spec={{ label: 'Weight (oz)', step: '1', min: '0' }}
        value={values.weightOz}
        onChange={(v) => setValue('weightOz', v)}
        error={fieldErrors.weight_oz}
      />

      <div data-tour={CLOTHING_ANCHORS.measurements}>
        <MeasurementFields measurements={form.measurements} errors={fieldErrors} onChange={form.setMeasurement} />
      </div>
    </>
  );
}

export default function AddClothingForm() {
  const form = useClothingForm();
  const { values, setValue, fieldErrors } = form;

  return (
    <form onSubmit={(e) => { void form.handleSubmit(e); }} className="space-y-5 max-w-lg">
      <IdentityFields form={form} />
      <DetailFields form={form} />

      <div data-tour={CLOTHING_ANCHORS.acquisition}>
        <AcquisitionFields
          cost={values.acquisitionCost}
          onCostChange={(v) => setValue('acquisitionCost', v)}
          costError={fieldErrors.acquisition_cost}
          date={values.acquisitionDate}
          onDateChange={(v) => setValue('acquisitionDate', v)}
          dateError={fieldErrors.acquisition_date}
        />
      </div>

      <SubmitError message={form.submitError} />

      <div data-tour={CLOTHING_ANCHORS.submit}>
        <SubmitButton loading={form.submitLoading} label="Add Clothing Item" />
      </div>
    </form>
  );
}

function TitleField({ value, onChange }: TitleFieldProps) {
  return (
    <TextField
      label={
        <>
          Listing Title
          <span className="font-normal text-gray-400 dark:text-gray-500"> — suggested, edit freely</span>
        </>
      }
      value={value}
      onChange={onChange}
      hint={
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          Replace <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">[item type]</code> with what it actually is
          (e.g. &quot;Jeans&quot;, &quot;Dress&quot;) — brand, attribute, and size are filled in for you.
        </p>
      }
    />
  );
}
