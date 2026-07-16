import { NextRequest, NextResponse } from 'next/server';
import { getDashboardData } from '@/lib/dashboard';
import { requireTenant } from '@/lib/apiRequest';

export async function GET(request: NextRequest) {
  const tenant = requireTenant(request);
  if (tenant instanceof NextResponse) return tenant;

  try {
    return NextResponse.json(getDashboardData(tenant.tenantId));
  } catch (error) {
    console.error('Dashboard API error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
