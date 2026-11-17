export const PLATFORM_TABLE: Array<{ item: string; platform: string; why: string }> = [
  { item: "Designer/luxury (Chanel, LV, Gucci)", platform: "The RealReal, Vestiaire Collective", why: "Built-in authentication, higher-dollar buyers" },
  { item: "Streetwear/menswear (Supreme, Rick Owens, vintage band tees)", platform: "Grailed", why: "Buyers who know and pay for the niche" },
  { item: "Everyday brands, women's fashion, activewear", platform: "Poshmark", why: "Large, fashion-focused audience, willing to pay more" },
  { item: "Fast fashion, high volume, low price point", platform: "Vinted", why: "Zero seller fees — keep the whole sale price" },
  { item: "Simple, beginner-friendly, mixed inventory", platform: "Mercari", why: "Straightforward listing flow, no social-selling learning curve" },
  { item: "Rare/collectible, or you want price discovery", platform: "eBay", why: "Auction format, best sold-comps data of any platform" },
  { item: "Bulk closet clean-out, minimal effort acceptable", platform: "ThredUp", why: "Mail it in, they handle everything — lowest payout, least work" },
];

export const FEES: Array<{ platform: string; fee: string }> = [
  { platform: "Vinted", fee: "0% seller fee. Buyer pays a small protection fee at checkout instead." },
  { platform: "Depop", fee: "0% commission, ~3.3% + $0.45 payment processing." },
  { platform: "Mercari", fee: "10% flat on item + shipping." },
  { platform: "Grailed", fee: "~9% commission + ~3.5% processing (~12.5% total)." },
  { platform: "eBay", fee: "~13.6–15.3% of the total transaction (including shipping), plus a small per-order fee." },
  { platform: "Poshmark", fee: "Flat $2.95 under $15, 20% commission at $15+." },
  { platform: "Vestiaire Collective", fee: "Tiered 12–25% by item value, plus 3% processing." },
  { platform: "The RealReal / ThredUp", fee: "Full-service consignment — lowest seller take-home %, but they do the photography, listing, and selling for you." },
];

export const MISTAKES: Array<{ mistake: string; fix: string }> = [
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

export const NAV_LINKS: Array<[id: string, label: string]> = [
  ["workflow", "Workflow"],
  ["prep", "Prep"],
  ["photos", "Photography"],
  ["platforms", "Platforms"],
  ["pricing", "Pricing"],
  ["listing", "Listing"],
  ["shipping", "Shipping"],
  ["mistakes", "Mistakes"],
];
