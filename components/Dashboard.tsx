"use client";

import type { ReactNode } from 'react';
import { BOOK_CONDITIONS, CLOTHING_CONDITIONS } from '@/lib/constants';

interface DashboardData {
  held_count: number;
  held_acquisition_cost: number;
  by_condition: Record<string, number>;
  by_status: Record<string, number>;
  by_category: {
    book: { count: number; acquisition_cost: number };
    clothing: { count: number; acquisition_cost: number };
  };
}

interface DashboardProps {
  data: DashboardData;
}

const PANEL_CLASS = 'rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 p-4';

const STATUS_ORDER = ["Unlisted", "Listed", "Sale Pending", "Sold", "Removed", "Donated", "Discarded"];

const formatCurrency = (cents: number): string => {
  return (cents / 100).toFixed(2);
};

interface SummaryCardProps {
  title: string;
  children: ReactNode;
}

function SummaryCard({ title, children }: SummaryCardProps) {
  return (
    <div className={PANEL_CLASS}>
      <h2 className="text-sm font-semibold text-gray-600 dark:text-gray-400 mb-2">{title}</h2>
      <p className="text-3xl font-bold text-gray-900 dark:text-gray-100">{children}</p>
    </div>
  );
}

interface PanelProps {
  title: string;
  children: ReactNode;
}

function Panel({ title, children }: PanelProps) {
  return (
    <div className={PANEL_CLASS}>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">{title}</h2>
      {children}
    </div>
  );
}

interface StatRowProps {
  label: string;
  value: ReactNode;
}

function StatRow({ label, value }: StatRowProps) {
  return (
    <div className="flex justify-between text-sm">
      <dt className="text-gray-600 dark:text-gray-400">{label}</dt>
      <dd className="font-medium text-gray-900 dark:text-gray-100">{value}</dd>
    </div>
  );
}

interface StatGroupProps {
  heading: string;
  children: ReactNode;
}

function StatGroup({ heading, children }: StatGroupProps) {
  return (
    <div>
      <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase mb-2">{heading}</h3>
      <dl className="space-y-2">{children}</dl>
    </div>
  );
}

interface CategoryTotals {
  count: number;
  acquisition_cost: number;
}

function CategoryStats({ heading, totals }: { heading: string; totals: CategoryTotals }) {
  return (
    <StatGroup heading={heading}>
      <StatRow label="Count" value={totals.count} />
      <StatRow label="Acquisition Cost" value={`$${formatCurrency(totals.acquisition_cost)}`} />
    </StatGroup>
  );
}

interface ConditionStatsProps {
  heading: string;
  conditions: readonly string[];
  counts: Record<string, number>;
}

function ConditionStats({ heading, conditions, counts }: ConditionStatsProps) {
  return (
    <StatGroup heading={heading}>
      {conditions.map((condition) => (
        <StatRow key={condition} label={condition} value={counts[condition]} />
      ))}
    </StatGroup>
  );
}

export default function Dashboard({ data }: DashboardProps) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4">
        <SummaryCard title="Items Held">{data.held_count}</SummaryCard>
        <SummaryCard title="Acquisition Cost (Held)">
          ${formatCurrency(data.held_acquisition_cost)}
        </SummaryCard>
      </div>

      <Panel title="By Category">
        <div className="grid grid-cols-2 gap-4">
          <CategoryStats heading="Books" totals={data.by_category.book} />
          <CategoryStats heading="Clothing" totals={data.by_category.clothing} />
        </div>
      </Panel>

      <Panel title="By Condition">
        <div className="grid grid-cols-2 gap-4">
          <ConditionStats heading="Books" conditions={BOOK_CONDITIONS} counts={data.by_condition} />
          <ConditionStats heading="Clothing" conditions={CLOTHING_CONDITIONS} counts={data.by_condition} />
        </div>
      </Panel>

      <Panel title="By Status">
        <dl className="space-y-2">
          {STATUS_ORDER.map((status) => (
            <StatRow key={status} label={status} value={data.by_status[status]} />
          ))}
        </dl>
      </Panel>
    </div>
  );
}
