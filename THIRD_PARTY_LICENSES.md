# Third Party Licenses

This project uses the following open source software. Licenses were inventoried
from production dependencies (`pnpm licenses list --prod`).

## MIT License

Next.js, React, React DOM, @anthropic-ai/sdk, @supabase/* (ssr / supabase-js /
auth-js / storage-js / realtime-js / postgrest-js / functions-js), @upstash/redis,
@upstash/ratelimit, pdf-lib, @pdf-lib/fontkit, pdfjs-serverless, unpdf,
@napi-rs/canvas, opentype.js, qrcode, nanoid, p-limit, zod, react-hook-form,
@hookform/resolvers, react-turnstile, docxtemplater, libreoffice-convert,
and other transitive MIT-licensed packages.

## Apache-2.0 License

@mistralai/mistralai, pdfjs-dist, tesseract.js, tesseract.js-core,
sharp, idb-keyval, detect-libc, baseline-browser-mapping, wasm-feature-detect,
@swc/helpers, and other transitive Apache-2.0 packages (14 in total per
`pnpm licenses list --prod`).

The platform-specific sharp binaries (e.g. `@img/sharp-win32-x64`) are licensed
"Apache-2.0 AND LGPL-3.0-or-later"; the LGPL-3.0-or-later portion covers the
prebuilt native libvips component bundled with those binaries.

None of the bundled Apache-2.0 dependencies ship a NOTICE file, so no NOTICE
file is required by Apache-2.0 §4(d) for this distribution.

## ISC License

semver, lru-cache, picocolors, inherits, and other transitive ISC-licensed
packages.

## 0BSD License

- tslib（pdf-lib / supabase / sharp 経由・配布物に同梱）

## CC-BY-4.0 License

- caniuse-lite（next / browserslist 経由）

## BSD-2-Clause / BSD-3-Clause License

mammoth, dingbat-to-unicode, lop, option, webidl-conversions, duck
(mammoth → lop 経由) (BSD-2-Clause);
source-map-js, sprintf-js (BSD-3-Clause).

## Dual-Licensed (MIT selected)

- jszip (MIT OR GPL-3.0-or-later) — used under MIT
- pizzip (MIT OR GPL-3.0) — used under MIT
- pako (MIT AND Zlib)

## SIL Open Font License 1.1

- Noto Sans JP (subset, bundled at `app/public/fonts/NotoSansJP-Regular.subset.otf`)
- @fontsource/noto-sans-jp
- See: app/public/fonts/OFL.txt

## Character Assets (separate license)

The Gizirotto character assets under `app/public/character/` are NOT covered by
the repository MIT license. They are licensed under CC-BY-NC 4.0 (non-commercial
use only). See: app/public/character/LICENSE.md
