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

  // Look up ISBN
  const result = await lookupISBN(isbn);

  if (!result || (result.title === '' && result.author === '')) {
    return NextResponse.json(
      { error: 'Not found' },
      { status: 404 },
    );
  }

  return NextResponse.json(result);
}
