import { NextResponse } from 'next/server';
import { getDashboardData } from '@/lib/dashboard';

export async function GET() {
  try {
    return NextResponse.json(getDashboardData());
  } catch (error) {
    console.error('Dashboard API error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
