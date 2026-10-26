/**
 * Typed view of the Vite-injected environment.
 * `vite/client` is loaded through `compilerOptions.types` in tsconfig.json, so this file only
 * narrows the variables the app is allowed to read — everything else stays invisible.
 */
export {};

declare global {
  interface ImportMetaEnv {
    readonly VITE_API_BASE_URL?: string;
    readonly VITE_DEV_API_TARGET?: string;
    readonly MODE: string;
    readonly DEV: boolean;
    readonly PROD: boolean;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}
