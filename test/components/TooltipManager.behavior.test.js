/**
 * @jest-environment jsdom
 *
 * Behavior tests for TooltipManager, a headless controller that:
 *  - patches setAttribute('title') → data-tooltip (prevents native tooltips)
 *  - proactively strips native title attributes via MutationObserver
 *  - shows/hides a custom tooltip on hover (debounced) + focus (immediate)
 *  - hides on blur/visibilitychange and repositions on scroll/resize
 *  - unmounts cleanly with no dangling timers / DOM leaks
 */
import React from 'react';
import { act, render } from '@testing-library/react';

jest.mock('../../src/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }))
}));

import TooltipManager from '../../src/renderer/components/TooltipManager';

const flushObserverMicrotasks = async () => {
  // MutationObserver callbacks are microtasks; a resolved promise queue is
  // sufficient to drain them under jsdom.
  await Promise.resolve();
  await Promise.resolve();
};

const getTooltipEl = () => document.querySelector('.tooltip-enhanced');

const cleanupBody = () => {
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild);
  }
};

describe('TooltipManager', () => {
  beforeEach(() => {
    // Stabilize rAF/getBoundingClientRect for jsdom
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb();
      return 1;
    });
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  });

  afterEach(() => {
    // Clean up any leftover elements from prior renders
    cleanupBody();
    jest.restoreAllMocks();
  });

  test('mounts a hidden tooltip element to document.body', () => {
    const { unmount } = render(<TooltipManager />);
    const tp = getTooltipEl();
    expect(tp).toBeTruthy();
    expect(tp.getAttribute('role')).toBe('tooltip');
    expect(tp.getAttribute('aria-hidden')).toBe('true');
    unmount();
    expect(getTooltipEl()).toBeFalsy();
  });

  test('renders null (no visible React output)', () => {
    const { container } = render(<TooltipManager />);
    expect(container.firstChild).toBeNull();
  });

  test('strips existing native `title` attributes and mirrors as data-tooltip', () => {
    const target = document.createElement('button');
    target.setAttribute('title', 'existing tip');
    document.body.appendChild(target);

    render(<TooltipManager />);

    // Initial sweep runs synchronously in the effect
    expect(target.hasAttribute('title')).toBe(false);
    expect(target.getAttribute('data-tooltip')).toBe('existing tip');
    // aria-description mirror
    expect(target.getAttribute('aria-description')).toBe('existing tip');
  });

  test('patched setAttribute redirects future title writes to data-tooltip', () => {
    const target = document.createElement('a');
    document.body.appendChild(target);
    render(<TooltipManager />);

    target.setAttribute('title', 'fresh tip');
    expect(target.hasAttribute('title')).toBe(false);
    expect(target.getAttribute('data-tooltip')).toBe('fresh tip');
    expect(target.getAttribute('aria-description')).toBe('fresh tip');
  });

  test('patched title property setter redirects to data-tooltip', () => {
    const target = document.createElement('button');
    document.body.appendChild(target);
    render(<TooltipManager />);

    // Direct property write should be intercepted
    target.title = 'via property';
    expect(target.getAttribute('data-tooltip')).toBe('via property');
    // Getter reflects data-tooltip
    expect(target.title).toBe('via property');
  });

  test('empty title write removes data-tooltip and aria-description mirror', () => {
    const target = document.createElement('span');
    document.body.appendChild(target);
    render(<TooltipManager />);

    target.setAttribute('title', 'has value');
    expect(target.getAttribute('data-tooltip')).toBe('has value');
    target.setAttribute('title', '');
    expect(target.hasAttribute('data-tooltip')).toBe(false);
  });

  test('MutationObserver strips titles on nodes added after mount', async () => {
    render(<TooltipManager />);

    // Use raw prototype to avoid the setAttribute patch that would rewrite this
    // synchronously — the point here is to confirm the MutationObserver sweep
    // of newly added subtrees still catches stray title attributes.
    const rawSetAttribute = Object.getPrototypeOf(HTMLElement.prototype).setAttribute;
    const child = document.createElement('div');
    rawSetAttribute.call(child, 'title', 'stray');
    document.body.appendChild(child);

    await flushObserverMicrotasks();
    expect(child.hasAttribute('title')).toBe(false);
    expect(child.getAttribute('data-tooltip')).toBe('stray');
  });

  test('mouseover on [data-tooltip] element shows tooltip AFTER debounce', () => {
    jest.useFakeTimers();
    try {
      const target = document.createElement('button');
      target.textContent = 'hover me';
      target.setAttribute('data-tooltip', 'tip text');
      document.body.appendChild(target);
      render(<TooltipManager />);

      const tp = getTooltipEl();
      expect(tp.classList.contains('show')).toBe(false);

      const evt = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(evt, 'target', { value: target });
      document.dispatchEvent(evt);

      // Not yet visible before debounce
      expect(tp.classList.contains('show')).toBe(false);
      act(() => {
        jest.advanceTimersByTime(300);
      });
      expect(tp.classList.contains('show')).toBe(true);
      expect(tp.textContent).toContain('tip text');
    } finally {
      jest.useRealTimers();
    }
  });

  test('mouseout hides the tooltip when relatedTarget is outside the trigger', () => {
    jest.useFakeTimers();
    try {
      const target = document.createElement('button');
      target.setAttribute('data-tooltip', 'a');
      document.body.appendChild(target);
      const outside = document.createElement('div');
      document.body.appendChild(outside);
      render(<TooltipManager />);

      // Show first
      const over = new MouseEvent('mouseover', { bubbles: true });
      Object.defineProperty(over, 'target', { value: target });
      document.dispatchEvent(over);
      act(() => {
        jest.advanceTimersByTime(300);
      });
      const tp = getTooltipEl();
      expect(tp.classList.contains('show')).toBe(true);

      const out = new MouseEvent('mouseout', { bubbles: true });
      Object.defineProperty(out, 'target', { value: target });
      Object.defineProperty(out, 'relatedTarget', { value: outside });
      document.dispatchEvent(out);
      expect(tp.classList.contains('show')).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  test('focusin on [data-tooltip] shows tooltip immediately (no debounce)', () => {
    const target = document.createElement('button');
    target.setAttribute('data-tooltip', 'focus tip');
    document.body.appendChild(target);
    render(<TooltipManager />);

    const evt = new FocusEvent('focusin', { bubbles: true });
    Object.defineProperty(evt, 'target', { value: target });
    document.dispatchEvent(evt);

    const tp = getTooltipEl();
    expect(tp.classList.contains('show')).toBe(true);
    expect(tp.textContent).toContain('focus tip');
  });

  test('focusout hides the tooltip', () => {
    const target = document.createElement('button');
    target.setAttribute('data-tooltip', 'focus me');
    document.body.appendChild(target);
    render(<TooltipManager />);

    const focus = new FocusEvent('focusin', { bubbles: true });
    Object.defineProperty(focus, 'target', { value: target });
    document.dispatchEvent(focus);
    const tp = getTooltipEl();
    expect(tp.classList.contains('show')).toBe(true);

    const blur = new FocusEvent('focusout', { bubbles: true });
    Object.defineProperty(blur, 'target', { value: target });
    document.dispatchEvent(blur);
    expect(tp.classList.contains('show')).toBe(false);
  });

  test('visibilitychange with document.hidden hides an active tooltip', () => {
    const target = document.createElement('button');
    target.setAttribute('data-tooltip', 'hide me');
    document.body.appendChild(target);
    render(<TooltipManager />);

    const focus = new FocusEvent('focusin', { bubbles: true });
    Object.defineProperty(focus, 'target', { value: target });
    document.dispatchEvent(focus);
    const tp = getTooltipEl();
    expect(tp.classList.contains('show')).toBe(true);

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(tp.classList.contains('show')).toBe(false);
    // Reset visibility for other tests
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  });

  test('unmount removes tooltip element and restores setAttribute patch', () => {
    const originalSetAttribute = Element.prototype.setAttribute;
    const { unmount } = render(<TooltipManager />);
    // Patched during mount
    expect(Element.prototype.setAttribute).not.toBe(originalSetAttribute);
    unmount();
    expect(Element.prototype.setAttribute).toBe(originalSetAttribute);
    expect(getTooltipEl()).toBeFalsy();
  });
});
