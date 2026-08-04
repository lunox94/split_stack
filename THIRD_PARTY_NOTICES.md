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

## Public-domain musical inspiration

Split Stack's three chiptune tracks are original procedural arrangements that
take melodic inspiration from the public-domain compositions *In the Hall of
the Mountain King* (Edvard Grieg), *Flight of the Bumblebee* (Nikolai
Rimsky-Korsakov), and *Kalinka* (Ivan Larionov). No third-party MIDI file,
recording, performance, or BitMidi asset is included in the source or release
bundle.

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
