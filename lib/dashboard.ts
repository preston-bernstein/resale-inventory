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

export function getDashboardData(tenantId: string): DashboardData {
  // Get held count and held acquisition cost (category-agnostic, spans both categories)
  const heldStmt = db.prepare(`
    SELECT
      COUNT(*) as held_count,
      COALESCE(SUM(acquisition_cost), 0) as held_acquisition_cost
    FROM items
    WHERE status IN (?, ?, ?) AND tenant_id = ?
  `);
  const heldResult = heldStmt.get(...HELD_STATUSES, tenantId) as {
    held_count: number;
    held_acquisition_cost: number;
  };

  // Get condition counts. Condition lives on the per-category satellite
  // tables (book_details / clothing_details / electronics_details), not on
  // items, so combine three separate GROUP BY queries into one flat object.
  // ELECTRONICS_CONDITIONS shares literal strings ('Good', 'Fair') with
  // BOOK_CONDITIONS / CLOTHING_CONDITIONS respectively, so rows are
  // accumulated (+=) rather than assigned (=) into each bucket -- otherwise
  // whichever category's query ran last would clobber the other's count.
  const by_condition: Record<string, number> = {};
  BOOK_CONDITIONS.forEach((c) => {
    by_condition[c] = 0;
  });
  CLOTHING_CONDITIONS.forEach((c) => {
    by_condition[c] = 0;
  });
  ELECTRONICS_CONDITIONS.forEach((c) => {
    by_condition[c] = 0;
  });

  const bookConditionStmt = db.prepare(`
    SELECT bd.condition as condition, COUNT(*) as count
    FROM items i
    JOIN book_details bd ON bd.item_id = i.id
    WHERE i.tenant_id = ? AND bd.tenant_id = ?
    GROUP BY bd.condition
  `);
  const bookConditionRows = bookConditionStmt.all(tenantId, tenantId) as Array<{
    condition: string;
    count: number;
  }>;
  bookConditionRows.forEach((row) => {
    by_condition[row.condition] += row.count;
  });

  const clothingConditionStmt = db.prepare(`
    SELECT cd.condition as condition, COUNT(*) as count
    FROM items i
    JOIN clothing_details cd ON cd.item_id = i.id
    WHERE i.tenant_id = ? AND cd.tenant_id = ?
    GROUP BY cd.condition
  `);
  const clothingConditionRows = clothingConditionStmt.all(tenantId, tenantId) as Array<{
    condition: string;
    count: number;
  }>;
  clothingConditionRows.forEach((row) => {
    by_condition[row.condition] += row.count;
  });

  const electronicsConditionStmt = db.prepare(`
    SELECT ed.condition as condition, COUNT(*) as count
    FROM items i
    JOIN electronics_details ed ON ed.item_id = i.id
    WHERE i.tenant_id = ? AND ed.tenant_id = ?
    GROUP BY ed.condition
  `);
  const electronicsConditionRows = electronicsConditionStmt.all(tenantId, tenantId) as Array<{
    condition: string;
    count: number;
  }>;
  electronicsConditionRows.forEach((row) => {
    by_condition[row.condition] += row.count;
  });

  // Get status counts (status lives on items for both categories)
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

  // Get per-category totals (all statuses, not just held)
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

  return {
    held_count: heldResult.held_count,
    held_acquisition_cost: heldResult.held_acquisition_cost,
    by_condition,
    by_status,
    by_category,
  };
}
