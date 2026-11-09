(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const invoke = (action, payload) => window.__TAURI__.core.invoke('launcher', { action, payload });
  try {
    for (let i = 0; i < 100; i += 1) {
      if (window.__eclipseClient && window.__eclipseClient.state && window.__eclipseClient.state.ready) break;
      await sleep(200);
    }
    const launcher = window.__eclipseClient;
    if (!launcher) throw new Error('window.__eclipseClient was not installed');

    const modrinthNav = document.querySelector('[data-page="modrinth"]');
    if (modrinthNav) modrinthNav.click();
    await sleep(1400);
    for (let i = 0; i < 20; i += 1) {
      if (document.querySelectorAll('#essentialsFeatures .essentials-feature').length > 0) break;
      await sleep(100);
    }

    const createPack = document.querySelector('#createModpackBtn');
    if (createPack) createPack.click();
    let fabricLoaderOptions = [];
    for (let i = 0; i < 50; i += 1) {
      const loaderSelect = document.querySelector('#modpackLoaderVersion');
      if (loaderSelect && loaderSelect.options.length > 1 && !loaderSelect.disabled) {
        fabricLoaderOptions = Array.from(loaderSelect.options).map((option) => option.textContent.trim());
        break;
      }
      await sleep(200);
    }
    const fabricUnstableOptions = fabricLoaderOptions.filter((label) => label.includes('unstable')).length;
    const loaderSummary = (document.querySelector('#modpackLoaderNote') || {}).textContent || '';
    const closePack = document.querySelector('#closeModpackModal');
    if (closePack) closePack.click();

    const result = {
      ready: Boolean(launcher.state && launcher.state.ready),
      title: document.title,
      pages: Array.from(document.querySelectorAll('[data-page-panel]')).map((panel) => panel.dataset.pagePanel),
      versionRows: document.querySelectorAll('.version-row').length,
      playLabel: (document.querySelector('#playLabel') || {}).textContent || '',
      javaSummary: (document.querySelector('#javaSummary') || {}).textContent || '',
      accountName: (document.querySelector('#sidebarName') || {}).textContent || '',
      avatarHeads: document.querySelectorAll('.avatar.has-head').length,
      modpacks: Array.isArray(launcher.state.modpacks) ? launcher.state.modpacks.length : -1,
      modrinthPage: Boolean(document.querySelector('[data-page-panel="modrinth"]')),
      createModpackButton: Boolean(document.querySelector('#createModpackBtn')),
      importButtons: document.querySelectorAll('[data-import-mrpack]').length,
      loaderChoices: document.querySelectorAll('#modpackLoader option').length,
      fastLaunchToggle: Boolean(document.querySelector('#fastLaunchToggle')),
      performanceJvmToggle: Boolean(document.querySelector('#performanceJvmToggle')),
      discordRpcToggle: Boolean(document.querySelector('#discordRpcToggle')),
      discordClientIdInput: Boolean(document.querySelector('#discordClientIdInput')),
      discordPortalButton: Boolean(document.querySelector('#openDiscordPortal')),
      updatesCard: Boolean(document.querySelector('#updatesCard')),
      updateCheckButton: Boolean(document.querySelector('#checkUpdatesBtn')),
      updateInstallButton: Boolean(document.querySelector('#installUpdateBtn')),
      deletePackButton: Boolean(document.querySelector('#contentDeletePack')),
      modrinthActive: Boolean(document.querySelector('#page-modrinth.active')),
      modrinthLayout: getComputedStyle(document.querySelector('.content-layout')).display,
      modrinthTargetOptions: document.querySelectorAll('#contentTarget option').length,
      modrinthPageSize: Boolean(document.querySelector('#modrinthPageSize')),
      modrinthPageSizeOptions: document.querySelectorAll('#modrinthPageSize option').length,
      essentialsCard: Boolean(document.querySelector('#essentialsCard:not([hidden])')),
      essentialsToggle: Boolean(document.querySelector('#essentialsToggle')),
      essentialsFeatures: document.querySelectorAll('#essentialsFeatures .essentials-feature').length,
      essentialsCustom: document.querySelectorAll('#essentialsFeatures .essentials-custom').length,
      renderCard: Boolean(document.querySelector('#renderCard:not([hidden])')),
      renderDistanceFields: document.querySelectorAll('#renderFields input').length,
      renderApply: Boolean(document.querySelector('#renderApply')),
      modrinthTarget: (document.querySelector('#contentTarget') || {}).value || '',
      modrinthResultCards: document.querySelectorAll('#modrinthResults .mod-card').length,
      theme: document.documentElement.dataset.theme || '',
      themeChoices: Array.from(document.querySelectorAll('[data-theme-choice]')).map((button) => button.dataset.themeChoice),
      themeCurrent: (document.querySelector('#themeCurrent') || {}).textContent || '',
      fabricLoaderOptions: fabricLoaderOptions.length,
      fabricUnstableOptions,
      loaderSummary,
    };
    const originalTheme = document.documentElement.dataset.theme;
    result.themeStyles = {};
    for (const theme of ['eclipse', 'aurora', 'ember', 'daylight', 'midnight', 'frost', 'sakura', 'solar']) {
      document.documentElement.dataset.theme = theme;
      result.themeStyles[theme] = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    }
    document.documentElement.dataset.theme = originalTheme;
    const checks = {
      ready: result.ready,
      pages: ['play', 'versions', 'modrinth', 'settings'].every((page) => result.pages.includes(page)),
      modrinthPage: result.modrinthPage,
      createModpackButton: result.createModpackButton,
      importButtons: result.importButtons > 0,
      loaderChoices: result.loaderChoices === 3,
      fastLaunchToggle: result.fastLaunchToggle,
      performanceJvmToggle: result.performanceJvmToggle,
      discordRpcToggle: result.discordRpcToggle,
      discordClientIdInput: result.discordClientIdInput,
      discordPortalButton: result.discordPortalButton,
      updatesCard: result.updatesCard,
      updateCheckButton: result.updateCheckButton,
      updateInstallButton: result.updateInstallButton,
      deletePackButton: result.deletePackButton,
      modrinthActive: result.modrinthActive,
      modrinthLayout: result.modrinthLayout === 'grid',
      modrinthTargetOptions: result.modrinthTargetOptions > 0,
      modrinthPageSize: result.modrinthPageSize,
      modrinthPageSizeOptions: result.modrinthPageSizeOptions === 3,
      essentialsCard: result.essentialsCard,
      essentialsToggle: result.essentialsToggle,
      essentialsFeatures: result.essentialsFeatures > 0,
      essentialsCustom: result.essentialsCustom > 0,
      renderCard: result.renderCard,
      renderDistanceFields: result.renderDistanceFields === 4,
      renderApply: result.renderApply,
      theme: ['eclipse', 'aurora', 'ember', 'daylight', 'midnight', 'frost', 'sakura', 'solar'].includes(result.theme),
      themeChoices: ['eclipse', 'aurora', 'ember', 'daylight', 'midnight', 'frost', 'sakura', 'solar'].every((theme) => result.themeChoices.includes(theme)) && result.themeChoices.length === 8,
      themeStyles: new Set(Object.values(result.themeStyles)).size === 8,
      themeCurrent: Boolean(result.themeCurrent),
      fabricLoaderOptions: result.fabricLoaderOptions > 1,
      fabricUnstableOptions: result.fabricUnstableOptions > 0,
    };
    result.checks = checks;
    result.passed = Object.values(checks).every(Boolean);
    await invoke('smoke:report', result);
  } catch (error) {
    const message = String((error && error.message) || error);
    try {
      await invoke('client:error', { message, stack: String((error && error.stack) || '') });
    } catch (_) { /* app may be closing */ }
    try {
      await invoke('smoke:report', { ready: false, passed: false, error: message });
    } catch (_) { /* app may be closing */ }
  }
})();
