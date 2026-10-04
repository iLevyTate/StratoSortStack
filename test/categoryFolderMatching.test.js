const {
  stripCategorySubjectSuffix,
  hasCategorySubjectSuffix,
  scoreFolderNameForDedup,
  findSmartFolderForLabel,
  findBestSemanticFolder,
  findSmartFolderForExtension,
  findSmartFolderForFile,
  getSelectableSmartFolders,
  isDefaultCategoryName
} = require('../src/shared/categoryFolderMatching');

describe('categoryFolderMatching', () => {
  describe('stripCategorySubjectSuffix', () => {
    test('strips long numeric suffix from category-subject artifacts', () => {
      expect(stripCategorySubjectSuffix('Nature_17803333378895')).toBe('Nature');
      expect(stripCategorySubjectSuffix('Finances-17803333396590')).toBe('Finances');
    });

    test('preserves short numeric tails like years', () => {
      expect(stripCategorySubjectSuffix('Annual_Report_2024')).toBe('Annual_Report_2024');
    });

    test('returns empty-safe input unchanged', () => {
      expect(stripCategorySubjectSuffix('')).toBe('');
      expect(stripCategorySubjectSuffix('Nature')).toBe('Nature');
    });
  });

  describe('hasCategorySubjectSuffix', () => {
    test('detects category-subject suffix artifacts', () => {
      expect(hasCategorySubjectSuffix('Nature_17803333378895')).toBe(true);
      expect(hasCategorySubjectSuffix('Nature')).toBe(false);
    });
  });

  describe('scoreFolderNameForDedup', () => {
    test('prefers clean folder names over suffix artifacts', () => {
      expect(scoreFolderNameForDedup('Nature')).toBeGreaterThan(
        scoreFolderNameForDedup('Nature_17803333378895')
      );
    });

    test('still prefers longer legitimate expansions', () => {
      expect(scoreFolderNameForDedup('Logos and Graphic Design')).toBeGreaterThan(
        scoreFolderNameForDedup('Logos')
      );
    });
  });

  describe('findSmartFolderForLabel', () => {
    const folders = [
      { name: 'Nature', path: 'C:/Docs/Nature' },
      { name: 'Finances', path: 'C:/Docs/Finances' },
      { name: 'Logos', path: 'C:/Docs/Logos' }
    ];

    test('matches category-subject artifact to configured smart folder', () => {
      expect(findSmartFolderForLabel('Nature_17803333378895', folders)?.name).toBe('Nature');
      expect(findSmartFolderForLabel('Finances_17803333396590', folders)?.name).toBe('Finances');
    });

    test('matches exact and variant labels', () => {
      expect(findSmartFolderForLabel('nature', folders)?.name).toBe('Nature');
      expect(
        findSmartFolderForLabel('my documents', [{ name: 'My Documents', path: '/x' }])?.name
      ).toBe('My Documents');
    });

    test('returns null when no folder matches', () => {
      expect(findSmartFolderForLabel('Videos', folders)).toBeNull();
    });

    test('resolves labels through folder description semantics', () => {
      const semanticFolders = [
        {
          name: 'Financial',
          path: 'C:/Docs/Financial',
          description: 'invoices, receipts, tax, bank statements'
        },
        { name: 'Uncategorized', path: 'C:/Docs/Uncategorized' }
      ];
      expect(findSmartFolderForLabel('Invoices', semanticFolders)?.name).toBe('Financial');
      expect(findBestSemanticFolder('Invoices', semanticFolders, { minScore: 0.35 })?.name).toBe(
        'Financial'
      );
    });

    describe('single-token labels (M5)', () => {
      test('does not route "Personal" to Finance via the phrase "personal finance"', () => {
        const folders = [
          { name: 'Finance', path: 'C:/Docs/Finance', description: 'personal finance' },
          { name: 'Uncategorized', path: 'C:/Docs/Uncategorized' }
        ];
        expect(findSmartFolderForLabel('Personal', folders)).toBeNull();
        expect(findBestSemanticFolder('Personal', folders)).toBeNull();
      });

      test('does not route "Photos" to Marketing via the phrase "campaign photos"', () => {
        const folders = [
          { name: 'Marketing', path: 'C:/Docs/Marketing', description: 'campaign photos' },
          { name: 'Uncategorized', path: 'C:/Docs/Uncategorized' }
        ];
        expect(findSmartFolderForLabel('Photos', folders)).toBeNull();
      });

      test('still honours an explicit keyword or standalone description item', () => {
        const folders = [
          { name: 'Marketing', path: 'C:/Docs/Marketing', keywords: ['photos', 'campaigns'] },
          { name: 'Finance', path: 'C:/Docs/Finance', description: 'budgets, personal, taxes' }
        ];
        expect(findSmartFolderForLabel('Photos', folders)?.name).toBe('Marketing');
        expect(findSmartFolderForLabel('Personal', folders)?.name).toBe('Finance');
      });
    });

    describe('description/keyword routing for typical LLM labels', () => {
      const folders = [
        {
          name: 'Finance',
          path: 'C:/Docs/Finance',
          description: 'Budgets, forecasts, portfolio, invoices, financial'
        },
        {
          name: 'Research',
          path: 'C:/Docs/Research',
          description:
            'Research papers, science, biotech, clinical trials, machine learning, biology'
        },
        {
          name: 'Nature',
          path: 'C:/Docs/Nature',
          description: 'Environment, climate, wildlife, ecology, oceans, coral, reefs, arctic'
        },
        { name: 'Uncategorized', path: 'C:/Docs/Uncategorized' }
      ];

      test.each([
        ['Finance', 'Finance'],
        ['Financial', 'Finance'],
        ['Budget', 'Finance'],
        ['Budgets', 'Finance'],
        ['Forecast', 'Finance'],
        ['Invoices', 'Finance'],
        ['Portfolio', 'Finance'],
        ['Portfolio Performance', 'Finance'],
        ['Budget Forecast', 'Finance'],
        ['Research', 'Research'],
        ['Science', 'Research'],
        ['Biology', 'Research'],
        ['Biotech', 'Research'],
        ['Clinical Trials', 'Research'],
        ['Machine Learning', 'Research'],
        ['Deep Learning', 'Research'],
        ['Nature', 'Nature'],
        ['Climate', 'Nature'],
        ['Climate Change', 'Nature'],
        ['Environment', 'Nature'],
        ['Wildlife', 'Nature'],
        ['Ecology', 'Nature'],
        ['Oceans', 'Nature']
      ])('%s → %s', (label, expected) => {
        expect(findSmartFolderForLabel(label, folders)?.name).toBe(expected);
      });

      test('refuses a bare Reports label when more than one folder lists reports as a keyword', () => {
        const withReports = [
          { name: 'Finance', description: 'budgets, reports' },
          { name: 'Nature', description: 'climate, reports' },
          { name: 'Uncategorized' }
        ];
        expect(findSmartFolderForLabel('Reports', withReports)).toBeNull();
      });
    });
  });

  describe('getSelectableSmartFolders', () => {
    test('hides the built-in Uncategorized catch-all from Organize pickers', () => {
      const folders = [
        { id: '1', name: 'Work' },
        { id: '2', name: 'Uncategorized' },
        { id: '3', name: 'Research' }
      ];
      expect(getSelectableSmartFolders(folders).map((f) => f.name)).toEqual(['Work', 'Research']);
      expect(isDefaultCategoryName('Uncategorized')).toBe(true);
    });
  });

  describe('findSmartFolderForExtension', () => {
    const folders = [
      { name: 'Documents', path: 'C:/Docs/Documents', keywords: ['pdf', 'doc'] },
      { name: '3D Prints', path: 'C:/Docs/3D Prints', description: 'STL OBJ 3MF G-code models' },
      { name: 'Uncategorized', path: 'C:/Docs/Uncategorized' }
    ];

    test('routes 3D print extensions to the 3D Prints folder', () => {
      expect(findSmartFolderForExtension('.stl', folders)?.name).toBe('3D Prints');
      expect(findSmartFolderForExtension('gcode', folders)?.name).toBe('3D Prints');
      expect(findSmartFolderForExtension('.3mf', folders)?.name).toBe('3D Prints');
      expect(findSmartFolderForExtension('.scad', folders)?.name).toBe('3D Prints');
    });

    test('does not force PDFs into the 3D folder', () => {
      expect(findSmartFolderForExtension('.pdf', folders)?.name).toBe('Documents');
    });

    test('honors explicit "all .ext go here" keywords on any folder', () => {
      const withBooks = [
        ...folders,
        { name: 'Books', path: 'C:/Docs/Books', keywords: ['.epub', 'mobi'] }
      ];
      expect(findSmartFolderForExtension('.epub', withBooks)?.name).toBe('Books');
      expect(findSmartFolderForExtension('mobi', withBooks)?.name).toBe('Books');
    });

    test('prefers a themed folder over Documents when both list the same extension', () => {
      const mixed = [
        { name: 'Documents', path: 'C:/Docs/Documents', keywords: ['pdf', 'doc'] },
        { name: 'Invoices', path: 'C:/Docs/Invoices', keywords: ['.pdf'] }
      ];
      expect(findSmartFolderForExtension('.pdf', mixed)?.name).toBe('Invoices');
    });

    describe('explicit extension claims (H5)', () => {
      test('".json" in a description does not claim .js (and vice versa)', () => {
        const withCode = [
          { name: 'Configs', path: 'C:/Docs/Configs', description: 'All .json config files' },
          { name: 'Scripts', path: 'C:/Docs/Scripts', description: 'Node .js sources' }
        ];
        expect(findSmartFolderForExtension('.js', withCode)?.name).toBe('Scripts');
        expect(findSmartFolderForExtension('.json', withCode)?.name).toBe('Configs');
      });

      test('".css" does not claim .c and ".c" does not claim .css', () => {
        const withCode = [
          { name: 'Styles', path: 'C:/Docs/Styles', description: 'Stylesheets (.css)' },
          { name: 'Sources', path: 'C:/Docs/Sources', description: 'C sources: .c and .h' }
        ];
        expect(findSmartFolderForExtension('.c', withCode)?.name).toBe('Sources');
        expect(findSmartFolderForExtension('.css', withCode)?.name).toBe('Styles');
      });

      test('a bare word in prose is not a claim ("PDF manuals", "step-by-step")', () => {
        const prose = [
          { name: 'Printer Manuals', path: 'C:/Docs/Manuals', description: 'PDF manuals' },
          { name: 'Guides', path: 'C:/Docs/Guides', description: 'step-by-step tutorials' }
        ];
        expect(findSmartFolderForExtension('.pdf', prose)).toBeNull();
        expect(findSmartFolderForExtension('.step', prose)).toBeNull();
      });

      test('refuses when two themed folders claim the same extension without a keyword', () => {
        const ambiguous = [
          { name: 'Invoices', path: 'C:/Docs/Invoices', description: 'Vendor .pdf invoices' },
          { name: 'Contracts', path: 'C:/Docs/Contracts', description: 'Signed .pdf contracts' }
        ];
        expect(findSmartFolderForExtension('.pdf', ambiguous)).toBeNull();

        const withKeyword = [ambiguous[0], { ...ambiguous[1], keywords: ['pdf'] }];
        expect(findSmartFolderForExtension('.pdf', withKeyword)?.name).toBe('Contracts');
      });
    });

    describe('specialized 3D routing (L10)', () => {
      test('a "Print" word in the folder name alone does not attract .stl / .gcode', () => {
        const shops = [
          { name: 'Print Shop Receipts', path: 'C:/Docs/Receipts' },
          { name: 'Printer Manuals', path: 'C:/Docs/Manuals' },
          { name: 'Uncategorized', path: 'C:/Docs/Uncategorized' }
        ];
        expect(findSmartFolderForExtension('.stl', shops)).toBeNull();
        expect(findSmartFolderForExtension('.gcode', shops)).toBeNull();
      });

      test('still routes to folders with unmistakable maker signals', () => {
        const maker = [
          { name: 'Print Shop Receipts', path: 'C:/Docs/Receipts' },
          { name: 'Prints', path: 'C:/Docs/Prints', description: 'sliced 3D printing models' },
          { name: 'Uncategorized', path: 'C:/Docs/Uncategorized' }
        ];
        expect(findSmartFolderForExtension('.stl', maker)?.name).toBe('Prints');
        expect(findSmartFolderForExtension('.stl', [{ name: 'CAD', path: 'C:/CAD' }])?.name).toBe(
          'CAD'
        );
      });
    });
  });

  describe('findSmartFolderForFile', () => {
    const folders = [
      { name: 'Documents', path: 'C:/Docs/Documents' },
      { name: '3D Prints', path: 'C:/Docs/3D Prints', keywords: ['stl', '3d', 'print'] },
      { name: 'Uncategorized', path: 'C:/Docs/Uncategorized' }
    ];

    test('overrides Uncategorized / Documents categories for .stl files', () => {
      expect(
        findSmartFolderForFile(
          {
            path: 'C:/inbox/benchy.stl',
            extension: '.stl',
            analysis: { category: 'Uncategorized' }
          },
          folders
        )?.name
      ).toBe('3D Prints');
      expect(
        findSmartFolderForFile(
          { path: 'C:/inbox/part.stl', analysis: { category: 'Documents' } },
          folders
        )?.name
      ).toBe('3D Prints');
    });

    test('keeps a specific non-generic category match', () => {
      const withWork = [...folders, { name: 'Work', path: 'C:/Docs/Work' }];
      expect(
        findSmartFolderForFile(
          { path: 'C:/inbox/spec.pdf', extension: '.pdf', analysis: { category: 'Work' } },
          withWork
        )?.name
      ).toBe('Work');
    });

    test('routes any claimed extension even when analysis says Documents', () => {
      const withBooks = [...folders, { name: 'Books', path: 'C:/Docs/Books', keywords: ['epub'] }];
      expect(
        findSmartFolderForFile(
          { path: 'C:/inbox/novel.epub', extension: '.epub', analysis: { category: 'Documents' } },
          withBooks
        )?.name
      ).toBe('Books');
    });

    test('falls back to analysis keywords when category is Uncategorized', () => {
      const themed = [
        {
          name: 'Finance',
          path: 'C:/Docs/Finance',
          description: 'Budgets, forecasts, portfolio, invoices, financial'
        },
        { name: 'Uncategorized', path: 'C:/Docs/Uncategorized' }
      ];
      expect(
        findSmartFolderForFile(
          {
            path: 'C:/inbox/annual-budget-forecast-2026.txt',
            analysis: {
              category: 'Uncategorized',
              keywords: ['budget', 'forecast', 'revenue', 'ebitda']
            }
          },
          themed
        )?.name
      ).toBe('Finance');
    });
  });
});
