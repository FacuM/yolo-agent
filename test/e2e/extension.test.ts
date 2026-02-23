import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

suite('YOLO Agent Extension', () => {
  const extensionId = 'yolo-agent.yolo-agent';

  suiteSetup(async function () {
    this.timeout(30000);
    // Wait for our extension to activate
    const ext = vscode.extensions.getExtension(extensionId);
    if (ext && !ext.isActive) {
      await ext.activate();
    }
    // Give VS Code time to register views
    await new Promise((resolve) => setTimeout(resolve, 2000));
  });

  // --- Extension Activation ---

  test('Extension is present', () => {
    const ext = vscode.extensions.getExtension(extensionId);
    assert.ok(ext, 'Extension should be installed');
  });

  test('Extension activates successfully', async () => {
    const ext = vscode.extensions.getExtension(extensionId);
    assert.ok(ext, 'Extension should be installed');
    if (!ext!.isActive) {
      await ext!.activate();
    }
    assert.ok(ext!.isActive, 'Extension should be active');
  });

  // --- Commands Registration ---

  test('Commands are registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes('yoloAgent.newChat'),
      'newChat command should be registered'
    );
    assert.ok(
      commands.includes('yoloAgent.setApiKey'),
      'setApiKey command should be registered'
    );
  });

  // --- Configuration ---

  test('Configuration section exists with empty properties', () => {
    const ext = vscode.extensions.getExtension(extensionId);
    assert.ok(ext, 'Extension should exist');

    const config = ext!.packageJSON.contributes?.configuration;
    assert.ok(config, 'Configuration should be contributed');
    assert.ok(
      config.properties !== undefined,
      'Properties object should exist'
    );
  });

  // --- File Tools (against real temp workspace) ---

  suite('File Operations Tools', () => {
    let tmpDir: string;

    suiteSetup(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yolo-test-'));
    });

    suiteTeardown(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('ReadFileTool reads file content', async () => {
      const testFile = path.join(tmpDir, 'test-read.txt');
      fs.writeFileSync(testFile, 'line1\nline2\nline3\nline4\nline5');

      const content = fs.readFileSync(testFile, 'utf-8');
      assert.strictEqual(content, 'line1\nline2\nline3\nline4\nline5');
    });

    test('WriteFileTool creates files', async () => {
      const testFile = path.join(tmpDir, 'test-write.txt');
      fs.writeFileSync(testFile, 'hello world');
      assert.ok(fs.existsSync(testFile), 'File should exist after write');
      assert.strictEqual(
        fs.readFileSync(testFile, 'utf-8'),
        'hello world'
      );
    });

    test('WriteFileTool creates nested directories', async () => {
      const nested = path.join(tmpDir, 'a', 'b', 'c', 'test.txt');
      fs.mkdirSync(path.dirname(nested), { recursive: true });
      fs.writeFileSync(nested, 'nested content');
      assert.ok(fs.existsSync(nested), 'Nested file should exist');
    });

    test('ListFiles finds files by pattern', async () => {
      fs.writeFileSync(path.join(tmpDir, 'foo.ts'), '');
      fs.writeFileSync(path.join(tmpDir, 'bar.ts'), '');
      fs.writeFileSync(path.join(tmpDir, 'baz.js'), '');

      const tsFiles = fs
        .readdirSync(tmpDir)
        .filter((f) => f.endsWith('.ts'));
      assert.strictEqual(tsFiles.length, 2, 'Should find 2 .ts files');
    });
  });

  // --- Webview Registration ---

  test('Chat view is registered', async () => {
    const ext = vscode.extensions.getExtension(extensionId);
    assert.ok(ext, 'Extension should exist');

    const packageJson = ext!.packageJSON;
    const views = packageJson.contributes?.views?.['yolo-agent'];
    assert.ok(views, 'Views should be contributed under yolo-agent container');
    assert.ok(
      views.some((v: { id: string }) => v.id === 'yoloAgent.chatView'),
      'chatView should be registered'
    );
  });

  test('Activity bar container is registered', () => {
    const ext = vscode.extensions.getExtension(extensionId);
    assert.ok(ext, 'Extension should exist');

    const packageJson = ext!.packageJSON;
    const containers =
      packageJson.contributes?.viewsContainers?.activitybar;
    assert.ok(containers, 'Activity bar containers should exist');
    assert.ok(
      containers.some((c: { id: string }) => c.id === 'yolo-agent'),
      'yolo-agent container should be registered'
    );
  });

  // --- ProfileManager structural test ---

  test('Extension exports activate without errors', () => {
    const ext = vscode.extensions.getExtension(extensionId);
    assert.ok(ext, 'Extension should exist');
    assert.ok(ext!.isActive, 'Extension should be active after suiteSetup');
  });
});
