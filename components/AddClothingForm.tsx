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

export default function AddClothingForm() {
  const [title, setTitle] = useState('');
  const [titleTouched, setTitleTouched] = useState(false);
  const [brand, setBrand] = useState('');
  const [sizeLabel, setSizeLabel] = useState('');
  const [sizeSystem, setSizeSystem] = useState<SizeSystem | null>(null);
  const [waistValue, setWaistValue] = useState('');
  const [inseamValue, setInseamValue] = useState('');
  const [color, setColor] = useState('');
  const [material, setMaterial] = useState('');
  const [genderDepartment, setGenderDepartment] = useState('');
  const [condition, setCondition] = useState<string>('EUC'); // most closet-clearout items are used, not deadstock
  const [weightOz, setWeightOz] = useState('');
  const [acquisitionCost, setAcquisitionCost] = useState('');
  const [acquisitionDate, setAcquisitionDate] = useState('');

  const [measurements, setMeasurements] = useState<Record<ClothingMeasurementField, string>>({
    pit_to_pit_in: '',
    length_in: '',
    sleeve_length_in: '',
    waist_in: '',
    rise_in: '',
    inseam_in: '',
    leg_opening_in: '',
    hip_in: '',
  });

  // Autocomplete suggestion list for size — re-fetched whenever brand
  // changes, since sizes aren't standardized across brands (FR9) and a
  // brand-scoped list is far more useful than a flat one. Color/material/
  // gender_department suggestions are now fetched internally by VocabCombobox.
  const [sizeOptions, setSizeOptions] = useState<string[]>([]);

  const { submitLoading, fieldErrors, submitError, submit } = useSubmitItemForm();

  // Debounced brand-scoped size lookup — fires ~400ms after the operator
  // stops typing a brand, not on every keystroke.
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

  // Keep the title suggestion in sync with brand/color/size until the
  // operator edits the title field directly — once touched, their edit
  // always wins and we stop overwriting it.
  useEffect(() => {
    if (!titleTouched) {
      setTitle(suggestTitle(brand, color, sizeLabel));
    }
  }, [brand, color, sizeLabel, titleTouched]);

  function setMeasurement(field: ClothingMeasurementField, value: string) {
    setMeasurements(prev => ({ ...prev, [field]: value }));
  }

  // Switching size systems clears any size data entered under the previous
  // system — a stale free-text or waist/inseam value isn't valid once the
  // vocabulary changes.
  function handleSizeSystemChange(next: SizeSystem | null) {
    setSizeSystem(next);
    setSizeLabel('');
    setWaistValue('');
    setInseamValue('');
  }

  // For numeric_waist_inseam, size_label is derived from the two number
  // inputs rather than typed directly; leave it empty until both are filled
  // so an incomplete pair never submits a malformed value.
  useEffect(() => {
    if (sizeSystem === 'numeric_waist_inseam') {
      setSizeLabel(waistValue.trim() && inseamValue.trim() ? `${waistValue.trim()}x${inseamValue.trim()}` : '');
    }
  }, [sizeSystem, waistValue, inseamValue]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await submit({
      acquisitionCost,
      buildBody: (costCents) => {
        const body: Record<string, unknown> = {
          category: 'clothing',
          title: title.trim() || `${brand.trim()} ${sizeLabel.trim()}`.trim(),
          brand: brand.trim(),
          size_label: sizeLabel.trim(),
          condition,
          acquisition_cost: costCents,
          acquisition_date: acquisitionDate,
        };
        if (sizeSystem) body.size_system = sizeSystem;
        if (color.trim()) body.color = color.trim();
        if (material.trim()) body.material = material.trim();
        if (genderDepartment.trim()) body.gender_department = genderDepartment.trim();
        if (weightOz.trim() !== '') {
          const parsedWeight = parseInt(weightOz, 10);
          if (!isNaN(parsedWeight)) body.weight_oz = parsedWeight;
        }
        for (const field of CLOTHING_MEASUREMENT_FIELDS) {
          const raw = measurements[field];
          if (raw.trim() !== '') {
            const parsed = parseFloat(raw);
            if (!isNaN(parsed)) body[field] = parsed;
          }
        }
        return body;
      },
    });
  }

  return (
    <form onSubmit={(e) => { void handleSubmit(e); }} className="space-y-5 max-w-lg">
      {/* Brand */}
      <div data-tour={CLOTHING_ANCHORS.brand}>
        <BrandCombobox value={brand} onChange={setBrand} error={fieldErrors.brand} />
      </div>

      {/* Size */}
      <div data-tour={CLOTHING_ANCHORS.size}>
        <SizeSystemPicker value={sizeSystem} onChange={handleSizeSystemChange} />

        {sizeSystem === null && (
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Size *</label>
            <input
              type="text"
              required
              list="size-options"
              value={sizeLabel}
              onChange={e => setSizeLabel(e.target.value)}
              className="w-full border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
            />
            <datalist id="size-options">
              {sizeOptions.map(s => <option key={s} value={s} />)}
            </datalist>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Enter exactly as shown on the tag — sizes aren&apos;t standardized across brands
              {sizeOptions.length > 0 && ' — suggestions below are sizes you\'ve used for this brand before'}
            </p>
          </div>
        )}

        {(sizeSystem === 'letter' || sizeSystem === 'shoe') && (
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Size *</label>
            <select
              required
              value={sizeLabel}
              onChange={e => setSizeLabel(e.target.value)}
              className="w-full border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
            >
              <option value="">Select...</option>
              {SIZE_SYSTEMS[sizeSystem].map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        )}

        {sizeSystem === 'numeric_waist_inseam' && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Waist *</label>
              <input
                type="number"
                min="0"
                required
                value={waistValue}
                onChange={e => setWaistValue(e.target.value)}
                className="w-full border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Inseam *</label>
              <input
                type="number"
                min="0"
                required
                value={inseamValue}
                onChange={e => setInseamValue(e.target.value)}
                className="w-full border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
              />
            </div>
          </div>
        )}

        <FieldError message={fieldErrors.size_label} />
      </div>

      {/* Color */}
      <div>
        <VocabCombobox
          value={color}
          onChange={setColor}
          error={fieldErrors.color}
          endpoint="/api/colors"
          responseKey="colors"
          suggestionField="color"
          label="Color"
          maxLength={255}
        />
      </div>

      {/* Material */}
      <div>
        <VocabCombobox
          value={material}
          onChange={setMaterial}
          error={fieldErrors.material}
          endpoint="/api/materials"
          responseKey="materials"
          suggestionField="material"
          label="Material"
          maxLength={255}
        />
      </div>

      {/* Department */}
      <div>
        <VocabCombobox
          value={genderDepartment}
          onChange={setGenderDepartment}
          error={fieldErrors.gender_department}
          endpoint="/api/departments"
          responseKey="departments"
          suggestionField="gender_department"
          label="Department"
          maxLength={255}
        />
      </div>

      {/* Title — suggested from the fields above using the Playbook's title
          formula (Brand + Item Type + Attribute + Size); editable, and once
          edited directly it stops auto-updating. */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Listing Title
          <span className="font-normal text-gray-400 dark:text-gray-500"> — suggested, edit freely</span>
        </label>
        <input
          type="text"
          value={title}
          onChange={e => {
            setTitle(e.target.value);
            setTitleTouched(true);
          }}
          className="w-full border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
        />
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          Replace <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">[item type]</code> with what it actually is
          (e.g. &quot;Jeans&quot;, &quot;Dress&quot;) — brand, attribute, and size are filled in for you.
        </p>
      </div>

      <div data-tour={CLOTHING_ANCHORS.condition}>
        <ConditionSelect
          conditions={CLOTHING_CONDITIONS}
          value={condition}
          onChange={setCondition}
          error={fieldErrors.condition}
        />
      </div>

      {/* Weight */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Weight (oz)</label>
        <input
          type="number"
          step="1"
          min="0"
          value={weightOz}
          onChange={e => setWeightOz(e.target.value)}
          className="w-full border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
        />
        <FieldError message={fieldErrors.weight_oz} />
      </div>

      {/* Measurements */}
      <div data-tour={CLOTHING_ANCHORS.measurements}>
        {CLOTHING_MEASUREMENT_FIELDS.map(field => (
          <div key={field}>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {MEASUREMENT_LABELS[field]}
            </label>
            <input
              type="number"
              step="0.1"
              min="0"
              value={measurements[field]}
              onChange={e => setMeasurement(field, e.target.value)}
              className="w-full border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
            />
            <FieldError message={fieldErrors[field]} />
          </div>
        ))}
      </div>

      <div data-tour={CLOTHING_ANCHORS.acquisition}>
        <AcquisitionFields
          cost={acquisitionCost}
          onCostChange={setAcquisitionCost}
          costError={fieldErrors.acquisition_cost}
          date={acquisitionDate}
          onDateChange={setAcquisitionDate}
          dateError={fieldErrors.acquisition_date}
        />
      </div>

      <SubmitError message={submitError} />

      <div data-tour={CLOTHING_ANCHORS.submit}>
        <SubmitButton loading={submitLoading} label="Add Clothing Item" />
      </div>
    </form>
  );
}
