declare module "vscode" {
  export enum StatusBarAlignment {
    Left = 1,
    Right = 2,
  }

  export class ThemeColor {
    readonly id: string;
    constructor(id: string);
  }

  export class MarkdownString {
    value: string;
    isTrusted?: boolean;
    supportThemeIcons?: boolean;
    constructor(value?: string, supportThemeIcons?: boolean);
    appendMarkdown(value: string): MarkdownString;
  }

  export interface StatusBarItem {
    alignment: StatusBarAlignment;
    priority?: number;
    text: string;
    tooltip?: string | MarkdownString | undefined;
    color?: string | ThemeColor | undefined;
    backgroundColor?: ThemeColor | undefined;
    command?: string | undefined;
    show(): void;
    hide(): void;
    dispose(): void;
  }

  export interface Disposable {
    dispose(): unknown;
  }

  export interface Uri {
    readonly fsPath: string;
  }

  export interface FileSystemWatcher extends Disposable {
    onDidCreate(listener: (e: Uri) => unknown): Disposable;
    onDidChange(listener: (e: Uri) => unknown): Disposable;
    onDidDelete(listener: (e: Uri) => unknown): Disposable;
  }

  export interface WorkspaceFolder {
    readonly uri: Uri;
    readonly name: string;
    readonly index: number;
  }

  export interface Terminal {
    readonly name: string;
    show(preserveFocus?: boolean): void;
    sendText(text: string, addNewLine?: boolean): void;
  }

  export interface ExtensionContext {
    readonly subscriptions: Disposable[];
  }

  export namespace window {
    export function createStatusBarItem(
      alignment?: StatusBarAlignment,
      priority?: number,
    ): StatusBarItem;
    export function createTerminal(name?: string): Terminal;
    export function showInformationMessage(
      message: string,
    ): Promise<string | undefined>;
    export function onDidChangeActiveTextEditor(
      listener: (e: unknown) => unknown,
    ): Disposable;
  }

  export namespace workspace {
    export const workspaceFolders: readonly WorkspaceFolder[] | undefined;
    export function createFileSystemWatcher(
      globPattern: string,
    ): FileSystemWatcher;
  }

  export namespace commands {
    export function registerCommand(
      command: string,
      callback: (...args: unknown[]) => unknown,
    ): Disposable;
  }
}
