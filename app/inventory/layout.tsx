import type { ReactNode } from "react";

export default function InventoryLayout({ children }: { children: ReactNode }) {
  return (
    <section>
      {children}
    </section>
  );
}
