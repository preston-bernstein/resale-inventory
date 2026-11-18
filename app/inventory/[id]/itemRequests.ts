import type { ItemWithRelations } from '@/lib/types';
import { STATUS_TRANSITIONS } from './itemStatus';

// Pure request-body builders, split out of the event handlers so the
// handlers themselves are just fetch/state orchestration.
function buildPatchBody(
  editListingPrice: string,
  editPlatforms: string[],
  editCondition: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const priceStr = editListingPrice.trim();
  if (priceStr !== '') {
    body.listing_price = Math.round(parseFloat(priceStr) * 100);
  }
  body.platforms = editPlatforms;
  body.condition = editCondition;
  return body;
}

function buildStatusTransitionBody(
  nextStatus: string,
  salePrice: string,
  salePlatform: string,
  saleDate: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = { status: nextStatus };
  if (nextStatus === 'Sold') {
    if (salePrice.trim()) body.sale_price = Math.round(parseFloat(salePrice) * 100);
    if (salePlatform.trim()) body.sale_platform = salePlatform.trim();
    if (saleDate.trim()) body.sale_date = saleDate.trim();
  }
  return body;
}

// Request/response orchestration, split out of the component so the
// component's own body is just wiring hooks to these calls. Each takes the
// state it needs plus the setters it updates as plain arguments — no
// closures over component scope, no custom hook.

export interface LoadItemActions {
  setLoading: (v: boolean) => void;
  setError: (v: string | null) => void;
  setItem: (v: ItemWithRelations | null) => void;
  setEditListingPrice: (v: string) => void;
  setEditPlatforms: (v: string[]) => void;
  setEditCondition: (v: string) => void;
  setNextStatus: (v: string) => void;
}

export async function loadItem(id: string, actions: LoadItemActions): Promise<void> {
  actions.setLoading(true);
  actions.setError(null);
  try {
    const res = await fetch(`/api/items/${id}`, { cache: 'no-store' } as RequestInit);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: ItemWithRelations = await res.json();
    actions.setItem(data);
    actions.setEditListingPrice(data.listing_price !== null ? (data.listing_price / 100).toFixed(2) : '');
    actions.setEditPlatforms(data.platforms);
    actions.setEditCondition(data.details.condition);
    const transitions = STATUS_TRANSITIONS[data.status] ?? [];
    actions.setNextStatus(transitions[0] ?? '');
  } catch (err) {
    console.error('loadItem failed:', err);
    actions.setError(err instanceof Error ? err.message : 'Failed to load item.');
  } finally {
    actions.setLoading(false);
  }
}

export interface PatchFormFields {
  editListingPrice: string;
  editPlatforms: string[];
  editCondition: string;
}

export interface PatchActions {
  setPatchLoading: (v: boolean) => void;
  setPatchError: (v: string) => void;
  setPatchSuccess: (v: string) => void;
  refetch: () => Promise<void>;
}

export async function submitPatch(
  itemId: string,
  fields: PatchFormFields,
  actions: PatchActions,
): Promise<void> {
  actions.setPatchLoading(true);
  actions.setPatchError('');
  actions.setPatchSuccess('');
  try {
    const body = buildPatchBody(fields.editListingPrice, fields.editPlatforms, fields.editCondition);
    const res = await fetch(`/api/items/${itemId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      actions.setPatchSuccess('Saved.');
      await actions.refetch();
    } else {
      const data = await res.json().catch(() => ({}));
      actions.setPatchError(data.error ?? `Error ${res.status}`);
    }
  } catch (err) {
    console.error('submitPatch failed:', err);
    actions.setPatchError('Network error.');
  } finally {
    actions.setPatchLoading(false);
  }
}

export interface StatusTransitionFields {
  nextStatus: string;
  salePrice: string;
  salePlatform: string;
  saleDate: string;
}

export interface StatusTransitionActions {
  setStatusLoading: (v: boolean) => void;
  setStatusError: (v: string) => void;
  refetch: () => Promise<void>;
}

export async function submitStatusTransition(
  itemId: string,
  fields: StatusTransitionFields,
  actions: StatusTransitionActions,
): Promise<void> {
  actions.setStatusLoading(true);
  actions.setStatusError('');
  try {
    const body = buildStatusTransitionBody(
      fields.nextStatus,
      fields.salePrice,
      fields.salePlatform,
      fields.saleDate,
    );
    const res = await fetch(`/api/items/${itemId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      await actions.refetch();
    } else {
      const data = await res.json().catch(() => ({}));
      actions.setStatusError(data.error ?? `Error ${res.status}`);
    }
  } catch (err) {
    console.error('submitStatusTransition failed:', err);
    actions.setStatusError('Network error.');
  } finally {
    actions.setStatusLoading(false);
  }
}
