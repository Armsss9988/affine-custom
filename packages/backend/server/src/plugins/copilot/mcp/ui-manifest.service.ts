import { Injectable, Logger } from '@nestjs/common';
import manifestData from '../ui-manifest.json' with { type: 'json' };

@Injectable()
export class UiManifestService {
  private readonly logger = new Logger(UiManifestService.name);
  private readonly manifest: any = manifestData;

  constructor() {
    this.logger.log('Loaded UI Capability Manifest successfully.');
  }

  search(
    query: string,
    category?: 'shortcuts' | 'commands' | 'page-features' | 'all',
    platform?: 'mac' | 'win'
  ): Record<string, any> {
    if (!this.manifest) {
      return { error: 'Manifest not loaded' };
    }

    const q = query.trim().toLowerCase();
    const results: Record<string, any> = {};

    // 1. Search commands
    if (!category || category === 'commands' || category === 'all') {
      const matchedCommands = (this.manifest.commands || []).filter((cmd: any) => {
        return (
          cmd.id.toLowerCase().includes(q) ||
          cmd.label.toLowerCase().includes(q) ||
          (cmd.category && cmd.category.toLowerCase().includes(q))
        );
      });
      if (matchedCommands.length > 0) {
        results.commands = matchedCommands;
      }
    }

    // 2. Search shortcuts
    if (!category || category === 'shortcuts' || category === 'all') {
      const matchedShortcuts: Record<string, any> = {};
      const shortcuts = this.manifest.shortcuts || {};

      for (const [secName, secShortcuts] of Object.entries(shortcuts)) {
        const matchedSection: Record<string, any> = {};
        for (const [shortcutName, shortcutInfo] of Object.entries(secShortcuts as any)) {
          const nameMatch = shortcutName.toLowerCase().includes(q);
          let infoMatch = false;
          if (shortcutInfo && typeof shortcutInfo === 'object') {
            if ('syntax' in shortcutInfo) {
              infoMatch = (shortcutInfo as any).syntax.toLowerCase().includes(q);
            } else {
              infoMatch = JSON.stringify(shortcutInfo).toLowerCase().includes(q);
            }
          }
          if (nameMatch || infoMatch) {
            if (
              platform &&
              shortcutInfo &&
              typeof shortcutInfo === 'object' &&
              (platform in shortcutInfo)
            ) {
              matchedSection[shortcutName] = (shortcutInfo as any)[platform];
            } else {
              matchedSection[shortcutName] = shortcutInfo;
            }
          }
        }
        if (Object.keys(matchedSection).length > 0) {
          matchedShortcuts[secName] = matchedSection;
        }
      }
      if (Object.keys(matchedShortcuts).length > 0) {
        results.shortcuts = matchedShortcuts;
      }
    }

    // 3. Search page features
    if (!category || category === 'page-features' || category === 'all') {
      const matchedPages: Record<string, any> = {};
      const pages = this.manifest.pages || {};

      for (const [route, pageInfo] of Object.entries(pages)) {
        const info = pageInfo as any;
        const routeMatch = route.toLowerCase().includes(q);
        const titleMatch = info.title && info.title.toLowerCase().includes(q);
        const matchedFeatures = (info.features || []).filter((f: string) =>
          f.toLowerCase().includes(q)
        );
        const matchedQuickActions = (info.quickActions || []).filter((a: string) =>
          a.toLowerCase().includes(q)
        );

        if (
          routeMatch ||
          titleMatch ||
          matchedFeatures.length > 0 ||
          matchedQuickActions.length > 0
        ) {
          matchedPages[route] = {
            title: info.title,
            features: matchedFeatures.length > 0 ? matchedFeatures : info.features,
            quickActions:
              matchedQuickActions.length > 0 ? matchedQuickActions : info.quickActions,
          };
        }
      }
      if (Object.keys(matchedPages).length > 0) {
        results.pages = matchedPages;
      }
    }

    return results;
  }
}
