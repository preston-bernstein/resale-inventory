import type { Step } from 'react-joyride';
import { CLOTHING_ANCHORS, BOOK_ANCHORS } from '@/lib/tourAnchors';

// Each tour step below notes which SELLER_WORKFLOW_STEPS index it derives
// its tooltip copy from, so the mapping can be checked by a test.

export const CLOTHING_TOUR_STEPS: Step[] = [
  {
    // derives from SELLER_WORKFLOW_STEPS[5] ("Pick the platform that fits the item.")
    target: `[data-tour="${CLOTHING_ANCHORS.brand}"]`,
    title: 'Note the brand',
    content:
      'Brand drives which platform is worth listing on — some sites pay better for certain labels, so jot it down before you pick where to sell.',
  },
  {
    // derives from SELLER_WORKFLOW_STEPS[6] ("Take flat measurements with a visible tape-measure photo.")
    target: `[data-tour="${CLOTHING_ANCHORS.size}"]`,
    title: 'Confirm the size',
    content:
      'Tag sizes run inconsistent across brands, so treat this as a starting point — the flat measurements you take later are what buyers actually trust.',
  },
  {
    // derives from SELLER_WORKFLOW_STEPS[0] ("Pull the item out and assess it — stains, odor, pilling, damage, missing parts.")
    target: `[data-tour="${CLOTHING_ANCHORS.condition}"]`,
    title: 'Check the condition',
    content:
      'Look it over for stains, pilling, or damage — condition is the single biggest lever on price, so be honest here.',
  },
  {
    // derives from SELLER_WORKFLOW_STEPS[6] ("Take flat measurements with a visible tape-measure photo.")
    target: `[data-tour="${CLOTHING_ANCHORS.measurements}"]`,
    title: 'Take flat measurements',
    content:
      'Lay the item flat and measure it with a tape measure visible in a photo — buyers rely on these numbers more than the size tag.',
  },
  {
    // derives from SELLER_WORKFLOW_STEPS[4] ("Set your price and your walk-away floor.")
    target: `[data-tour="${CLOTHING_ANCHORS.acquisition}"]`,
    title: 'Record what it cost you',
    content:
      'What you paid for the item feeds directly into your walk-away floor — you need this number before you can set a real price.',
  },
  {
    // derives from SELLER_WORKFLOW_STEPS[8] / SELLER_WORKFLOW_STEPS[9] ("Write the listing..." / "Publish it.")
    target: `[data-tour="${CLOTHING_ANCHORS.submit}"]`,
    title: 'Publish the listing',
    content:
      'Once the title and description are written, this button publishes the listing so it goes live for buyers.',
  },
];

export const BOOK_TOUR_STEPS: Step[] = [
  {
    // derives from SELLER_WORKFLOW_STEPS[8] ("Write the listing (title formula + front-loaded description).")
    target: `[data-tour="${BOOK_ANCHORS.isbn}"]`,
    title: 'Scan or enter the ISBN',
    content:
      'The ISBN pulls in accurate title and edition details, which makes writing an accurate listing much faster.',
  },
  {
    // derives from SELLER_WORKFLOW_STEPS[8] ("Write the listing (title formula + front-loaded description).")
    target: `[data-tour="${BOOK_ANCHORS.title}"]`,
    title: 'Confirm the title',
    content:
      'Double-check the title matches the edition in hand — an accurate title up front makes the listing description easier to write.',
  },
  {
    // derives from SELLER_WORKFLOW_STEPS[5] ("Pick the platform that fits the item.")
    target: `[data-tour="${BOOK_ANCHORS.author}"]`,
    title: 'Confirm the author',
    content:
      'Author matters for matching the book to the right platform — some marketplaces suit certain genres or authors better than others.',
  },
  {
    // derives from SELLER_WORKFLOW_STEPS[0] ("Pull the item out and assess it — stains, odor, pilling, damage, missing parts.")
    target: `[data-tour="${BOOK_ANCHORS.condition}"]`,
    title: 'Assess the condition',
    content:
      'Check for water damage, torn pages, or a cracked spine — condition is the biggest factor in what a buyer will pay.',
  },
  {
    // derives from SELLER_WORKFLOW_STEPS[4] ("Set your price and your walk-away floor.")
    target: `[data-tour="${BOOK_ANCHORS.acquisition}"]`,
    title: 'Record what it cost you',
    content:
      'What you paid feeds into your walk-away floor, so log it here before you settle on an asking price.',
  },
  {
    // derives from SELLER_WORKFLOW_STEPS[8] / SELLER_WORKFLOW_STEPS[9] ("Write the listing..." / "Publish it.")
    target: `[data-tour="${BOOK_ANCHORS.submit}"]`,
    title: 'Publish the listing',
    content:
      'This publishes the listing once the description is written, putting the book live for buyers to find.',
  },
];
