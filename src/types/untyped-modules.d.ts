// Ambient module declarations for third-party packages that ship without types
// and don't have a maintained @types/* package on DefinitelyTyped. Kept as
// `any` on purpose — installing full types for these narrow use cases would
// pull in transitive @types deps that the app itself doesn't need. If a use
// case grows beyond a few method calls, promote to a real d.ts here.

declare module 'adm-zip' {
  const AdmZip: any;
  export = AdmZip;
}

declare module 'xlsx-populate' {
  const XlsxPopulate: any;
  export = XlsxPopulate;
}

declare module 'better-sqlite3' {
  const Database: any;
  export = Database;
}

declare module 'word-extractor' {
  const value: any;
  export = value;
}

declare module 'officeparser' {
  const officeParser: any;
  export = officeParser;
}

declare module 'exif-reader' {
  const exifReader: any;
  export = exifReader;
}

declare module 'prop-types' {
  const PropTypes: any;
  export = PropTypes;
}
