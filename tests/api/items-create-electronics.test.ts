import { describe, it, expect, beforeEach } from 'vitest';
import { POST } from '@/app/api/items/route';
import {
  postRequest,
  validBook,
  validElectronics,
  resetItemsAndTenant,
} from '../fixtures/itemsApi';

describe('POST /api/items', () => {
  beforeEach(resetItemsAndTenant);

  it('electronics missing brand → 422 with fields includes brand', async () => {
    const res = await POST(postRequest(validElectronics({ brand: '' })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('Validation failed.');
    expect(body.fields).toContain('brand');
  });

  it('electronics missing model → 422 with fields includes model', async () => {
    const res = await POST(postRequest(validElectronics({ model: '' })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('model');
  });

  it('electronics brand of the wrong type (number) → 422 with fields includes brand (not a crash)', async () => {
    const res = await POST(postRequest(validElectronics({ brand: 42 })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('brand');
  });

  it('electronics model of the wrong type (number) → 422 with fields includes model (not a crash)', async () => {
    const res = await POST(postRequest(validElectronics({ model: 42 })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('model');
  });

  it('electronics brand exactly matching the literal string "Stryker was here!" round-trips correctly', async () => {
    const res = await POST(postRequest(validElectronics({ brand: 'Stryker was here!' })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.brand).toBe('Stryker was here!');
  });

  it('electronics model exactly matching the literal string "Stryker was here!" round-trips correctly', async () => {
    const res = await POST(postRequest(validElectronics({ model: 'Stryker was here!' })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.model).toBe('Stryker was here!');
  });
});

describe('POST /api/items', () => {
  beforeEach(resetItemsAndTenant);

  it('electronics processor is trimmed and persisted when provided', async () => {
    const res = await POST(postRequest(validElectronics({ processor: '  M2 Pro  ' })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.processor).toBe('M2 Pro');
  });

  it('electronics ram_gb valid positive value is persisted', async () => {
    const res = await POST(postRequest(validElectronics({ ram_gb: 16 })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ram_gb).toBe(16);
  });

  it('electronics ram_gb of 0 → 422 with fields includes ram_gb', async () => {
    const res = await POST(postRequest(validElectronics({ ram_gb: 0 })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('ram_gb');
  });

  it('electronics storage_gb valid positive value is persisted', async () => {
    const res = await POST(postRequest(validElectronics({ storage_gb: 512 })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.storage_gb).toBe(512);
  });

  it('electronics negative storage_gb → 422 with fields includes storage_gb', async () => {
    const res = await POST(postRequest(validElectronics({ storage_gb: -1 })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('storage_gb');
  });

  it('electronics screen_size_in valid positive value is persisted', async () => {
    const res = await POST(postRequest(validElectronics({ screen_size_in: 14.2 })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.screen_size_in).toBe(14.2);
  });
});

describe('POST /api/items', () => {
  beforeEach(resetItemsAndTenant);

  it('electronics negative screen_size_in → 422 with fields includes screen_size_in', async () => {
    const res = await POST(postRequest(validElectronics({ screen_size_in: -1 })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('screen_size_in');
  });

  it('electronics battery_health_pct valid boundary values (0 and 100) are persisted', async () => {
    const res0 = await POST(postRequest(validElectronics({ battery_health_pct: 0 })));
    expect(res0.status).toBe(201);
    expect((await res0.json()).battery_health_pct).toBe(0);

    const res100 = await POST(postRequest(validElectronics({ battery_health_pct: 100 })));
    expect(res100.status).toBe(201);
    expect((await res100.json()).battery_health_pct).toBe(100);
  });

  it('electronics battery_health_pct of 101 → 422 with fields includes battery_health_pct', async () => {
    const res = await POST(postRequest(validElectronics({ battery_health_pct: 101 })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('battery_health_pct');
  });

  it('electronics battery_cycle_count valid non-negative value is persisted', async () => {
    const res = await POST(postRequest(validElectronics({ battery_cycle_count: 50 })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.battery_cycle_count).toBe(50);
  });

  it('electronics negative battery_cycle_count → 422 with fields includes battery_cycle_count', async () => {
    const res = await POST(postRequest(validElectronics({ battery_cycle_count: -1 })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('battery_cycle_count');
  });
});

describe('POST /api/items', () => {
  beforeEach(resetItemsAndTenant);

  it('electronics item with omitted optional fields defaults them to null', async () => {
    const res = await POST(postRequest(validElectronics()));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.processor).toBeNull();
    expect(body.ram_gb).toBeNull();
    expect(body.storage_gb).toBeNull();
    expect(body.screen_size_in).toBeNull();
    expect(body.battery_health_pct).toBeNull();
    expect(body.battery_cycle_count).toBeNull();
  });

  it('invalid ISBN format → 422 "Invalid ISBN format."', async () => {
    const res = await POST(postRequest(validBook({ isbn: 'not-an-isbn' })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('Invalid ISBN format.');
  });
});
