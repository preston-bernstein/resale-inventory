'use client';

import { ELECTRONICS_CONDITIONS, LAPTOP_BRANDS } from '@/lib/constants';
import { useSubmitItemForm } from './useSubmitItemForm';
import { ConditionSelect } from './ConditionSelect';
import { AcquisitionFields } from './AcquisitionFields';
import { SubmitButton } from './SubmitButton';
import { SubmitError } from './SubmitError';
import { FormField, INPUT_CLASS, NumberField, TextField, useFieldValues, type NumberFieldSpec } from './FormField';
import { assignOptionalNumber, assignTrimmed, parseDecimalInt } from './formBody';

export { assignOptionalNumber };

// device_type is fixed to 'laptop' for this increment (FR3 / out-of-scope —
// no UI control for it yet), so it's always sent but never rendered.
const DEVICE_TYPE = 'laptop';

interface SectionProps {
  values: ElectronicsValues;
  setValue: (key: keyof ElectronicsValues, value: string) => void;
  errors: Record<string, string>;
}

interface ElectronicsNumberField extends NumberFieldSpec {
  bodyKey: string;
  parse: (s: string) => number;
}

// Declaration order is the order the values are added to the request body.
const NUMBER_FIELDS = {
  ramGb: { bodyKey: 'ram_gb', label: 'RAM (GB)', step: '1', min: '1', parse: parseDecimalInt },
  storageGb: { bodyKey: 'storage_gb', label: 'Storage (GB)', step: '1', min: '1', parse: parseDecimalInt },
  screenSizeIn: { bodyKey: 'screen_size_in', label: 'Screen Size (in)', step: '0.1', min: '0.1', parse: parseFloat },
  batteryHealthPct: {
    bodyKey: 'battery_health_pct',
    label: 'Battery Health (%)',
    step: '1',
    min: '0',
    max: '100',
    parse: parseDecimalInt,
  },
  batteryCycleCount: {
    bodyKey: 'battery_cycle_count',
    label: 'Battery Cycle Count',
    step: '1',
    min: '0',
    parse: parseDecimalInt,
  },
} satisfies Record<string, ElectronicsNumberField>;

type NumberKey = keyof typeof NUMBER_FIELDS;

interface ElectronicsValues extends Record<NumberKey, string> {
  brand: string;
  model: string;
  processor: string;
  condition: string;
  acquisitionCost: string;
  acquisitionDate: string;
}

const INITIAL_VALUES: ElectronicsValues = {
  brand: '',
  model: '',
  processor: '',
  ramGb: '',
  storageGb: '',
  screenSizeIn: '',
  batteryHealthPct: '',
  batteryCycleCount: '',
  condition: 'Good',
  acquisitionCost: '',
  acquisitionDate: '',
};

function buildElectronicsBody(values: ElectronicsValues, costCents: number): Record<string, unknown> {
  const body: Record<string, unknown> = {
    category: 'electronics',
    device_type: DEVICE_TYPE,
    title: `${values.brand.trim()} ${values.model.trim()}`.trim(),
    brand: values.brand.trim(),
    model: values.model.trim(),
    condition: values.condition,
    acquisition_cost: costCents,
    acquisition_date: values.acquisitionDate,
  };
  assignTrimmed(body, 'processor', values.processor);
  for (const key of Object.keys(NUMBER_FIELDS) as NumberKey[]) {
    const field = NUMBER_FIELDS[key];
    assignOptionalNumber(body, field.bodyKey, values[key], field.parse);
  }
  return body;
}

function IdentityFields({ values, setValue, errors }: SectionProps) {
  return (
    <>
      <FormField label="Brand *" error={errors.brand}>
        <select
          required={true}
          value={values.brand}
          onChange={e => setValue('brand', e.target.value)}
          className={INPUT_CLASS}
        >
          <option value="">Select...</option>
          {LAPTOP_BRANDS.map(b => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>
      </FormField>

      <TextField
        label="Model *"
        required={true}
        value={values.model}
        onChange={(value) => setValue('model', value)}
        error={errors.model}
      />

      <TextField
        label="Processor"
        value={values.processor}
        onChange={(value) => setValue('processor', value)}
        error={errors.processor}
      />
    </>
  );
}

function SpecFields({ values, setValue, errors }: SectionProps) {
  function numberField(key: NumberKey) {
    return (
      <NumberField
        spec={NUMBER_FIELDS[key]}
        value={values[key]}
        onChange={(value) => setValue(key, value)}
        error={errors[NUMBER_FIELDS[key].bodyKey]}
      />
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        {numberField('ramGb')}
        {numberField('storageGb')}
      </div>

      {numberField('screenSizeIn')}

      <div className="grid grid-cols-2 gap-3">
        {numberField('batteryHealthPct')}
        {numberField('batteryCycleCount')}
      </div>
    </>
  );
}

export default function AddElectronicsForm() {
  const [values, setValue] = useFieldValues(INITIAL_VALUES);
  const { submitLoading, fieldErrors, submitError, submit } = useSubmitItemForm();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await submit({
      acquisitionCost: values.acquisitionCost,
      buildBody: (costCents) => buildElectronicsBody(values, costCents),
    });
  }

  return (
    <form onSubmit={(e) => { void handleSubmit(e); }} className="space-y-5 max-w-lg">
      <IdentityFields values={values} setValue={setValue} errors={fieldErrors} />
      <SpecFields values={values} setValue={setValue} errors={fieldErrors} />

      <ConditionSelect
        conditions={ELECTRONICS_CONDITIONS}
        value={values.condition}
        onChange={(value) => setValue('condition', value)}
        error={fieldErrors.condition}
      />

      <AcquisitionFields
        cost={values.acquisitionCost}
        onCostChange={(value) => setValue('acquisitionCost', value)}
        costError={fieldErrors.acquisition_cost}
        date={values.acquisitionDate}
        onDateChange={(value) => setValue('acquisitionDate', value)}
        dateError={fieldErrors.acquisition_date}
      />

      <SubmitError message={submitError} />
      <SubmitButton loading={submitLoading} label="Add Electronics Item" />
    </form>
  );
}
