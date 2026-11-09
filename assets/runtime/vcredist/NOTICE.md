# Microsoft Visual C++ Redistributable — Notice

Windows builds of StratoSort Stack include Microsoft's **Visual C++ Redistributable (v14,
2015-2022 and later)** installer in this directory, so the StratoSort installer (and the app's
**Install now** button) can install the runtime that the local AI engine needs
(`MSVCP140.dll`, `VCRUNTIME140.dll`).

- **Component:** Microsoft Visual C++ Redistributable, `vc_redist.x64.exe` (x64 builds) or
  `vc_redist.arm64.exe` (arm64 builds).
- **Publisher:** Microsoft Corporation.
- **Distributed:** unmodified, as Microsoft publishes it at `https://aka.ms/vc14/vc_redist.x64.exe`
  / `https://aka.ms/vc14/vc_redist.arm64.exe`. StratoSort does not re-sign it; its Authenticode
  signature is Microsoft's own and is checked before it is bundled and again before the app runs
  it.
- **License:** Microsoft "Distributable Code" under the Microsoft Visual Studio license terms; the
  installed runtime is subject to Microsoft's license terms
  (<https://visualstudio.microsoft.com/license-terms/>). StratoSort always runs the redistributable
  with `/passive` or `/quiet`, so Microsoft's installer does not show its license page; the
  StratoSort Windows installer's license screen states that it may install this component and
  that it is subject to Microsoft's terms. Copyright © Microsoft Corporation. All rights reserved.
- **Version and checksum:** recorded in `vc_redist.<arch>.json` next to this file, written by
  `scripts/setup-vc-redist.js` at package time.

**Commercial builds:** a business/commercially licensed StratoSort build may only ship this file
once the distributor has confirmed a Visual Studio license that covers redistribution of the
Distributable Code. See `docs/COMMERCIAL_COMPLIANCE.md`.

The redistributable is Windows-only and is not part of the macOS or Linux packages.
