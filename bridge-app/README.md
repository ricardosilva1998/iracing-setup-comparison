# iRacing Setup Bridge

Desktop app (Windows) that lets you navigate the setup comparison site and download setups directly into your iRacing setups folder.

Built with [Tauri 2](https://tauri.app/) (Rust + React/Vite). Installer is a Windows `.msi`.

## Folder layout written to disk

```
<iRacing setups root>\
  <car-slug>\
    <season-label>\       e.g. 26s2
      <track-slug>\
        <shop-slug>\
          setup-name.sto
```

Default root: `%USERPROFILE%\Documents\iRacing\setups\` (configurable in Settings).

## Building locally (Mac — dev only, no MSI output)

Requires Rust stable (`rustup` + `cargo`) and Node 22.

```bash
cd bridge-app
npm install
npm run tauri dev       # compiles Rust + starts Vite dev server; Ctrl-C to stop
```

Rust compile check only (no window):

```bash
cd bridge-app/src-tauri
cargo check
```

## Building the Windows MSI (CI)

Push a tag matching `bridge-v*`:

```bash
git tag bridge-v0.1.0
git push origin bridge-v0.1.0
```

GitHub Actions (`bridge-build.yml`) runs on `windows-latest`, builds the MSI, and attaches it to a GitHub Release automatically.

Download URL pattern:
```
https://github.com/ricardosilva1998/iracing-setup-comparison/releases/download/bridge-v<version>/iracing-setup-bridge_<version>_x64_en-US.msi
```

You can also trigger the build manually without a tag via the Run workflow button in the Actions tab (`workflow_dispatch`). The MSI is uploaded as an artifact but no Release is created for manual runs.

## Environment / secrets required by CI

None beyond repository permissions. No signing cert is configured; Windows will show a SmartScreen warning on first run (expected for unsigned MSIs).

## Updating the server URL or credentials

Open the app Settings tab. The server URL and iRacing root are stored in `%APPDATA%\iracing-setup-bridge\config.json`. Credentials are stored in Windows Credential Manager (never on disk in plaintext).
