/**
 * checkFolderDescription: plain warnings for Smart Folder descriptions that
 * give the AI too little to go on, are cut off, or read like another folder's.
 */
const { checkFolderDescription } = require('../src/shared/smartFolderDescriptionCheck');
const { TRUNCATION } = require('../src/shared/performanceConstants');

const codes = (issues) => issues.map((issue) => issue.code);

describe('checkFolderDescription', () => {
  test('an empty description, or the template the app fills in, is missing', () => {
    expect(codes(checkFolderDescription({ name: 'GSC', description: '' }))).toEqual(['missing']);
    expect(codes(checkFolderDescription({ name: 'GSC', description: '   ' }))).toEqual(['missing']);
    expect(
      codes(checkFolderDescription({ name: 'GSC', description: 'Smart folder for GSC' }))
    ).toEqual(['missing']);
    expect(checkFolderDescription({ name: 'GSC', description: '' })[0].message).toMatch(
      /^Add a description\./
    );
  });

  test('a description of a few words is short', () => {
    const issues = checkFolderDescription({ name: 'SEO', description: 'SEO stuff' });
    expect(codes(issues)).toEqual(['short']);
  });

  test('a description longer than the AI reads is flagged with the limit', () => {
    const max = TRUNCATION.PROMPT_FOLDER_DESCRIPTION_MAX;
    const description = `Monthly search reports ${'and more words '.repeat(40)}`.slice(0, max + 50);
    const issues = checkFolderDescription({ name: 'Reports', description });
    expect(codes(issues)).toEqual(['long']);
    expect(issues[0].message).toContain(`${max} characters`);
  });

  test('a custom limit is honoured', () => {
    const issues = checkFolderDescription({
      name: 'Reports',
      description: 'Monthly search reports from every tool we use',
      maxChars: 20
    });
    expect(issues[0].message).toContain('20 characters');
  });

  test('descriptions that read alike name the other folder', () => {
    const issues = checkFolderDescription({
      name: 'GSC',
      description: 'Google Search Console performance exports with queries pages clicks',
      otherFolders: [
        {
          name: 'Bing',
          description: 'Bing Webmaster performance exports with queries pages clicks'
        }
      ]
    });
    expect(codes(issues)).toEqual(['similar']);
    expect(issues[0].message).toContain('"Bing"');
  });

  test('descriptions about different things are fine', () => {
    expect(
      checkFolderDescription({
        name: 'Invoices',
        description: 'Invoices from suppliers with amounts due',
        otherFolders: [{ name: 'Contracts', description: 'Signed client contracts and NDAs' }]
      })
    ).toEqual([]);
  });

  test('another folder with a template description is not compared', () => {
    expect(
      checkFolderDescription({
        name: 'GSC',
        description: 'Google Search Console exports of queries',
        otherFolders: [{ name: 'Bing', description: 'Smart folder for Bing' }, null]
      })
    ).toEqual([]);
  });
});
