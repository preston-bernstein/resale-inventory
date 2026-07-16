import type { ReactNode } from "react";

export default function ConnectionsLayout({ children }: { children: ReactNode }) {
  return (
    <section>
      {children}
    </section>
  );
}
