import { NextResponse } from 'next/server';
import db from '@/lib/db';
import { CONDITIONS as ALL_CONDITIONS } from '@/lib/constants';

const HELD_STATUSES = ['Unlisted', 'Listed', 'Sale Pending'];
const ALL_STATUSES = ['Unlisted', 'Listed', 'Sale Pending', 'Sold', 'Removed', 'Donated', 'Discarded'];

export async function GET() {
  try {
    // Get held count and held acquisition cost
    const heldStmt = db.prepare(`
      SELECT
        COUNT(*) as held_count,
        COALESCE(SUM(acquisition_cost), 0) as held_acquisition_cost
      FROM books
      WHERE status IN (?, ?, ?)
    `);
    const heldResult = heldStmt.get(...HELD_STATUSES) as {
      held_count: number;
      held_acquisition_cost: number;
    };

    // Get condition counts
    const conditionStmt = db.prepare(`
      SELECT condition, COUNT(*) as count
      FROM books
      GROUP BY condition
    `);
    const conditionRows = conditionStmt.all() as Array<{
      condition: string;
      count: number;
    }>;
    const by_condition: Record<string, number> = {};
    ALL_CONDITIONS.forEach((c) => {
      by_condition[c] = 0;
    });
    conditionRows.forEach((row) => {
      by_condition[row.condition] = row.count;
    });

    // Get status counts
    const statusStmt = db.prepare(`
      SELECT status, COUNT(*) as count
      FROM books
      GROUP BY status
    `);
    const statusRows = statusStmt.all() as Array<{
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

    return NextResponse.json({
      held_count: heldResult.held_count,
      held_acquisition_cost: heldResult.held_acquisition_cost,
      by_condition,
      by_status,
    });
  } catch (error) {
    console.error('Dashboard API error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
