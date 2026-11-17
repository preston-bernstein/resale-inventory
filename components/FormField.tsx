import { useCallback, useState, type ReactNode } from 'react';
import { FieldError } from './FieldError';

export const LABEL_CLASS = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1';

export const INPUT_CLASS =
  'w-full border border-gray-300 dark:border-gray-700 rounded px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500';

interface FormFieldProps {
  label: ReactNode;
  error?: string;
  /** `data-tour` anchor the presale tour highlights. */
  tourAnchor?: string;
  /** Help text under the control, above the error. */
  hint?: ReactNode;
  children: ReactNode;
}

/** Label, control and inline error message: the wrapper every "add item" field shares. */
export function FormField({ label, error, tourAnchor, hint, children }: FormFieldProps) {
  return (
    <div data-tour={tourAnchor}>
      <label className={LABEL_CLASS}>{label}</label>
      {children}
      {hint}
      <FieldError message={error} />
    </div>
  );
}

interface TextFieldProps {
  label: ReactNode;
  hint?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  tourAnchor?: string;
  required?: boolean;
  /** Autocomplete choices, rendered as a <datalist> the input points at. */
  suggestions?: { listId: string; options: string[] };
}

export function TextField({ label, hint, value, onChange, error, tourAnchor, required = false, suggestions }: TextFieldProps) {
  return (
    <FormField label={label} hint={hint} error={error} tourAnchor={tourAnchor}>
      <input
        type="text"
        required={required}
        list={suggestions?.listId}
        value={value}
        onChange={e => onChange(e.target.value)}
        className={INPUT_CLASS}
      />
      {suggestions && (
        <datalist id={suggestions.listId}>
          {suggestions.options.map(option => <option key={option} value={option} />)}
        </datalist>
      )}
    </FormField>
  );
}

export interface NumberFieldSpec {
  label: string;
  step?: string;
  min: string;
  max?: string;
}

interface NumberFieldProps {
  spec: NumberFieldSpec;
  value: string;
  onChange: (value: string) => void;
  error?: string;
}

export function NumberField({ spec, value, onChange, error }: NumberFieldProps) {
  return (
    <FormField label={spec.label} error={error}>
      <input
        type="number"
        step={spec.step}
        min={spec.min}
        max={spec.max}
        value={value}
        onChange={e => onChange(e.target.value)}
        className={INPUT_CLASS}
      />
    </FormField>
  );
}

/** Keeps a form's text inputs in one record, so each field needs no state of its own. */
export function useFieldValues<T extends object>(initial: T) {
  const [values, setValues] = useState<T>(initial);

  // Stable identity, and no state change when the value is unchanged, so
  // effects can depend on it without looping.
  const setValue = useCallback((key: keyof T, value: string) => {
    setValues(prev => (prev[key] === value ? prev : { ...prev, [key]: value }));
  }, []);

  return [values, setValue] as const;
}
