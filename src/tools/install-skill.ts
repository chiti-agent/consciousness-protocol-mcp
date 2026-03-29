/**
 * Install Skill tool — discover → license → install in one call.
 *
 * Completes the agent marketplace cycle:
 * search_works finds a skill → install_skill checks license,
 * downloads from trusted sources, installs to ~/.claude/skills/.
 *
 * Trusted sources only (no arbitrary archives):
 * - git clone from GitHub/GitLab/Bitbucket
 * - npm install from npmjs.com registry
 * - pip install from PyPI
 * - cargo install from crates.io
 * - go install from Go modules
 * - text content (SKILL.md directly)
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import type { Config } from '../config/store.js';
import { searchTool } from './search.js';
import { licenseTool } from './license.js';

const SKILLS_DIR = join(homedir(), '.claude', 'skills');

interface InstallResult {
  success: boolean;
  ipId: string;
  title: string;
  installPath?: string;
  licenseMinted?: boolean;
  licenseTokenId?: string;
  source?: 'git' | 'npm' | 'pip' | 'cargo' | 'go' | 'content';
  error?: string;
  instructions?: string;
}

/** Derive a filesystem-safe skill name from title */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
}

/** Check if a URL looks like a git repo on trusted hosts */
function isGitUrl(url: string): boolean {
  return /^https?:\/\/(github\.com|gitlab\.com|bitbucket\.org)\//.test(url);
}

/** Check if a URL points to an npm package */
function isNpmUrl(url: string): boolean {
  return /^https?:\/\/(www\.)?npmjs\.com\/package\//.test(url);
}

/** Check if a URL points to a PyPI package */
function isPypiUrl(url: string): boolean {
  return /^https?:\/\/(www\.)?pypi\.org\/project\//.test(url);
}

/** Check if a URL points to a crates.io package */
function isCratesUrl(url: string): boolean {
  return /^https?:\/\/(www\.)?crates\.io\/crates\//.test(url);
}

/** Check if a URL points to a Go module (pkg.go.dev or go import path) */
function isGoUrl(url: string): boolean {
  return /^https?:\/\/pkg\.go\.dev\//.test(url);
}

/** Extract package name from a registry URL */
function extractPackageName(url: string, pattern: RegExp): string {
  const match = url.match(pattern);
  if (!match) throw new Error(`Cannot extract package name from URL: ${url}`);
  return match[1];
}

