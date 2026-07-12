'use client';

import { useEffect, useRef, useState } from 'react';
import { CLOTHING_CONDITIONS } from '@/lib/constants';
import { CLOTHING_MEASUREMENT_FIELDS, type ClothingMeasurementField } from '@/lib/clothing';
import { fetchFieldSuggestions } from '@/lib/suggestions';
import { useSubmitItemForm } from './useSubmitItemForm';
import { ConditionSelect } from './ConditionSelect';
import { AcquisitionFields } from './AcquisitionFields';
import { SubmitButton } from './SubmitButton';
import { SubmitError } from './SubmitError';
import { FieldError } from './FieldError';

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

  // Autocomplete suggestion lists — fetched once from the operator's own
  // past entries, not a new service. Sizes are re-fetched whenever brand
  // changes, since sizes aren't standardized across brands (FR9) and a
  // brand-scoped list is far more useful than a flat one.
  const [brandOptions, setBrandOptions] = useState<string[]>([]);
  const [colorOptions, setColorOptions] = useState<string[]>([]);
  const [materialOptions, setMaterialOptions] = useState<string[]>([]);
  const [departmentOptions, setDepartmentOptions] = useState<string[]>([]);
  const [sizeOptions, setSizeOptions] = useState<string[]>([]);

  const { submitLoading, fieldErrors, submitError, submit } = useSubmitItemForm();

  useEffect(() => {
    // fetchFieldSuggestions swallows its own errors and resolves to [] on
    // failure — it never rejects — so `.then()` alone is complete handling;
    // `void` just satisfies the linter's static (can't-see-that) analysis.
    void fetchFieldSuggestions('brand').then(setBrandOptions);
    void fetchFieldSuggestions('color').then(setColorOptions);
    void fetchFieldSuggestions('material').then(setMaterialOptions);
    void fetchFieldSuggestions('gender_department').then(setDepartmentOptions);
  }, []);

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
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Brand *</label>
        <input
          type="text"
          required
          list="brand-options"
          value={brand}
          onChange={e => setBrand(e.target.value)}
          className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400"
        />
        <datalist id="brand-options">
          {brandOptions.map(b => <option key={b} value={b} />)}
        </datalist>
        <FieldError message={fieldErrors.brand} />
      </div>

      {/* Size */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Size *</label>
        <input
          type="text"
          required
          list="size-options"
          value={sizeLabel}
          onChange={e => setSizeLabel(e.target.value)}
          className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400"
        />
        <datalist id="size-options">
          {sizeOptions.map(s => <option key={s} value={s} />)}
        </datalist>
        <p className="text-xs text-gray-500 mt-1">
          Enter exactly as shown on the tag — sizes aren&apos;t standardized across brands
          {sizeOptions.length > 0 && ' — suggestions below are sizes you\'ve used for this brand before'}
        </p>
        <FieldError message={fieldErrors.size_label} />
      </div>

      {/* Color */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Color</label>
        <input
          type="text"
          list="color-options"
          value={color}
          onChange={e => setColor(e.target.value)}
          className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400"
        />
        <datalist id="color-options">
          {colorOptions.map(c => <option key={c} value={c} />)}
        </datalist>
      </div>

      {/* Material */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Material</label>
        <input
          type="text"
          list="material-options"
          value={material}
          onChange={e => setMaterial(e.target.value)}
          className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400"
        />
        <datalist id="material-options">
          {materialOptions.map(m => <option key={m} value={m} />)}
        </datalist>
      </div>

      {/* Department */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Department</label>
        <input
          type="text"
          list="department-options"
          value={genderDepartment}
          onChange={e => setGenderDepartment(e.target.value)}
          placeholder="e.g. Women's, Men's, Kids'"
          className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400"
        />
        <datalist id="department-options">
          {departmentOptions.map(d => <option key={d} value={d} />)}
        </datalist>
      </div>

      {/* Title — suggested from the fields above using the Playbook's title
          formula (Brand + Item Type + Attribute + Size); editable, and once
          edited directly it stops auto-updating. */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Listing Title
          <span className="font-normal text-gray-400"> — suggested, edit freely</span>
        </label>
        <input
          type="text"
          value={title}
          onChange={e => {
            setTitle(e.target.value);
            setTitleTouched(true);
          }}
          className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400"
        />
        <p className="text-xs text-gray-500 mt-1">
          Replace <code className="bg-gray-100 px-1 rounded">[item type]</code> with what it actually is
          (e.g. &quot;Jeans&quot;, &quot;Dress&quot;) — brand, attribute, and size are filled in for you.
        </p>
      </div>

      <ConditionSelect
        conditions={CLOTHING_CONDITIONS}
        value={condition}
        onChange={setCondition}
        error={fieldErrors.condition}
      />

      {/* Weight */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Weight (oz)</label>
        <input
          type="number"
          step="1"
          min="0"
          value={weightOz}
          onChange={e => setWeightOz(e.target.value)}
          className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400"
        />
        <FieldError message={fieldErrors.weight_oz} />
      </div>

      {/* Measurements */}
      {CLOTHING_MEASUREMENT_FIELDS.map(field => (
        <div key={field}>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {MEASUREMENT_LABELS[field]}
          </label>
          <input
            type="number"
            step="0.1"
            min="0"
            value={measurements[field]}
            onChange={e => setMeasurement(field, e.target.value)}
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400"
          />
          <FieldError message={fieldErrors[field]} />
        </div>
      ))}

      <AcquisitionFields
        cost={acquisitionCost}
        onCostChange={setAcquisitionCost}
        costError={fieldErrors.acquisition_cost}
        date={acquisitionDate}
        onDateChange={setAcquisitionDate}
        dateError={fieldErrors.acquisition_date}
      />

      <SubmitError message={submitError} />

      <SubmitButton loading={submitLoading} label="Add Clothing Item" />
    </form>
  );
}
