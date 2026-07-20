'use client';

import { useState } from 'react';
import { ELECTRONICS_CONDITIONS, LAPTOP_BRANDS } from '@/lib/constants';
import { useSubmitItemForm } from './useSubmitItemForm';
import { ConditionSelect } from './ConditionSelect';
import { AcquisitionFields } from './AcquisitionFields';
import { SubmitButton } from './SubmitButton';
import { SubmitError } from './SubmitError';
import { FieldError } from './FieldError';

// device_type is fixed to 'laptop' for this increment (FR3 / out-of-scope —
// no UI control for it yet), so it's always sent but never rendered.
const DEVICE_TYPE = 'laptop';

/** Parses a raw numeric field and assigns it under `key` only when non-blank and parseable — silently omitted otherwise. */
export function assignOptionalNumber(
  body: Record<string, unknown>,
  key: string,
  rawValue: string,
  parser: (s: string) => number,
): void {
  if (rawValue.trim() === '') return;
  const parsed = parser(rawValue);
  if (!isNaN(parsed)) body[key] = parsed;
}

export default function AddElectronicsForm() {
  const [brand, setBrand] = useState('');
  const [model, setModel] = useState('');
  const [processor, setProcessor] = useState('');
  const [ramGb, setRamGb] = useState('');
  const [storageGb, setStorageGb] = useState('');
  const [screenSizeIn, setScreenSizeIn] = useState('');
  const [batteryHealthPct, setBatteryHealthPct] = useState('');
  const [batteryCycleCount, setBatteryCycleCount] = useState('');
  const [condition, setCondition] = useState<string>('Good');
  const [acquisitionCost, setAcquisitionCost] = useState('');
  const [acquisitionDate, setAcquisitionDate] = useState('');

  const { submitLoading, fieldErrors, submitError, submit } = useSubmitItemForm();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await submit({
      acquisitionCost,
      buildBody: (costCents) => {
        const body: Record<string, unknown> = {
          category: 'electronics',
          device_type: DEVICE_TYPE,
          title: `${brand.trim()} ${model.trim()}`.trim(),
          brand: brand.trim(),
          model: model.trim(),
          condition,
          acquisition_cost: costCents,
          acquisition_date: acquisitionDate,
        };
        if (processor.trim()) body.processor = processor.trim();
        assignOptionalNumber(body, 'ram_gb', ramGb, (s) => parseInt(s, 10));
        assignOptionalNumber(body, 'storage_gb', storageGb, (s) => parseInt(s, 10));
        assignOptionalNumber(body, 'screen_size_in', screenSizeIn, parseFloat);
        assignOptionalNumber(body, 'battery_health_pct', batteryHealthPct, (s) => parseInt(s, 10));
        assignOptionalNumber(body, 'battery_cycle_count', batteryCycleCount, (s) => parseInt(s, 10));
        return body;
      },
    });
  }

  return (
    <form onSubmit={(e) => { void handleSubmit(e); }} className="space-y-5 max-w-lg">
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Brand *</label>
        <select
          required
          value={brand}
          onChange={e => setBrand(e.target.value)}
          className="w-full border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
        >
          <option value="">Select...</option>
          {LAPTOP_BRANDS.map(b => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>
        <FieldError message={fieldErrors.brand} />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Model *</label>
        <input
          type="text"
          required
          value={model}
          onChange={e => setModel(e.target.value)}
          className="w-full border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
        />
        <FieldError message={fieldErrors.model} />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Processor</label>
        <input
          type="text"
          value={processor}
          onChange={e => setProcessor(e.target.value)}
          className="w-full border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
        />
        <FieldError message={fieldErrors.processor} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">RAM (GB)</label>
          <input
            type="number"
            step="1"
            min="1"
            value={ramGb}
            onChange={e => setRamGb(e.target.value)}
            className="w-full border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
          />
          <FieldError message={fieldErrors.ram_gb} />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Storage (GB)</label>
          <input
            type="number"
            step="1"
            min="1"
            value={storageGb}
            onChange={e => setStorageGb(e.target.value)}
            className="w-full border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
          />
          <FieldError message={fieldErrors.storage_gb} />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Screen Size (in)</label>
        <input
          type="number"
          step="0.1"
          min="0.1"
          value={screenSizeIn}
          onChange={e => setScreenSizeIn(e.target.value)}
          className="w-full border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
        />
        <FieldError message={fieldErrors.screen_size_in} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Battery Health (%)</label>
          <input
            type="number"
            step="1"
            min="0"
            max="100"
            value={batteryHealthPct}
            onChange={e => setBatteryHealthPct(e.target.value)}
            className="w-full border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
          />
          <FieldError message={fieldErrors.battery_health_pct} />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Battery Cycle Count</label>
          <input
            type="number"
            step="1"
            min="0"
            value={batteryCycleCount}
            onChange={e => setBatteryCycleCount(e.target.value)}
            className="w-full border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
          />
          <FieldError message={fieldErrors.battery_cycle_count} />
        </div>
      </div>

      <ConditionSelect
        conditions={ELECTRONICS_CONDITIONS}
        value={condition}
        onChange={setCondition}
        error={fieldErrors.condition}
      />

      <AcquisitionFields
        cost={acquisitionCost}
        onCostChange={setAcquisitionCost}
        costError={fieldErrors.acquisition_cost}
        date={acquisitionDate}
        onDateChange={setAcquisitionDate}
        dateError={fieldErrors.acquisition_date}
      />

      <SubmitError message={submitError} />
      <SubmitButton loading={submitLoading} label="Add Electronics Item" />
    </form>
  );
}
