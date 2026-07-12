import type { Metadata } from "next";
import { SELLER_WORKFLOW_STEPS as STEPS } from '@/lib/sellerWorkflowSteps';

export const metadata: Metadata = {
  title: "Seller Playbook",
};

const PLATFORM_TABLE: Array<{ item: string; platform: string; why: string }> = [
  { item: "Designer/luxury (Chanel, LV, Gucci)", platform: "The RealReal, Vestiaire Collective", why: "Built-in authentication, higher-dollar buyers" },
  { item: "Streetwear/menswear (Supreme, Rick Owens, vintage band tees)", platform: "Grailed", why: "Buyers who know and pay for the niche" },
  { item: "Everyday brands, women's fashion, activewear", platform: "Poshmark", why: "Large, fashion-focused audience, willing to pay more" },
  { item: "Fast fashion, high volume, low price point", platform: "Vinted", why: "Zero seller fees — keep the whole sale price" },
  { item: "Simple, beginner-friendly, mixed inventory", platform: "Mercari", why: "Straightforward listing flow, no social-selling learning curve" },
  { item: "Rare/collectible, or you want price discovery", platform: "eBay", why: "Auction format, best sold-comps data of any platform" },
  { item: "Bulk closet clean-out, minimal effort acceptable", platform: "ThredUp", why: "Mail it in, they handle everything — lowest payout, least work" },
];

const FEES: Array<{ platform: string; fee: string }> = [
  { platform: "Vinted", fee: "0% seller fee. Buyer pays a small protection fee at checkout instead." },
  { platform: "Depop", fee: "0% commission, ~3.3% + $0.45 payment processing." },
  { platform: "Mercari", fee: "10% flat on item + shipping." },
  { platform: "Grailed", fee: "~9% commission + ~3.5% processing (~12.5% total)." },
  { platform: "eBay", fee: "~13.6–15.3% of the total transaction (including shipping), plus a small per-order fee." },
  { platform: "Poshmark", fee: "Flat $2.95 under $15, 20% commission at $15+." },
  { platform: "Vestiaire Collective", fee: "Tiered 12–25% by item value, plus 3% processing." },
  { platform: "The RealReal / ThredUp", fee: "Full-service consignment — lowest seller take-home %, but they do the photography, listing, and selling for you." },
];

const MISTAKES: Array<{ mistake: string; fix: string }> = [
  { mistake: "Bad photos — biggest lever on both price and speed.", fix: "Natural light, plain background, full shot list." },
  { mistake: "Pricing off active listings instead of sold ones — leads to overpriced, stale listings.", fix: "Always filter to sold comps." },
  { mistake: "Hiding flaws — leads to returns and rating damage.", fix: "Photograph and disclose every real flaw, price accordingly." },
  { mistake: "Listing too much too fast — rushed photos and pricing on day one.", fix: "Work in small batches, same discipline every time." },
  { mistake: "Slow shipping — hurts your seller metrics everywhere.", fix: "Build 1–2 day handling into your routine, don't treat it as an afterthought." },
  { mistake: "Declining lowballs instead of countering — kills sales that could've closed.", fix: "Always counter, using the floor price you already set." },
  { mistake: "Wrong platform for the item — leaves money or opportunity on the table.", fix: "Use the platform table above before you list." },
  { mistake: "Forgetting fees when pricing — you'll net less than expected once the platform takes its cut.", fix: "Back into your list price from your desired net." },
  { mistake: "Not weighing the package before buying a label — leads to overage charges or a held shipment.", fix: "Weigh with all packaging included, every time." },
];

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 border-t border-gray-200 dark:border-gray-700 pt-8">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">{title}</h2>
      <div className="space-y-4 text-sm text-gray-700 dark:text-gray-300 leading-relaxed">{children}</div>
    </section>
  );
}

