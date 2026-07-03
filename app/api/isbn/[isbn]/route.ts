import { NextResponse } from 'next/server';
import { lookupISBN } from '@/lib/isbn';

const ISBN_PATTERN = /^\d{9}[\dX]$|^\d{13}$/;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ isbn: string }> },
) {
  const { isbn } = await params;

  // Validate ISBN format
  const stripped = isbn.replace(/[-\s]/g, '');
  if (!ISBN_PATTERN.test(stripped)) {
    return NextResponse.json(
      { error: 'Invalid ISBN format.' },
      { status: 400 },
    );
  }

  // Look up ISBN. Distinguish a genuine "not found" (404) from the provider
  // being unavailable (503) — see DR-3 / plan.md ISBN route contract.
  const result = await lookupISBN(isbn);

  switch (result.status) {
    case 'found':
      // A record with neither title nor author is treated as not found,
      // matching the prior behaviour.
      if (result.title === '' && result.author === '') {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
      return NextResponse.json({
        title: result.title,
        author: result.author,
        publisher: result.publisher,
      });

    case 'not-found':
      return NextResponse.json({ error: 'Not found' }, { status: 404 });

    case 'invalid':
      // Unreachable in practice (format is validated above), kept for safety.
      return NextResponse.json({ error: 'Invalid ISBN format.' }, { status: 400 });

    case 'unavailable':
      return NextResponse.json(
        { error: 'Lookup unavailable. Enter details manually.' },
        { status: 503 },
      );
  }
}
