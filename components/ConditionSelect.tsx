import { FieldError } from './FieldError';

interface ConditionSelectProps {
  conditions: readonly string[];
  value: string;
  onChange: (value: string) => void;
  error?: string;
}

/**
 * The condition <select> rendering pattern is identical between the book
 * and clothing forms — only the vocabulary (BOOK_CONDITIONS vs
 * CLOTHING_CONDITIONS) and current value differ.
 */
export function ConditionSelect({ conditions, value, onChange, error }: ConditionSelectProps) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">Condition *</label>
      <select
        required
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400"
      >
        {conditions.map(c => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>
      <FieldError message={error} />
    </div>
  );
}
