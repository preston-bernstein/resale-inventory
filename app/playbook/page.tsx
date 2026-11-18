import type { Metadata } from "next";
import {
  ListingSection,
  MistakesSection,
  PhotosSection,
  PlatformsSection,
  PrepSection,
  PricingSection,
  ShippingSection,
  WorkflowSection,
} from './PlaybookSections';
import { NAV_LINKS } from './playbookData';

export const metadata: Metadata = {
  title: "Seller Playbook",
};

function PlaybookHeader() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100 mb-2">Seller Playbook</h1>
      <p className="text-sm text-gray-600 dark:text-gray-400">
        A practical guide to selling clothes online, for a first-timer. Everything here is
        distilled from platform help centers and reseller-education sources — see{" "}
        <code className="text-xs bg-gray-100 dark:bg-gray-800 rounded px-1 py-0.5">docs/clothing-resale-research.md</code>{" "}
        in the repo for full citations.
      </p>
    </div>
  );
}

function PlaybookNav() {
  return (
    <nav className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-700 rounded p-3">
      {NAV_LINKS.map(([id, label]) => (
        <a key={id} href={`#${id}`} className="hover:text-gray-900 dark:hover:text-gray-100 hover:underline">
          {label}
        </a>
      ))}
    </nav>
  );
}

export default function PlaybookPage() {
  return (
    <div className="max-w-3xl mx-auto space-y-10 pb-16">
      <PlaybookHeader />
      <PlaybookNav />
      <WorkflowSection />
      <PrepSection />
      <PhotosSection />
      <PlatformsSection />
      <PricingSection />
      <ListingSection />
      <ShippingSection />
      <MistakesSection />

      <p className="text-xs text-gray-400 dark:text-gray-500 border-t border-gray-200 dark:border-gray-700 pt-6">
        Fee percentages and shipping rates change — verify current numbers against each
        platform&apos;s own help center before relying on them for a specific sale.
      </p>
    </div>
  );
}
