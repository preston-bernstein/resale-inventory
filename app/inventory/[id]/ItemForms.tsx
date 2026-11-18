import { conditionsForCategory, platformsForCategory } from '@/lib/constants';
import type { ItemWithRelations } from '@/lib/types';
import { SALE_PLATFORMS } from './itemStatus';

export interface EditFormProps {
  price: string;
  onPriceChange: (value: string) => void;
  platforms: string[];
  onPlatformsChange: (value: string[]) => void;
  condition: string;
  onConditionChange: (value: string) => void;
  loading: boolean;
  error: string;
  success: string;
  onSubmit: (e: React.FormEvent) => void;
}

export interface StatusFormProps {
  nextStatus: string;
  onNextStatusChange: (value: string) => void;
  salePrice: string;
  onSalePriceChange: (value: string) => void;
  salePlatform: string;
  onSalePlatformChange: (value: string) => void;
  saleDate: string;
  onSaleDateChange: (value: string) => void;
  loading: boolean;
  error: string;
  onSubmit: (e: React.FormEvent) => void;
}

const LABEL_CLASS = 'block text-xs text-gray-600 dark:text-gray-400 mb-1';
const FIELD_CLASS =
  'w-full border border-gray-300 dark:border-gray-700 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-gray-500 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-500';

function MoneyField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label className={LABEL_CLASS}>{label}</label>
      <input
        type="number"
        min="0"
        step="0.01"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="0.00"
        className={FIELD_CLASS}
      />
    </div>
  );
}

function PlatformCheckboxes({
  category,
  platforms,
  onChange,
}: {
  category: ItemWithRelations['category'];
  platforms: string[];
  onChange: (value: string[]) => void;
}) {
  return (
    <div>
      <label className={LABEL_CLASS}>Platforms</label>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {platformsForCategory(category).map(platform => (
          <label key={platform} className="flex items-center gap-1.5 text-sm text-gray-900 dark:text-gray-100">
            <input
              type="checkbox"
              checked={platforms.includes(platform)}
              onChange={e => {
                const next = e.target.checked
                  ? [...platforms, platform]
                  : platforms.filter(p => p !== platform);
                onChange(next);
              }}
              className="rounded border-gray-300 dark:border-gray-700"
            />
            {platform}
          </label>
        ))}
      </div>
    </div>
  );
}

function FormMessages({ error, success }: { error: string; success?: string }) {
  return (
    <>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      {success && <p className="text-xs text-green-700 dark:text-green-400">{success}</p>}
    </>
  );
}

export function EditListingForm({
  category,
  form,
}: {
  category: ItemWithRelations['category'];
  form: EditFormProps;
}) {
  return (
    <section className="border border-gray-200 dark:border-gray-700 rounded p-4 space-y-4 text-sm">
      <h2 className="font-medium text-gray-700 dark:text-gray-300">Edit Listing</h2>
      <form onSubmit={form.onSubmit} className="space-y-3">
        <MoneyField label="Listing Price (USD)" value={form.price} onChange={form.onPriceChange} />
        <PlatformCheckboxes category={category} platforms={form.platforms} onChange={form.onPlatformsChange} />
        <div>
          <label className={LABEL_CLASS}>Condition</label>
          <select
            value={form.condition}
            onChange={e => form.onConditionChange(e.target.value)}
            className={FIELD_CLASS}
          >
            {conditionsForCategory(category).map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <FormMessages error={form.error} success={form.success} />
        <button
          type="submit"
          disabled={form.loading}
          className="border border-gray-300 dark:border-gray-600 rounded px-3 py-1.5 text-sm bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-gray-200 disabled:opacity-50"
        >
          {form.loading ? 'Saving…' : 'Save Changes'}
        </button>
      </form>
    </section>
  );
}

function SaleFields({ form }: { form: StatusFormProps }) {
  return (
    <>
      <MoneyField label="Sale Price (USD)" value={form.salePrice} onChange={form.onSalePriceChange} />
      <div>
        <label className={LABEL_CLASS}>Sale Platform</label>
        <select
          value={form.salePlatform}
          onChange={e => form.onSalePlatformChange(e.target.value)}
          className={FIELD_CLASS}
        >
          <option value="">— select —</option>
          {SALE_PLATFORMS.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>
      <div>
        <label className={LABEL_CLASS}>Sale Date</label>
        <input
          type="date"
          value={form.saleDate}
          onChange={e => form.onSaleDateChange(e.target.value)}
          className={FIELD_CLASS}
        />
      </div>
    </>
  );
}

export function ChangeStatusForm({
  transitions,
  form,
}: {
  transitions: string[];
  form: StatusFormProps;
}) {
  return (
    <section className="border border-gray-200 dark:border-gray-700 rounded p-4 space-y-4 text-sm">
      <h2 className="font-medium text-gray-700 dark:text-gray-300">Change Status</h2>
      <form onSubmit={form.onSubmit} className="space-y-3">
        <div>
          <label className={LABEL_CLASS}>Transition to</label>
          <select
            value={form.nextStatus}
            onChange={e => form.onNextStatusChange(e.target.value)}
            className={FIELD_CLASS}
          >
            {transitions.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        {form.nextStatus === 'Sold' && <SaleFields form={form} />}

        <FormMessages error={form.error} />
        <button
          type="submit"
          disabled={form.loading || !form.nextStatus}
          className="border border-gray-300 dark:border-gray-600 rounded px-3 py-1.5 text-sm bg-gray-900 dark:bg-white text-white dark:text-gray-900 hover:bg-gray-700 dark:hover:bg-gray-200 disabled:opacity-50"
        >
          {form.loading ? 'Updating…' : `Set to ${form.nextStatus || '…'}`}
        </button>
      </form>
    </section>
  );
}