export default function PlaybookPage() {
  return (
    <div className="max-w-3xl mx-auto space-y-10 pb-16">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100 mb-2">Seller Playbook</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          A practical guide to selling clothes online, for a first-timer. Everything here is
          distilled from platform help centers and reseller-education sources — see{" "}
          <code className="text-xs bg-gray-100 dark:bg-gray-800 rounded px-1 py-0.5">docs/clothing-resale-research.md</code>{" "}
          in the repo for full citations.
        </p>
      </div>

      <nav className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-700 rounded p-3">
        {[
          ["workflow", "Workflow"],
          ["prep", "Prep"],
          ["photos", "Photography"],
          ["platforms", "Platforms"],
          ["pricing", "Pricing"],
          ["listing", "Listing"],
          ["shipping", "Shipping"],
          ["mistakes", "Mistakes"],
        ].map(([id, label]) => (
          <a key={id} href={`#${id}`} className="hover:text-gray-900 dark:hover:text-gray-100 hover:underline">
            {label}
          </a>
        ))}
      </nav>

      <Section id="workflow" title="The 17-step workflow">
        <p>This is the whole process, start to finish. Everything below expands on one of these steps.</p>
        <ol className="list-decimal list-inside space-y-1.5 marker:text-gray-400 dark:marker:text-gray-500">
          {STEPS.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      </Section>

      <Section id="prep" title="1. Prep: what to clean, fix, and skip">
        <p>
          <strong>Clean it properly.</strong> Machine-wash sturdy fabrics (cotton, denim); hand-wash
          delicates and vintage. Pre-treat stains <em>before</em> washing — washing first can set a
          stain permanently. A simple stain fix: equal parts 3% hydrogen peroxide and blue Dawn dish
          soap, worked in gently, left 30–60 minutes before laundering.
        </p>
        <p>
          <strong>Deal with odor separately from stains.</strong> Air a smelly item outside for a few
          hours before washing. Add white vinegar to the rinse cycle. A $10–15 fabric shaver fixes
          pilling on sweaters and coats almost instantly — cleaning and small fixes like this can add
          $20–50 in perceived value for about $5 in supplies.
        </p>
        <p>
          <strong>Iron vs. steam.</strong> Iron cotton, linen, and structured pieces (dress shirts,
          blouses) that need a crisp finish. Steam anything that could scorch or crush under an iron —
          silk, chiffon, velvet, corduroy.
        </p>
        <div>
          <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">What NOT to sell:</p>
          <ul className="list-disc list-inside space-y-1 marker:text-gray-400 dark:marker:text-gray-500">
            <li>Anything on a CPSC recall list (check cpsc.gov/recalls if unsure, especially kids&apos; items).</li>
            <li>Anything that could be mistaken for counterfeit designer goods.</li>
            <li>Anything with a structural safety issue (broken drawstrings, exposed hardware).</li>
            <li>
              Visible holes, staining that didn&apos;t lift, a broken zipper you haven&apos;t fixed, or
              odor that survived a wash — donate or recycle these instead.
            </li>
          </ul>
        </div>
      </Section>

      <Section id="photos" title="2. Photography">
        <p>Photos are the single biggest lever on both sale price and how fast something sells.</p>
        <p>
          <strong>Lighting.</strong> Natural light near a window, during the day, is the default —
          soft and even. Avoid direct sun. A softbox beats a bare lamp if shooting artificially.
        </p>
        <p>
          <strong>Background.</strong> Plain white or gray, no pattern competing with the garment.
        </p>
        <p>
          <strong>Phone camera basics.</strong> Turn off flash. Turn on grid lines to keep the garment
          level. Tap to focus on the fabric. Keep white balance consistent so colors read true.
        </p>
        <div>
          <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">Shot list, in order:</p>
          <ol className="list-decimal list-inside space-y-1 marker:text-gray-400 dark:marker:text-gray-500">
            <li>Hero shot — worn on-body if you can (converts 20–30% higher than flat-lay).</li>
            <li>Back of the garment.</li>
            <li>Brand/size tag, close up.</li>
            <li>Fabric content tag, close up.</li>
            <li>Any flaw, stain, or repair — honest, in normal light, not cropped out.</li>
            <li>Measurement shot — a tape measure laid across the garment, clearly readable.</li>
            <li>Any distinguishing detail (buttons, embroidery, hardware, logo).</li>
          </ol>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Photo limits: Poshmark 16, eBay 24, Mercari ~12, Vinted ~20 (practical sweet spot 4–12),
          Depop just 4 — if you&apos;re short on slots, keep hero → tag → flat-lay → flaw.
        </p>
      </Section>

      <Section id="platforms" title="3. Choosing a platform">
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-sm border border-gray-200 dark:border-gray-700 min-w-[560px]">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                <th className="text-left px-3 py-2 font-medium text-gray-700 dark:text-gray-300 border-b border-gray-200 dark:border-gray-700">Your item</th>
                <th className="text-left px-3 py-2 font-medium text-gray-700 dark:text-gray-300 border-b border-gray-200 dark:border-gray-700">Best platform</th>
                <th className="text-left px-3 py-2 font-medium text-gray-700 dark:text-gray-300 border-b border-gray-200 dark:border-gray-700">Why</th>
              </tr>
            </thead>
            <tbody>
              {PLATFORM_TABLE.map((row) => (
                <tr key={row.item} className="border-b border-gray-100 dark:border-gray-800">
                  <td className="px-3 py-2 align-top">{row.item}</td>
                  <td className="px-3 py-2 align-top font-medium text-gray-900 dark:text-gray-100">{row.platform}</td>
                  <td className="px-3 py-2 align-top text-gray-600 dark:text-gray-400">{row.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">
            Fees, roughly (verify current numbers before relying on them — they change):
          </p>
          <ul className="list-disc list-inside space-y-1 marker:text-gray-400 dark:marker:text-gray-500">
            {FEES.map((f) => (
              <li key={f.platform}>
                <strong>{f.platform}</strong>: {f.fee}
              </li>
            ))}
          </ul>
        </div>
      </Section>

      <Section id="pricing" title="4. Pricing">
        <p>
          <strong>Always price from sold listings, never active ones.</strong> Active/asking prices
          show what people hope to get. Sold listings show what buyers actually paid. eBay&apos;s
          sold-listing filter has the deepest history and is worth checking even if you&apos;re
          selling elsewhere.
        </p>
        <p>
          <strong>Condition is the biggest price lever.</strong> A small stain can cut the price by
          ~40% versus an otherwise-identical clean item. After condition: brand recognition, size
          (mid-range sizes sell faster), and season (list coats in fall, not July).
        </p>
        <p>
          <strong>Two pricing approaches:</strong> price low and let it move fast (works for most
          items, especially fast fashion), or price ~15% above your real target and use offers to
          close the gap (works well on Poshmark specifically, via &quot;offers to likers&quot;).
        </p>
        <p>
          <strong>Set your floor before you list</strong>, factoring in the platform&apos;s fee % and
          any shipping you&apos;re covering. Don&apos;t decline a lowball outright — counter it.
        </p>
        <p>
          <strong>If it hasn&apos;t sold in ~2 weeks</strong>, cut the price 10–15% and refresh the
          listing.
        </p>
      </Section>

      <Section id="listing" title="5. Writing the listing">
        <p>
          <strong>Title formula:</strong> Brand + Item Type + Distinguishing Style/Model + Key
          Attribute (color/material) + Size.
        </p>
        <p className="italic text-gray-600 dark:text-gray-400">
          Example: &quot;Lululemon Align High Rise Leggings Black Size 6&quot;
        </p>
        <p>
          Brand goes first — it&apos;s the single most-filtered search term on every platform. Size,
          color, and condition come next. Save style keywords (Y2K, oversized, vintage) for the end,
          and only if accurate — several platforms penalize keyword-stuffing.
        </p>
        <p>
          <strong>Description:</strong> front-load brand, size, condition, and key measurements. One
          fact per line reads better than a dense paragraph.
        </p>
        <p>
          <strong>Measurements — flat, not on-body.</strong> Lay the garment flat and smooth. For most
          tops, measure pit-to-pit (armpit seam to armpit seam) and double it. For pants, measure the
          waistband straight across (doubled) and the inseam along the inner leg (not doubled).
          Photograph the tape measure laid across the garment — it meaningfully cuts size disputes.
        </p>
      </Section>

      <Section id="shipping" title="6. Shipping">
        <p>Weigh everything, including packaging, before buying or printing a label.</p>
        <p>
          <strong>Poly mailers are the default for clothing</strong> — cheaper, lighter, and
          water-resistant. Reserve boxes for structured or embellished pieces that could crease or
          catch in a mailer.
        </p>
        <p>
          <strong>Carrier:</strong> USPS Ground Advantage is the standard choice — cheap, includes
          tracking and $100 of insurance by default. Most marketplaces (Poshmark, Mercari, Depop,
          Vinted) generate a prepaid label automatically once an item sells. Outside those systems
          (eBay, Grailed), <strong>Pirate Ship</strong> is a free label reseller offering commercial
          rates, often cheaper than the post office counter.
        </p>
        <p>
          <strong>Ship within 1–2 business days of a sale.</strong> Always ship with tracking, to the
          address the platform&apos;s order system gives you — not one a buyer messages you directly.
        </p>
      </Section>

      <Section id="mistakes" title="7. Common mistakes (and the fix)">
        <ul className="space-y-3">
          {MISTAKES.map((m) => (
            <li key={m.mistake} className="border border-gray-200 dark:border-gray-700 rounded p-3">
              <p className="text-gray-900 dark:text-gray-100">{m.mistake}</p>
              <p className="text-gray-600 dark:text-gray-400 mt-1">
                <span className="font-medium text-gray-700 dark:text-gray-300">Fix: </span>
                {m.fix}
              </p>
            </li>
          ))}
        </ul>
      </Section>

      <p className="text-xs text-gray-400 dark:text-gray-500 border-t border-gray-200 dark:border-gray-700 pt-6">
        Fee percentages and shipping rates change — verify current numbers against each
        platform&apos;s own help center before relying on them for a specific sale.
      </p>
    </div>
  );
}
