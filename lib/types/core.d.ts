export interface PackFileRecord {
  encoding: 'utf8' | 'base64';
  content: string;
}

export interface PackMeta {
  name: string;
  title?: string;
  description?: string;
  createdAt: string;
  plugin: string;
  dshVersion?: string;
}

export interface DshPack {
  format: 'dsh-pack/1';
  meta: PackMeta;
  files: Record<string, PackFileRecord>;
}

export interface BuildPackOptions {
  profile: string;
  title?: string;
  description?: string;
  includeLockfile?: boolean;
  includeVendor?: boolean;
  dshVersion?: string;
  outputPath?: string;
  outputDir?: string;
  workspace?: string;
}

export interface ExportResult {
  profile: string;
  outputPath: string;
  bytes: number;
}

export interface InstallResult {
  ok: boolean;
  skipped?: boolean;
  exitCode?: number | null;
  error?: string;
}

export interface ImportResult {
  profile: string;
  dir: string;
  backupDir?: string | null;
  install?: InstallResult | null;
}

export declare const PACK_FORMAT: 'dsh-pack/1';
export declare const PACK_EXTENSION: '.dshpack';
export declare const DEFAULT_OUTPUT_DIR: '.dshpacks';

export declare function buildPack(options: BuildPackOptions): Promise<Buffer>;
export declare function exportPack(options: BuildPackOptions): Promise<ExportResult>;
export declare function parsePack(buffer: Buffer): DshPack;
export declare function importPack(options: {
  buffer: Buffer;
  profileName?: string;
  overwrite?: boolean;
  autoInstall?: boolean;
}): Promise<ImportResult>;
export declare function importPackFile(options: {
  packPath: string;
  profileName?: string;
  overwrite?: boolean;
  autoInstall?: boolean;
}): Promise<ImportResult>;
export declare function listProfiles(): Promise<string[]>;
export declare function installProfileDeps(dir: string): Promise<InstallResult>;
