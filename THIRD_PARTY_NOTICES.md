# Third-party notices

Split Stack is distributed under the MIT License in `LICENSE`. The release
bundle contains or was produced with the following third-party work.

## Runtime dependency

### Three.js 0.162.0

Copyright © 2010–2024 three.js authors
Source: https://github.com/mrdoob/three.js
License: MIT

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## Algorithm reference

The deterministic random-number generator is a TypeScript port of the
public-domain xoshiro128** 1.1 reference implementation by David Blackman and
Sebastiano Vigna: https://prng.di.unimi.it/

## Tracker replay engine

### Micromod JavaScript replay core

`src/audio/mod-replay.ts` contains an adapted version of Micromod's JavaScript
ProTracker replay core.

Copyright (c) 2019, Martin Cameron

All rights reserved.

- Source: https://github.com/martincameron/micromod
- Upstream commit: `83b5d9aebddb528ea177e115b0afed5d75f6b92a`
- Upstream file blob: `2afe964f4304718071bfbb1483df96724cfeb8c6`
- License: BSD 3-Clause

> Redistribution and use in source and binary forms, with or without
> modification, are permitted provided that the following conditions are met:
>
> - Redistributions of source code must retain the above copyright notice,
>   this list of conditions and the following disclaimer.
> - Redistributions in binary form must reproduce the above copyright notice,
>   this list of conditions and the following disclaimer in the documentation
>   and/or other materials provided with the distribution.
> - Neither the name of the organization nor the names of its contributors may
>   be used to endorse or promote products derived from this software without
>   specific prior written permission.
>
> THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
> AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
> IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
> ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
> LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
> CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
> SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
> INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
> CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
> ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
> POSSIBILITY OF SUCH DAMAGE.

## Bundled ProTracker music modules

The following module files are bundled byte-for-byte as supplied by the project
owner. They are not licensed under the Split Stack MIT License. Their Mod
Archive pages show only the Mod Archive Distribution license; according to Mod
Archive's licensing FAQ, that license does not itself grant permission to bundle
a module inside a packed game or application. Inclusion here records the
project owner's decision to accept that unresolved risk for limited personal
distribution. It is not a representation that game-use permission has been
obtained. Replace or independently clear these assets before wider
redistribution.

- Licensing FAQ: https://modarchive.org/index.php?faq-licensing
- Distribution terms: https://modarchive.org/index.php?terms-upload

### Bloody Tears

- File: `bloody_tears.mod`
- Credit embedded in the module: X68000 conversion by Estrayk, June 2023,
  Capsule / Scoopex, for Dante.
- Mod Archive ID/source: [212035](https://modarchive.org/index.php?request=view_by_moduleid&query=212035)
- SHA-256: `76e82333f8c6e17707f41c4c82ca36928d6b94dd0c6b8dfdae0c148150303414`

### In the Hall of the Mountain King

- File: `radix-mountain_king.mod`
- Credit: module by Radix / Limited Edition.
- Mod Archive ID/source: [67602](https://modarchive.org/index.php?request=view_by_moduleid&query=67602)
- SHA-256: `3605bb8d15ab070fe5c89f1a2020b6f4b1c922db2862d1ce66f0ecb2f115ca3d`

### Flight of the Bumblebee

- File: `flight_of_bumble_bee.mod`
- Credit embedded in the module: edited by Frog & Max Schorwer.
- Mod Archive ID/source: [97600](https://modarchive.org/index.php?request=view_by_moduleid&query=97600)
- SHA-256: `7ae9abff166887906f4ac76635ffca186139d1bb1abfdab463a117126990af5c`

### Popcorn

- File: `galaxy_-_popcorn.mod`
- Credit: the arranger is not identified in the module or Mod Archive listing;
  `galaxy_` appears only in the supplied filename and is not presented here as
  a confirmed artist credit.
- Mod Archive ID/source: [187118](https://modarchive.org/index.php?request=view_by_moduleid&query=187118)
- SHA-256: `bc756fc62d403ee7837695d4933cc8e2b56de49666b37b8560fb8dabbc7a1aab`

Underlying composition, arrangement, performance, and sample rights remain
with their respective holders. The credits above reproduce only the authorship
information present in the files or their Mod Archive listings.

## Build and test toolchain

The following packages are development/build tools and are not separately
installed by the `.xdc` at runtime:

| Package | Version | License | Source |
| --- | ---: | --- | --- |
| @webxdc/vite-plugins | 1.6.0 | MIT | https://github.com/webxdc/vite-plugins |
| @types/node | 24.3.0 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node |
| @types/three | 0.162.0 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/three |
| @vitest/coverage-v8 | 4.1.10 | MIT | https://github.com/vitest-dev/vitest/tree/main/packages/coverage-v8 |
| vite-plugin-zip-pack | 1.2.4 | MIT | https://github.com/7th-Cyborg/vite-plugin-zip-pack |
| JSZip | 3.10.1 | MIT or GPL-3.0 (used under MIT) | https://github.com/Stuk/jszip |
| Vite | 8.2.0 | MIT | https://github.com/vitejs/vite |
| Vitest | 4.1.10 | MIT | https://github.com/vitest-dev/vitest |
| TypeScript | 5.9.2 | Apache-2.0 | https://github.com/microsoft/TypeScript |
| Playwright | 1.58.2 | Apache-2.0 | https://github.com/microsoft/playwright |
| jsdom | 26.1.0 | MIT | https://github.com/jsdom/jsdom |

Exact dependency versions and transitive dependency metadata are recorded in
`package-lock.json` in the source distribution.

## Reference-project statement

ArcaneCircle/no-as-a-service was consulted only for its public Webxdc/Vite
project shape. No source code, fonts, visual assets, rejection data, branding,
or user interface from that project is included in Split Stack.
