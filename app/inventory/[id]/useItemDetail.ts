import { useEffect, useState, useCallback } from 'react';
import type { ItemWithRelations, Photo } from '@/lib/types';
import type { EditFormProps, StatusFormProps } from './ItemForms';
import { loadItem, submitPatch, submitStatusTransition } from './itemRequests';

type Refetch = () => Promise<void>;

/** State of the "Edit Listing" form, and the setters loadItem fills it with. */
function useEditListingForm(item: ItemWithRelations | null, refetch: Refetch) {
  const [editListingPrice, setEditListingPrice] = useState('');
  const [editPlatforms, setEditPlatforms] = useState<string[]>([]);
  const [editCondition, setEditCondition] = useState('');
  const [patchLoading, setPatchLoading] = useState(false);
  const [patchError, setPatchError] = useState('');
  const [patchSuccess, setPatchSuccess] = useState('');

  async function handlePatch(e: React.FormEvent) {
    e.preventDefault();
    if (!item) return;
    await submitPatch(
      item.id,
      { editListingPrice, editPlatforms, editCondition },
      { setPatchLoading, setPatchError, setPatchSuccess, refetch },
    );
  }

  const form: EditFormProps = {
    price: editListingPrice,
    onPriceChange: setEditListingPrice,
    platforms: editPlatforms,
    onPlatformsChange: setEditPlatforms,
    condition: editCondition,
    onConditionChange: setEditCondition,
    loading: patchLoading,
    error: patchError,
    success: patchSuccess,
    onSubmit: (e) => { void handlePatch(e); },
  };
  return { form, setEditListingPrice, setEditPlatforms, setEditCondition };
}

/** State of the "Change Status" form, and the setter loadItem fills it with. */
function useStatusTransitionForm(item: ItemWithRelations | null, refetch: Refetch) {
  const [nextStatus, setNextStatus] = useState('');
  const [salePrice, setSalePrice] = useState('');
  const [salePlatform, setSalePlatform] = useState('');
  const [saleDate, setSaleDate] = useState('');
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState('');

  async function handleStatusTransition(e: React.FormEvent) {
    e.preventDefault();
    if (!item || !nextStatus) return;
    await submitStatusTransition(
      item.id,
      { nextStatus, salePrice, salePlatform, saleDate },
      { setStatusLoading, setStatusError, refetch },
    );
  }

  const form: StatusFormProps = {
    nextStatus,
    onNextStatusChange: setNextStatus,
    salePrice,
    onSalePriceChange: setSalePrice,
    salePlatform,
    onSalePlatformChange: setSalePlatform,
    saleDate,
    onSaleDateChange: setSaleDate,
    loading: statusLoading,
    error: statusError,
    onSubmit: (e) => { void handleStatusTransition(e); },
  };
  return { form, setNextStatus };
}

/** Item state, its two edit forms' state, and the handlers that talk to the API. */
export function useItemDetail(id: string) {
  const [item, setItem] = useState<ItemWithRelations | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Both forms refetch the item after a successful save, and loadItem in
  // turn fills both forms, so each side reaches the other through a closure
  // that only runs after the hooks below have all been set up.
  const refetch = () => fetchItem();
  const edit = useEditListingForm(item, refetch);
  const status = useStatusTransitionForm(item, refetch);
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

  function handlePhotosChange(photos: Photo[]) {
    setItem(prev => (prev ? { ...prev, photos } : prev));
  }

  return { item, loading, error, editForm: edit.form, statusForm: status.form, handlePhotosChange };
}
