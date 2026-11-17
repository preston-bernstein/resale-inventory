import Image from 'next/image';
import type { ItemWithRelations, BookDetails, ClothingDetails, ElectronicsDetails, Photo } from '@/lib/types';

const MEASUREMENT_LABELS: Record<string, string> = {
  pit_to_pit_in: 'Pit to Pit',
  length_in: 'Length',
  sleeve_length_in: 'Sleeve Length',
  waist_in: 'Waist',
  rise_in: 'Rise',
  inseam_in: 'Inseam',
  leg_opening_in: 'Leg Opening',
  hip_in: 'Hip',
};

const MEASUREMENT_FIELDS = [
  'pit_to_pit_in',
  'length_in',
  'sleeve_length_in',
  'waist_in',
  'rise_in',
  'inseam_in',
  'leg_opening_in',
  'hip_in',
] as const;

function fmt(cents: number | null): string {
  if (cents === null) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return iso.slice(0, 10);
}

export function HeroPhoto({ photo, itemId, title }: { photo: Photo; itemId: string; title: string }) {
  return (
    <div className="relative w-full aspect-[4/5] sm:aspect-video rounded-lg overflow-hidden bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700">
      <Image
        src={`/api/items/${itemId}/photos/${photo.id}`}
        alt={title}
        fill={true}
        sizes="(max-width: 640px) 100vw, 672px"
        className="object-cover"
        priority={true}
      />
    </div>
  );
}

export function DetailsSection({ item, grossProfit }: { item: ItemWithRelations; grossProfit: number | null }) {
  return (
    <section className="border border-gray-200 dark:border-gray-700 rounded p-4 space-y-2 text-sm">
      <h2 className="font-medium text-gray-700 dark:text-gray-300 mb-2">Details</h2>
      <Row label="Title" value={item.title} />
      {item.category === 'book' ? (
        <BookDetailRows details={item.details as BookDetails} />
      ) : item.category === 'clothing' ? (
        <ClothingDetailRows details={item.details as ClothingDetails} />
      ) : (
        <ElectronicsDetailRows details={item.details as ElectronicsDetails} />
      )}
      <Row label="Status" value={item.status} />
      <Row label="Acquisition Cost" value={fmt(item.acquisition_cost)} />
      <Row label="Acquisition Date" value={fmtDate(item.acquisition_date)} />
      <Row label="Listing Price" value={fmt(item.listing_price)} />
      <Row label="Platforms" value={item.platforms.length > 0 ? item.platforms.join(', ') : '—'} />
      {item.status === 'Sold' || item.sale_price !== null ? (
        <>
          <Row label="Sale Price" value={fmt(item.sale_price)} />
          <Row label="Sale Platform" value={item.sale_platform ?? '—'} />
          <Row label="Sale Date" value={fmtDate(item.sale_date)} />
        </>
      ) : null}
      {item.status === 'Sold' && grossProfit !== null && (
        <Row label="Gross Profit" value={fmt(grossProfit)} highlight />
      )}
    </section>
  );
}

export function PriceHistoryTable({ priceHistory }: { priceHistory: ItemWithRelations['price_history'] }) {
  return (
    <section className="border border-gray-200 dark:border-gray-700 rounded p-4 text-sm">
      <h2 className="font-medium text-gray-700 dark:text-gray-300 mb-3">Price History</h2>
      <table className="w-full text-xs border border-gray-200 dark:border-gray-700">
        <thead className="bg-gray-50 dark:bg-gray-800">
          <tr>
            <th className="text-left px-3 py-2 font-medium text-gray-600 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">Previous</th>
            <th className="text-left px-3 py-2 font-medium text-gray-600 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">New</th>
            <th className="text-left px-3 py-2 font-medium text-gray-600 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">Changed At</th>
          </tr>
        </thead>
        <tbody>
          {priceHistory.map(row => (
            <tr key={row.id} className="border-b border-gray-100 dark:border-gray-800">
              <td className="px-3 py-2 text-gray-900 dark:text-gray-100">{fmt(row.previous_price)}</td>
              <td className="px-3 py-2 text-gray-900 dark:text-gray-100">{fmt(row.new_price)}</td>
              <td className="px-3 py-2 text-gray-900 dark:text-gray-100">{new Date(row.changed_at).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function BookDetailRows({ details }: { details: BookDetails }) {
  return (
    <>
      <Row label="Author" value={details.author} />
      <Row label="Publisher" value={details.publisher ?? '—'} />
      <Row label="ISBN" value={details.isbn ?? '—'} />
      <Row label="Condition" value={details.condition} />
    </>
  );
}

function ClothingDetailRows({ details }: { details: ClothingDetails }) {
  return (
    <>
      <Row label="Brand" value={details.brand} />
      <Row label="Size" value={details.size_label} />
      {details.color !== null && <Row label="Color" value={details.color} />}
      {details.material !== null && <Row label="Material" value={details.material} />}
      {details.gender_department !== null && <Row label="Department" value={details.gender_department} />}
      {details.weight_oz !== null && <Row label="Weight" value={`${details.weight_oz} oz`} />}
      {MEASUREMENT_FIELDS.map(field =>
        details[field] !== null ? (
          <Row key={field} label={MEASUREMENT_LABELS[field]} value={`${details[field]}"`} />
        ) : null,
      )}
      <Row label="Condition" value={details.condition} />
    </>
  );
}

function ElectronicsDetailRows({ details }: { details: ElectronicsDetails }) {
  return (
    <>
      <Row label="Device Type" value={details.device_type} />
      <Row label="Brand" value={details.brand} />
      <Row label="Model" value={details.model} />
      {details.processor !== null && <Row label="Processor" value={details.processor} />}
      {details.ram_gb !== null && <Row label="RAM" value={`${details.ram_gb} GB`} />}
      {details.storage_gb !== null && <Row label="Storage" value={`${details.storage_gb} GB`} />}
      {details.screen_size_in !== null && <Row label="Screen Size" value={`${details.screen_size_in}"`} />}
      {details.battery_health_pct !== null && <Row label="Battery Health" value={`${details.battery_health_pct}%`} />}
      {details.battery_cycle_count !== null && <Row label="Battery Cycle Count" value={`${details.battery_cycle_count}`} />}
      <Row label="Condition" value={details.condition} />
    </>
  );
}

function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex gap-2">
      <span className="w-40 text-gray-500 dark:text-gray-400 flex-shrink-0">{label}</span>
      <span className={highlight ? 'font-semibold text-green-700 dark:text-green-400' : 'text-gray-900 dark:text-gray-100'}>{value}</span>
    </div>
  );
}
