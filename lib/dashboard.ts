import db from '@/lib/db';
import {
  CATEGORIES,
  BOOK_CONDITIONS,
  CLOTHING_CONDITIONS,
  ELECTRONICS_CONDITIONS,
  type Category,
} from '@/lib/constants';

const HELD_STATUSES = ['Unlisted', 'Listed', 'Sale Pending'];
const ALL_STATUSES = ['Unlisted', 'Listed', 'Sale Pending', 'Sold', 'Removed', 'Donated', 'Discarded'];

export interface DashboardData {
  held_count: number;
  held_acquisition_cost: number;
  by_condition: Record<string, number>;
  by_status: Record<string, number>;
  by_category: Record<Category, { count: number; acquisition_cost: number }>;
}

function getHeldTotals(tenantId: string): { held_count: number; held_acquisition_cost: number } {
  const heldStmt = db.prepare(`
    SELECT
      COUNT(*) as held_count,
      COALESCE(SUM(acquisition_cost), 0) as held_acquisition_cost
    FROM items
    WHERE status IN (?, ?, ?) AND tenant_id = ?
  `);
  return heldStmt.get(...HELD_STATUSES, tenantId) as {
    held_count: number;
    held_acquisition_cost: number;
  };
}

// Condition lives on the per-category satellite tables, not on items.
const CONDITION_TABLES = ['book_details', 'clothing_details', 'electronics_details'];

// ELECTRONICS_CONDITIONS shares literal strings ('Good', 'Fair') with
// BOOK_CONDITIONS / CLOTHING_CONDITIONS respectively, so rows are
// accumulated (+=) rather than assigned (=) into each bucket -- otherwise
// whichever category's query ran last would clobber the other's count.
function getConditionCounts(tenantId: string): Record<string, number> {
  const by_condition: Record<string, number> = {};
  for (const condition of [...BOOK_CONDITIONS, ...CLOTHING_CONDITIONS, ...ELECTRONICS_CONDITIONS]) {
    by_condition[condition] = 0;
  }

  for (const table of CONDITION_TABLES) {
    const rows = db
      .prepare(
        `
    SELECT d.condition as condition, COUNT(*) as count
    FROM items i
    JOIN ${table} d ON d.item_id = i.id
    WHERE i.tenant_id = ? AND d.tenant_id = ?
    GROUP BY d.condition
  `,
      )
      .all(tenantId, tenantId) as Array<{ condition: string; count: number }>;
    for (const row of rows) {
      by_condition[row.condition] += row.count;
    }
  }
  return by_condition;
}

// Status lives on items for every category.
function getStatusCounts(tenantId: string): Record<string, number> {
  const statusStmt = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM items
    WHERE tenant_id = ?
    GROUP BY status
  `);
  const statusRows = statusStmt.all(tenantId) as Array<{
    status: string;
    count: number;
  }>;
  const by_status: Record<string, number> = {};
  ALL_STATUSES.forEach((s) => {
    by_status[s] = 0;
  });
  statusRows.forEach((row) => {
    by_status[row.status] = row.count;
  });
  return by_status;
}

// Per-category totals cover all statuses, not just held.
function getCategoryTotals(tenantId: string): DashboardData['by_category'] {
  const by_category = {} as Record<Category, { count: number; acquisition_cost: number }>;
  CATEGORIES.forEach((c) => {
    by_category[c] = { count: 0, acquisition_cost: 0 };
  });

  const categoryStmt = db.prepare(`
    SELECT category, COUNT(*) as count, COALESCE(SUM(acquisition_cost), 0) as acquisition_cost
    FROM items
    WHERE tenant_id = ?
    GROUP BY category
  `);
  const categoryRows = categoryStmt.all(tenantId) as Array<{
    category: Category;
    count: number;
    acquisition_cost: number;
  }>;
  categoryRows.forEach((row) => {
    by_category[row.category] = {
      count: row.count,
      acquisition_cost: row.acquisition_cost,
    };
  });
  return by_category;
}

export function getDashboardData(tenantId: string): DashboardData {
  const heldResult = getHeldTotals(tenantId);
  return {
    held_count: heldResult.held_count,
    held_acquisition_cost: heldResult.held_acquisition_cost,
    by_condition: getConditionCounts(tenantId),
    by_status: getStatusCounts(tenantId),
    by_category: getCategoryTotals(tenantId),
  };
}
