import * as vscode from 'vscode';
import { INIManager } from './parser';
import { SchemaManager } from './schema-manager';

/**
 * 负责检测并高亮显示覆盖了父类键的子类键。
 */
export class OverrideDecorator implements vscode.Disposable {
    private decorationType: vscode.TextEditorDecorationType;
    private timeout: NodeJS.Timeout | undefined = undefined;
    private disposables: vscode.Disposable[] = [];
    private isEnabled = true;

    constructor(
        private context: vscode.ExtensionContext,
        private iniManager: INIManager,
        private schemaManager: SchemaManager
    ) {
        this.decorationType = this.createDecoration();
        this.updateEnabledStatus();

        this.disposables.push(vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor && this.isEnabled) {
                this.triggerUpdateDecorations(editor.document.uri);
            }
        }));

        this.disposables.push(vscode.workspace.onDidChangeTextDocument(event => {
            if (this.isEnabled && vscode.window.activeTextEditor?.document === event.document) {
                this.triggerUpdateDecorations(event.document.uri, true);
            }
        }));
    }

    /**
     * 创建用于高亮覆盖键的装饰器类型。
     */
    private createDecoration(): vscode.TextEditorDecorationType {
        return vscode.window.createTextEditorDecorationType({
            gutterIconPath: this.context.asAbsolutePath('assets/override-icon.svg'),
            gutterIconSize: 'contain',
        });
    }

    /**
     * 从配置中更新启用状态。
     */
    private updateEnabledStatus() {
        this.isEnabled = vscode.workspace.getConfiguration('ra2-ini-intellisense.decorations.overrideIndicator').get('enabled', true);
    }

    /**
     * 重新加载配置并更新所有可见编辑器。
     */
    public reload() {
        this.updateEnabledStatus();
        
        // 清理旧的装饰器
        this.decorationType.dispose();
        this.decorationType = this.createDecoration();

        this.triggerUpdateDecorationsForAllVisibleEditors();
    }

    /**
     * 触发对所有可见的INI编辑器进行装饰更新。
     */
    public triggerUpdateDecorationsForAllVisibleEditors() {
        vscode.window.visibleTextEditors.forEach(editor => {
            if (editor.document.languageId === 'ra2-ini') {
                this.triggerUpdateDecorations(editor.document.uri);
            }
        });
    }

    /**
     * 触发对特定URI的文档进行装饰更新，使用防抖机制。
     * @param uri 要更新的文档的URI
     * @param throttle 是否启用防抖
     */
    public triggerUpdateDecorations(uri: vscode.Uri, throttle = false) {
        if (!this.isEnabled) {
            // 如果被禁用，确保清除所有现有装饰
            const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uri.toString());
            if (editor) {
                editor.setDecorations(this.decorationType, []);
            }
            return;
        }

        if (this.timeout) {
            clearTimeout(this.timeout);
        }

        const callback = () => {
            const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uri.toString());
            if (editor) {
                this.updateDecorations(editor);
            }
        };

        if (throttle) {
            this.timeout = setTimeout(callback, 200);
        } else {
            callback();
        }
    }

    /**
     * 核心更新逻辑：扫描文档并应用装饰。
     * @param editor 要装饰的文本编辑器
     */
    private async updateDecorations(editor: vscode.TextEditor) {
        if (!this.isEnabled || !this.schemaManager.isSchemaLoaded()) {
            editor.setDecorations(this.decorationType, []);
            return;
        }
        
        const document = editor.document;
        const overrideDecorations: vscode.DecorationOptions[] = [];
        let currentSectionName: string | null = null;
        
        for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i);
            const trimmedLine = line.text.trim();

            if (trimmedLine.startsWith('[')) {
                const sectionMatch = trimmedLine.match(/^\s*\[([^\]:]+)/);
                if (sectionMatch) {
                    currentSectionName = sectionMatch[1].trim();
                }
                continue;
            }

            if (currentSectionName) {
                const parentName = this.iniManager.getInheritance(currentSectionName);
                if(parentName){
                    const kvMatch = line.text.match(/^\s*([^;=\s][^=]*?)\s*=/);
                    if (kvMatch) {
                        const key = kvMatch[1].trim();
                        const parentKeyInfo = this.iniManager.findKeyLocationRecursive(parentName, key);
                        if (parentKeyInfo.location) {
                            const keyStartIndex = line.text.indexOf(key);
                            const range = new vscode.Range(i, keyStartIndex, i, keyStartIndex + key.length);
                            overrideDecorations.push({ range });
                        }
                    }
                }
            }
        }
        editor.setDecorations(this.decorationType, overrideDecorations);
    }
    
    public dispose() {
        if (this.timeout) {
            clearTimeout(this.timeout);
        }
        this.decorationType.dispose();
        this.disposables.forEach(d => d.dispose());
    }
}