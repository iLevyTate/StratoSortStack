describe('scrollLock', () => {
  function loadModule() {
    jest.resetModules();
    return require('../src/renderer/utils/scrollLock');
  }

  test('lockAppScroll hides overflow and restores on unlock', () => {
    const main = document.createElement('div');
    main.id = 'main-content';
    document.body.appendChild(main);
    document.body.style.overflow = 'auto';
    main.style.overflow = 'scroll';

    const { lockAppScroll, unlockAppScroll } = loadModule();

    lockAppScroll();
    expect(document.body.style.overflow).toBe('hidden');
    expect(main.style.overflow).toBe('hidden');

    unlockAppScroll();
    expect(document.body.style.overflow).toBe('auto');
    expect(main.style.overflow).toBe('scroll');

    main.remove();
  });

  test('lock count prevents early unlock', () => {
    const main = document.createElement('div');
    main.id = 'main-content';
    document.body.appendChild(main);
    document.body.style.overflow = 'auto';

    const { lockAppScroll, unlockAppScroll } = loadModule();

    lockAppScroll();
    lockAppScroll();
    unlockAppScroll();
    expect(document.body.style.overflow).toBe('hidden');

    unlockAppScroll();
    expect(document.body.style.overflow).toBe('auto');

    main.remove();
  });

  test('lock ids are idempotent and do not over-increment', () => {
    const main = document.createElement('div');
    main.id = 'main-content';
    document.body.appendChild(main);
    document.body.style.overflow = 'auto';

    const { lockAppScroll, unlockAppScroll } = loadModule();

    lockAppScroll('settings-panel');
    lockAppScroll('settings-panel');

    expect(document.body.style.overflow).toBe('hidden');

    unlockAppScroll('settings-panel');
    expect(document.body.style.overflow).toBe('auto');

    main.remove();
  });

  test('unlocking unknown id does not release active lock', () => {
    const main = document.createElement('div');
    main.id = 'main-content';
    document.body.appendChild(main);
    document.body.style.overflow = 'auto';

    const { lockAppScroll, unlockAppScroll } = loadModule();

    lockAppScroll('settings-panel');
    unlockAppScroll('modal-unknown');

    expect(document.body.style.overflow).toBe('hidden');

    unlockAppScroll('settings-panel');
    expect(document.body.style.overflow).toBe('auto');

    main.remove();
  });

  // Regression: the splash's permanent root lock must NOT freeze <main>,
  // or phase content can't scroll for the life of the app. See Theme 6
  // scroll-lock regression (Setup phase folder list).
  test('includeMain:false locks root surfaces but leaves main scrollable', () => {
    const main = document.createElement('div');
    main.id = 'main-content';
    document.body.appendChild(main);
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
    main.style.overflow = '';

    const { lockAppScroll } = loadModule();

    lockAppScroll('splash-permanent-root', { includeMain: false });

    expect(document.documentElement.style.overflow).toBe('hidden');
    expect(document.body.style.overflow).toBe('hidden');
    // Critical: <main> inline overflow must remain untouched so the
    // Tailwind class `overflow-y-auto` continues to govern it.
    expect(main.style.overflow).toBe('');

    main.remove();
  });

  // Regression: a modal opening on top of the permanent root lock must
  // still freeze <main> (full-page freeze while the modal is open), and
  // closing it must restore <main> — but leave the permanent root lock
  // intact so the document root stays pinned.
  test('modal layered on includeMain:false lock freezes and restores main independently', () => {
    const main = document.createElement('div');
    main.id = 'main-content';
    document.body.appendChild(main);
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
    main.style.overflow = '';

    const { lockAppScroll, unlockAppScroll } = loadModule();

    lockAppScroll('splash-permanent-root', { includeMain: false });
    expect(main.style.overflow).toBe('');

    lockAppScroll('modal');
    expect(document.documentElement.style.overflow).toBe('hidden');
    expect(document.body.style.overflow).toBe('hidden');
    expect(main.style.overflow).toBe('hidden');

    unlockAppScroll('modal');
    // Modal released main, permanent root lock still holds html/body.
    expect(main.style.overflow).toBe('');
    expect(document.documentElement.style.overflow).toBe('hidden');
    expect(document.body.style.overflow).toBe('hidden');

    main.remove();
  });
});
