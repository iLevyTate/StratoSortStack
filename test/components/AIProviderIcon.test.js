/**
 * @jest-environment jsdom
 */
'use strict';
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import AIProviderIcon from '../../src/renderer/components/common/AIProviderIcon';

describe('AIProviderIcon', () => {
  test('renders cloud icon with provider tooltip when provider is anthropic', () => {
    render(<AIProviderIcon provider="anthropic" />);
    const node = screen.getByLabelText(/anthropic claude/i);
    expect(node).toBeInTheDocument();
    expect(node.getAttribute('title')).toMatch(/cloud/i);
  });

  test('renders local icon with local tooltip when provider is local', () => {
    render(<AIProviderIcon provider="local" />);
    const node = screen.getByLabelText(/local llama/i);
    expect(node).toBeInTheDocument();
    expect(node.getAttribute('title')).toMatch(/local/i);
  });

  test('renders cloud icon for openaiCompatible', () => {
    render(<AIProviderIcon provider="openaiCompatible" />);
    const node = screen.getByLabelText(/openai \/ custom/i);
    expect(node).toBeInTheDocument();
    expect(node.getAttribute('title')).toMatch(/cloud/i);
  });

  test('renders nothing when provider is unknown / undefined', () => {
    const { container } = render(<AIProviderIcon provider={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  test('renders nothing when provider is an unrecognized id', () => {
    const { container } = render(<AIProviderIcon provider="totally-fake" />);
    expect(container).toBeEmptyDOMElement();
  });
});
