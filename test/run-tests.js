'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  isAllowedByRules,
  ruleMatches,
  offlineUuid,
  platformName,
  sha512Hex,
} = require('../src/core/utils');
const {
  buildLaunchCommand,
  clampMemory,
  clampResolution,
} = require('../src/core/launch');
const {
  parseJavaVersionString,
  parseJavaOutput,
  selectJava,
} = require('../src/core/java');
const { LauncherPaths } = require('../src/core/paths');
const { normalizeManifest } = require('../src/core/manifest');
const {
  parseMavenCoordinate,
  normalizeFabricLibraries,
  mergeFabricMetadata,
} = require('../src/core/fabric');
const {
  compareVersions,
  loaderInstallerUrl,
  normalizeLoader,
} = require('../src/core/loaders');
const {
  normalizeMrpackIndex,
  normalizePackPath,
  mrpackDownloadUrl,
} = require('../src/core/mrpack');
const {
  buildSearchFacets,
  imageUrl,
  normalizeProjectVersion,
  pickBestVersion,
} = require('../src/core/modrinth');
const {
  safeFileName,
  uniqueFileName,
  normalizeStoredInstance,
  modrinthDownloadUrl,
} = require('../src/main/modpacks');
const { Installer } = require('../src/core/installer');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function context(overrides = {}) {
  return {
    osName: 'windows',
    osVersion: '10.0.22631',
    arch: 'x64',
    features: {},
    ...overrides,
  };
}

test('rules: no rules allows the library', () => {
  assert.strictEqual(isAllowedByRules(undefined, context()), true);
  assert.strictEqual(isAllowedByRules([], context()), true);
});

test('rules: allow windows, reject osx', () => {
  const rules = [{ action: 'allow', os: { name: 'windows' } }];
  assert.strictEqual(isAllowedByRules(rules, context()), true);
  assert.strictEqual(isAllowedByRules(rules, context({ osName: 'osx' })), false);
});

test('rules: later disallow wins', () => {
  const rules = [{ action: 'allow' }, { action: 'disallow', os: { name: 'osx' } }];
  assert.strictEqual(isAllowedByRules(rules, context()), true);
  assert.strictEqual(isAllowedByRules(rules, context({ osName: 'osx' })), false);
});

test('rules: features gate arguments', () => {
  const rules = [{ action: 'allow', features: { has_custom_resolution: true } }];
  assert.strictEqual(isAllowedByRules(rules, context()), false);
  assert.strictEqual(
    isAllowedByRules(rules, context({ features: { has_custom_resolution: true } })),
    true,
  );
});

test('rules: match operating system version regex', () => {
  const rule = { action: 'allow', os: { name: 'windows', version: '^10\\.' } };
  assert.strictEqual(ruleMatches(rule, context()), true);
  assert.strictEqual(ruleMatches(rule, context({ osVersion: '6.1' })), false);
});

test('platform names are recognized', () => {
  assert.strictEqual(platformName('win32'), 'windows');
  assert.strictEqual(platformName('darwin'), 'osx');
  assert.strictEqual(platformName('linux'), 'linux');
});

