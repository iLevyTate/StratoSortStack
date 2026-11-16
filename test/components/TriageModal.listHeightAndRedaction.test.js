/**
 * TriageModal: the file list keeps a real height across close/reopen, and rows
 * honour the redactPaths setting.
 */
import React, { useEffect, useState } from 'react';
import { render, screen, act } from '@testing-library/react';

let mockRedactPaths = false;

jest.mock('react-window', () => ({
  __esModule: true,
  List: ({ rowCount, rowComponent: Row, rowProps = {}, style }) => (
    <div data-testid="react-window-list" style={style}>
      {Array.from({ length: rowCount }).map((_, index) => (
        <Row key={index} index={index} style={{}} {...rowProps} />
      ))}
    </div>
  )
}));

jest.mock('react-redux', () => ({
  useSelector: jest.fn((selector) =>
    selector({ system: { redactPaths: mockRedactPaths, redactPathsLoaded: true } })
  )
}));

jest.mock('lucide-react', () => ({
  FileText: () => <span>FileText</span>,
  FolderInput: () => <span>FolderInput</span>
}));

jest.mock('../../src/shared/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })
}));

// Mirrors ui/Modal's lifecycle: children mount one render after isOpen turns
// true and stay mounted through the exit animation (flushed by a timer).
jest.mock('../../src/renderer/components/ui/Modal', () => {
  const ReactLib = jest.requireActual('react');
  function DelayedModal({ isOpen, children, footer }) {
    const [isVisible, setIsVisible] = ReactLib.useState(false);
    ReactLib.useEffect(() => {
      if (isOpen && !isVisible) setIsVisible(true);
      if (!isOpen && isVisible) {
        const t = setTimeout(() => setIsVisible(false), 140);
        return () => clearTimeout(t);
      }
      return undefined;
    }, [isOpen, isVisible]);
    if (!isVisible) return null;
    return (
      <div data-testid="modal">
        {children}
        {footer}
      </div>
    );
  }
  return { __esModule: true, default: DelayedModal };
});

jest.mock('../../src/renderer/components/ui/Button', () => ({
  __esModule: true,
  default: ({ children, onClick, leftIcon, isLoading, variant, size, ...props }) => (
    <button type="button" onClick={onClick} {...props}>
      {children}
    </button>
  )
}));

jest.mock('../../src/renderer/components/ui/Typography', () => ({
  Text: ({ children, as: Tag = 'span', variant, ...props }) => <Tag {...props}>{children}</Tag>
}));

jest.mock('../../src/renderer/components/ui/FileIcon', () => ({
  __esModule: true,
  default: ({ filename }) => <span data-testid="file-icon">{filename}</span>
}));

jest.mock('../../src/renderer/hooks/useFileActions', () => ({
  useFileActions: () => ({ openFile: jest.fn(), revealFile: jest.fn() })
}));

import TriageModal from '../../src/renderer/components/organize/TriageModal';

/** Fake ResizeObserver that lets the test report sizes for observed nodes. */
class FakeResizeObserver {
  static instances = [];
  constructor(cb) {
    this.cb = cb;
    this.targets = new Set();
    FakeResizeObserver.instances.push(this);
  }
  observe(el) {
    this.targets.add(el);
  }
  unobserve(el) {
    this.targets.delete(el);
  }
  disconnect() {
    this.targets.clear();
  }
  static report(el, height) {
    for (const obs of FakeResizeObserver.instances) {
      if (obs.targets.has(el)) obs.cb([{ target: el, contentRect: { height } }]);
    }
  }
  static activeTargets() {
    return FakeResizeObserver.instances.flatMap((obs) => [...obs.targets]);
  }
}

const FILES = [{ path: 'C:\\Users\\someone\\Documents\\Taxes\\invoice.pdf', name: 'invoice.pdf' }];

function Host({ files = FILES }) {
  const [open, setOpen] = useState(false);
  // Expose toggles to the test without extra UI.
  useEffect(() => {
    Host.setOpen = setOpen;
  }, []);
  return (
    <TriageModal
      isOpen={open}
      onClose={() => setOpen(false)}
      files={files}
      onMoveFiles={jest.fn()}
    />
  );
}

function listContainer() {
  return screen.getByTestId('react-window-list').parentElement;
}

describe('TriageModal list height', () => {
  const originalRO = global.ResizeObserver;

  beforeEach(() => {
    jest.useFakeTimers();
    FakeResizeObserver.instances = [];
    global.ResizeObserver = FakeResizeObserver;
    mockRedactPaths = false;
  });

  afterEach(() => {
    jest.useRealTimers();
    global.ResizeObserver = originalRO;
  });

  test('observes the list container once Modal mounts it, on first and second open', () => {
    render(<Host />);

    act(() => Host.setOpen(true));
    let container = listContainer();
    expect(FakeResizeObserver.activeTargets()).toContain(container);

    act(() => FakeResizeObserver.report(container, 321));
    expect(screen.getByTestId('react-window-list').style.height).toBe('321px');

    // Close and let the exit animation finish so the content unmounts.
    act(() => Host.setOpen(false));
    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(screen.queryByTestId('modal')).toBeNull();
    // Nothing should still be watching the removed node.
    expect(FakeResizeObserver.activeTargets()).toHaveLength(0);

    act(() => Host.setOpen(true));
    container = listContainer();
    expect(FakeResizeObserver.activeTargets()).toContain(container);
    expect(screen.getByTestId('react-window-list').style.height).not.toBe('0px');

    act(() => FakeResizeObserver.report(container, 280));
    expect(screen.getByTestId('react-window-list').style.height).toBe('280px');
  });

  test('ignores a 0-height entry from a detaching node', () => {
    render(<Host />);
    act(() => Host.setOpen(true));
    const container = listContainer();
    act(() => FakeResizeObserver.report(container, 300));
    act(() => FakeResizeObserver.report(container, 0));
    expect(screen.getByTestId('react-window-list').style.height).toBe('300px');
  });
});

describe('TriageModal path redaction', () => {
  function renderOpen() {
    return render(
      <TriageModal isOpen={true} onClose={jest.fn()} files={FILES} onMoveFiles={jest.fn()} />
    );
  }

  test('shows the full path and name when redaction is off', () => {
    mockRedactPaths = false;
    renderOpen();
    expect(screen.getByText(FILES[0].path)).toBeInTheDocument();
    expect(screen.getByText('invoice.pdf', { selector: 'div' })).toBeInTheDocument();
    expect(screen.getByLabelText('Select invoice.pdf')).toBeInTheDocument();
  });

  test('hides the directory structure and name when redaction is on', () => {
    mockRedactPaths = true;
    const { container } = renderOpen();
    expect(container.textContent).not.toContain('someone');
    expect(container.textContent).not.toContain('Documents');
    expect(screen.getByText('…\\Taxes\\invoice.pdf')).toBeInTheDocument();
    expect(screen.getByText('Hidden file.pdf')).toBeInTheDocument();
    expect(screen.getByLabelText('Select Hidden file.pdf')).toBeInTheDocument();
    expect(container.querySelector('[title*="someone"]')).toBeNull();
  });
});
