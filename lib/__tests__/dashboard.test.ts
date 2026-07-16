import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { getDashboardData } from '../dashboard';
import db from '../db';
import { DEFAULT_TENANT_ID } from '../constants';

// ---------------------------------------------------------------------------
// Helpers — mirrors tests/integration.test.ts's insert helpers.
//
// Task 19 retrofit (finished by Task 22): getDashboardData() now requires an
// explicit tenantId. These inserts deliberately omit tenant_id from every
// INSERT below — items/book_details/clothing_details all default that
// column to DEFAULT_TENANT_ID (data/migrations/006_tenant_scoping.sql), so
// every row this file seeds lands on the default tenant, and every
// getDashboardData() call below is passed that same DEFAULT_TENANT_ID.
// ---------------------------------------------------------------------------

function insertBookItem(overrides: Record<string, unknown> = {}): string {
  const id = uuidv4();
  const defaults: Record<string, unknown> = {
    id,
    title: 'Test Book',
    acquisition_cost: 1000,
    acquisition_date: '2024-01-01',
    status: 'Unlisted',
    listing_price: null,
    sale_price: null,
    sale_platform: null,
    sale_date: null,
    isbn: null,
    author: 'Test Author',
    publisher: 'Test Publisher',
    condition: 'Good',
  };
  const item = { ...defaults, ...overrides, id, category: 'book' };
  db.prepare(`
    INSERT INTO items
      (id, category, title, acquisition_cost, acquisition_date, status,
       listing_price, sale_price, sale_platform, sale_date)
    VALUES
      (@id, @category, @title, @acquisition_cost, @acquisition_date, @status,
       @listing_price, @sale_price, @sale_platform, @sale_date)
  `).run(item);
  db.prepare(`
    INSERT INTO book_details (item_id, isbn, author, publisher, condition)
    VALUES (@id, @isbn, @author, @publisher, @condition)
  `).run(item);
  return id;
}

function insertClothingItem(overrides: Record<string, unknown> = {}): string {
  const id = uuidv4();
  const defaults: Record<string, unknown> = {
    id,
    title: 'Test Clothing Item',
    acquisition_cost: 2000,
    acquisition_date: '2024-01-01',
    status: 'Unlisted',
    listing_price: null,
    sale_price: null,
    sale_platform: null,
    sale_date: null,
    brand: 'TestBrand',
    size_label: 'M',
    color: null,
    material: null,
    gender_department: null,
    weight_oz: null,
    pit_to_pit_in: null,
    length_in: null,
    sleeve_length_in: null,
    waist_in: null,
    rise_in: null,
    inseam_in: null,
    leg_opening_in: null,
    hip_in: null,
    condition: 'EUC',
  };
  const item = { ...defaults, ...overrides, id, category: 'clothing' };
  db.prepare(`
    INSERT INTO items
      (id, category, title, acquisition_cost, acquisition_date, status,
       listing_price, sale_price, sale_platform, sale_date)
    VALUES
      (@id, @category, @title, @acquisition_cost, @acquisition_date, @status,
       @listing_price, @sale_price, @sale_platform, @sale_date)
  `).run(item);
  db.prepare(`
    INSERT INTO clothing_details
      (item_id, brand, size_label, color, material, gender_department, weight_oz,
       pit_to_pit_in, length_in, sleeve_length_in, waist_in, rise_in, inseam_in,
       leg_opening_in, hip_in, condition)
    VALUES
      (@id, @brand, @size_label, @color, @material, @gender_department, @weight_oz,
       @pit_to_pit_in, @length_in, @sleeve_length_in, @waist_in, @rise_in, @inseam_in,
       @leg_opening_in, @hip_in, @condition)
  `).run(item);
  return id;
}

function cleanTables() {
  db.exec(
    'DELETE FROM item_photos; DELETE FROM price_history; DELETE FROM item_platforms; ' +
    'DELETE FROM clothing_details; DELETE FROM book_details; DELETE FROM items;',
  );
}

