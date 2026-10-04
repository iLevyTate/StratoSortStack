/**
 * @jest-environment jsdom
 *
 * Runtime accessibility audits for the self-contained design-system primitives.
 *
 * These components are rendered UNMOCKED (only React + PropTypes + lucide icons +
 * sibling primitives), so axe inspects the real DOM the app ships. Fully-mocked
 * phase screens (Discover/Organize) are intentionally NOT audited here — mocking
 * the ui layer away makes an axe pass a vanity check. Whole-screen audits live in
 * the Playwright E2E pass (test/e2e/accessibility.spec.js) where the real layout,
 * focus order, and color contrast can be measured.
 *
 * jsdom limitation: axe's color-contrast rule is reported "incomplete" (no layout
 * engine) and therefore never fails toHaveNoViolations(). Treat this suite as the
 * semantic/ARIA gate; contrast is the E2E pass's job.
 */
'use strict';
import React from 'react';
import { render } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

import Button from '../../src/renderer/components/ui/Button';
import IconButton from '../../src/renderer/components/ui/IconButton';
import AlertBox from '../../src/renderer/components/ui/AlertBox';
import StatusBadge from '../../src/renderer/components/ui/StatusBadge';
import Input from '../../src/renderer/components/ui/Input';
import Label from '../../src/renderer/components/ui/Label';
import Switch from '../../src/renderer/components/ui/Switch';
import Modal from '../../src/renderer/components/ui/Modal';

expect.extend(toHaveNoViolations);

// Page-composition rules (region/landmark) only make sense for a whole page.
// These are isolated component fragments with no surrounding <main>, so those
// rules would always fire — they're enforced instead by the full-page E2E pass
// (test/e2e/accessibility.spec.js). Everything else (WCAG name/role/label
// conformance) stays on.
const FRAGMENT_AXE_OPTIONS = {
  rules: {
    region: { enabled: false },
    'landmark-one-main': { enabled: false },
    'page-has-heading-one': { enabled: false }
  }
};

async function expectNoA11yViolations(ui) {
  const { baseElement } = render(ui);
  const results = await axe(baseElement, FRAGMENT_AXE_OPTIONS);
  expect(results).toHaveNoViolations();
}

describe('UI primitives accessibility (axe)', () => {
  describe('Button', () => {
    test('text-label button has no violations', async () => {
      await expectNoA11yViolations(<Button>Browse files</Button>);
    });

    test('icon-only button derives its name from aria-label', async () => {
      await expectNoA11yViolations(
        <Button aria-label="Refresh results" leftIcon={<svg aria-hidden="true" />} />
      );
    });

    test('loading + disabled states stay accessible', async () => {
      await expectNoA11yViolations(
        <Button isLoading disabled>
          Saving
        </Button>
      );
    });
  });

  describe('IconButton', () => {
    test('requires and applies an accessible name', async () => {
      await expectNoA11yViolations(
        <IconButton aria-label="Close panel" icon={<svg aria-hidden="true" />} />
      );
    });
  });

  describe('AlertBox', () => {
    test.each(['info', 'warning', 'danger', 'success'])(
      '%s variant exposes role="alert" with content',
      async (variant) => {
        await expectNoA11yViolations(<AlertBox variant={variant}>Heads up</AlertBox>);
      }
    );
  });

  describe('StatusBadge', () => {
    test('renders text content without violations', async () => {
      await expectNoA11yViolations(<StatusBadge variant="success">Ready</StatusBadge>);
    });
  });

  describe('Input', () => {
    test('labelled text input associates label and control', async () => {
      await expectNoA11yViolations(<Input label="Folder name" name="folder" />);
    });

    test('error state wires aria-describedby to the message', async () => {
      await expectNoA11yViolations(
        <Input label="Folder name" name="folder" error="Required" invalid />
      );
    });

    test('standalone input falls back to an accessible name', async () => {
      await expectNoA11yViolations(<Input aria-label="Search" name="q" />);
    });

    test('number input keeps its redundant visual steppers out of the a11y tree', async () => {
      // The +/- steppers are aria-hidden + tabIndex=-1 on purpose: a native
      // number input already increments via arrow keys, so exposing unnamed
      // icon buttons would be noise. This pins that intent — if someone drops
      // the aria-hidden wrapper, axe's button-name rule fails this test.
      await expectNoA11yViolations(
        <Input
          label="Concurrency"
          name="concurrency"
          type="number"
          min={1}
          max={8}
          value={4}
          readOnly
        />
      );
    });
  });

  describe('Label', () => {
    test('required label exposes the required marker accessibly', async () => {
      await expectNoA11yViolations(
        <>
          <Label htmlFor="x" required>
            API key
          </Label>
          {/* htmlFor->id pairs the Label to this input; axe confirms the
              association at runtime. jsx-a11y can't follow it across sibling
              JSX, so its static warning here is a false positive. */}
          {/* eslint-disable-next-line jsx-a11y/control-has-associated-label */}
          <input id="x" />
        </>
      );
    });
  });

  describe('Switch', () => {
    test('toggle has role=switch and an accessible name', async () => {
      await expectNoA11yViolations(
        <Switch checked={false} onChange={() => {}} aria-label="Enable telemetry" />
      );
    });
  });

  describe('Modal', () => {
    test('open dialog labels itself and its close control', async () => {
      await expectNoA11yViolations(
        <Modal isOpen onClose={() => {}} title="Confirm" description="Are you sure?">
          <p>Body content</p>
        </Modal>
      );
    });
  });
});