test('offline UUID matches Java UUID.nameUUIDFromBytes', () => {
  assert.strictEqual(offlineUuid('Notch'), 'b50ad385-829d-3141-a216-7e7d7539ba7f');
  assert.match(offlineUuid('Player'), /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('manifest normalization rejects invalid data', () => {
  assert.throws(() => normalizeManifest({}), /unexpected/i);
  const manifest = normalizeManifest({
    latest: { release: '26.3', snapshot: '26.4-snapshot-1' },
    versions: [
      {
        id: '26.3',
        type: 'release',
        url: 'https://example.com/26.3.json',
        releaseTime: '2026-09-15T11:23:02+00:00',
      },
    ],
  });
  assert.strictEqual(manifest.latest.release, '26.3');
  assert.strictEqual(manifest.versions[0].id, '26.3');
  assert.strictEqual(manifest.versions[0].type, 'release');
});

test('memory and resolution are clamped', () => {
  assert.strictEqual(clampMemory(100), 1024);
  assert.strictEqual(clampMemory(100000), 32768);
  assert.strictEqual(clampMemory(4096), 4096);
  assert.strictEqual(clampResolution(10, 1280), 320);
  assert.strictEqual(clampResolution(999999, 1280), 7680);
});

test('java version parsing', () => {
  assert.strictEqual(parseJavaVersionString('1.8.0_451'), 8);
  assert.strictEqual(parseJavaVersionString('21.0.10'), 21);
  assert.strictEqual(parseJavaVersionString('25.0.3'), 25);
  const parsed = parseJavaOutput(
    '',
    `openjdk version "25.0.3" 2026-04-21 LTS
OpenJDK Runtime Environment Zulu25.34+17-CA (build 25.0.3+9-LTS)
    java.version = 25.0.3
    java.vendor = Azul Systems, Inc.
    os.arch = amd64`,
  );
  assert.strictEqual(parsed.major, 25);
  assert.strictEqual(parsed.version, '25.0.3');
  assert.match(parsed.vendor, /Azul/);
});

test('java selection respects the Java 8 era', () => {
  const installs = [
    { major: 8, version: '1.8.0_451', path: 'C:/jdk8/bin/java.exe' },
    { major: 21, version: '21.0.10', path: 'C:/jdk21/bin/java.exe' },
    { major: 25, version: '25.0.3', path: 'C:/jdk25/bin/java.exe' },
  ];
  assert.strictEqual(selectJava(installs, 8).major, 8);
  assert.strictEqual(selectJava(installs, 21).major, 21);
  assert.strictEqual(selectJava(installs, 25).major, 25);
  assert.strictEqual(selectJava(installs.slice(1), 8), null);
});

function makeFixture() {
  const root = path.resolve('.tmp', 'unit-fixture');
  fs.rmSync(root, { recursive: true, force: true });
  const paths = new LauncherPaths(root);
  fs.mkdirSync(paths.logConfigs, { recursive: true });
  fs.writeFileSync(paths.logConfig('client-test.xml'), '<xml/>');
  return { root, paths };
}

function modernMeta() {
  return {
    id: 'unit-test',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: 'unit-assets',
    assetIndex: { id: 'unit-assets', sha1: '0'.repeat(40) },
    downloads: {
      client: {
        path: 'unit-test.jar',
        url: 'https://example.com/client.jar',
        sha1: '0'.repeat(40),
        size: 1,
      },
    },
    javaVersion: { majorVersion: 21 },
    libraries: [
      {
        name: 'example:common:1.0',
        downloads: {
          artifact: {
            path: 'example/common/1.0/common-1.0.jar',
            url: 'https://example.com/common.jar',
            sha1: '0'.repeat(40),
            size: 1,
          },
        },
      },
      {
        name: 'example:mac-only:1.0',
        rules: [{ action: 'allow', os: { name: 'osx' } }],
        downloads: {
          artifact: {
            path: 'example/mac/mac-1.0.jar',
            url: 'https://example.com/mac.jar',
            sha1: '0'.repeat(40),
            size: 1,
          },
        },
      },
      {
        name: 'example:natives:1.0',
        natives: { windows: 'natives-windows' },
        downloads: {
          artifact: {
            path: 'example/natives/natives-1.0.jar',
            url: 'https://example.com/natives.jar',
            sha1: '0'.repeat(40),
            size: 1,
          },
          classifiers: {
            'natives-windows': {
              path: 'example/natives/natives-1.0-natives-windows.jar',
              url: 'https://example.com/natives-windows.jar',
              sha1: '0'.repeat(40),
              size: 1,
            },
          },
        },
      },
    ],
    arguments: {
      jvm: [
        '-Djava.library.path=${natives_directory}',
        '-Dbrand=${launcher_name}',
        '-cp',
        '${classpath}',
        {
          rules: [{ action: 'allow', os: { name: 'osx' } }],
          value: '-XstartOnFirstThread',
        },
      ],
      game: [
        '--username',
        '${auth_player_name}',
        '--uuid',
        '${auth_uuid}',
        '--accessToken',
        '${auth_access_token}',
        '--version',
        '${version_name}',
        '--assetsDir',
        '${assets_root}',
        {
          rules: [{ action: 'allow', features: { has_custom_resolution: true } }],
          value: ['--width', '${resolution_width}', '--height', '${resolution_height}'],
        },
      ],
    },
    logging: {
      client: {
        argument: '-Dlog4j.configurationFile=${path}',
        file: { id: 'client-test.xml' },
      },
    },
  };
}

test('launch command fills placeholders and filters rules', () => {
  const { paths } = makeFixture();
  const result = buildLaunchCommand({
    meta: modernMeta(),
    paths,
    versionId: 'unit-test',
    account: {
      name: 'TestUser',
      uuid: '11111111-2222-3333-8444-555555555555',
      accessToken: 'secret-token',
      type: 'offline',
    },
    settings: {
      memoryMb: 4096,
      customResolution: true,
      resolutionWidth: 1600,
      resolutionHeight: 900,
    },
    javaPath: 'java',
    gameDir: paths.root,
    assetIndex: { id: 'unit-assets', virtual: false, objects: {} },
    verifyFiles: false,
    platform: 'win32',
  });

  const joined = result.args.join(' ');
  assert.ok(joined.includes('net.minecraft.client.main.Main'));
  assert.ok(joined.includes('--username TestUser'));
  assert.ok(joined.includes('--width 1600'));
  assert.ok(joined.includes('--height 900'));
  assert.ok(joined.includes('-Dbrand=Eclipse Client'));
  assert.ok(joined.includes('-Dminecraft.launcher.brand=EclipseClient'));
  assert.ok(joined.includes('-Dlog4j.configurationFile='));
  assert.ok(joined.includes('-Xmx4096M'));
  assert.ok(!joined.includes('${'));
  assert.ok(!joined.includes('mac-only'));
  assert.ok(!joined.includes('-XstartOnFirstThread'));
  assert.ok(result.args.includes('11111111-2222-3333-8444-555555555555'));
  assert.ok(result.args.includes('secret-token'));
  assert.strictEqual(result.requiredJavaMajor, 21);
  assert.ok(result.classpath.includes('unit-test.jar'));
  assert.ok(result.classpath.includes('common-1.0.jar'));
  assert.ok(!result.classpath.includes('natives-windows.jar'));
});

test('launch command supports legacy minecraftArguments', () => {
  const { paths } = makeFixture();
  const meta = {
    id: 'legacy-test',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: 'legacy-assets',
    minecraftArguments:
      '--username ${auth_player_name} --version ${version_name} --gameDir ${game_directory} --assetsDir ${assets_root} --assetIndex ${assets_index_name} --uuid ${auth_uuid} --accessToken ${auth_access_token} --userType ${user_type}',
    libraries: [],
  };
  const result = buildLaunchCommand({
    meta,
    paths,
    versionId: 'legacy-test',
    account: { name: 'LegacyPlayer', type: 'offline', accessToken: '0' },
    settings: { memoryMb: 2048, customResolution: true, resolutionWidth: 1024, resolutionHeight: 768 },
    gameDir: paths.root,
    assetIndex: null,
    verifyFiles: false,
    platform: 'win32',
  });
  const joined = result.args.join(' ');
  assert.ok(joined.includes('--username LegacyPlayer'));
  assert.ok(joined.includes('--userType legacy'));
  assert.ok(joined.includes('-Djava.library.path='));
  assert.ok(joined.includes('--width 1024'));
  assert.ok(joined.includes('--height 768'));
  assert.ok(!joined.includes('${'));
  assert.strictEqual(result.requiredJavaMajor, 8);
});

test('Modrinth search facets target the pack and content type', () => {
  assert.deepStrictEqual(
    JSON.parse(buildSearchFacets({ projectType: 'mod', gameVersion: '1.21.1', loader: 'fabric' })),
    [['project_type:mod'], ['versions:1.21.1'], ['categories:fabric']],
  );
  assert.deepStrictEqual(
    JSON.parse(buildSearchFacets({ projectType: 'resourcepack', gameVersion: '1.21.1' })),
    [['project_type:resourcepack'], ['versions:1.21.1']],
  );
  assert.deepStrictEqual(
    JSON.parse(buildSearchFacets({ projectType: 'shader', gameVersion: '1.20.1' })),
    [['project_type:shader'], ['versions:1.20.1']],
  );
  assert.throws(() => buildSearchFacets({ projectType: 'plugin' }), /Unknown Modrinth project type/);
});

test('Modrinth normalization selects an HTTPS primary file', () => {
  const version = normalizeProjectVersion({
    id: 'version-1',
    project_id: 'project-1',
    name: 'Example release',
    version_number: '1.2.3',
    version_type: 'release',
    game_versions: ['1.21.1'],
    loaders: ['fabric'],
    files: [
      { filename: 'extra.jar', url: 'https://cdn.modrinth.com/extra.jar', size: 2 },
      {
        filename: 'example.jar',
        url: 'https://cdn.modrinth.com/example.jar',
        primary: true,
        size: 3,
        hashes: { sha1: 'ABC' },
      },
      { filename: 'insecure.jar', url: 'http://cdn.modrinth.com/insecure.jar' },
    ],
    dependencies: [
      { project_id: 'dependency-1', dependency_type: 'required' },
      { project_id: 'ignored', dependency_type: 'unknown' },
    ],
  });
  assert.strictEqual(version.fileName, 'example.jar');
  assert.strictEqual(version.sha1, 'ABC');
  assert.strictEqual(version.fileSize, 3);
  assert.strictEqual(version.dependencies.length, 1);
  assert.strictEqual(version.dependencies[0].dependencyType, 'required');
  assert.strictEqual(imageUrl('https://cdn.modrinth.com/icon.png'), 'https://cdn.modrinth.com/icon.png');
  assert.strictEqual(imageUrl('https://cdn-raw.modrinth.com/icon.png'), 'https://cdn-raw.modrinth.com/icon.png');
  assert.strictEqual(imageUrl('https://cdn.modrinth.com.evil.test/icon.png'), '');
  assert.strictEqual(imageUrl('http://cdn.modrinth.com/icon.png'), '');
  assert.strictEqual(pickBestVersion([
    { id: 'beta', versionType: 'beta' },
    { id: 'release', versionType: 'release' },
  ]).id, 'release');
});

test('Modrinth downloads stay on trusted HTTPS CDN hosts', () => {
  assert.strictEqual(
    modrinthDownloadUrl('https://cdn.modrinth.com/data/example.jar'),
    'https://cdn.modrinth.com/data/example.jar',
  );
  assert.throws(() => modrinthDownloadUrl('http://cdn.modrinth.com/data/example.jar'), /insecure/);
  assert.throws(() => modrinthDownloadUrl('https://example.com/example.jar'), /unknown host/);
  assert.throws(() => modrinthDownloadUrl('not a url'), /invalid download link/);
});

test('Fabric Maven coordinates map to library paths', () => {
  assert.deepStrictEqual(parseMavenCoordinate('net.fabricmc:fabric-loader:0.16.9'), {
    group: 'net.fabricmc',
    artifact: 'fabric-loader',
    version: '0.16.9',
    classifier: '',
    extension: 'jar',
    path: 'net/fabricmc/fabric-loader/0.16.9/fabric-loader-0.16.9.jar',
  });
  assert.strictEqual(
    parseMavenCoordinate('org.lwjgl:lwjgl:3.3.3:natives-windows').path,
    'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar',
  );
  assert.strictEqual(parseMavenCoordinate('missing-parts'), null);
  assert.strictEqual(parseMavenCoordinate('bad group:artifact:1.0'), null);
  assert.strictEqual(parseMavenCoordinate('group:artifact:1.0:natives:jar:extra'), null);

  const libraries = normalizeFabricLibraries([
    { name: 'net.fabricmc:fabric-loader:0.16.9', url: 'https://maven.fabricmc.net/' },
    { name: 'net.fabricmc:fabric-loader:0.16.9', url: 'https://maven.fabricmc.net/' },
    { name: 'net.fabricmc:intermediary:1.21.1', url: 'https://maven.fabricmc.net' },
    { name: 'bad-coordinate', url: 'https://maven.fabricmc.net/' },
    { name: 'test:http:1.0', url: 'http://maven.example.test/' },
  ]);
  assert.strictEqual(libraries.length, 2);
  assert.strictEqual(
    libraries[0].downloads.artifact.url,
    'https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.16.9/fabric-loader-0.16.9.jar',
  );
});

test('Fabric metadata merges into an installable standalone version', () => {
  const base = {
    id: '1.21.1',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: '17',
    assetIndex: { id: '17', sha1: '0'.repeat(40), size: 1, url: 'https://example.com/17.json' },
    downloads: {
      client: { url: 'https://example.com/client.jar', sha1: '0'.repeat(40), size: 1 },
    },
    javaVersion: { majorVersion: 21, component: 'java-runtime-gamma' },
    libraries: [
      {
        name: 'com.mojang:base:1.0',
        downloads: {
          artifact: {
            path: 'com/mojang/base/1.0/base-1.0.jar',
            url: 'https://example.com/base.jar',
            sha1: '0'.repeat(40),
            size: 1,
          },
        },
      },
    ],
    arguments: {
      game: ['--gameDir', '${game_directory}'],
      jvm: ['-cp', '${classpath}'],
    },
    releaseTime: '2024-08-08T00:00:00+00:00',
  };
  const profile = {
    id: 'fabric-loader-0.16.9-1.21.1',
    mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
    inheritsFrom: '1.21.1',
    libraries: [
      { name: 'net.fabricmc:fabric-loader:0.16.9', url: 'https://maven.fabricmc.net/' },
    ],
    arguments: {
      game: ['--fabric'],
      jvm: ['-Dfabric=true'],
    },
  };

  const merged = mergeFabricMetadata(base, profile, {
    versionId: 'eclipse-unit-1-21-1',
    name: 'Unit Pack',
    gameVersion: '1.21.1',
    loaderVersion: '0.16.9',
    minimumJava: 21,
  });
  assert.strictEqual(merged.id, 'eclipse-unit-1-21-1');
  assert.strictEqual(merged.mainClass, 'net.fabricmc.loader.impl.launch.knot.KnotClient');
  assert.strictEqual(merged.inheritsFrom, undefined);
  assert.strictEqual(merged.libraries.length, 2);
  assert.strictEqual(merged.javaVersion.majorVersion, 21);
  assert.deepStrictEqual(merged.arguments.game, ['--gameDir', '${game_directory}', '--fabric']);
  assert.deepStrictEqual(merged.arguments.jvm, ['-cp', '${classpath}', '-Dfabric=true']);
  assert.strictEqual(merged.launcher.eclipse.loader, 'fabric');
  assert.strictEqual(merged.launcher.eclipse.loaderVersion, '0.16.9');
  assert.strictEqual(base.id, '1.21.1');
  assert.strictEqual(JSON.stringify(merged).includes('inheritsFrom'), false);
  assert.throws(() => mergeFabricMetadata(null, profile), /invalid base/);
  assert.throws(() => mergeFabricMetadata(base, null), /invalid loader profile/);

  const { paths } = makeFixture();
  const plan = new Installer({ paths, platform: 'win32', log: () => {} }).buildPlan(
    merged,
    null,
    merged.id,
    paths.root,
  );
  assert.ok(plan.tasks.some((task) => task.kind === 'client'));
  assert.ok(plan.tasks.some((task) => task.url.includes('fabric-loader-0.16.9.jar')));
  assert.ok(plan.classpath.some((entry) => entry.includes('fabric-loader-0.16.9.jar')));
});

test('content files cannot escape their instance folder', () => {
  assert.strictEqual(safeFileName('../../evil.jar'), 'evil.jar');
  assert.strictEqual(safeFileName('..\\..\\evil.jar'), 'evil.jar');
  assert.strictEqual(safeFileName('bad:name?.jar', 'fallback.jar'), 'bad-name-.jar');
  assert.strictEqual(safeFileName('...', 'fallback.jar'), 'fallback.jar');
  assert.strictEqual(uniqueFileName('Sodium.jar', new Set(['sodium.jar'])), 'Sodium-2.jar');
  assert.strictEqual(uniqueFileName('Sodium.jar', new Set()), 'Sodium.jar');

  const instance = normalizeStoredInstance({
    id: 'eclipse-test-1-21-1',
    name: '  Test Pack  ',
    loader: 'fabric',
    loaderVersion: '0.16.9',
    gameVersion: '1.21.1',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  assert.strictEqual(instance.name, 'Test Pack');
  assert.strictEqual(instance.kind, 'modpack');
  assert.strictEqual(normalizeStoredInstance({ ...instance, id: '../escape' }), null);
  assert.strictEqual(normalizeStoredInstance({ ...instance, loader: 'quilt' }), null);
  assert.strictEqual(normalizeStoredInstance({ ...instance, loaderVersion: '' }), null);
  assert.strictEqual(normalizeStoredInstance({ ...instance, loader: 'forge' }).loader, 'forge');
  assert.strictEqual(normalizeStoredInstance({ ...instance, loader: 'neoforge' }).loader, 'neoforge');
});

test('loader versions sort and installer URLs are official', () => {
  assert.ok(compareVersions('52.1.20', '52.1.9') > 0);
  assert.ok(compareVersions('21.1.265', '21.1.100') > 0);
  assert.strictEqual(normalizeLoader('NeoForge'), 'neoforge');
  assert.throws(() => normalizeLoader('quilt'), /Fabric, Forge, or NeoForge/);
  assert.strictEqual(
    loaderInstallerUrl('forge', {
      installerVersion: '1.21.1-52.1.20',
      version: '52.1.20',
    }),
    'https://maven.minecraftforge.net/net/minecraftforge/forge/1.21.1-52.1.20/forge-1.21.1-52.1.20-installer.jar',
  );
  assert.strictEqual(
    loaderInstallerUrl('neoforge', {
      installerVersion: '21.1.265',
      version: '21.1.265',
    }),
    'https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.265/neoforge-21.1.265-installer.jar',
  );
});

test('Forge merge preserves local jars and substitutes loader paths', () => {
  const { paths } = makeFixture();
  const base = {
    id: '1.21.1',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: '17',
    downloads: {
      client: { url: 'https://example.com/client.jar', sha1: '0'.repeat(40), size: 1 },
    },
    javaVersion: { majorVersion: 21 },
    libraries: [],
    arguments: {
      game: ['--gameDir', '${game_directory}'],
      jvm: ['-cp', '${classpath}'],
    },
  };
  const localPath = 'net/minecraftforge/forge/1.21.1-52.1.20/forge-1.21.1-52.1.20-client.jar';
  const profile = {
    id: '1.21.1-forge-52.1.20',
    inheritsFrom: '1.21.1',
    mainClass: 'net.minecraftforge.bootstrap.ForgeBootstrap',
    libraries: [
      {
        name: 'net.minecraftforge:forge:1.21.1-52.1.20:client',
        downloads: {
          artifact: {
            path: localPath,
            url: '',
            sha1: '0'.repeat(40),
            size: 1,
          },
        },
      },
    ],
    arguments: {
      game: ['--launchTarget', 'forge_client'],
      jvm: ['-DlibraryDirectory=${library_directory}'],
    },
  };
  const merged = mergeFabricMetadata(base, profile, {
    versionId: 'eclipse-forge-test',
    name: 'Forge Test',
    gameVersion: '1.21.1',
    loader: 'forge',
    loaderVersion: '52.1.20',
  });
  assert.strictEqual(merged.launcher.eclipse.loader, 'forge');
  assert.strictEqual(merged.libraries[0].downloads.artifact.url, '');

  const absoluteLocal = path.join(paths.libraries, localPath);
  fs.mkdirSync(path.dirname(absoluteLocal), { recursive: true });
  fs.writeFileSync(absoluteLocal, 'jar');
  fs.mkdirSync(paths.versionDir('eclipse-forge-test'), { recursive: true });
  fs.writeFileSync(paths.clientJar('eclipse-forge-test'), 'client');

  const installer = new Installer({ paths, platform: 'win32', log: () => {} });
  const plan = installer.buildPlan(merged, null, 'eclipse-forge-test', paths.root);
  assert.ok(plan.classpath.includes(absoluteLocal));
  assert.ok(!plan.tasks.some((task) => task.dest === absoluteLocal));

  const command = buildLaunchCommand({
    meta: merged,
    paths,
    versionId: 'eclipse-forge-test',
    account: { name: 'Player' },
    settings: { performanceJvm: false },
    gameDir: paths.root,
    verifyFiles: false,
    platform: 'win32',
  });
  assert.ok(command.args.includes('net.minecraftforge.bootstrap.ForgeBootstrap'));
  assert.ok(command.args.includes(`-DlibraryDirectory=${paths.libraries}`));
  assert.ok(command.args.includes('--launchTarget'));
  assert.ok(!command.args.join(' ').includes('${'));
});

test('JVM performance flags can be enabled or disabled', () => {
  const { paths } = makeFixture();
  const argsFor = (performanceJvm) => buildLaunchCommand({
    meta: modernMeta(),
    paths,
    versionId: 'unit-test',
    account: { name: 'Player' },
    settings: { performanceJvm },
    gameDir: paths.root,
    verifyFiles: false,
    platform: 'win32',
  }).args;
  assert.ok(argsFor(true).includes('-XX:+UseG1GC'));
  assert.ok(!argsFor(false).includes('-XX:+UseG1GC'));
});

test('.mrpack parsing validates loaders, hosts, paths, and hashes', () => {
  assert.strictEqual(typeof sha512Hex(Buffer.from('abc')), 'string');
  assert.strictEqual(sha512Hex(Buffer.from('abc')).length, 128);
  assert.strictEqual(
    mrpackDownloadUrl('https://cdn.modrinth.com/data/example/file.jar'),
    'https://cdn.modrinth.com/data/example/file.jar',
  );
  assert.strictEqual(
    mrpackDownloadUrl('https://raw.githubusercontent.com/example/repo/main/file.txt'),
    'https://raw.githubusercontent.com/example/repo/main/file.txt',
  );
  assert.throws(() => mrpackDownloadUrl('https://example.com/file.jar'), /untrusted/);
  assert.throws(() => normalizePackPath('../evil.jar'), /outside/);
  assert.throws(() => normalizePackPath('mods/../../evil.jar'), /outside/);
  assert.throws(() => normalizePackPath('C:/Windows/evil.jar'), /absolute/);
  assert.throws(() => normalizePackPath('instance.json'), /metadata/);
  assert.strictEqual(normalizePackPath('mods\\Sodium.jar'), 'mods/Sodium.jar');

  const raw = {
    formatVersion: 1,
    game: 'minecraft',
    name: 'Test Pack',
    versionId: '1.0.0',
    dependencies: { minecraft: '1.21.1', forge: '52.1.20' },
    files: [
      {
        path: 'mods/example.jar',
        hashes: { sha1: 'a'.repeat(40), sha512: 'b'.repeat(128) },
        downloads: ['https://cdn.modrinth.com/data/example.jar'],
        fileSize: 12,
      },
      {
        path: 'server-only.jar',
        env: { client: 'unsupported' },
        downloads: ['https://example.com/ignored.jar'],
      },
    ],
  };
  const pack = normalizeMrpackIndex(raw);
  assert.strictEqual(pack.loader, 'forge');
  assert.strictEqual(pack.loaderVersion, '52.1.20');
  assert.strictEqual(pack.files.length, 1);
  assert.strictEqual(pack.files[0].path, 'mods/example.jar');
  assert.throws(
    () => normalizeMrpackIndex({ ...raw, dependencies: { minecraft: '1.21.1', 'quilt-loader': '1.0' } }),
    /Quilt/,
  );
  assert.throws(
    () => normalizeMrpackIndex({ ...raw, files: [{ ...raw.files[0], hashes: {} }] }),
    /checksum/,
  );
});

test('launch readiness is fast but deep checks still find missing files', async () => {
  const { paths } = makeFixture();
  const id = 'ready-test';
  const meta = {
    id,
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: 'ready-assets',
    assetIndex: { id: 'ready-assets' },
    downloads: {
      client: { url: 'https://example.com/client.jar', sha1: '0'.repeat(40), size: 1 },
    },
    libraries: [
      {
        name: 'example:ready:1.0',
        downloads: {
          artifact: {
            path: 'example/ready/1.0/ready-1.0.jar',
            url: 'https://example.com/ready.jar',
            sha1: '0'.repeat(40),
            size: 1,
          },
        },
      },
    ],
  };
  fs.mkdirSync(paths.versionDir(id), { recursive: true });
  fs.mkdirSync(paths.assetIndexes, { recursive: true });
  fs.writeFileSync(paths.versionJson(id), JSON.stringify(meta));
  fs.writeFileSync(paths.clientJar(id), 'jar');
  fs.writeFileSync(paths.completionMarker(id), JSON.stringify({ installedAt: new Date().toISOString() }));
  fs.writeFileSync(paths.assetIndex('ready-assets'), '{}');
  const installer = new Installer({ paths, platform: 'win32', log: () => {} });
  assert.strictEqual(await installer.isLaunchReady(id), true);
  assert.strictEqual(await installer.canUseExisting(id), false);
  const library = paths.libraryPath('example/ready/1.0/ready-1.0.jar');
  fs.mkdirSync(path.dirname(library), { recursive: true });
  fs.writeFileSync(library, 'jar');
  assert.strictEqual(await installer.canUseExisting(id), true);
});

test('asset root follows virtual asset indexes', () => {
  const { paths } = makeFixture();
  const { getAssetRoot } = require('../src/core/launch');
  const meta = { assets: 'legacy', assetIndex: { id: 'legacy' } };
  assert.strictEqual(getAssetRoot(paths, meta, { id: 'legacy', virtual: true }), paths.virtualAssets('legacy'));
  assert.strictEqual(getAssetRoot(paths, meta, { id: 'legacy', virtual: false }), paths.assets);
});

async function main() {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL  ${name}`);
      console.error(error && error.stack ? error.stack : error);
    }
  }
  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main();
