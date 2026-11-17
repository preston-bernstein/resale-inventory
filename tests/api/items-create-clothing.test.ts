import { describe, it, expect } from 'vitest';
import { POST } from '@/app/api/items/route';
import { postRequest, validClothing, useFreshTenant } from './itemFixtures';

describe('POST /api/items › clothing brand and size (1 of 2)', () => {
  useFreshTenant();

  it('clothing missing brand → 422 with fields includes brand', async () => {
    const res = await POST(postRequest(validClothing({ brand: '' })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('Validation failed.');
    expect(body.fields).toContain('brand');
  });

  it('brand of the wrong type (number) → 422 with fields includes brand (not a crash)', async () => {
    const res = await POST(postRequest(validClothing({ brand: 42 })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('brand');
  });

  it('brand exactly matching the literal string "Stryker was here!" round-trips correctly', async () => {
    const res = await POST(postRequest(validClothing({ brand: 'Stryker was here!' })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.brand).toBe('Stryker was here!');
  });

  it('brand with surrounding whitespace is trimmed', async () => {
    const res = await POST(postRequest(validClothing({ brand: "  Levi's  " })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.brand).toBe("Levi's");
  });
});

describe('POST /api/items › clothing brand and size (2 of 2)', () => {
  useFreshTenant();

  it('clothing missing size_label → 422 with fields includes size_label', async () => {
    const res = await POST(postRequest(validClothing({ size_label: '' })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('size_label');
  });

  it('size_label of the wrong type (number) → 422 with fields includes size_label (not a crash)', async () => {
    const res = await POST(postRequest(validClothing({ size_label: 42 })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('size_label');
  });

  it('size_label exactly matching the literal string "Stryker was here!" round-trips correctly', async () => {
    const res = await POST(postRequest(validClothing({ size_label: 'Stryker was here!' })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.size_label).toBe('Stryker was here!');
  });

  it('size_label with surrounding whitespace is trimmed', async () => {
    const res = await POST(postRequest(validClothing({ size_label: '  L  ' })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.size_label).toBe('L');
  });
});

describe('POST /api/items › clothing color and material', () => {
  useFreshTenant();

  it('clothing color of the wrong type (number) → 422 with fields includes color', async () => {
    const res = await POST(postRequest(validClothing({ color: 42 })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('color');
  });

  it('clothing color explicitly null is valid', async () => {
    const res = await POST(postRequest(validClothing({ color: null })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.color).toBeNull();
  });

  it('clothing color with surrounding whitespace is trimmed', async () => {
    const res = await POST(postRequest(validClothing({ color: '  Blue  ' })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.color).toBe('Blue');
  });

  it('clothing material of the wrong type (number) → 422 with fields includes material', async () => {
    const res = await POST(postRequest(validClothing({ material: 42 })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('material');
  });

  it('clothing material explicitly null is valid', async () => {
    const res = await POST(postRequest(validClothing({ material: null })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.material).toBeNull();
  });

  it('clothing material is trimmed and persisted when provided', async () => {
    const res = await POST(postRequest(validClothing({ material: '  Wool  ' })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.material).toBe('Wool');
  });
});

describe('POST /api/items › clothing gender and measurements (1 of 2)', () => {
  useFreshTenant();

  it('clothing gender_department valid string is persisted', async () => {
    const res = await POST(postRequest(validClothing({ gender_department: 'Womens' })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.gender_department).toBe('Womens');
  });

  it('clothing invalid gender_department type → 422 with fields includes gender_department', async () => {
    const res = await POST(postRequest(validClothing({ gender_department: 42 })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('gender_department');
  });

  it('clothing weight_oz valid positive integer is persisted', async () => {
    const res = await POST(postRequest(validClothing({ weight_oz: 16 })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.weight_oz).toBe(16);
  });

  it('clothing negative weight_oz → 422 with fields includes weight_oz', async () => {
    const res = await POST(postRequest(validClothing({ weight_oz: -3 })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('Validation failed.');
    expect(body.fields).toContain('weight_oz');
  });

  it('clothing non-integer weight_oz → 422 with fields includes weight_oz', async () => {
    const res = await POST(postRequest(validClothing({ weight_oz: 3.2 })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('weight_oz');
  });
});

describe('POST /api/items › clothing gender and measurements (2 of 2)', () => {
  useFreshTenant();

  it('clothing negative measurement field → 422 with fields includes that field', async () => {
    const res = await POST(postRequest(validClothing({ waist_in: -1 })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields).toContain('waist_in');
  });

  it('clothing item persists optional measurement fields when provided', async () => {
    const res = await POST(
      postRequest(validClothing({ waist_in: 30, pit_to_pit_in: 22.5, color: 'Blue' })),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.waist_in).toBe(30);
    expect(body.pit_to_pit_in).toBe(22.5);
    expect(body.color).toBe('Blue');
  });

  it('clothing item with omitted optional fields defaults them to null', async () => {
    const res = await POST(postRequest(validClothing()));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.color).toBeNull();
    expect(body.material).toBeNull();
    expect(body.weight_oz).toBeNull();
    expect(body.gender_department).toBeNull();
  });
});
