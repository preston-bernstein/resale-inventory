// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AddClothingForm from '@/components/AddClothingForm';
import {
  describeSubmissionErrors,
  expectNoItemsPost,
  fieldByLabel,
  fillAndSubmit,
  postedItem,
  stubItemFormFetch,
  type User,
} from './itemFormFixtures';
import { jsonResponse } from '@/tests/jsonResponse';

const pushMock = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function fillRequiredFields(user: User) {
  await user.type(fieldByLabel('Brand *'), 'Patagonia');
  await user.type(fieldByLabel('Size *'), 'L');
  await user.type(fieldByLabel('Acquisition Cost (USD) *'), '45');
  await user.type(fieldByLabel('Acquisition Date *'), '2026-02-01');
}

/** Renders the form, fills the required fields and clicks Add Clothing Item. */
function submitRequiredFields() {
  return fillAndSubmit(<AddClothingForm />, 'Add Clothing Item', fillRequiredFields);
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

beforeEach(() => {
  stubItemFormFetch();
});

describe('AddClothingForm — rendering and title suggestion', () => {
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
});

describe('AddClothingForm — title editing', () => {
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
    const fetchMock = stubItemFormFetch({ items: () => jsonResponse({}, true, 201) });
    const user = userEvent.setup();
    render(<AddClothingForm />);

    await user.type(fieldByLabel('Brand *'), 'Nike');
    await user.type(fieldByLabel('Size *'), 'M');
    await user.clear(fieldByLabel('Listing Title'));
    await user.type(fieldByLabel('Acquisition Cost (USD) *'), '10');
    await user.type(fieldByLabel('Acquisition Date *'), '2026-02-01');

    await user.click(screen.getByRole('button', { name: 'Add Clothing Item' }));

    const { body } = postedItem(fetchMock);
    expect(body.title).toBe('Nike M');
  });
});

describe('AddClothingForm — submit payload', () => {
  it('submits a valid form with the full payload shape and redirects on success', async () => {
    const fetchMock = stubItemFormFetch({ items: () => jsonResponse({}, true, 201) });
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

    const { init, body } = postedItem(fetchMock);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });

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
});

describe('AddClothingForm — measurements', () => {
  it('omits all 8 measurement fields and weight from the payload when left blank', async () => {
    const fetchMock = stubItemFormFetch({ items: () => jsonResponse({}, true, 201) });
    await submitRequiredFields();

    const { body } = postedItem(fetchMock);

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
    const fetchMock = stubItemFormFetch({ items: () => jsonResponse({}, true, 201) });
    const user = userEvent.setup();
    render(<AddClothingForm />);

    await fillRequiredFields(user);
    await user.type(fieldByLabel('Pit to Pit (in)'), '20.5');
    await user.click(screen.getByRole('button', { name: 'Add Clothing Item' }));

    const { body } = postedItem(fetchMock);
    expect(body.pit_to_pit_in).toBe(20.5);
    expect(body).not.toHaveProperty('length_in');
  });
});

describe('AddClothingForm — required validation and field errors', () => {
  it('blocks submission via native required validation when Brand is missing', async () => {
    const fetchMock = stubItemFormFetch();
    const user = userEvent.setup();
    render(<AddClothingForm />);

    await user.type(fieldByLabel('Size *'), 'L');
    await user.type(fieldByLabel('Acquisition Cost (USD) *'), '45');
    await user.type(fieldByLabel('Acquisition Date *'), '2026-02-01');

    await user.click(screen.getByRole('button', { name: 'Add Clothing Item' }));

    expectNoItemsPost(fetchMock);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('blocks submission via native required validation when Size is missing', async () => {
    const fetchMock = stubItemFormFetch();
    const user = userEvent.setup();
    render(<AddClothingForm />);

    await user.type(fieldByLabel('Brand *'), 'Patagonia');
    await user.type(fieldByLabel('Acquisition Cost (USD) *'), '45');
    await user.type(fieldByLabel('Acquisition Date *'), '2026-02-01');

    await user.click(screen.getByRole('button', { name: 'Add Clothing Item' }));

    expectNoItemsPost(fetchMock);
    expect(pushMock).not.toHaveBeenCalled();
  });
});

describeSubmissionErrors({
  name: 'AddClothingForm',
  submit: submitRequiredFields,
  pushMock,
  fieldError: { field: 'brand', message: 'Brand already used, pick another.' },
});