const PACKAGE_PATTERNS: Record<string, RegExp> = {
  npm: /npmjs\.com\/package\/((?:@[^/]+\/)?[^/?#]+)/,
  pip: /pypi\.org\/project\/([^/?#]+)/,
  cargo: /crates\.io\/crates\/([^/?#]+)/,
  go: /pkg\.go\.dev\/([^?#]+)/,
};

/** Clone a git repo to the target directory */
function gitClone(url: string, targetDir: string): void {
  const cleanUrl = url.replace(/\/+$/, '');
  execSync(`git clone --depth 1 ${cleanUrl} ${targetDir}`, {
    stdio: 'pipe',
    timeout: 60_000,
  });
}

/** Install a package from a registry */
function registryInstall(manager: 'npm' | 'pip' | 'cargo' | 'go', packageName: string, targetDir: string): void {
  const commands: Record<string, string> = {
    npm: `npm install --prefix ${targetDir} ${packageName}`,
    pip: `pip install --target ${targetDir} ${packageName}`,
    cargo: `cargo install --root ${targetDir} ${packageName}`,
    go: `GOBIN=${targetDir}/bin go install ${packageName}@latest`,
  };
  execSync(commands[manager], { stdio: 'pipe', timeout: 120_000 });
}

/** Write a minimal SKILL.md if one doesn't exist */
function ensureSkillMd(skillDir: string, title: string, ipId: string): void {
  const skillMd = join(skillDir, 'SKILL.md');
  if (existsSync(skillMd)) return;

  const content = `---
name: ${slugify(title)}
description: ${title} (installed from Volem IP ${ipId})
---

# ${title}

Installed from Volem marketplace.
IP Asset: ${ipId}
`;
  writeFileSync(skillMd, content, 'utf-8');
}

/** Detect which package manager to use from URL or metadata */
function detectSource(externalUrl: string, npmPackage: string): { manager: 'git' | 'npm' | 'pip' | 'cargo' | 'go'; packageName?: string } | null {
  if (npmPackage) return { manager: 'npm', packageName: npmPackage };
  if (isNpmUrl(externalUrl)) return { manager: 'npm', packageName: extractPackageName(externalUrl, PACKAGE_PATTERNS.npm) };
  if (isPypiUrl(externalUrl)) return { manager: 'pip', packageName: extractPackageName(externalUrl, PACKAGE_PATTERNS.pip) };
  if (isCratesUrl(externalUrl)) return { manager: 'cargo', packageName: extractPackageName(externalUrl, PACKAGE_PATTERNS.cargo) };
  if (isGoUrl(externalUrl)) return { manager: 'go', packageName: extractPackageName(externalUrl, PACKAGE_PATTERNS.go) };
  if (isGitUrl(externalUrl)) return { manager: 'git' };
  return null;
}

export const installSkillTool = {
  async install(
    config: Config,
    params: {
      ip_id: string;
      install_path?: string;
      auto_license?: boolean;
    },
  ): Promise<InstallResult> {
    const { ip_id, auto_license = true } = params;

    // 0. Quick check: already installed?
    const earlySlug = slugify(`skill-${ip_id.slice(2, 12)}`);
    const earlyPath = params.install_path ?? join(SKILLS_DIR, earlySlug);
    if (existsSync(earlyPath)) {
      const hasSkillMd = existsSync(join(earlyPath, 'SKILL.md'));
      const hasPkgJson = existsSync(join(earlyPath, 'package.json'));
      if (hasSkillMd || hasPkgJson) {
        return {
          success: true,
          ipId: ip_id,
          title: earlySlug,
          installPath: earlyPath,
          instructions: `Already installed at ${earlyPath}. Delete the directory to reinstall.`,
        };
      }
    }

    // 1. Get asset details
    let asset: Record<string, any>;
    try {
      asset = await searchTool.getAssetDetails(config, ip_id) as Record<string, any>;
    } catch (err: any) {
      return { success: false, ipId: ip_id, title: 'unknown', error: `Failed to fetch asset: ${err.message}` };
    }

    const title = asset.title ?? asset.asset?.title ?? `skill-${ip_id.slice(0, 10)}`;
    const ipCategory = asset.ipCategory ?? asset.asset?.ipCategory ?? '';
    const externalUrl = asset.externalUrl ?? asset.asset?.externalUrl ?? '';
    const license = asset.license ?? asset.asset?.license ?? 'unknown';
    const licenseTermsId = asset.licenseTermsId ?? asset.asset?.licenseTermsId ?? '';
    const textContent = asset.content ?? asset.asset?.content ?? '';
    const npmPackage = asset.npmPackage ?? asset.asset?.npmPackage ?? '';

    // 2. Validate: is this installable?
    const installableCategories = [
      'agent-skill', 'mcp-server', 'agent-workflow', 'prompt',
      'software', 'ai-agent', 'evaluation',
    ];
    const isSkillCategory = installableCategories.some(c => ipCategory.includes(c));
    const sourceInfo = detectSource(externalUrl, npmPackage);
    const hasContent = !!textContent;

    if (!isSkillCategory && !sourceInfo && !hasContent) {
      return {
        success: false,
        ipId: ip_id,
        title,
        error: `Asset "${title}" (category: ${ipCategory || 'none'}) has no installable content. Need a git URL (GitHub/GitLab/Bitbucket), package registry URL (npm/pip/cargo/go), or text content.`,
      };
    }

    if (!sourceInfo && !hasContent) {
      return {
        success: false,
        ipId: ip_id,
        title,
        error: `Asset "${title}" has category "${ipCategory}" but no trusted source URL. Supported: GitHub/GitLab/Bitbucket repos, npmjs.com, pypi.org, crates.io, pkg.go.dev packages, or text content.`,
      };
    }

    // 3. Handle licensing
    let licenseMinted = false;
    let licenseTokenId: string | undefined;

    if (license !== 'free' && auto_license && licenseTermsId) {
      try {
        const mintResult = await licenseTool.mint(config, {
          ip_id,
          license_terms_id: String(licenseTermsId),
          amount: 1,
        });
        if (mintResult.success) {
          licenseMinted = true;
          licenseTokenId = mintResult.licenseTokenIds?.[0];
        } else {
          return {
            success: false,
            ipId: ip_id,
            title,
            error: `License minting failed: ${mintResult.error}. Set auto_license=false to skip.`,
          };
        }
      } catch (err: any) {
        return {
          success: false,
          ipId: ip_id,
          title,
          error: `License error: ${err.message}. If this is a free skill, the license field may be misconfigured.`,
        };
      }
    }

    // 4. Determine install path
    const skillSlug = slugify(title);
    const installPath = params.install_path ?? join(SKILLS_DIR, skillSlug);

    // Check if already installed
    if (existsSync(installPath)) {
      const skillMd = join(installPath, 'SKILL.md');
      const packageJson = join(installPath, 'package.json');
      if (existsSync(skillMd) || existsSync(packageJson)) {
        return {
          success: true,
          ipId: ip_id,
          title,
          installPath,
          licenseMinted,
          licenseTokenId,
          source: sourceInfo?.manager ?? 'content',
          instructions: `Already installed at ${installPath}. Delete the directory to reinstall.`,
        };
      }
    }

    mkdirSync(installPath, { recursive: true });

    // 5. Download and install from trusted source only
    let source: InstallResult['source'];

    try {
      if (sourceInfo) {
        if (sourceInfo.manager === 'git') {
          source = 'git';
          gitClone(externalUrl, installPath);
        } else {
          source = sourceInfo.manager;
          registryInstall(sourceInfo.manager, sourceInfo.packageName!, installPath);
        }
        ensureSkillMd(installPath, title, ip_id);
      } else if (hasContent) {
        source = 'content';
        writeFileSync(join(installPath, 'SKILL.md'), textContent, 'utf-8');
      } else {
        return { success: false, ipId: ip_id, title, error: 'No trusted source found.' };
      }
    } catch (err: any) {
      return {
        success: false,
        ipId: ip_id,
        title,
        error: `Install failed: ${err.message}`,
      };
    }

    // 6. Verify SKILL.md exists
    ensureSkillMd(installPath, title, ip_id);

    return {
      success: true,
      ipId: ip_id,
      title,
      installPath,
      licenseMinted,
      licenseTokenId,
      source,
      instructions: `Skill installed at ${installPath}. It will be available in Claude Code as "${skillSlug}".`,
    };
  },
};
