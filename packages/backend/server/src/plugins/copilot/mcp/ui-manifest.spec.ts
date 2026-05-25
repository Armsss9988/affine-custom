import test from 'ava';
import { UiManifestService } from './ui-manifest.service';

test('UiManifestService loads and searches successfully', t => {
  const service = new UiManifestService();

  // Test 1: Load check
  t.assert(service, 'Service should be initialized');

  // Test 2: Search shortcuts (e.g., Bold)
  const boldResult = service.search('Bold');
  t.assert(boldResult.shortcuts, 'Should find bold in shortcuts');
  t.assert(boldResult.shortcuts.page, 'Should contain page shortcuts for bold');
  t.assert(boldResult.shortcuts.markdown, 'Should contain markdown shortcuts for bold');

  // Test 3: Search commands (e.g., Settings)
  const settingsResult = service.search('Settings');
  t.assert(settingsResult.commands, 'Should find settings in commands');
  const openSettingsCmd = settingsResult.commands.find((c: any) => c.id === 'affine:open-settings');
  t.assert(openSettingsCmd, 'Should find affine:open-settings command');

  // Test 4: Search page features (e.g., multi-select)
  const multiSelectResult = service.search('multi-select');
  t.assert(multiSelectResult.pages, 'Should find pages with multi-select features');
  t.assert(multiSelectResult.pages['/all'], 'Should contain All Docs page features');
  t.assert(
    multiSelectResult.pages['/all'].features.some((f: string) => f.toLowerCase().includes('multi-select')),
    'Should match specific multi-select feature description'
  );

  // Test 5: Search with platform filter (e.g., Mac shortcuts for Cancel)
  const cancelMacResult = service.search('Cancel', 'shortcuts', 'mac');
  t.deepEqual(
    cancelMacResult.shortcuts.general['Cancel / Close (Hủy / Đóng)'],
    ['ESC'],
    'Should retrieve mac cancel shortcut'
  );

  // Test 6: Search with Win platform filter
  const cancelWinResult = service.search('Cancel', 'shortcuts', 'win');
  t.deepEqual(
    cancelWinResult.shortcuts.general['Cancel / Close (Hủy / Đóng)'],
    ['ESC'],
    'Should retrieve win cancel shortcut'
  );
});
