import { SizeSystem } from '@/lib/clothing';
import { FieldError } from './FieldError';

interface SizeSystemPickerProps {
  value: SizeSystem | null;
  onChange: (value: SizeSystem | null) => void;
  error?: string;
}

export function SizeSystemPicker({ value, onChange, error }: SizeSystemPickerProps) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Size system</label>
      <select
        value={value ?? ''}
        onChange={e => onChange(e.target.value === '' ? null : e.target.value as SizeSystem)}
        className="w-full border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500"
      >
        <option value="">Free text</option>
        <option value="letter">Letter (XS–XXL)</option>
        <option value="shoe">Shoe size</option>
        <option value="numeric_waist_inseam">Numeric (waist × inseam)</option>
      </select>
      <FieldError message={error} />
    </div>
  );
}
