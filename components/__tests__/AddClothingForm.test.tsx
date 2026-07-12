// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AddClothingForm from '@/components/AddClothingForm';

const pushMock = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/**
 * This app's field labels are bare <label> elements with no for/id
 * association to their input — walk from the label text to the nearest
 * sibling input/select/textarea instead of relying on getByLabelText.
 */
function fieldByLabel(labelText: string): HTMLElement {
  const labels = Array.from(document.querySelectorAll('label'));
  const label = labels.find(l => l.textContent?.trim().startsWith(labelText));
  if (!label) throw new Error(`No label found starting with "${labelText}"`);
  const el = label.parentElement?.querySelector('input, select, textarea');
  if (!el) throw new Error(`No form control found for label "${labelText}"`);
  return el as HTMLElement;
}

/** Default fetch mock: only the suggestions endpoint (hit on mount) resolves. */
function stubDefaultFetch() {
  const fn = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/items/suggestions')) {
      return { ok: true, status: 200, json: async () => ({ values: [] }) } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function stubSubmitFetch(responder: (url: string) => Response | Promise<Response>) {
  const fn = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/items/suggestions')) {
      return { ok: true, status: 200, json: async () => ({ values: [] }) } as Response;
    }
    return responder(url);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>) {
  await user.type(fieldByLabel('Brand *'), 'Patagonia');
  await user.type(fieldByLabel('Size *'), 'L');
  await user.type(fieldByLabel('Acquisition Cost (USD) *'), '45');
  await user.type(fieldByLabel('Acquisition Date *'), '2026-02-01');
}

const MEASUREMENT_LABELS = [
  'Pit to Pit (in)',
  'Length (in)',
  'Sleeve Length (in)',
  'Waist (in)',
  'Rise (in)',
  'Inseam (in)',
  'Leg Opening (in)',
  'Hip (in)',
];

