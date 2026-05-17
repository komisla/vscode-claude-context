const fs = require('fs');
const path = require('path');
const Module = require('module');
const { fileURLToPath } = require('url');

class MockEventEmitter {
  constructor() {
    this.listeners = new Set();
  }

  event = (listener) => {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      }
    };
  };

  fire(value) {
    for (const listener of this.listeners) {
      listener(value);
    }
  }

  dispose() {
    this.listeners.clear();
  }
}

class MockMarkdownString {
  constructor(value = '', supportThemeIcons = false) {
    this.value = value;
    this.supportThemeIcons = supportThemeIcons;
    this.isTrusted = false;
  }

  appendText(text) {
    this.value += text;
  }
}

class MockThemeColor {
  constructor(id) {
    this.id = id;
  }
}

function createUri(value) {
  let fsPath = value;

  try {
    fsPath = value.startsWith('file:') ? fileURLToPath(value) : value;
  } catch {
    fsPath = value;
  }

  return {
    fsPath,
    toString: () => value
  };
}

class MockStatusBarItem {
  constructor(alignment, priority) {
    this.alignment = alignment;
    this.priority = priority;
    this.command = undefined;
    this.name = undefined;
    this.text = '';
    this.tooltip = undefined;
    this.backgroundColor = undefined;
    this.visible = false;
    this.disposed = false;
    this.showCount = 0;
    this.hideCount = 0;
    this.disposeCount = 0;
  }

  show() {
    if (this.disposed) {
      throw new Error('StatusBarItem disposed');
    }

    this.visible = true;
    this.showCount += 1;
  }

  hide() {
    if (this.disposed) {
      throw new Error('StatusBarItem disposed');
    }

    this.visible = false;
    this.hideCount += 1;
  }

  dispose() {
    this.disposed = true;
    this.disposeCount += 1;
  }
}

class MockWebviewPanel {
  constructor(viewType, title, viewColumn, options) {
    this.viewType = viewType;
    this.title = title;
    this.viewColumn = viewColumn;
    this.options = options;
    this.revealCalls = [];
    this.postedMessages = [];
    this.disposeEmitter = new MockEventEmitter();
    this.messageEmitter = new MockEventEmitter();
    this.disposed = false;
    this.disposeCount = 0;
    this.webview = {
      html: '',
      postedMessages: this.postedMessages,
      receiveMessage: (message) => {
        this.messageEmitter.fire(message);
      },
      postMessage: async (message) => {
        if (this.disposed) {
          throw new Error('Webview panel disposed');
        }

        this.postedMessages.push(message);
        return true;
      },
      onDidReceiveMessage: (listener) => this.messageEmitter.event(listener)
    };
  }

  onDidDispose(listener) {
    return this.disposeEmitter.event(listener);
  }

  reveal(viewColumn) {
    this.revealCalls.push(viewColumn);
  }

  dispose() {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.disposeCount += 1;
    this.disposeEmitter.fire(undefined);
    this.disposeEmitter.dispose();
    this.messageEmitter.dispose();
  }
}

const mockState = {
  configuration: new Map(),
  statusBarItems: [],
  webviewPanels: [],
  registeredCommands: [],
  clipboardWrites: [],
  informationMessages: [],
  openExternalCalls: [],
  openExternalResult: true
};

const workspace = {
  workspaceFolders: [],
  configurationEmitter: new MockEventEmitter(),
  getConfiguration(section) {
    return {
      get: (key, defaultValue) => {
        const values = mockState.configuration.get(section);
        const value = values?.[key];
        return value === undefined ? defaultValue : value;
      }
    };
  },
  onDidChangeConfiguration(listener) {
    return workspace.configurationEmitter.event(listener);
  },
  fireDidChangeConfiguration(sections) {
    const changedSections = Array.isArray(sections) ? sections : [sections];

    workspace.configurationEmitter.fire({
      affectsConfiguration: (section) =>
        changedSections.some(
          (changedSection) =>
            section === changedSection || section.startsWith(`${changedSection}.`)
        )
    });
  }
};

const window = {
  statusBarItems: mockState.statusBarItems,
  webviewPanels: mockState.webviewPanels,
  informationMessages: mockState.informationMessages,
  createStatusBarItem(alignment, priority) {
    const item = new MockStatusBarItem(alignment, priority);
    window.statusBarItems.push(item);
    return item;
  },
  createWebviewPanel(viewType, title, viewColumn, options) {
    const panel = new MockWebviewPanel(viewType, title, viewColumn, options);
    window.webviewPanels.push(panel);
    return panel;
  },
  showInformationMessage(message) {
    window.informationMessages.push(message);
    return Promise.resolve(undefined);
  }
};

const commands = {
  registeredCommands: mockState.registeredCommands,
  registerCommand(id, callback) {
    const entry = {
      id,
      callback,
      disposed: false
    };

    commands.registeredCommands.push(entry);

    return {
      dispose: () => {
        entry.disposed = true;

        const index = commands.registeredCommands.indexOf(entry);
        if (index >= 0) {
          commands.registeredCommands.splice(index, 1);
        }
      }
    };
  }
};

const env = {
  clipboard: {
    writes: mockState.clipboardWrites,
    writeText(text) {
      env.clipboard.writes.push(text);
      return Promise.resolve();
    }
  },
  openExternalCalls: mockState.openExternalCalls,
  openExternal(uri) {
    env.openExternalCalls.push(uri);
    return Promise.resolve(env.openExternalResult);
  },
  openExternalResult: true
};

function resetMockState() {
  mockState.configuration.clear();
  mockState.statusBarItems.length = 0;
  mockState.webviewPanels.length = 0;
  mockState.registeredCommands.length = 0;
  mockState.clipboardWrites.length = 0;
  mockState.informationMessages.length = 0;
  mockState.openExternalCalls.length = 0;
  mockState.openExternalResult = true;
  workspace.workspaceFolders = [];
  workspace.configurationEmitter = new MockEventEmitter();
  env.openExternalResult = true;
}

function setWorkspaceConfiguration(section, values) {
  mockState.configuration.set(section, values);
}

const vscodeMock = {
  EventEmitter: MockEventEmitter,
  MarkdownString: MockMarkdownString,
  ThemeColor: MockThemeColor,
  Uri: {
    parse: createUri
  },
  StatusBarAlignment: {
    Left: 1,
    Right: 2
  },
  ViewColumn: {
    One: 1
  },
  workspace,
  window,
  commands,
  env,
  resetMockState,
  setWorkspaceConfiguration
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeMock;
  }

  if (request === './dashboard.html' || request.endsWith('/dashboard.html') || request.endsWith('\\dashboard.html')) {
    return fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'dashboard.html'), 'utf8');
  }

  return originalLoad.call(this, request, parent, isMain);
};

require.extensions['.html'] = function loadHtml(module) {
  module.exports = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'dashboard.html'), 'utf8');
};

module.exports = vscodeMock;
