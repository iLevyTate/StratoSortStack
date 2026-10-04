import React from 'react';
import { render, screen } from '@testing-library/react';
import { Copy } from 'lucide-react';

import Button from '../../src/renderer/components/ui/Button';

describe('Button', () => {
  test('derives an accessible label from nested text children', () => {
    render(
      <Button>
        <Copy className="h-4 w-4" />
        <span>Copy Path</span>
      </Button>
    );

    expect(screen.getByRole('button', { name: 'Copy Path' })).toBeInTheDocument();
  });

  test('uses the provided aria-label for icon-only buttons', () => {
    render(
      <Button aria-label="Reveal file in folder">
        <Copy className="h-4 w-4" />
      </Button>
    );

    expect(screen.getByRole('button', { name: 'Reveal file in folder' })).toBeInTheDocument();
  });
});
