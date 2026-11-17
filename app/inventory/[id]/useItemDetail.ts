'use client';

import { useEffect, useState, useCallback } from 'react';
import type { ItemWithRelations, Photo } from '@/lib/types';
import type { EditFormProps, StatusFormProps } from './ListingForms';

const TERMINAL_STATUSES = new Set(['Sold', 'Removed', 'Donated', 'Discarded']);

const STATUS_TRANSITIONS: Record<string, string[]> = {
  Unlisted: ['Listed', 'Donated', 'Discarded'],
  Listed: ['Unlisted', 'Sale Pending', 'Removed', 'Donated', 'Discarded'],
  'Sale Pending': ['Listed', 'Sold'],
};

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

interface LoadItemActions {
  setLoading: (v: boolean) => void;
  setError: (v: string | null) => void;
  setItem: (v: ItemWithRelations | null) => void;
  setEditListingPrice: (v: string) => void;
  setEditPlatforms: (v: string[]) => void;
  setEditCondition: (v: string) => void;
  setNextStatus: (v: string) => void;
}

async function loadItem(id: string, actions: LoadItemActions): Promise<void> {
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

interface PatchFormFields {
  editListingPrice: string;
  editPlatforms: string[];
  editCondition: string;
}

interface PatchActions {
  setPatchLoading: (v: boolean) => void;
  setPatchError: (v: string) => void;
  setPatchSuccess: (v: string) => void;
  refetch: () => Promise<void>;
}

async function submitPatch(
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

interface StatusTransitionFields {
  nextStatus: string;
  salePrice: string;
  salePlatform: string;
  saleDate: string;
}

interface StatusTransitionActions {
  setStatusLoading: (v: boolean) => void;
  setStatusError: (v: string) => void;
  refetch: () => Promise<void>;
}

async function submitStatusTransition(
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

function useEditState() {
  const [editListingPrice, setEditListingPrice] = useState('');
  const [editPlatforms, setEditPlatforms] = useState<string[]>([]);
  const [editCondition, setEditCondition] = useState('');
  const [patchLoading, setPatchLoading] = useState(false);
  const [patchError, setPatchError] = useState('');
  const [patchSuccess, setPatchSuccess] = useState('');

  return {
    editListingPrice,
    setEditListingPrice,
    editPlatforms,
    setEditPlatforms,
    editCondition,
    setEditCondition,
    patchLoading,
    setPatchLoading,
    patchError,
    setPatchError,
    patchSuccess,
    setPatchSuccess,
  };
}

function useStatusState() {
  const [nextStatus, setNextStatus] = useState('');
  const [salePrice, setSalePrice] = useState('');
  const [salePlatform, setSalePlatform] = useState('');
  const [saleDate, setSaleDate] = useState('');
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState('');

  return {
    nextStatus,
    setNextStatus,
    salePrice,
    setSalePrice,
    salePlatform,
    setSalePlatform,
    saleDate,
    setSaleDate,
    statusLoading,
    setStatusLoading,
    statusError,
    setStatusError,
  };
}

type EditState = ReturnType<typeof useEditState>;

type StatusState = ReturnType<typeof useStatusState>;

type Refetch = () => Promise<void>;

function makePatchHandler(item: ItemWithRelations | null, edit: EditState, refetch: Refetch) {
  return async function handlePatch(e: React.FormEvent) {
    e.preventDefault();
    if (!item) return;
    await submitPatch(
      item.id,
      { editListingPrice: edit.editListingPrice, editPlatforms: edit.editPlatforms, editCondition: edit.editCondition },
      { setPatchLoading: edit.setPatchLoading, setPatchError: edit.setPatchError, setPatchSuccess: edit.setPatchSuccess, refetch },
    );
  };
}

function makeStatusHandler(item: ItemWithRelations | null, status: StatusState, refetch: Refetch) {
  return async function handleStatusTransition(e: React.FormEvent) {
    e.preventDefault();
    if (!item || !status.nextStatus) return;
    await submitStatusTransition(
      item.id,
      {
        nextStatus: status.nextStatus,
        salePrice: status.salePrice,
        salePlatform: status.salePlatform,
        saleDate: status.saleDate,
      },
      { setStatusLoading: status.setStatusLoading, setStatusError: status.setStatusError, refetch },
    );
  };
}

function toEditFormProps(edit: EditState, onSubmit: EditFormProps['onSubmit']): EditFormProps {
  return {
    price: edit.editListingPrice,
    onPriceChange: edit.setEditListingPrice,
    platforms: edit.editPlatforms,
    onPlatformsChange: edit.setEditPlatforms,
    condition: edit.editCondition,
    onConditionChange: edit.setEditCondition,
    loading: edit.patchLoading,
    error: edit.patchError,
    success: edit.patchSuccess,
    onSubmit,
  };
}

function toStatusFormProps(status: StatusState, onSubmit: StatusFormProps['onSubmit']): StatusFormProps {
  return {
    nextStatus: status.nextStatus,
    onNextStatusChange: status.setNextStatus,
    salePrice: status.salePrice,
    onSalePriceChange: status.setSalePrice,
    salePlatform: status.salePlatform,
    onSalePlatformChange: status.setSalePlatform,
    saleDate: status.saleDate,
    onSaleDateChange: status.setSaleDate,
    loading: status.statusLoading,
    error: status.statusError,
    onSubmit,
  };
}

export function useItemDetail(id: string) {
  const [item, setItem] = useState<ItemWithRelations | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const edit = useEditState();
  const status = useStatusState();

  const { setEditListingPrice, setEditPlatforms, setEditCondition } = edit;
  const { setNextStatus } = status;

  const fetchItem = useCallback(async () => {
    await loadItem(id, {
      setLoading,
      setError,
      setItem,
      setEditListingPrice,
      setEditPlatforms,
      setEditCondition,
      setNextStatus,
    });
  }, [id, setEditListingPrice, setEditPlatforms, setEditCondition, setNextStatus]);

  useEffect(() => {
    void fetchItem();
  }, [fetchItem]);

  const handlePatch = makePatchHandler(item, edit, fetchItem);
  const handleStatusTransition = makeStatusHandler(item, status, fetchItem);

  const editForm = toEditFormProps(edit, (e) => { void handlePatch(e); });
  const statusForm = toStatusFormProps(status, (e) => { void handleStatusTransition(e); });

  function handlePhotosChange(photos: Photo[]) {
    setItem(prev => (prev ? { ...prev, photos } : prev));
  }

  return { item, loading, error, editForm, statusForm, handlePhotosChange };
}

export interface DerivedItemView {
  isTerminal: boolean;
  transitions: string[];
  grossProfit: number | null;
  heroPhoto: Photo | null;
}

// Pure derivation of the view-only values computed from `item` — split out
// so ItemDetailPage's own body doesn't carry this branching.
export function deriveItemView(item: ItemWithRelations): DerivedItemView {
  const isTerminal = TERMINAL_STATUSES.has(item.status);
  const transitions = STATUS_TRANSITIONS[item.status] ?? [];
  const grossProfit =
    item.status === 'Sold' && item.sale_price !== null ? item.sale_price - item.acquisition_cost : null;
  const heroPhoto =
    item.category === 'clothing' && item.photos.length > 0
      ? [...item.photos].sort((a, b) => a.sort_order - b.sort_order)[0]
      : null;
  return { isTerminal, transitions, grossProfit, heroPhoto };
}