describe('AddClothingForm', () => {
  beforeEach(() => {
    stubDefaultFetch();
  });

  it('renders all fields with Condition defaulting to EUC and an unset title placeholder', () => {
    render(<AddClothingForm />);

    expect(fieldByLabel('Brand *')).toBeInTheDocument();
    expect(fieldByLabel('Size *')).toBeInTheDocument();
    expect(fieldByLabel('Color')).toBeInTheDocument();
    expect(fieldByLabel('Material')).toBeInTheDocument();
    expect(fieldByLabel('Department')).toBeInTheDocument();
    expect(fieldByLabel('Weight (oz)')).toBeInTheDocument();
    expect(fieldByLabel('Acquisition Cost (USD) *')).toBeInTheDocument();
    expect(fieldByLabel('Acquisition Date *')).toBeInTheDocument();

    for (const label of MEASUREMENT_LABELS) {
      expect(fieldByLabel(label)).toBeInTheDocument();
    }

    const condition = fieldByLabel('Condition *') as HTMLSelectElement;
    expect(condition.value).toBe('EUC');

    const title = fieldByLabel('Listing Title') as HTMLInputElement;
    expect(title.value).toBe('[Brand] [item type] [Size]');

    expect(screen.getByRole('button', { name: 'Add Clothing Item' })).toBeInTheDocument();
  });

  it('live-updates the Listing Title suggestion as Brand, Size, and Color are typed', async () => {
    const user = userEvent.setup();
    render(<AddClothingForm />);

    const title = fieldByLabel('Listing Title') as HTMLInputElement;
    const brand = fieldByLabel('Brand *');
    const size = fieldByLabel('Size *');
    const color = fieldByLabel('Color');

    await user.type(brand, 'Levis');
    expect(title.value).toBe('Levis [item type] [Size]');

    await user.type(size, '32x34');
    expect(title.value).toBe('Levis [item type] Size 32x34');

    await user.type(color, 'Blue');
    expect(title.value).toBe('Levis [item type] Blue Size 32x34');
  });

  it('preserves a manually edited Listing Title and stops auto-updating it', async () => {
    const user = userEvent.setup();
    render(<AddClothingForm />);

    const title = fieldByLabel('Listing Title') as HTMLInputElement;
    const brand = fieldByLabel('Brand *');

    await user.type(brand, 'Levis');
    expect(title.value).toBe('Levis [item type] [Size]');

    await user.clear(title);
    await user.type(title, 'Vintage Levis 501 Jeans');
    expect(title.value).toBe('Vintage Levis 501 Jeans');

    // Further brand edits must NOT overwrite the operator's manual title.
    await user.type(brand, ' Strauss');
    expect(title.value).toBe('Vintage Levis 501 Jeans');
  });

  it('falls back to "brand size" for the payload title when the title is cleared to blank', async () => {
    const fetchMock = stubSubmitFetch(() => ({ ok: true, status: 201, json: async () => ({}) }) as Response);
    const user = userEvent.setup();
    render(<AddClothingForm />);

    await user.type(fieldByLabel('Brand *'), 'Nike');
    await user.type(fieldByLabel('Size *'), 'M');
    await user.clear(fieldByLabel('Listing Title'));
    await user.type(fieldByLabel('Acquisition Cost (USD) *'), '10');
    await user.type(fieldByLabel('Acquisition Date *'), '2026-02-01');

    await user.click(screen.getByRole('button', { name: 'Add Clothing Item' }));

    const postCall = fetchMock.mock.calls.find(c => String(c[0]) === '/api/items');
    expect(postCall).toBeTruthy();
    const body = JSON.parse((postCall![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body.title).toBe('Nike M');
  });

  it('submits a valid form with the full payload shape and redirects on success', async () => {
    const fetchMock = stubSubmitFetch(() => ({ ok: true, status: 201, json: async () => ({}) }) as Response);
    const user = userEvent.setup();
    render(<AddClothingForm />);

    await user.type(fieldByLabel('Brand *'), 'Patagonia');
    await user.type(fieldByLabel('Size *'), 'L');
    await user.type(fieldByLabel('Color'), 'Green');
    await user.type(fieldByLabel('Material'), 'Fleece');
    await user.type(fieldByLabel('Department'), "Women's");
    await user.type(fieldByLabel('Weight (oz)'), '8');
    await user.type(fieldByLabel('Waist (in)'), '30');
    await user.type(fieldByLabel('Acquisition Cost (USD) *'), '45.00');
    await user.type(fieldByLabel('Acquisition Date *'), '2026-02-01');

    await user.click(screen.getByRole('button', { name: 'Add Clothing Item' }));

    expect(pushMock).toHaveBeenCalledWith('/inventory');

    const postCall = fetchMock.mock.calls.find(c => String(c[0]) === '/api/items');
    expect(postCall).toBeTruthy();
    const init = postCall![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    const body = JSON.parse(init.body as string) as Record<string, unknown>;

    expect(body).toEqual({
      category: 'clothing',
      title: 'Patagonia [item type] Green Size L',
      brand: 'Patagonia',
      size_label: 'L',
      condition: 'EUC',
      acquisition_cost: 4500,
      acquisition_date: '2026-02-01',
      color: 'Green',
      material: 'Fleece',
      gender_department: "Women's",
      weight_oz: 8,
      waist_in: 30,
    });
  });

  it('omits all 8 measurement fields and weight from the payload when left blank', async () => {
    const fetchMock = stubSubmitFetch(() => ({ ok: true, status: 201, json: async () => ({}) }) as Response);
    const user = userEvent.setup();
    render(<AddClothingForm />);

    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: 'Add Clothing Item' }));

    const postCall = fetchMock.mock.calls.find(c => String(c[0]) === '/api/items');
    expect(postCall).toBeTruthy();
    const body = JSON.parse((postCall![1] as RequestInit).body as string) as Record<string, unknown>;

    expect(body).not.toHaveProperty('weight_oz');
    for (const field of [
      'pit_to_pit_in',
      'length_in',
      'sleeve_length_in',
      'waist_in',
      'rise_in',
      'inseam_in',
      'leg_opening_in',
      'hip_in',
    ]) {
      expect(body).not.toHaveProperty(field);
    }
    // And optional text fields are omitted too, since none were filled in.
    expect(body).not.toHaveProperty('color');
    expect(body).not.toHaveProperty('material');
    expect(body).not.toHaveProperty('gender_department');
  });

  it('parses a single filled measurement field as a number in the payload', async () => {
    const fetchMock = stubSubmitFetch(() => ({ ok: true, status: 201, json: async () => ({}) }) as Response);
    const user = userEvent.setup();
    render(<AddClothingForm />);

    await fillRequiredFields(user);
    await user.type(fieldByLabel('Pit to Pit (in)'), '20.5');
    await user.click(screen.getByRole('button', { name: 'Add Clothing Item' }));

    const postCall = fetchMock.mock.calls.find(c => String(c[0]) === '/api/items');
    const body = JSON.parse((postCall![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body.pit_to_pit_in).toBe(20.5);
    expect(body).not.toHaveProperty('length_in');
  });

  it('blocks submission via native required validation when Brand is missing', async () => {
    const fetchMock = stubDefaultFetch();
    const user = userEvent.setup();
    render(<AddClothingForm />);

    await user.type(fieldByLabel('Size *'), 'L');
    await user.type(fieldByLabel('Acquisition Cost (USD) *'), '45');
    await user.type(fieldByLabel('Acquisition Date *'), '2026-02-01');

    await user.click(screen.getByRole('button', { name: 'Add Clothing Item' }));

    expect(fetchMock.mock.calls.some(c => String(c[0]) === '/api/items')).toBe(false);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('blocks submission via native required validation when Size is missing', async () => {
    const fetchMock = stubDefaultFetch();
    const user = userEvent.setup();
    render(<AddClothingForm />);

    await user.type(fieldByLabel('Brand *'), 'Patagonia');
    await user.type(fieldByLabel('Acquisition Cost (USD) *'), '45');
    await user.type(fieldByLabel('Acquisition Date *'), '2026-02-01');

    await user.click(screen.getByRole('button', { name: 'Add Clothing Item' }));

    expect(fetchMock.mock.calls.some(c => String(c[0]) === '/api/items')).toBe(false);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('surfaces field-level errors from a 422 response without redirecting', async () => {
    stubSubmitFetch(() => ({
      ok: false,
      status: 422,
      json: async () => ({ fields: { brand: 'Brand already used, pick another.' } }),
    }) as Response);

    const user = userEvent.setup();
    render(<AddClothingForm />);

    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: 'Add Clothing Item' }));

    expect(await screen.findByText('Brand already used, pick another.')).toBeInTheDocument();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('surfaces a generic submission error when the server returns a non-201/422 status with an error message', async () => {
    stubSubmitFetch(() => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Database is on fire.' }),
    }) as Response);

    const user = userEvent.setup();
    render(<AddClothingForm />);

    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: 'Add Clothing Item' }));

    expect(await screen.findByText('Database is on fire.')).toBeInTheDocument();
  });

  it('falls back to a generic "Submission failed." message when the server gives no error body', async () => {
    stubSubmitFetch(() => ({ ok: false, status: 500, json: async () => ({}) }) as Response);

    const user = userEvent.setup();
    render(<AddClothingForm />);

    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: 'Add Clothing Item' }));

    expect(await screen.findByText('Submission failed.')).toBeInTheDocument();
  });

  it('shows a network error message when fetch rejects', async () => {
    stubSubmitFetch(() => {
      throw new Error('boom');
    });

    const user = userEvent.setup();
    render(<AddClothingForm />);

    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: 'Add Clothing Item' }));

    expect(await screen.findByText('Network error — please try again.')).toBeInTheDocument();
  });
});
