import type { ReactNode } from "react";

export default function BooksLayout({ children }: { children: ReactNode }) {
  return (
    <section>
      {children}
    </section>
  );
}
