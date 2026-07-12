import { FieldError } from './FieldError';

interface AcquisitionFieldsProps {
  cost: string;
  onCostChange: (value: string) => void;
  costError?: string;
  date: string;
  onDateChange: (value: string) => void;
  dateError?: string;
}

/**
 * Acquisition Cost + Acquisition Date fields — byte-for-byte identical
 * markup and behavior between the book and clothing forms.
 */
export function AcquisitionFields({
  cost,
  onCostChange,
  costError,
  date,
  onDateChange,
  dateError,
}: AcquisitionFieldsProps) {
  return (
    <>
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Acquisition Cost (USD) *</label>
        <input
          type="number"
          required
          min="0"
          step="0.01"
          value={cost}
          onChange={e => onCostChange(e.target.value)}
          placeholder="0.00"
          className="w-full border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 dark:placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
        />
        <FieldError message={costError} />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Acquisition Date *</label>
        <input
          type="date"
          required
          value={date}
          onChange={e => onDateChange(e.target.value)}
          className="w-full border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
        />
        <FieldError message={dateError} />
      </div>
    </>
  );
}