describe('getDashboardData', () => {
  beforeEach(() => {
    cleanTables();
  });

  it('returns all-zero shape with no items in the DB', () => {
    const data = getDashboardData(DEFAULT_TENANT_ID);
    expect(data.held_count).toBe(0);
    expect(data.held_acquisition_cost).toBe(0);
    expect(data.by_condition).toMatchObject({
      Poor: 0, Acceptable: 0, Good: 0, 'Very Good': 0, 'Like New': 0,
      NWT: 0, NWOT: 0, EUC: 0, GUC: 0, Fair: 0,
    });
    expect(data.by_status).toMatchObject({
      Unlisted: 0, Listed: 0, 'Sale Pending': 0, Sold: 0,
      Removed: 0, Donated: 0, Discarded: 0,
    });
    expect(data.by_category).toEqual({
      book: { count: 0, acquisition_cost: 0 },
      clothing: { count: 0, acquisition_cost: 0 },
    });
  });

  it('held_count/held_acquisition_cost only sum Unlisted+Listed+Sale Pending, excluding Sold/Removed/Donated/Discarded', () => {
    insertBookItem({ acquisition_cost: 1000, status: 'Unlisted' });
    insertBookItem({ acquisition_cost: 2000, status: 'Listed', listing_price: 3000 });
    insertClothingItem({ acquisition_cost: 500, status: 'Sale Pending', listing_price: 900 });
    insertBookItem({
      acquisition_cost: 700, status: 'Sold', listing_price: 1200,
      sale_price: 1200, sale_platform: 'eBay', sale_date: '2024-06-01',
    });
    insertBookItem({ acquisition_cost: 300, status: 'Removed', listing_price: 600 });
    insertBookItem({ acquisition_cost: 400, status: 'Donated' });
    insertBookItem({ acquisition_cost: 100, status: 'Discarded' });

    const data = getDashboardData(DEFAULT_TENANT_ID);
    expect(data.held_count).toBe(3);
    expect(data.held_acquisition_cost).toBe(3500);
  });

  it('by_condition combines book and clothing vocabularies without collision', () => {
    insertBookItem({ condition: 'Good' });
    insertBookItem({ condition: 'Good' });
    insertBookItem({ condition: 'Very Good' });
    insertClothingItem({ condition: 'NWT' });
    insertClothingItem({ condition: 'EUC' });
    insertClothingItem({ condition: 'EUC' });
    insertClothingItem({ condition: 'EUC' });

    const data = getDashboardData(DEFAULT_TENANT_ID);
    expect(data.by_condition.Good).toBe(2);
    expect(data.by_condition['Very Good']).toBe(1);
    expect(data.by_condition.Poor).toBe(0);
    expect(data.by_condition['Like New']).toBe(0);
    expect(data.by_condition.NWT).toBe(1);
    expect(data.by_condition.EUC).toBe(3);
    expect(data.by_condition.NWOT).toBe(0);
    expect(data.by_condition.GUC).toBe(0);
    expect(data.by_condition.Fair).toBe(0);
  });

  it('by_status counts every status value, including terminal ones', () => {
    insertBookItem({ status: 'Unlisted' });
    insertBookItem({ status: 'Unlisted' });
    insertBookItem({ status: 'Listed', listing_price: 500 });
    insertBookItem({
      status: 'Sold', listing_price: 800, sale_price: 800,
      sale_platform: 'eBay', sale_date: '2024-01-01',
    });
    insertClothingItem({ status: 'Donated' });
    insertClothingItem({ status: 'Discarded' });
    insertClothingItem({ status: 'Removed', listing_price: 400 });

    const data = getDashboardData(DEFAULT_TENANT_ID);
    expect(data.by_status.Unlisted).toBe(2);
    expect(data.by_status.Listed).toBe(1);
    expect(data.by_status.Sold).toBe(1);
    expect(data.by_status.Donated).toBe(1);
    expect(data.by_status.Discarded).toBe(1);
    expect(data.by_status.Removed).toBe(1);
    expect(data.by_status['Sale Pending']).toBe(0);
  });

  it('by_category totals every item regardless of status (not just held)', () => {
    insertBookItem({ acquisition_cost: 1000, status: 'Unlisted' });
    insertBookItem({
      acquisition_cost: 500, status: 'Sold', listing_price: 900,
      sale_price: 900, sale_platform: 'eBay', sale_date: '2024-01-01',
    });
    insertClothingItem({ acquisition_cost: 2000, status: 'Unlisted' });
    insertClothingItem({ acquisition_cost: 300, status: 'Donated' });

    const data = getDashboardData(DEFAULT_TENANT_ID);
    expect(data.by_category.book).toEqual({ count: 2, acquisition_cost: 1500 });
    expect(data.by_category.clothing).toEqual({ count: 2, acquisition_cost: 2300 });
  });

  it('mixed dataset produces internally consistent totals', () => {
    insertBookItem({ acquisition_cost: 1200, status: 'Listed', listing_price: 2000, condition: 'Like New' });
    insertClothingItem({ acquisition_cost: 800, status: 'Unlisted', condition: 'GUC' });
    insertClothingItem({
      acquisition_cost: 600, status: 'Sold', listing_price: 1000, sale_price: 1000,
      sale_platform: 'Poshmark', sale_date: '2024-03-01', condition: 'Fair',
    });

    const data = getDashboardData(DEFAULT_TENANT_ID);
    expect(data.held_count).toBe(2);
    expect(data.held_acquisition_cost).toBe(2000);
    expect(data.by_condition['Like New']).toBe(1);
    expect(data.by_condition.GUC).toBe(1);
    expect(data.by_condition.Fair).toBe(1);
    expect(data.by_status.Listed).toBe(1);
    expect(data.by_status.Unlisted).toBe(1);
    expect(data.by_status.Sold).toBe(1);
    expect(data.by_category.book).toEqual({ count: 1, acquisition_cost: 1200 });
    expect(data.by_category.clothing).toEqual({ count: 2, acquisition_cost: 1400 });
  });
});
