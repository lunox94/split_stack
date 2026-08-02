declare module "@webxdc/vite-plugins" {
  import type { PluginOption } from "vite";

  export interface BuildXdcOptions {
    outDir?: string;
    outFileName?: string;
    done?: (error: Error | undefined) => void;
    filter?: (fileName: string, filePath: string, isDirectory: boolean) => boolean;
  }

  export function buildXDC(options?: BuildXdcOptions): PluginOption;
  export function eruda(debug?: boolean): PluginOption;
  export function mockWebxdc(path?: string): PluginOption;
}
